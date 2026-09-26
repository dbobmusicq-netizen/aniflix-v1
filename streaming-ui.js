/**
 * ============================================================================
 * AnimeDrift — ADVANCED STREAMING UI (ENTERPRISE MASTER SYSTEM)
 * ============================================================================
 *
 * File:
 *    streaming-ui.js
 *
 * Version:
 *    46.4.0 Strict TMDB v3 Compliance & Full UI Matrix
 * ============================================================================
 */

(() => {
  'use strict';

  // ==========================================================================
  // 01. RUNTIME STATE, TIMERS & STORAGE CONSTANTS
  // ==========================================================================
  const win = window;
  const doc = document;
  const queryCache = new Map();
  const imageBlobCache = new Map();

  let streamLoadTimeout = null;
  let healthProbeAbortControllers = [];
  let aniSkipIntervals = [];
  let aniSkipPollTimer = null;
  let currentAudioGainLevel = 1.0;
  let audioCtx = null;
  let gainNode = null;

  let lastGqlRequestTime = 0;
  const GQL_MIN_INTERVAL_MS = 380;
  let gqlQueue = Promise.resolve();

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const FALLBACK_POSTER = 'data:image/svg+xml;charset=utf-8,%3Csvg%20width%3D%22200%22%20height%3D%22300%22%20viewBox%3D%220%200%20200%20300%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%2316161c%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20fill%3D%22%23666666%22%20font-size%3D%2214%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22middle%22%3ENo%20Image%3C%2Ftext%3E%3C%2Fsvg%3E';

  // ==========================================================================
  // 02. INDEXEDDB PERSISTENCE (DEXIE.JS WITH 24H PRUNING ENGINE)
  // ==========================================================================
  const db = win.Dexie ? new win.Dexie('AnimeDriftUltraDB') : null;
  if (db) {
    try {
      db.version(2).stores({
        watchHistory: 'id, animeId, title, season, episode, currentTime, duration, lastUpdated, isFinished',
        cachedQueries: 'key, data, timestamp',
        cachedMetadata: 'id, data, timestamp',
        cachedImages: 'url, blob, timestamp'
      });
    } catch (e) {
      console.warn('[Storage Nexus] Dexie schema registration warning:', e);
    }
  }
  win.db = db;

  win.pruneStaleStorageCache = async function () {
    if (!db) return;
    const cutoff = Date.now() - CACHE_TTL_MS;
    try {
      await Promise.allSettled([
        db.cachedQueries.where('timestamp').below(cutoff).delete(),
        db.cachedMetadata.where('timestamp').below(cutoff).delete(),
        db.cachedImages.where('timestamp').below(cutoff).delete()
      ]);
      console.info('[Storage Nexus] 24-hour cache pruning cycle completed.');
    } catch (err) {}
  };

  setTimeout(() => win.pruneStaleStorageCache(), 5000);
  setInterval(() => win.pruneStaleStorageCache(), 60 * 60 * 1000);

  // ==========================================================================
  // 03. SECURE DOM & STRING UTILITIES
  // ==========================================================================
  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function cleanText(value) {
    return String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function titleOf(anime) {
    return (
      anime?.title?.english ||
      anime?.title?.romaji ||
      anime?.title?.native ||
      anime?.name ||
      anime?.title ||
      'Unknown Title'
    );
  }

  function posterOf(anime) {
    return (
      anime?.coverImage?.extraLarge ||
      anime?.coverImage?.large ||
      anime?.poster ||
      (anime?.poster_path
        ? `https://image.tmdb.org/t/p/w500${anime.poster_path}`
        : '') ||
      FALLBACK_POSTER
    );
  }

  function backdropOf(anime) {
    return (
      anime?.bannerImage ||
      anime?.banner ||
      anime?.backdrop ||
      (anime?.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${anime.backdrop_path}`
        : '') ||
      posterOf(anime)
    );
  }

  function formatRating(score) {
    const val = Number(score);
    if (!Number.isFinite(val) || val <= 0) return 'N/A';
    return val <= 10 ? `${Math.round(val * 10)}%` : `${Math.round(val)}%`;
  }

  // ==========================================================================
  // 04. VERCEL SERVERLESS PROXY URL BUILDER (STRICT TMDB v3 QUERY PARSING)
  // ==========================================================================
  function cleanTMDBUrl(endpointPath, customParams = {}) {
    let raw = String(endpointPath || '').replace(/^\/+/, '');
    if (raw.startsWith('3/')) {
      raw = raw.replace(/^3\//, '');
    }

    let path = raw;
    let queryStr = '';
    if (raw.includes('?')) {
      const parts = raw.split('?');
      path = parts[0].replace(/\/+$/, '');
      queryStr = parts.slice(1).join('?');
    } else {
      path = path.replace(/\/+$/, '');
    }

    const url = new URL('/api/tmdb', win.location.origin);
    url.searchParams.set('endpoint', path);

    // Forward embedded query parameters individually
    if (queryStr) {
      const embedded = new URLSearchParams(queryStr);
      embedded.forEach((val, key) => {
        url.searchParams.set(key, val);
      });
    }

    // Official TMDB discover rules:
    // Only apply global vote_count threshold to non-regional feeds so Indian titles aren't eliminated
    if (path.startsWith('discover/')) {
      if (!url.searchParams.has('without_genres')) url.searchParams.set('without_genres', '16');
      if (!url.searchParams.has('vote_count.gte') && !url.searchParams.has('with_original_language')) {
        url.searchParams.set('vote_count.gte', '15');
      }
      if (!url.searchParams.has('include_adult')) url.searchParams.set('include_adult', 'false');
      if (!url.searchParams.has('include_video')) url.searchParams.set('include_video', 'false');
      if (!url.searchParams.has('language')) url.searchParams.set('language', 'en-US');
    }

    for (const [key, value] of Object.entries(customParams)) {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
  win.cleanTMDBUrl = cleanTMDBUrl;

  function enqueueGQL(taskFn) {
    gqlQueue = gqlQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - lastGqlRequestTime;
      if (elapsed < GQL_MIN_INTERVAL_MS) {
        await new Promise(res => setTimeout(res, GQL_MIN_INTERVAL_MS - elapsed));
      }
      lastGqlRequestTime = Date.now();
      return taskFn();
    }).catch(err => null);
    return gqlQueue;
  }

  async function fetchWithRetry(url, options = {}, retries = 2, delay = 1500) {
    let finalUrl = url;
    if (typeof url === 'string' && url.includes('db.speedracelight.com/3/')) {
      try {
        const parsed = new URL(url);
        const ep = parsed.pathname.replace(/^\/?3\/?/, '');
        const newUrl = new URL('/api/tmdb', win.location.origin);
        newUrl.searchParams.set('endpoint', ep);
        parsed.searchParams.forEach((v, k) => newUrl.searchParams.set(k, v));
        finalUrl = newUrl.toString();
      } catch (e) {}
    }

    try {
      const response = await fetch(finalUrl, options);

      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');
        const waitSeconds = retryHeader ? parseInt(retryHeader, 10) : (delay / 1000);
        if (retries > 0) {
          await new Promise(res => setTimeout(res, Math.max(waitSeconds, 2) * 1000));
          return fetchWithRetry(finalUrl, options, retries - 1, delay * 2);
        }
        return null;
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 404 || response.status === 500) {
          return null;
        }
        if (retries > 0) {
          await new Promise(res => setTimeout(res, delay));
          return fetchWithRetry(finalUrl, options, retries - 1, delay * 2);
        }
        return null;
      }

      return await response.json();
    } catch (error) {
      if (retries > 0) {
        await new Promise(res => setTimeout(res, delay));
        return fetchWithRetry(finalUrl, options, retries - 1, delay * 2);
      }
      return null;
    }
  }
  win.fetchWithRetry = fetchWithRetry;

  const GQL_BASIC = `
    query ($page: Int, $perPage: Int, $sort: [MediaSort], $genre: String, $search: String) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: $sort, genre: $genre, search: $search, isAdult: false) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          coverImage {
            extraLarge
            large
            medium
            color
          }
          bannerImage
          episodes
          duration
          format
          status
          genres
          averageScore
          seasonYear
          description(asHtml: false)
        }
      }
    }
  `;

  const GQL_DEEP = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        trailer {
          id
          site
        }
        characters(sort: [ROLE, RELEVANCE_DESC], perPage: 14) {
          edges {
            node {
              id
              name {
                full
              }
              image {
                large
              }
            }
            voiceActors(language: JAPANESE) {
              name {
                full
              }
              image {
                large
              }
            }
          }
        }
        recommendations(sort: [RATING_DESC], perPage: 8) {
          nodes {
            mediaRecommendation {
              id
              idMal
              title {
                romaji
                english
              }
              coverImage {
                extraLarge
                large
              }
              format
              episodes
              averageScore
              bannerImage
            }
          }
        }
      }
    }
  `;

  async function fetchGQL(query, rawVariables = {}) {
    const variables = {};
    for (const [key, value] of Object.entries(rawVariables)) {
      if (value !== null && value !== undefined && value !== '') {
        if (key === 'page' || key === 'perPage' || key === 'id') {
          const num = parseInt(value, 10);
          if (!isNaN(num)) variables[key] = num;
        } else if (key === 'sort') {
          if (Array.isArray(value) && value.length > 0) {
            variables[key] = value;
          } else if (typeof value === 'string' && value.length > 0) {
            variables[key] = [value];
          }
        } else if (typeof value === 'string' && value.trim().length > 0) {
          variables[key] = value.trim();
        }
      }
    }

    const cacheKey = JSON.stringify({ query, variables });

    if (queryCache.has(cacheKey)) {
      return queryCache.get(cacheKey);
    }

    if (db && db.cachedQueries) {
      try {
        const cached = await db.cachedQueries.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          queryCache.set(cacheKey, cached.data);
          return cached.data;
        }
      } catch (e) {}
    }

    return enqueueGQL(async () => {
      try {
        const json = await fetchWithRetry(win.CONFIG?.APIS?.ANILIST || 'https://graphql.anilist.co', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ query, variables })
        });

        if (json?.data) {
          queryCache.set(cacheKey, json.data);
          if (db && db.cachedQueries) {
            db.cachedQueries.put({ key: cacheKey, data: json.data, timestamp: Date.now() }).catch(() => {});
          }
          setTimeout(() => queryCache.delete(cacheKey), CACHE_TTL_MS);
          return json.data;
        }
        return null;
      } catch (err) {
        return null;
      }
    });
  }
  win.fetchGQL = fetchGQL;

  // ==========================================================================
  // 05. CACHED IMAGE BLOB INTERCEPTOR & WATCH TELEMETRY
  // ==========================================================================
  win.fetchCachedImageBlob = async function (imageUrl) {
    if (!imageUrl || imageUrl.startsWith('data:')) return imageUrl;
    if (imageBlobCache.has(imageUrl)) return imageBlobCache.get(imageUrl);

    if (db && db.cachedImages) {
      try {
        const cached = await db.cachedImages.get(imageUrl);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          const objUrl = URL.createObjectURL(cached.blob);
          imageBlobCache.set(imageUrl, objUrl);
          return objUrl;
        }
      } catch (e) {}
    }

    try {
      const res = await fetch(imageUrl, { mode: 'cors' });
      if (!res.ok) return imageUrl;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      imageBlobCache.set(imageUrl, objUrl);

      if (db && db.cachedImages) {
        db.cachedImages.put({ url: imageUrl, blob, timestamp: Date.now() }).catch(() => {});
      }
      return objUrl;
    } catch (e) {
      return imageUrl;
    }
  };

  win.recordWatchedEpisode = async function (animeId, season, episode, currentTime = 0, duration = 0, isFinished = false) {
    const recordKey = `${animeId}_${season}_${episode}`;
    const telemetry = {
      id: recordKey,
      animeId: String(animeId),
      title: win.STATE.currentAnime?.title?.english || win.STATE.currentAnime?.title?.romaji || 'Stream Master',
      season: Number(season),
      episode: Number(episode),
      currentTime: Math.round(currentTime),
      duration: Math.round(duration),
      lastUpdated: Date.now(),
      isFinished: Boolean(isFinished || (duration > 0 && currentTime / duration > 0.90))
    };

    if (db && db.watchHistory) {
      try {
        await db.watchHistory.put(telemetry);
      } catch (e) {}
    }
    win.STATE.watchHistory[recordKey] = telemetry;
    try {
      localStorage.setItem('animedrift_history_v6', JSON.stringify(win.STATE.watchHistory));
    } catch (e) {}

    const epCard = doc.querySelector(`.ep-modern-card[onclick*="switchEpisode(${episode})"]`);
    if (epCard && telemetry.isFinished) {
      epCard.classList.add('watched');
    }
  };

  win.isEpisodeWatched = function (animeId, season, episode) {
    const recordKey = `${animeId}_${season}_${episode}`;
    return Boolean(win.STATE.watchHistory[recordKey]?.isFinished);
  };

  // ==========================================================================
  // 06. CATEGORY SYNCHRONIZER & TAB ROUTER
  // ==========================================================================
  win.syncCategoryState = function (categoryKey) {
    const topLinks = doc.querySelectorAll('.nav-desktop .nav-link, .mobile-nav-list .mobile-nav-link');
    const chips = doc.querySelectorAll('.chips-container .chip');

    topLinks.forEach(l => l.classList.remove('active'));
    chips.forEach(c => c.classList.remove('active'));

    const normKey = (categoryKey || 'ALL').toUpperCase();

    const targetChip = doc.querySelector(`.chip[data-filter="${normKey}"]`) ||
      doc.querySelector(`.chip[onclick*="'${normKey}'"]`) ||
      chips[0];
    if (targetChip) targetChip.classList.add('active');

    topLinks.forEach(l => {
      const text = l.innerText.toUpperCase();
      if (normKey === 'ALL' && text.includes('HOME')) l.classList.add('active');
      else if ((normKey === 'MOVIES' || normKey === 'MOVIE') && text.includes('MOVIES')) l.classList.add('active');
      else if ((normKey === 'TOP_AIRING' || normKey === 'TV' || normKey === 'SHOWS') && (text.includes('TV') || text.includes('SHOWS'))) l.classList.add('active');
      else if (normKey === 'HINDI' && text.includes('HINDI')) l.classList.add('active');
      else if (normKey === 'ACTION' && text.includes('ACTION')) l.classList.add('active');
      else if (normKey === 'THRILLER' && (text.includes('THRILLER') || text.includes('CRIME'))) l.classList.add('active');
      else if (normKey === 'ROMANCE' && text.includes('ROMANCE')) l.classList.add('active');
      else if (normKey === 'FANTASY' && text.includes('FANTASY')) l.classList.add('active');
    });
  };

  // ==========================================================================
  // 07. HERO SPOTLIGHT & BILLBOARD ENGINE (FAIL-SAFE NON-BLOCKING PIPELINE)
  // ==========================================================================
  win.renderHeroSpotlight = async function () {
    const heroDubBadge = doc.querySelector('.hero-tags .tag-hindi');
    const heroTitle = doc.getElementById('heroTitle');
    const heroDesc = doc.getElementById('heroDesc');
    const heroBg = doc.getElementById('heroBg');
    const heroScore = doc.getElementById('heroScore');
    const heroYear = doc.getElementById('heroYear');
    const heroFormat = doc.getElementById('heroFormat');
    const heroStatus = doc.getElementById('heroStatus');
    const heroFormatBadge = doc.getElementById('heroFormatBadge');
    const playBtn = doc.getElementById('heroPlayBtn');
    const infoBtn = doc.getElementById('heroInfoBtn');
    const bookmarkBtn = doc.getElementById('heroBookmarkBtn');

    // CASE A: NETFLIX / LIVE-ACTION SPOTLIGHT
    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('discover/movie', {
          sort_by: 'popularity.desc',
          'vote_count.gte': '100'
        });
        const data = await fetchWithRetry(url, {}, 2, 800);
        const item = data?.results?.[0];

        if (item) {
          const title = item.title || item.name || 'Featured Live-Action';
          const poster = item.backdrop_path
            ? `https://image.tmdb.org/t/p/original${item.backdrop_path}`
            : (item.poster_path ? `https://image.tmdb.org/t/p/original${item.poster_path}` : FALLBACK_POSTER);
          const isMovie = item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));

          const mockMediaObj = {
            id: item.id,
            idMal: null,
            tmdbId: item.id,
            title: { romaji: title, english: title, native: item.original_title || title },
            description: item.overview || 'Exclusive live-action cinematic stream.',
            bannerImage: poster,
            coverImage: { extraLarge: poster, large: poster },
            episodes: isMovie ? 1 : 16,
            duration: item.runtime || 115,
            format: isMovie ? 'MOVIE' : 'TV',
            status: 'RELEASED',
            genres: ['Live-Action', 'Blockbuster'],
            averageScore: Math.round((item.vote_average || 8.2) * 10),
            seasonYear: (item.release_date || item.first_air_date || '2026').split('-')[0],
            isLiveAction: true
          };

          win.animeCache.set(mockMediaObj.id, mockMediaObj);
          win.STATE.currentAnime = mockMediaObj;
          win.STATE.currentTMDBId = mockMediaObj.id;

          if (heroBg) {
            heroBg.src = poster;
            if (typeof win.extractChromaAmbilight === 'function') win.extractChromaAmbilight(poster);
          }
          if (heroTitle) heroTitle.innerText = title;
          if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${mockMediaObj.averageScore}% Match`;
          if (heroYear) heroYear.innerText = mockMediaObj.seasonYear;
          if (heroFormat) heroFormat.innerText = mockMediaObj.format;
          if (heroStatus) heroStatus.innerText = 'NETFLIX LIVE';
          if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> NETFLIX LIVE SPOTLIGHT`;
          if (heroDubBadge) heroDubBadge.innerHTML = `<i class="fas fa-film"></i> 4K ULTRA HD / MULTI AUDIO`;
          if (heroDesc) heroDesc.innerText = cleanText(mockMediaObj.description);

          if (playBtn) playBtn.onclick = () => win.openModal(mockMediaObj, 1, 1, true);
          if (infoBtn) infoBtn.onclick = () => win.openModal(mockMediaObj, 1, 1, false);
          if (bookmarkBtn) bookmarkBtn.onclick = () => win.toggleWatchlist(mockMediaObj);
          return;
        }
      } catch (e) {
        console.warn('[Netflix Spotlight Failover Engaged]:', e);
      }
    }

    // CASE B: ANIME UNIVERSE SPOTLIGHT
    try {
      const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 1, sort: ['TRENDING_DESC'] });
      const anime = data?.Page?.media?.[0];

      if (anime) {
        win.animeCache.set(anime.id, anime);
        win.STATE.currentAnime = anime;

        const title = anime.title?.english || anime.title?.romaji || 'Stream Spotlight';
        const banner = anime.bannerImage || anime.coverImage?.extraLarge || FALLBACK_POSTER;

        if (heroBg) {
          heroBg.src = banner;
          if (typeof win.extractChromaAmbilight === 'function') win.extractChromaAmbilight(banner);
        }
        if (heroTitle) heroTitle.innerText = title;
        if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 95}% Rating`;
        if (heroYear) heroYear.innerText = anime.seasonYear || '2026';
        if (heroFormat) heroFormat.innerText = anime.format || 'TV SERIES';
        if (heroStatus) heroStatus.innerText = anime.status || 'AIRING';
        if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> FEATURED SPOTLIGHT`;
        if (heroDubBadge) heroDubBadge.innerHTML = `<i class="fas fa-microphone"></i> HINDI / SUB / DUB`;
        if (heroDesc) heroDesc.innerText = cleanText(anime.description);

        if (playBtn) playBtn.onclick = () => win.openModal(anime, 1, 1, true);
        if (infoBtn) infoBtn.onclick = () => win.openModal(anime, 1, 1, false);
        if (bookmarkBtn) bookmarkBtn.onclick = () => win.toggleWatchlist(anime);
        return;
      }
    } catch (err) {
      console.warn('[AniList Spotlight Query Error]:', err);
    }

    // CASE C: EMERGENCY STATIC FALLBACK
    if (heroTitle && heroTitle.innerText.includes('Connecting')) {
      const fallbackTitle = win.STATE.isNetflixMode ? 'Deadpool & Wolverine' : 'Demon Slayer: Kimetsu no Yaiba';
      const fallbackPoster = 'https://image.tmdb.org/t/p/original/yDHYTfA3R0jFYba16jBB1ef8oIt.jpg';

      const defaultObj = {
        id: 533535,
        title: { english: fallbackTitle, romaji: fallbackTitle },
        description: 'Stream trending titles with zero popups and ultra-fast multi-server sync.',
        bannerImage: fallbackPoster,
        coverImage: { extraLarge: fallbackPoster, large: fallbackPoster },
        format: 'MOVIE',
        averageScore: 98,
        seasonYear: '2026'
      };

      win.STATE.currentAnime = defaultObj;
      if (heroBg) heroBg.src = fallbackPoster;
      heroTitle.innerText = fallbackTitle;
      if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> 98% Rating`;
      if (heroYear) heroYear.innerText = '2026';
      if (heroDesc) heroDesc.innerText = defaultObj.description;
      if (playBtn) playBtn.onclick = () => win.openModal(defaultObj, 1, 1, true);
      if (infoBtn) infoBtn.onclick = () => win.openModal(defaultObj, 1, 1, false);
    }
  };

  // ==========================================================================
  // 08. STAGGERED CATALOG RAILS & DISCRETE QUERY EXECUTION
  // ==========================================================================
  win.renderHomeRows = async function () {
    const content = doc.getElementById('contentRows');
    if (content) content.innerHTML = '';

    if (win.STATE.isNetflixMode) {
      if (typeof win.showToast === 'function') win.showToast('Loading Netflix Live-Action Universe...');

      // 1. Trending Global Movies
      await renderTMDBRow('Trending Movies Worldwide', 'discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');

      // 2. TRUE Bollywood & Hindi Cinema (Locked to Hindi language + India origin country)
      await renderTMDBRow(
        'Hindi Blockbuster Movies', 
        'discover/movie?with_original_language=hi&with_origin_country=IN&sort_by=popularity.desc', 
        '<i class="fas fa-language"></i>', 
        'MOVIE'
      );

      // 3. TRUE Hindi Web Series & Dramas (Locked to Hindi TV series)
      await renderTMDBRow(
        'Hindi Web Series & Dramas', 
        'discover/tv?with_original_language=hi&with_origin_country=IN&with_type=0|4&sort_by=popularity.desc', 
        '<i class="fas fa-tv"></i>', 
        'TV'
      );

      // 4. South Indian Cinema (Telugu & Tamil Hits)
      await renderTMDBRow(
        'Telugu & Tamil Indian Cinema', 
        'discover/movie?with_original_language=te|ta&with_origin_country=IN&sort_by=popularity.desc', 
        '<i class="fas fa-fire"></i>', 
        'MOVIE'
      );

      // 5. Trending Global TV Shows
      await renderTMDBRow('Trending TV Shows Worldwide', 'discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');

      // 6. Action & Adrenaline (Strict Movie Action=28, TV Action=10759)
      await renderTMDBRow('Explosive Action & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
      await renderTMDBRow('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-shield"></i>', 'TV');

      // 7. Sci-Fi (Strict Movie Sci-Fi=878, TV Sci-Fi=10765)
      await renderTMDBRow('Sci-Fi & High Concept Cinema', 'discover/movie?with_genres=878&sort_by=popularity.desc', '<i class="fas fa-microchip"></i>', 'MOVIE');

      // 8. Crime & Mystery Thrillers (Movie Thriller=53, TV Crime=80)
      await renderTMDBRow('Gripping Crime & Mystery Thrillers', 'discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');

      // 9. Romance & Drama
      await renderTMDBRow('Romance & Heartwarming Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
      return;
    }

    await renderRow('Trending Masterpieces', { page: 1, perPage: 14, sort: ['TRENDING_DESC'] }, false);
    await renderRow('Top 10 Global Anime Today', { page: 1, perPage: 10, sort: ['POPULARITY_DESC'] }, true);
    await renderHindiDubRow();
    await renderRow('Action & Shonen Hits', { page: 1, perPage: 14, genre: 'Action', sort: ['TRENDING_DESC'] }, false);
    await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 14, genre: 'Fantasy', sort: ['TRENDING_DESC'] }, false);
    await renderRow('Romance & Slice of Life', { page: 1, perPage: 14, genre: 'Romance', sort: ['SCORE_DESC'] }, false);
  };

  async function renderRow(title, vars, isTop10 = false) {
    const data = await fetchGQL(GQL_BASIC, vars);
    if (data?.Page?.media?.length) buildUnifiedCarouselDOM(title, data.Page.media, isTop10, false);
  }
  win.renderRow = renderRow;

  async function renderHindiDubRow() {
    const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 14, sort: ['FAVOURITES_DESC'] });
    if (data?.Page?.media?.length) buildUnifiedCarouselDOM('<i class="fas fa-language" style="color:var(--accent-red,#e50914);"></i> Premium Hindi Dubbed Anime', data.Page.media, false, true);
  }
  win.renderHindiDubRow = renderHindiDubRow;

  async function renderTMDBRow(title, endpoint, iconHtml = '<i class="fas fa-clapperboard"></i>', forceFormat = null) {
    const container = doc.getElementById('contentRows');
    if (!container) return;

    const rowId = 'row-' + Math.random().toString(36).substring(2, 9);
    const section = doc.createElement('section');
    section.className = 'row-section content-row';
    section.style.cssText = 'margin: 28px 0; padding: 0 4%; position: relative; width: 100%; box-sizing: border-box;';
    section.innerHTML = `
      <h2 class="row-header" style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 12px; letter-spacing: 0.3px;">
        <span style="color:var(--accent-red,#e50914); margin-right:8px;">${iconHtml}</span>${title}
      </h2>
      <div class="row-container carousel-container" style="position: relative; width: 100%; overflow: hidden;">
        <div class="carousel-track carousel-rail" id="${rowId}" style="display: flex; flex-wrap: nowrap; align-items: stretch; gap: 16px; overflow-x: auto; overflow-y: hidden; scroll-behavior: smooth; padding: 10px 4px 16px 4px; -webkit-overflow-scrolling: touch; scrollbar-width: thin;">
          <div style="color: var(--text-muted); padding: 16px; font-size: 13px;"><i class="fas fa-spinner fa-spin"></i> Loading titles...</div>
        </div>
      </div>
    `;
    container.appendChild(section);

    const track = doc.getElementById(rowId);
    const sanitizedUrl = cleanTMDBUrl(endpoint);
    const data = await fetchWithRetry(sanitizedUrl);

    if (data?.results?.length) {
      const cleanResults = data.results.filter(item => !(item.genre_ids || []).includes(16));
      if (cleanResults.length && track) {
        track.innerHTML = '';
        populateCardsIntoTrack(track, cleanResults, false, false, forceFormat);
        enableCarouselDrag(track);
        return;
      }
    }

    if (section && section.parentNode) {
      section.parentNode.removeChild(section);
    }
  }

  function populateCardsIntoTrack(track, items, isTop10 = false, isHindi = false, forceFormat = null) {
    items.forEach((item, idx) => {
      if (!item) return;

      const isMovie = forceFormat === 'MOVIE' || item.media_type === 'movie' || Boolean(item.title && !item.name);
      const dispTitle = item.title?.english || item.title?.romaji || item.title || item.name || 'Title';
      const posterPath = item.poster_path || item.backdrop_path;
      const poster = item.coverImage?.extraLarge || item.coverImage?.large || (posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : FALLBACK_POSTER);
      const score = item.averageScore ? `${item.averageScore}%` : (item.vote_average ? `${Math.round(item.vote_average * 10)}%` : '85%');
      const year = item.seasonYear || (item.release_date || item.first_air_date || '2026').split('-')[0];
      const format = item.format || (isMovie ? 'MOVIE' : 'TV');

      const mediaObj = {
        id: item.id,
        tmdbId: item.id,
        title: { english: dispTitle, romaji: dispTitle },
        coverImage: { extraLarge: poster, large: poster },
        format: format,
        averageScore: Math.round((item.vote_average || 8) * 10),
        seasonYear: year,
        isLiveAction: Boolean(item.vote_average)
      };
      win.animeCache.set(item.id, mediaObj);

      const card = doc.createElement('div');
      card.className = 'anime-card card ui-card-locked';
      card.style.cssText = 'flex: 0 0 185px !important; min-width: 185px !important; max-width: 185px !important; height: 275px !important; position: relative !important; border-radius: 12px !important; overflow: hidden !important; cursor: pointer !important; transition: transform 0.28s ease, box-shadow 0.28s ease !important; user-select: none !important; background: #16161c !important;';

      card.onmouseenter = () => {
        card.style.transform = 'translateY(-4px) scale(1.03)';
        card.style.boxShadow = '0 14px 28px rgba(0,0,0,0.8)';
      };
      card.onmouseleave = () => {
        card.style.transform = 'translateY(0) scale(1)';
        card.style.boxShadow = 'none';
      };
      card.onclick = () => {
        if (track.dataset.isDragging !== 'true') win.handleAnimeClick(item.id);
      };

      card.innerHTML = `
        ${isTop10 ? `<div class="top10-rank" style="font-size: 3.8rem; font-weight: 900; position: absolute; left: -2px; bottom: 12px; z-index: 3; color: rgba(255,255,255,0.95); -webkit-text-stroke: 1px rgba(0,0,0,0.7);">${idx + 1}</div>` : ''}
        <img src="${poster}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="width: 100% !important; height: 100% !important; object-fit: cover !important; display: block;" />
        <div class="card-badge" style="position: absolute !important; top: 8px !important; right: 8px !important; background: ${isHindi ? '#e50914' : 'rgba(0,0,0,0.78)'} !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px !important; border-radius: 6px !important; z-index: 3 !important;">${isHindi ? 'HINDI DUB' : format}</div>
        <div class="card-overlay" style="position: absolute !important; inset: auto 0 0 0 !important; width: 100% !important; padding: 42px 12px 10px 12px !important; background: linear-gradient(to top, rgba(4, 4, 6, 0.98) 0%, rgba(4, 4, 6, 0.72) 60%, transparent 100%) !important; z-index: 2 !important;">
          <div class="card-title" style="font-size: 13px !important; font-weight: 700 !important; color: #ffffff !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;">${dispTitle}</div>
          <div class="card-meta" style="font-size: 11px !important; color: #a1a1aa !important; margin-top: 4px !important;"><span style="color: #46d369 !important; font-weight: 700 !important;"><i class="fas fa-star" style="font-size: 9px;"></i> ${score}</span> &bull; ${year}</div>
        </div>
      `;
      track.appendChild(card);
    });
  }

  function buildUnifiedCarouselDOM(title, items, isTop10 = false, isHindi = false) {
    const container = doc.getElementById('contentRows');
    if (!container) return;
    const section = doc.createElement('section');
    section.className = 'row-section content-row';
    section.style.cssText = 'margin: 28px 0; padding: 0 4%; position: relative; width: 100%; box-sizing: border-box;';

    section.innerHTML = `
      <h2 class="row-header" style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 12px;">${title}</h2>
      <div class="row-container carousel-container" style="position: relative; width: 100%; overflow: hidden;">
        <div class="carousel-track carousel-rail" style="display: flex; flex-wrap: nowrap; align-items: stretch; gap: 16px; overflow-x: auto; overflow-y: hidden; scroll-behavior: smooth; padding: 10px 4px 16px 4px; -webkit-overflow-scrolling: touch; scrollbar-width: thin;"></div>
      </div>
    `;
    const track = section.querySelector('.carousel-track');
    populateCardsIntoTrack(track, items, isTop10, isHindi);
    enableCarouselDrag(track);
    container.appendChild(section);
  }

  function enableCarouselDrag(slider) {
    if (!slider) return;
    let isDown = false, startX, scrollLeft;
    slider.addEventListener('mousedown', (e) => { isDown = true; slider.dataset.isDragging = 'false'; startX = e.pageX - slider.offsetLeft; scrollLeft = slider.scrollLeft; slider.style.cursor = 'grabbing'; });
    slider.addEventListener('mouseleave', () => { isDown = false; slider.style.cursor = 'default'; setTimeout(() => { slider.dataset.isDragging = 'false'; }, 50); });
    slider.addEventListener('mouseup', () => { isDown = false; slider.style.cursor = 'default'; setTimeout(() => { slider.dataset.isDragging = 'false'; }, 50); });
    slider.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      const walk = (e.pageX - slider.offsetLeft - startX) * 1.5;
      if (Math.abs(walk) > 6) slider.dataset.isDragging = 'true';
      slider.scrollLeft = scrollLeft - walk;
    });
  }

  win.handleAnimeClick = function (animeId) {
    const anime = win.animeCache.get(animeId);
    if (anime) win.openModal(anime);
  };

  win.navigateGenre = async function (genre, label) {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);

    const key = genre ? genre.toUpperCase() : 'ALL';
    win.syncCategoryState(key);

    const contentRows = doc.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';

    if (!genre) {
      await win.renderHomeRows();
      win.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (typeof win.showToast === 'function') win.showToast(`Loading ${label || genre}...`);

    if (win.STATE.isNetflixMode) {
      if (genre === 'Movies' || genre === 'Movie') {
        await renderTMDBRow('Trending Feature Films', 'discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
        await renderTMDBRow('Top Rated Blockbusters', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=200', '<i class="fas fa-star"></i>', 'MOVIE');
      } else if (genre === 'TV' || genre === 'TV Shows') {
        await renderTMDBRow('Top Binge TV Series', 'discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        await renderTMDBRow('Critically Acclaimed Series', 'discover/tv?sort_by=vote_average.desc&vote_count.gte=100', '<i class="fas fa-star"></i>', 'TV');
      } else if (genre === 'Action') {
        await renderTMDBRow('Action Movies & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
        await renderTMDBRow('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-shield"></i>', 'TV');
      } else if (genre === 'Thriller' || genre === 'Crime') {
        await renderTMDBRow('Gripping Crime & Mystery Films', 'discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');
        await renderTMDBRow('Psychological Thriller Series', 'discover/tv?with_genres=80&sort_by=popularity.desc', '<i class="fas fa-user-secret"></i>', 'TV');
      } else if (genre === 'Romance') {
        await renderTMDBRow('Romantic Comedies & Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
        await renderTMDBRow('Romantic TV Series', 'discover/tv?with_genres=10766&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
      } else if (genre === 'Hindi') {
        await win.loadHindiDubbed();
      }
    } else {
      await renderRow(label || genre, { page: 1, perPage: 24, genre, sort: ['TRENDING_DESC'] }, false);
      await renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre, sort: ['SCORE_DESC'] }, false);
    }

    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.loadHindiDubbed = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);
    win.syncCategoryState('HINDI');

    const contentRows = doc.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';

    if (typeof win.showToast === 'function') win.showToast('Loading Hindi & Regional Indian Releases...');

    if (win.STATE.isNetflixMode) {
      await renderTMDBRow('Hindi Blockbuster Movies', 'discover/movie?with_original_language=hi&with_origin_country=IN&sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
      await renderTMDBRow('Hindi Web Series & Dramas', 'discover/tv?with_original_language=hi&with_origin_country=IN&with_type=0|4&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
      await renderTMDBRow('Telugu & Tamil Indian Cinema', 'discover/movie?with_original_language=te|ta&with_origin_country=IN&sort_by=popularity.desc', '<i class="fas fa-fire"></i>', 'MOVIE');
    } else {
      await renderHindiDubRow();
      await renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
      await renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['POPULARITY_DESC'] }, false);
    }
    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.applyQuickFilter = async function (type, chipBtn) {
    const normType = (type || 'ALL').toUpperCase();
    if (win.STATE.isNetflixMode) {
      if (normType === 'ALL') { win.syncCategoryState('ALL'); await win.renderHomeRows(); }
      else if (normType === 'MOVIES') await win.navigateGenre('Movies', 'Feature Films');
      else if (normType === 'TOP_AIRING' || normType === 'TV') await win.navigateGenre('TV', 'TV Series');
      else if (normType === 'HINDI') await win.loadHindiDubbed();
      else if (normType === 'ACTION') await win.navigateGenre('Action', 'Action');
      else if (normType === 'THRILLER') await win.navigateGenre('Thriller', 'Thriller');
      else if (normType === 'SCI_FI') {
        win.syncCategoryState('SCI_FI');
        const c = doc.getElementById('contentRows');
        if (c) c.innerHTML = '';
        await renderTMDBRow('Sci-Fi Explorations', 'discover/movie?with_genres=878&sort_by=popularity.desc', '<i class="fas fa-microchip"></i>', 'MOVIE');
        await renderTMDBRow('Futuristic TV Shows', 'discover/tv?with_genres=10765&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        win.scrollTo({ top: 350, behavior: 'smooth' });
      }
      else if (normType === 'ROMANCE') await win.navigateGenre('Romance', 'Romance');
      return;
    }
    switch (normType) {
      case 'ALL': await win.navigateGenre(null, 'Home'); break;
      case 'HINDI': await win.loadHindiDubbed(); break;
      case 'TOP_AIRING': {
        win.syncCategoryState('TOP_AIRING');
        const c = doc.getElementById('contentRows');
        if (c) c.innerHTML = '';
        await renderRow('Top Airing Worldwide', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);
        win.scrollTo({ top: 350, behavior: 'smooth' });
        break;
      }
      case 'MOVIES': await win.navigateGenre('Movie', 'Top Anime Movies'); break;
      case 'ACTION': await win.navigateGenre('Action', 'Action'); break;
      case 'SECONDARY': await win.navigateGenre('Fantasy', 'Fantasy'); break;
      case 'SCI_FI': await win.navigateGenre('Sci-Fi', 'Sci-Fi'); break;
      case 'ROMANCE': await win.navigateGenre('Romance', 'Romance'); break;
    }
  };

  win.toggleNetflixMode = async function (skipUrlSync = false) {
    win.STATE.isNetflixMode = !win.STATE.isNetflixMode;
    if (!skipUrlSync && win.Router) win.Router.set({ mode: win.STATE.isNetflixMode ? 'netflix' : null });

    const btn = doc.getElementById('netflixModeBtn');
    const brandText = doc.getElementById('brandTitleText');
    const searchInput = doc.getElementById('searchInput');
    const desktopNav = doc.querySelector('.nav-desktop .nav-links');
    const filterChips = doc.getElementById('filterChips');

    if (win.STATE.isNetflixMode) {
      doc.body.classList.add('netflix-theme-active');
      if (btn) btn.classList.add('netflix-mode-active');
      if (brandText) brandText.innerHTML = 'NETFLIX<small class="brand-badge" style="background:#ff0844; color:#fff;">LIVE</small>';
      if (searchInput) searchInput.placeholder = "Search movies, TV series, actors, dramas...";

      if (desktopNav) desktopNav.innerHTML = `<li><a class="nav-link active" onclick="window.navigateGenre(null, 'Home')"><i class="fas fa-house"></i> <span>Home</span></a></li><li><a class="nav-link" onclick="window.applyQuickFilter('MOVIES')"><i class="fas fa-film"></i> <span>Movies</span></a></li><li><a class="nav-link" onclick="window.applyQuickFilter('TOP_AIRING')"><i class="fas fa-tv"></i> <span>TV Shows</span></a></li><li><a class="nav-link" onclick="window.applyQuickFilter('ACTION')"><span>Action</span></a></li><li><a class="nav-link" onclick="window.applyQuickFilter('THRILLER')"><span>Thriller & Crime</span></a></li><li><a class="nav-link" onclick="window.applyQuickFilter('HINDI')"><i class="fas fa-language"></i> <span>Hindi Dubs</span></a></li>`;
      if (filterChips) filterChips.innerHTML = `<button class="chip active" data-filter="ALL" onclick="window.applyQuickFilter('ALL')"><i class="fas fa-border-all"></i> All</button><button class="chip" data-filter="MOVIES" onclick="window.applyQuickFilter('MOVIES')"><i class="fas fa-film"></i> Movies</button><button class="chip" data-filter="TOP_AIRING" onclick="window.applyQuickFilter('TOP_AIRING')"><i class="fas fa-tv"></i> TV Series</button><button class="chip" data-filter="HINDI" onclick="window.applyQuickFilter('HINDI')"><i class="fas fa-language"></i> Hindi Dubs</button><button class="chip" data-filter="ACTION" onclick="window.applyQuickFilter('ACTION')"><i class="fas fa-bolt"></i> Action</button><button class="chip" data-filter="THRILLER" onclick="window.applyQuickFilter('THRILLER')"><i class="fas fa-mask"></i> Thriller</button><button class="chip" data-filter="SCI_FI" onclick="window.applyQuickFilter('SCI_FI')"><i class="fas fa-microchip"></i> Sci-Fi</button>`;

      if (win.showToast) win.showToast('Switched to Netflix Live-Action Mode');
      await win.renderHomeRows();
    } else {
      doc.body.classList.remove('netflix-theme-active');
      if (btn) btn.classList.remove('netflix-mode-active');
      if (brandText) brandText.innerHTML = 'ANIMEDRIFT<small class="brand-badge">PORTAL</small>';
      if (searchInput) searchInput.placeholder = "Search anime, movies, series...";

      if (desktopNav) desktopNav.innerHTML = `<li><a class="nav-link active" onclick="window.navigateGenre(null, 'Home')"><i class="fas fa-house"></i> <span>Home</span></a></li><li><a class="nav-link" onclick="window.loadHindiDubbed()"><i class="fas fa-language"></i> <span>Hindi Dubs</span></a></li><li><a class="nav-link" onclick="window.navigateGenre('Action', 'Action Blockbusters')"><span>Action</span></a></li><li><a class="nav-link" onclick="window.navigateGenre('Romance', 'Romance & Drama')"><span>Romance</span></a></li><li><a class="nav-link" onclick="window.navigateGenre('Fantasy', 'Isekai & Fantasy')"><span>Fantasy</span></a></li>`;
      if (filterChips) filterChips.innerHTML = `<button class="chip active" data-filter="ALL" onclick="window.applyQuickFilter('ALL')"><i class="fas fa-border-all"></i> All</button><button class="chip" data-filter="HINDI" onclick="window.applyQuickFilter('HINDI')"><i class="fas fa-language"></i> Hindi Dubs</button><button class="chip" data-filter="TOP_AIRING" onclick="window.applyQuickFilter('TOP_AIRING')"><i class="fas fa-tower-broadcast"></i> Airing</button><button class="chip" data-filter="MOVIES" onclick="window.applyQuickFilter('MOVIES')"><i class="fas fa-film"></i> Movies</button><button class="chip" data-filter="ACTION" onclick="window.applyQuickFilter('ACTION')"><i class="fas fa-bolt"></i> Action</button><button class="chip" data-filter="SECONDARY" onclick="window.applyQuickFilter('SECONDARY')"><i class="fas fa-dungeon"></i> Fantasy</button>`;

      if (win.showToast) win.showToast('Switched to Anime Universe');
      if (win.renderHeroSpotlight) await win.renderHeroSpotlight();
      if (win.renderHomeRows) await win.renderHomeRows();
    }
    win.scrollTo({ top: 0, behavior: 'smooth' });
  };

  win.openModalById = async function (id, episode = 1, season = 1) {
    let anime = win.animeCache.get(id);
    if (!anime) {
      if (win.STATE.isNetflixMode) {
        try {
          const item = await fetchWithRetry(cleanTMDBUrl(`movie/${id}`));
          if (item) anime = win.formatTmdbMediaItem?.(item, 'MOVIE');
        } catch (e) {}
      } else {
        const data = await fetchGQL(GQL_DEEP, { id: parseInt(id, 10) });
        anime = data?.Media;
      }
    }
    if (anime) await win.openModal(anime, season, episode, true, true);
  };

  win.openModal = async function (anime, season = 1, episode = 1, autoStart = false, skipUrlSync = false) {
    win.STATE.savedScrollY = win.scrollY;
    win.STATE.currentAnime = anime;
    const isMovie = anime.format === 'MOVIE';
    const seasonInfo = win.extractSeasonInfo ? win.extractSeasonInfo(anime) : { season: 1, cleanTitle: anime.title?.english || '' };
    win.STATE.season = isMovie ? 1 : (season || seasonInfo.season);
    win.STATE.episode = isMovie ? 1 : (episode || 1);

    const overlay = doc.getElementById('modalOverlay');
    const container = doc.getElementById('modalContainer');
    if (overlay) overlay.classList.add('active');
    if (container) container.classList.add('active');
    doc.documentElement.style.overflowY = 'hidden';

    const overviewTabBtn = doc.querySelector('.modal-tabs .tab-btn') || doc.querySelector('[onclick*="tab-overview"]');
    if (typeof win.switchTab === 'function') {
      win.switchTab('tab-overview', overviewTabBtn);
    }

    const title = anime.title?.english || anime.title?.romaji || 'Title';
    const banner = anime.bannerImage || anime.coverImage?.extraLarge || '';

    const modalNowPlayingTitle = doc.getElementById('modalNowPlayingTitle');
    const playerStreamTitle = doc.getElementById('playerStreamTitle');
    const episodesMasterSection = doc.getElementById('episodesMasterSection');

    if (isMovie) {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Feature Film`;
      if (playerStreamTitle) playerStreamTitle.innerText = `Full Movie`;
      if (episodesMasterSection) episodesMasterSection.style.display = 'none';
    } else {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • S${win.STATE.season} Ep ${win.STATE.episode}`;
      if (playerStreamTitle) playerStreamTitle.innerText = `Season ${win.STATE.season} • Episode ${win.STATE.episode}`;
      if (episodesMasterSection) episodesMasterSection.style.display = 'block';
    }

    const scoreEl = doc.getElementById('modalScore');
    const yearEl = doc.getElementById('modalYear');
    const descEl = doc.getElementById('modalDesc');
    if (scoreEl) scoreEl.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 90}% Score`;
    if (yearEl) yearEl.innerText = anime.seasonYear || anime.year || '2026';
    if (descEl) descEl.innerText = cleanText(anime.description);

    const wrap = doc.getElementById('modalPlayerWrap');
    if (wrap) {
      wrap.innerHTML = `<img src="${banner}" class="modal-backdrop-preview" alt="" onerror="this.src='${FALLBACK_POSTER}'" style="width:100%; height:100%; object-fit:cover; filter:brightness(0.7);" /><div class="player-cover-overlay" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:15; background:rgba(0,0,0,0.45); cursor:pointer;" onclick="window.executeStream(0)"><div class="modal-big-play-btn" style="width:72px; height:72px; border-radius:50%; background:#ffffff; display:flex; align-items:center; justify-content:center; box-shadow:0 0 30px rgba(255,255,255,0.4); margin-bottom:14px; cursor:pointer;" onclick="event.stopPropagation(); window.executeStream(0);"><i class="fas fa-play" style="color:#000; font-size:24px; margin-left:4px;"></i></div><h2 style="color:#fff; text-shadow:0 2px 10px rgba(0,0,0,0.9); font-weight:800; font-size:clamp(1.2rem, 2.5vw, 1.8rem); text-align:center; padding:0 20px;">${title}</h2><p style="color:var(--accent-cyan, #00d2ff); font-size:13px; font-weight:700; margin-top:6px;">Season ${win.STATE.season} • Episode ${win.STATE.episode}</p></div>`;
    }

    if (win.resolveTMDBId) await win.resolveTMDBId(seasonInfo.cleanTitle, isMovie);
    await fetchAndPopulateDeepData(anime);

    if (!isMovie && win.renderEpisodeGrid) win.renderEpisodeGrid();
    if (anime.idMal && !win.STATE.isNetflixMode && win.resolveAndPollAniSkip) win.resolveAndPollAniSkip(anime.idMal, win.STATE.episode);
    if (win.renderServerSwitcherGrid) win.renderServerSwitcherGrid();

    if (!skipUrlSync && win.Router) win.Router.set({ watch: anime.id, s: win.STATE.season, ep: win.STATE.episode, srv: win.STATE.activeServer }, true);
    if (autoStart) win.executeStream(0);
  };

  win.closeModal = function (skipUrlSync = false) {
    const modalContainer = doc.getElementById('modalContainer');
    if (!modalContainer || !modalContainer.classList.contains('active')) return;
    const modalOverlay = doc.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('active');
    modalContainer.classList.remove('active');
    const wrap = doc.getElementById('modalPlayerWrap');
    if (wrap) wrap.innerHTML = '';
    doc.documentElement.style.overflowY = 'scroll';
    win.scrollTo(0, win.STATE.savedScrollY);
    win.STATE.currentAnime = null;
    if (!skipUrlSync && win.Router) win.Router.set({ watch: null, s: null, ep: null, fs: null, srv: null });
  };

  win.executeStream = async function (retryCount = 0) {
    const wrap = doc.getElementById('modalPlayerWrap');
    if (!wrap || !win.STATE.currentAnime) return;
    const tId = win.STATE.currentTMDBId || win.CONFIG?.DEFAULT_TMDB_FALLBACK;
    const isMovie = win.STATE.currentAnime?.format === 'MOVIE';
    const activeServerConfig = win.SERVER_CONFIG[win.STATE.activeServer] || win.SERVER_CONFIG[1];
    const streamUrl = activeServerConfig.endpoint(tId, win.STATE.season, win.STATE.episode, isMovie, win.STATE.currentAnime.id);

    wrap.innerHTML = `<iframe id="streamFrame" src="${streamUrl}" allowfullscreen allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share" style="position:absolute; inset:0; width:100%; height:100%; border:none; z-index:5; background:#000;"></iframe>`;
  };

  // ==========================================================================
  // 09. MULTI-SERVER SWITCHER WITH HIGHLIGHT MATRIX
  // ==========================================================================
  win.renderServerSwitcherGrid = function () {
    const container = doc.getElementById('serverSelectionContainer') || doc.getElementById('serverButtonsContainer');
    if (!container || !win.SERVER_CONFIG) return;

    container.innerHTML = Object.values(win.SERVER_CONFIG).map(srv => {
      const isActive = srv.id === win.STATE.activeServer;
      return `
        <button 
          type="button" 
          id="server-btn-${srv.id}"
          class="server-node-btn ${isActive ? 'active-server playing' : ''}" 
          onclick="window.switchStreamServer(${srv.id})"
          style="display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; border: 1px solid ${isActive ? '#ff0844' : 'rgba(255,255,255,0.1)'}; background: ${isActive ? 'rgba(255,8,68,0.18)' : 'rgba(255,255,255,0.04)'}; color: ${isActive ? '#ff0844' : '#ffffff'}; font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.25s ease; box-shadow: ${isActive ? '0 0 16px rgba(255,8,68,0.35)' : 'none'};">
          <span class="server-status-dot ${srv.healthStatus || 'optimal'}" style="width: 8px; height: 8px; border-radius: 50%; background: ${isActive ? '#ff0844' : '#46d369'}; display: inline-block;"></span>
          <span class="server-node-name">${escapeHTML(srv.name)}</span>
        </button>
      `;
    }).join('');
  };

  win.switchStreamServer = function (serverId) {
    const targetId = parseInt(serverId, 10);
    if (!win.SERVER_CONFIG[targetId]) return;
    win.STATE.activeServer = targetId;
    localStorage.setItem(win.CONFIG.STORAGE_KEYS.ACTIVE_SERVER, targetId);

    doc.querySelectorAll('.server-node-btn').forEach(btn => {
      btn.classList.remove('active-server', 'playing');
      btn.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      btn.style.background = 'rgba(255, 255, 255, 0.04)';
      btn.style.color = '#ffffff';
      btn.style.boxShadow = 'none';
      const dot = btn.querySelector('.server-status-dot');
      if (dot) dot.style.background = '#46d369';
    });

    const activeBtn = doc.getElementById(`server-btn-${targetId}`) || doc.querySelector(`.server-node-btn[onclick*="switchStreamServer(${targetId})"]`);
    if (activeBtn) {
      activeBtn.classList.add('active-server', 'playing');
      activeBtn.style.borderColor = '#ff0844';
      activeBtn.style.background = 'rgba(255, 8, 68, 0.18)';
      activeBtn.style.color = '#ff0844';
      activeBtn.style.boxShadow = '0 0 16px rgba(255, 8, 68, 0.35)';
      const dot = activeBtn.querySelector('.server-status-dot');
      if (dot) dot.style.background = '#ff0844';
    }

    if (typeof win.showToast === 'function') {
      win.showToast(`Active server: ${win.SERVER_CONFIG[targetId].name}`);
    }
    win.executeStream(0);
  };

  // ==========================================================================
  // 10. MODAL TABS DISPATCHER & RANDOM TITLE GENERATOR
  // ==========================================================================
  win.switchTab = function (tabId, btn) {
    doc.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    doc.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const targetContent = doc.getElementById(tabId);
    if (targetContent) targetContent.classList.add('active');

    if (btn) {
      btn.classList.add('active');
    } else {
      const matchBtn = doc.querySelector(`.tab-btn[onclick*="${tabId}"]`);
      if (matchBtn) matchBtn.classList.add('active');
    }
  };

  win.playRandomAnime = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);
    if (typeof win.showToast === 'function') win.showToast('Rolling random title...');

    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('discover/movie', { sort_by: 'popularity.desc' });
        const data = await fetchWithRetry(url);
        const results = data?.results || [];
        if (results.length > 0) {
          const item = results[Math.floor(Math.random() * results.length)];
          const poster = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
          const mockMediaObj = {
            id: item.id,
            tmdbId: item.id,
            title: { romaji: item.title || item.name, english: item.title || item.name },
            description: item.overview,
            bannerImage: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : poster,
            coverImage: { extraLarge: poster, large: poster },
            format: 'MOVIE',
            episodes: 1,
            averageScore: Math.round((item.vote_average || 8) * 10),
            isLiveAction: true
          };
          win.animeCache.set(mockMediaObj.id, mockMediaObj);
          win.openModal(mockMediaObj, 1, 1, false);
          return;
        }
      } catch (e) {}
    }

    const randomPage = Math.floor(Math.random() * 20) + 1;
    const data = await fetchGQL(GQL_BASIC, { page: randomPage, perPage: 10, sort: ['POPULARITY_DESC'] });
    const list = data?.Page?.media || [];

    if (list.length > 0) {
      const selected = list[Math.floor(Math.random() * list.length)];
      win.animeCache.set(selected.id, selected);
      win.openModal(selected, 1, 1, false);
      if (typeof win.showToast === 'function') {
        win.showToast(`Selected: ${selected.title?.english || selected.title?.romaji}`);
      }
    }
  };

  // ==========================================================================
  // 11. FUZZY ANIME RESOLUTION & MULTI-SEASON EPISODE HYDRATION
  // ==========================================================================
  win.resolveTMDBId = async function (rawTitle, isMovie = false) {
    if (win.STATE.isNetflixMode && win.STATE.currentAnime?.tmdbId) {
      win.STATE.currentTMDBId = win.STATE.currentAnime.tmdbId;
      return;
    }
    if (!rawTitle) {
      win.STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
      return;
    }

    let cleanQuery = rawTitle
      .replace(/:\s*[^:]+$/, '')
      .replace(/\b(?:part|cour|season)\s*\d+/gi, '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanQuery) cleanQuery = rawTitle;

    const cacheKey = `${isMovie ? 'movie' : 'tv'}_${cleanQuery.toLowerCase()}`;
    if (win.tmdbResolvedIdCache && win.tmdbResolvedIdCache.has(cacheKey)) {
      win.STATE.currentTMDBId = win.tmdbResolvedIdCache.get(cacheKey);
      return;
    }

    try {
      const searchType = isMovie ? 'movie' : 'tv';
      const proxyUrl = cleanTMDBUrl(`search/${searchType}`, { query: cleanQuery });
      const data = await fetchWithRetry(proxyUrl);

      if (data?.results?.length > 0) {
        win.STATE.currentTMDBId = data.results[0].id;
      } else {
        const words = cleanQuery.split(' ').slice(0, 2).join(' ');
        if (words.length > 2 && words !== cleanQuery) {
          const fallbackData = await fetchWithRetry(cleanTMDBUrl(`search/${searchType}`, { query: words }));
          if (fallbackData?.results?.length > 0) {
            win.STATE.currentTMDBId = fallbackData.results[0].id;
          } else {
            win.STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
          }
        } else {
          win.STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
        }
      }
    } catch (e) {
      win.STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
    }

    if (win.tmdbResolvedIdCache) {
      win.tmdbResolvedIdCache.set(cacheKey, win.STATE.currentTMDBId);
    }
  };

  win.fetchSeriesSeasons = async function (tmdbId) {
    if (!tmdbId || tmdbId === CONFIG.DEFAULT_TMDB_FALLBACK) return [];
    if (win.seriesSeasonsCache.has(`series_seasons_${tmdbId}`)) return win.seriesSeasonsCache.get(`series_seasons_${tmdbId}`);
    try {
      const data = await fetchWithRetry(cleanTMDBUrl(`tv/${tmdbId}`));
      if (data?.seasons?.length) {
        const validSeasons = data.seasons.filter(s => s.season_number > 0).map(s => ({
          season_number: s.season_number,
          name: s.name || `Season ${s.season_number}`,
          episode_count: s.episode_count || 12,
          overview: s.overview || '',
          poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null
        }));
        win.seriesSeasonsCache.set(`series_seasons_${tmdbId}`, validSeasons);
        return validSeasons;
      }
    } catch (err) {}
    return [];
  };

  win.fetchSeasonEpisodesData = async function (tmdbId, seasonNum) {
    if (win.episodeDataCache.has(`ep_cache_${tmdbId}_s${seasonNum}`)) return win.episodeDataCache.get(`ep_cache_${tmdbId}_s${seasonNum}`);
    try {
      const data = await fetchWithRetry(cleanTMDBUrl(`tv/${tmdbId}/season/${seasonNum}`));
      if (data?.episodes?.length) {
        const parsed = data.episodes.map(ep => ({
          number: ep.episode_number,
          title: ep.name ? String(ep.name).trim() : `Episode ${ep.episode_number}`,
          overview: ep.overview ? String(ep.overview).trim() : 'Tap to stream this episode in full high-definition.',
          still: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
          runtime: ep.runtime ? `${ep.runtime}m` : null,
          airDate: ep.air_date ? ep.air_date.slice(0, 4) : ''
        }));
        win.episodeDataCache.set(`ep_cache_${tmdbId}_s${seasonNum}`, parsed);
        return parsed;
      }
    } catch (err) {}
    return null;
  };

  // ==========================================================================
  // 12. EPISODE GRID RENDERING & SELECTION DISPATCHER
  // ==========================================================================
  win.renderEpisodeGrid = async function () {
    const epList = document.getElementById('epList');
    const seasonSelect = document.getElementById('seasonSelect');
    const episodeRangeSelect = document.getElementById('episodeRangeSelect');
    const episodesTotalPill = document.getElementById('episodesTotalPill');

    if (!win.STATE.currentAnime || !epList) return;
    if (win.STATE.currentAnime.format === 'MOVIE') return;

    let seasons = [];
    if (win.STATE.currentTMDBId && win.STATE.currentTMDBId !== CONFIG.DEFAULT_TMDB_FALLBACK) {
      seasons = await win.fetchSeriesSeasons(win.STATE.currentTMDBId);
    }

    if (!seasons || seasons.length === 0) {
      seasons = [{
        season_number: win.STATE.season || 1,
        name: `Season ${win.STATE.season || 1}`,
        episode_count: win.STATE.currentAnime.episodes || 24
      }];
    }
    win.STATE.availableSeasons = seasons;

    const currentSeasonMatch = seasons.find(s => s.season_number === win.STATE.season);
    const total = currentSeasonMatch ? currentSeasonMatch.episode_count : (win.STATE.currentAnime?.episodes || 12);
    win.STATE.totalEpisodes = total;

    if (episodesTotalPill) episodesTotalPill.innerText = `Total ${total}`;

    // Populate Season dropdown with complete franchise seasons
    if (seasonSelect) {
      seasonSelect.innerHTML = seasons.map(s => `
        <option value="${s.season_number}" ${s.season_number === win.STATE.season ? 'selected' : ''}>
          ${escapeHTML(s.name)} (${s.episode_count} Eps)
        </option>
      `).join('');
    }

    // Populate Episode Range dropdown (1-50, 51-100, etc.)
    if (episodeRangeSelect) {
      episodeRangeSelect.innerHTML = '';
      const batches = Math.ceil(total / 50);
      for (let b = 0; b < batches; b++) {
        const start = b * 50 + 1;
        const end = Math.min((b + 1) * 50, total);
        const opt = document.createElement('option');
        opt.value = b;
        opt.innerText = `Episodes ${start} - ${end}`;
        if (b === win.STATE.episodeBatchOffset) opt.selected = true;
        episodeRangeSelect.appendChild(opt);
      }
    }

    const posterFallback = win.STATE.currentAnime.bannerImage || win.STATE.currentAnime.coverImage?.extraLarge || FALLBACK_POSTER;
    let richEpisodes = null;

    if (win.STATE.currentTMDBId && win.STATE.currentTMDBId !== CONFIG.DEFAULT_TMDB_FALLBACK) {
      richEpisodes = await win.fetchSeasonEpisodesData(win.STATE.currentTMDBId, win.STATE.season);
    }

    const batchStart = (win.STATE.episodeBatchOffset || 0) * 50 + 1;
    const batchEnd = Math.min(((win.STATE.episodeBatchOffset || 0) + 1) * 50, total);

    let cardsHTML = '';
    for (let ep = batchStart; ep <= batchEnd; ep++) {
      const isPlaying = ep === win.STATE.episode;
      const isWatched = win.isEpisodeWatched ? win.isEpisodeWatched(win.STATE.currentAnime.id, win.STATE.season, ep) : false;
      const epData = richEpisodes ? richEpisodes.find(x => x.number === ep) : null;

      const title = epData?.title && epData.title !== `Episode ${ep}` ? epData.title : `Episode ${ep}`;
      const stillImg = epData?.still || posterFallback;
      const airDate = epData?.airDate ? ` • ${epData.airDate}` : '';
      const runtime = epData?.runtime ? ` • ${epData.runtime}` : (win.STATE.currentAnime.duration ? ` • ${win.STATE.currentAnime.duration}m` : '');
      const overview = epData?.overview && epData.overview.trim().length > 0 
        ? epData.overview 
        : (win.STATE.currentAnime.description ? cleanText(win.STATE.currentAnime.description).slice(0, 160) + '...' : 'Tap to stream this episode in full high-definition.');

      cardsHTML += `
        <div class="ep-modern-card ${isPlaying ? 'playing' : ''} ${isWatched ? 'watched' : ''}" 
             onclick="window.switchEpisode(${ep})" 
             style="display: flex; gap: 16px; padding: 12px; border-radius: 12px; background: ${isPlaying ? 'rgba(255, 8, 68, 0.12)' : 'rgba(255, 255, 255, 0.03)'}; border: 1px solid ${isPlaying ? '#ff0844' : 'rgba(255, 255, 255, 0.08)'}; box-shadow: ${isPlaying ? '0 0 20px rgba(255, 8, 68, 0.35)' : 'none'}; margin-bottom: 12px; cursor: pointer; transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); align-items: center; box-sizing: border-box;"
             onmouseenter="if(!this.classList.contains('playing')){ this.style.background='rgba(255,255,255,0.08)'; this.style.transform='translateX(4px)'; }"
             onmouseleave="if(!this.classList.contains('playing')){ this.style.background='rgba(255,255,255,0.03)'; this.style.transform='translateX(0)'; }">
          
          <div class="ep-thumb-preview" style="position: relative; width: 140px; min-width: 140px; height: 80px; border-radius: 8px; overflow: hidden; background: #0b0b12; flex-shrink: 0;">
            <img src="${stillImg}" alt="${escapeHTML(title)}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="width: 100%; height: 100%; object-fit: cover; display: block;" />
            <div class="ep-play-overlay" style="position: absolute; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; transition: opacity 0.2s ease;">
              <i class="fas ${isPlaying ? 'fa-play' : 'fa-circle-play'}" style="color: ${isPlaying ? '#ff0844' : '#ffffff'}; font-size: 22px;"></i>
            </div>
            <span style="position: absolute; bottom: 4px; right: 6px; background: rgba(0,0,0,0.85); color: #fff; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.5px;">EP ${ep}</span>
          </div>

          <div class="ep-meta-content" style="flex: 1; min-width: 0; overflow: hidden;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
              <h4 style="font-size: 14px; font-weight: 800; color: ${isPlaying ? '#ff0844' : '#ffffff'}; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${ep}. ${escapeHTML(title)}
              </h4>
              ${isPlaying ? '<span class="ep-now-playing-badge" style="font-size: 10px; font-weight: 800; color: #ff0844; text-transform: uppercase; flex-shrink: 0; background: rgba(255,8,68,0.2); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(255,8,68,0.4); letter-spacing: 0.5px;"><i class="fas fa-wave-square" style="margin-right: 4px;"></i> Playing</span>' : ''}
            </div>
            <div style="font-size: 11px; color: var(--text-muted, #747994); margin-top: 4px; font-weight: 600;">
              Season ${win.STATE.season}${runtime}${airDate}
            </div>
            <p style="font-size: 12px; color: rgba(255,255,255,0.65); margin: 6px 0 0 0; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
              ${escapeHTML(overview)}
            </p>
          </div>
        </div>
      `;
    }

    epList.innerHTML = cardsHTML;
  };

  win.switchEpisode = function (epNum) {
    const ep = parseInt(epNum, 10);
    win.STATE.episode = ep;

    // Reset inactive card highlights
    doc.querySelectorAll('.ep-modern-card').forEach(card => {
      card.classList.remove('playing');
      card.style.background = 'rgba(255, 255, 255, 0.03)';
      card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
      card.style.boxShadow = 'none';

      const titleEl = card.querySelector('h4');
      if (titleEl) titleEl.style.color = '#ffffff';

      const icon = card.querySelector('.ep-play-overlay i');
      if (icon) {
        icon.className = 'fas fa-circle-play';
        icon.style.color = '#ffffff';
      }

      const badge = card.querySelector('.ep-now-playing-badge');
      if (badge) badge.remove();
    });

    // Apply active glowing red styles and "Playing" badge
    const targetCard = doc.querySelector(`.ep-modern-card[onclick*="switchEpisode(${ep})"]`);
    if (targetCard) {
      targetCard.classList.add('playing');
      targetCard.style.background = 'rgba(255, 8, 68, 0.12)';
      targetCard.style.borderColor = '#ff0844';
      targetCard.style.boxShadow = '0 0 20px rgba(255, 8, 68, 0.35)';

      const titleEl = targetCard.querySelector('h4');
      if (titleEl) titleEl.style.color = '#ff0844';

      const icon = targetCard.querySelector('.ep-play-overlay i');
      if (icon) {
        icon.className = 'fas fa-play';
        icon.style.color = '#ff0844';
      }

      const metaRow = targetCard.querySelector('.ep-meta-content > div');
      if (metaRow && !metaRow.querySelector('.ep-now-playing-badge')) {
        const badge = doc.createElement('span');
        badge.className = 'ep-now-playing-badge';
        badge.style.cssText = 'font-size: 10px; font-weight: 800; color: #ff0844; text-transform: uppercase; flex-shrink: 0; background: rgba(255, 8, 68, 0.2); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(255, 8, 68, 0.4); letter-spacing: 0.5px;';
        badge.innerHTML = '<i class="fas fa-wave-square" style="margin-right: 4px;"></i> Playing';
        metaRow.appendChild(badge);
      }

      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const modalNowPlayingTitle = doc.getElementById('modalNowPlayingTitle');
    const playerStreamTitle = doc.getElementById('playerStreamTitle');
    const mainTitle = win.STATE.currentAnime?.title?.english || win.STATE.currentAnime?.title?.romaji || 'Stream Master';

    if (modalNowPlayingTitle) {
      modalNowPlayingTitle.innerText = `${mainTitle} • S${win.STATE.season} Ep ${ep}`;
    }
    if (playerStreamTitle) {
      playerStreamTitle.innerText = `Season ${win.STATE.season} • Episode ${ep}`;
    }

    if (win.Router) {
      win.Router.set({ ep: ep, s: win.STATE.season }, false);
    }

    if (typeof win.showToast === 'function') {
      win.showToast(`Now Playing: Episode ${ep}`);
    }

    win.executeStream(0);
  };

  win.changeSeason = function (seasonNum) {
    win.STATE.season = parseInt(seasonNum, 10);
    win.STATE.episode = 1;
    win.STATE.episodeBatchOffset = 0;
    if (typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();
    if (typeof win.executeStream === 'function') win.executeStream(0);
  };

  win.changeEpisodeRange = function (offsetIndex) {
    win.STATE.episodeBatchOffset = parseInt(offsetIndex, 10);
    if (typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();
  };

  win.nextEpisode = function () {
    if (win.STATE.episode < win.STATE.totalEpisodes) {
      win.switchEpisode(win.STATE.episode + 1);
    }
  };

  async function fetchAndPopulateDeepData(anime) {
    const numericId = parseInt(anime.id, 10);
    const castGrid = doc.getElementById('castGrid');
    const moreGrid = doc.getElementById('moreGrid');
    const trailersGrid = doc.getElementById('trailersGrid');

    if (castGrid) castGrid.innerHTML = '';
    if (moreGrid) moreGrid.innerHTML = '';
    if (trailersGrid) trailersGrid.innerHTML = '';

    if (win.STATE.isNetflixMode || (win.STATE.currentTMDBId && win.STATE.currentTMDBId !== 533535)) {
      try {
        const isMovie = anime.format === 'MOVIE';
        const tmdbData = await fetchWithRetry(cleanTMDBUrl(`${isMovie ? 'movie' : 'tv'}/${win.STATE.currentTMDBId}`, { append_to_response: 'credits,videos,recommendations' }));

        if (tmdbData?.credits?.cast?.length && castGrid) {
          tmdbData.credits.cast.slice(0, 16).forEach(item => {
            const img = item.profile_path ? `https://image.tmdb.org/t/p/w185${item.profile_path}` : FALLBACK_POSTER;
            castGrid.innerHTML += `
              <div class="cast-card">
                <img src="${img}" alt="${escapeHTML(item.character || item.name)}" onerror="this.src='${FALLBACK_POSTER}'" />
                <div class="cast-names">
                  <h4>${escapeHTML(item.character || item.name)}</h4>
                  <p><i class="fas fa-user"></i> ${escapeHTML(item.name)}</p>
                </div>
              </div>
            `;
          });
        }

        if (tmdbData?.videos?.results?.length && trailersGrid) {
          const yt = tmdbData.videos.results.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
          if (yt?.key) {
            trailersGrid.innerHTML = `
              <div class="modal-player-wrap" style="border-radius:12px; max-width:750px; margin:0 auto; aspect-ratio:16/9;">
                <iframe src="https://www.youtube-nocookie.com/embed/${yt.key}?autoplay=0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
              </div>
            `;
          }
        }

        if (tmdbData?.recommendations?.results?.length && moreGrid) {
          const recs = tmdbData.recommendations.results.filter(r => !(r.genre_ids || []).includes(16));
          recs.slice(0, 12).forEach(item => {
            const disp = item.title || item.name;
            const img = item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : FALLBACK_POSTER;
            moreGrid.innerHTML += `
              <div class="anime-card card ui-card-locked" style="cursor:pointer;" onclick="window.handleAnimeClick(${item.id})">
                <img src="${img}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="border-radius:8px; width:100%; aspect-ratio:2/3; object-fit:cover;" />
                <div class="card-overlay"><div class="card-title">${escapeHTML(disp)}</div></div>
              </div>
            `;
          });
        }
      } catch (e) {}
    } else if (!isNaN(numericId) && numericId > 0 && numericId < 300000) {
      try {
        const aniData = await fetchGQL(GQL_DEEP, { id: numericId });
        const media = aniData?.Media;
        const edges = media?.characters?.edges || [];

        if (edges.length > 0 && castGrid) {
          edges.slice(0, 16).forEach(edge => {
            const charImg = edge.node?.image?.large || FALLBACK_POSTER;
            castGrid.innerHTML += `
              <div class="cast-card">
                <img src="${charImg}" alt="${escapeHTML(edge.node?.name?.full)}" onerror="this.src='${FALLBACK_POSTER}'" />
                <div class="cast-names">
                  <h4>${escapeHTML(edge.node?.name?.full)}</h4>
                  <p><i class="fas fa-microphone"></i> ${escapeHTML(edge.voiceActors?.[0]?.name?.full || 'Japanese')}</p>
                </div>
              </div>
            `;
          });
        }

        if (media?.trailer?.site?.toLowerCase() === 'youtube' && media?.trailer?.id && trailersGrid) {
          trailersGrid.innerHTML = `
            <div class="modal-player-wrap" style="border-radius:12px; max-width:750px; margin:0 auto; aspect-ratio:16/9;">
              <iframe src="https://www.youtube-nocookie.com/embed/${media.trailer.id}?autoplay=0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
            </div>
          `;
        }

        const nodes = media?.recommendations?.nodes || [];
        if (nodes.length > 0 && moreGrid) {
          nodes.slice(0, 12).forEach(recNode => {
            const rec = recNode.mediaRecommendation;
            if (!rec) return;
            win.animeCache.set(rec.id, rec);
            const cover = rec.coverImage?.extraLarge || rec.coverImage?.large || FALLBACK_POSTER;
            moreGrid.innerHTML += `
              <div class="anime-card card ui-card-locked" style="cursor:pointer;" onclick="window.handleAnimeClick(${rec.id})">
                <img src="${cover}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="border-radius:8px; width:100%; aspect-ratio:2/3; object-fit:cover;" />
                <div class="card-overlay"><div class="card-title">${escapeHTML(rec.title?.english || rec.title?.romaji)}</div></div>
              </div>
            `;
          });
        }
      } catch (err) {}
    }
  }

  // ==========================================================================
  // 13. REAL-TIME SEARCH AUTOCOMPLETE
  // ==========================================================================
  win.toggleSearch = function () {
    const wrapper = doc.getElementById('searchWrapper');
    const input = doc.getElementById('searchInput');
    if (!wrapper || !input) return;
    wrapper.classList.toggle('open');
    if (wrapper.classList.contains('open')) {
      input.focus();
    } else {
      win.clearSearch();
    }
  };

  win.clearSearch = function () {
    const input = doc.getElementById('searchInput');
    if (input) input.value = '';
    const drop = doc.getElementById('searchDropdown');
    if (drop) drop.classList.remove('visible');
    const clearBtn = doc.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    if (win.Router) win.Router.set({ q: null });
  };

  doc.getElementById('searchInput')?.addEventListener('input', (e) => {
    clearTimeout(win.STATE.searchDebounce);
    const q = e.target.value.trim();
    const drop = doc.getElementById('searchDropdown');
    const clearBtn = doc.getElementById('searchClearBtn');

    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

    if (!q) {
      if (drop) drop.classList.remove('visible');
      if (win.Router) win.Router.set({ q: null });
      return;
    }

    if (win.Router && win.Router.get('q') !== q) {
      win.Router.set({ q }, false);
    }

    win.STATE.searchDebounce = setTimeout(async () => {
      if (win.STATE.isNetflixMode) {
        try {
          const searchUrl = cleanTMDBUrl('search/multi', { query: q });
          const data = await fetchWithRetry(searchUrl);
          drop.innerHTML = '';
          const results = (data?.results || []).filter(item => {
            const isMedia = item.media_type === 'movie' || item.media_type === 'tv';
            const notAnime = !(item.genre_ids || []).includes(16);
            return isMedia && notAnime;
          }).slice(0, 6);

          if (!results.length) {
            drop.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center;">No live-action titles found for "${escapeHTML(q)}"</div>`;
            drop.classList.add('visible');
            return;
          }

          results.forEach(item => {
            const title = item.title || item.name;
            const img = item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : FALLBACK_POSTER;
            const isMovie = item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));
            const mockMediaObj = {
              id: item.id,
              tmdbId: item.id,
              title: { romaji: title, english: title },
              coverImage: { extraLarge: img, large: img },
              format: isMovie ? 'MOVIE' : 'TV',
              episodes: isMovie ? 1 : 16,
              averageScore: Math.round((item.vote_average || 8) * 10),
              isLiveAction: true
            };
            win.animeCache.set(item.id, mockMediaObj);

            const el = doc.createElement('div');
            el.className = 'search-item';
            el.onclick = () => {
              win.openModal(mockMediaObj);
              win.clearSearch();
            };
            el.innerHTML = `
              <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" />
              <div class="search-info">
                <div class="search-title">${escapeHTML(title)}</div>
                <div class="search-meta">
                  <span>${(item.release_date || item.first_air_date || '2026').split('-')[0]}</span> &bull; 
                  <span>${item.media_type.toUpperCase()}</span> &bull; 
                  <span style="color:#46d369;"><i class="fas fa-star"></i> ${Math.round((item.vote_average || 8) * 10)}%</span>
                </div>
              </div>
            `;
            drop.appendChild(el);
          });
          drop.classList.add('visible');
          return;
        } catch (e) {}
      }

      const data = await fetchGQL(GQL_BASIC, { search: q, perPage: 6 });
      if (!drop) return;
      drop.innerHTML = '';

      if (!data || !data.Page?.media?.length) {
        drop.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center;">No anime found for "${escapeHTML(q)}"</div>`;
        drop.classList.add('visible');
        return;
      }

      data.Page.media.forEach(anime => {
        win.animeCache.set(anime.id, anime);
        const title = anime.title?.english || anime.title?.romaji || 'Anime';
        const img = anime.coverImage?.large || anime.coverImage?.extraLarge || FALLBACK_POSTER;
        const item = doc.createElement('div');
        item.className = 'search-item';
        item.onclick = () => {
          win.openModal(anime);
          win.clearSearch();
        };
        item.innerHTML = `
          <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" />
          <div class="search-info">
            <div class="search-title">${escapeHTML(title)}</div>
            <div class="search-meta">
              <span>${anime.seasonYear || '2026'}</span> &bull; 
              <span>${anime.format || 'TV'}</span> &bull; 
              <span style="color:#46d369;"><i class="fas fa-star"></i> ${anime.averageScore || '90'}%</span>
            </div>
          </div>
        `;
        drop.appendChild(item);
      });

      drop.classList.add('visible');
    }, 300);
  });

  // ==========================================================================
  // 14. SCHEDULER & REVERSE TRACE.MOE ENGINE
  // ==========================================================================
  const DAYS_MAP = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  win.openScheduleModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('scheduleModal');
    const overlay = doc.getElementById('scheduleModalOverlay');
    if (!modal || !overlay) return;

    modal.style.display = 'flex';
    overlay.classList.add('active');
    doc.documentElement.style.overflowY = 'hidden';

    if (!skipUrlSync && win.Router) win.Router.set({ modal: 'schedule' }, true);

    const todayIndex = new Date().getDay();
    renderScheduleTabs(todayIndex);
    loadJikanScheduleDay(DAYS_MAP[todayIndex]);
  };

  win.closeScheduleModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('scheduleModal');
    const overlay = doc.getElementById('scheduleModalOverlay');
    if (modal && overlay && modal.style.display === 'flex') {
      modal.style.display = 'none';
      overlay.classList.remove('active');
      doc.documentElement.style.overflowY = 'scroll';
      if (!skipUrlSync && win.Router) win.Router.set({ modal: null });
    }
  };

  function renderScheduleTabs(activeIdx) {
    const tabs = doc.getElementById('scheduleDayTabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    dayNames.forEach((name, idx) => {
      const btn = doc.createElement('button');
      btn.className = `modal-pill-btn ${idx === activeIdx ? 'next-ep-btn' : ''}`;
      btn.innerText = name + (idx === new Date().getDay() ? ' (Today)' : '');
      btn.onclick = () => {
        doc.querySelectorAll('#scheduleDayTabs button').forEach(b => b.classList.remove('next-ep-btn'));
        btn.classList.add('next-ep-btn');
        loadJikanScheduleDay(DAYS_MAP[idx]);
      };
      tabs.appendChild(btn);
    });
  }

  async function loadJikanScheduleDay(dayName) {
    const container = doc.getElementById('scheduleItemsContainer');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Fetching broadcast schedules...</div>';

    try {
      const data = await fetchWithRetry(`${win.CONFIG?.APIS?.JIKAN || 'https://api.jikan.moe/v4'}/schedules?filter=${dayName}&limit=20`);
      const items = data?.data || [];
      container.innerHTML = '';

      if (!items.length) {
        container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">No broadcast data found for this day.</div>';
        return;
      }

      items.forEach(anime => {
        const title = anime.title_english || anime.title;
        const img = anime.images?.webp?.image_url || anime.images?.jpg?.image_url || FALLBACK_POSTER;
        const time = anime.broadcast?.time || 'TBA';

        const row = doc.createElement('div');
        row.className = 'search-item';
        row.style.borderRadius = '12px';
        row.onclick = () => {
          win.closeScheduleModal();
          searchAndOpenByTitle(title);
        };
        row.innerHTML = `
          <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" />
          <div class="search-info">
            <div class="search-title">${escapeHTML(title)}</div>
            <div class="search-meta">
              <span style="color:var(--accent-cyan, #00d2ff);"><i class="fas fa-clock"></i> Broadcast: ${time} (JST)</span> &bull; 
              <span style="color:var(--accent-emerald, #46d369);"><i class="fas fa-star"></i> ${anime.score ? Math.round(anime.score * 10) + '%' : 'N/A'}</span>
            </div>
          </div>
        `;
        container.appendChild(row);
      });
    } catch (e) {
      container.innerHTML = `
        <div style="text-align:center; padding:30px; color:var(--accent-red,#e50914);">
          <p>Jikan API Gateway is busy.</p>
          <button class="btn btn-info" style="margin-top:12px; font-size:12px; padding:6px 14px;" onclick="loadJikanScheduleDay('${dayName}')">
            <i class="fas fa-rotate-right"></i> Retry
          </button>
        </div>
      `;
    }
  }

  async function searchAndOpenByTitle(title) {
    const data = await fetchGQL(GQL_BASIC, { search: title, perPage: 1 });
    const anime = data?.Page?.media?.[0];
    if (anime) {
      win.openModal(anime, 1, 1, false);
    } else {
      if (typeof win.showToast === 'function') {
        win.showToast(`Could not locate "${title}" in library.`);
      }
    }
  }
  win.searchAndOpenByTitle = searchAndOpenByTitle;

  win.openTraceMoeModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('traceMoeModal');
    const overlay = doc.getElementById('traceMoeOverlay');
    if (!modal || !overlay) return;

    modal.style.display = 'flex';
    overlay.classList.add('active');
    doc.documentElement.style.overflowY = 'hidden';

    if (!skipUrlSync && win.Router) win.Router.set({ modal: 'tracemoe' }, true);
    win.addEventListener('paste', handleTraceClipboardPaste);
  };

  win.closeTraceMoeModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('traceMoeModal');
    const overlay = doc.getElementById('traceMoeOverlay');
    if (modal && overlay && modal.style.display === 'flex') {
      modal.style.display = 'none';
      overlay.classList.remove('active');
      doc.documentElement.style.overflowY = 'scroll';
      if (!skipUrlSync && win.Router) win.Router.set({ modal: null });
    }
    win.removeEventListener('paste', handleTraceClipboardPaste);
  };

  function handleTraceClipboardPaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        executeTraceSearch(file);
        break;
      }
    }
  }

  win.handleTraceFileUpload = function (event) {
    const file = event.target.files?.[0];
    if (file) executeTraceSearch(file);
  };

  async function executeTraceSearch(fileBlob) {
    const resultsArea = doc.getElementById('traceResultsArea');
    if (!resultsArea) return;
    resultsArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--accent-cyan,#00d2ff);"><i class="fas fa-spinner fa-spin"></i> Analyzing frame...</div>';

    const formData = new FormData();
    formData.append('image', fileBlob);

    try {
      const res = await fetch('https://api.trace.moe/search?anilistInfo', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      const matches = data?.result || [];
      resultsArea.innerHTML = '';

      if (!matches.length) {
        resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-muted);">No match found.</div>';
        return;
      }

      const best = matches[0];
      const similarity = Math.round(best.similarity * 100);
      const title = best.anilist?.title?.english || best.anilist?.title?.romaji || best.filename;
      const ep = best.episode || 1;
      const timestamp = Math.floor(best.from || 0);
      const timeMins = Math.floor(timestamp / 60) + ':' + ('0' + (timestamp % 60)).slice(-2);

      resultsArea.innerHTML = `
        <div style="background:rgba(255,255,255,0.05); border-radius:12px; padding:12px; border:1px solid rgba(255,255,255,0.1);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span style="font-weight:800; color:#fff;">${escapeHTML(title)}</span>
            <span style="color:var(--accent-emerald, #46d369); font-weight:800;">${similarity}% Match</span>
          </div>
          <video src="${best.video}" autoplay loop muted style="width:100%; border-radius:8px; margin-bottom:8px; aspect-ratio:16/9;"></video>
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">Episode ${ep} &bull; Matched at ${timeMins}</div>
          <button class="btn btn-play" style="width:100%; font-size:13px; padding:8px 0;" onclick="window.closeTraceMoeModal(); window.openModalById(${best.anilist?.id || best.anilist}, ${ep})">
            <i class="fas fa-play"></i> Watch Episode ${ep} Now
          </button>
        </div>
      `;
    } catch (err) {
      resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--accent-red,#e50914);">Search failed.</div>';
    }
  }

  // ==========================================================================
  // 15. ANISKIP SKIP CHAPTER TELEMETRY
  // ==========================================================================
  async function resolveAndPollAniSkip(malId, episode) {
    clearTimeout(aniSkipPollTimer);
    const skipBtn = doc.getElementById('aniSkipIntroBtn');
    if (skipBtn) skipBtn.style.display = 'none';
    aniSkipIntervals = [];

    if (!malId || win.STATE.isNetflixMode) return;

    try {
      const res = await fetch(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&types[]=recap&episodeLength=1440`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.found && data?.results?.length) {
        aniSkipIntervals = data.results;
      }
    } catch (e) {}
  }
  win.resolveAndPollAniSkip = resolveAndPollAniSkip;

  function handlePlayerTimeUpdate(currentTimeSeconds) {
    const skipBtn = doc.getElementById('aniSkipIntroBtn');
    const label = doc.getElementById('aniSkipLabel');
    if (!skipBtn || !aniSkipIntervals.length) return;

    const activeInterval = aniSkipIntervals.find(item =>
      currentTimeSeconds >= item.interval.startTime && currentTimeSeconds <= item.interval.endTime
    );

    if (activeInterval) {
      const type = activeInterval.skipType.toUpperCase();
      if (label) label.innerText = `Skip ${type === 'OP' ? 'Opening' : type === 'ED' ? 'Ending' : 'Recap'}`;
      skipBtn.style.display = 'inline-flex';
      skipBtn.dataset.targetTime = activeInterval.interval.endTime;
    } else {
      skipBtn.style.display = 'none';
    }
  }

  win.triggerAniSkipJump = function () {
    const skipBtn = doc.getElementById('aniSkipIntroBtn');
    const targetTime = parseFloat(skipBtn?.dataset?.targetTime);
    if (!isNaN(targetTime)) {
      const video = doc.getElementById('nativeStreamVideo');
      if (video) {
        video.currentTime = targetTime;
      } else {
        const iframe = doc.getElementById('streamFrame');
        if (iframe) {
          iframe.contentWindow?.postMessage({ type: 'SEEK_TO', time: targetTime }, '*');
        }
      }

      skipBtn.style.display = 'none';
      if (typeof win.showToast === 'function') {
        win.showToast(`Skipped to ${Math.floor(targetTime)}s`);
      }

      if (win.p2pParty) {
        win.p2pParty.sendSeek(targetTime);
      }
    }
  };

  // ==========================================================================
  // 16. AUDIO GAIN BOOSTER (UP TO 250%)
  // ==========================================================================
  win.toggleAudioVolumeBooster = function () {
    const levels = [1.0, 1.5, 2.0, 2.5];
    const nextIdx = (levels.indexOf(currentAudioGainLevel) + 1) % levels.length;
    currentAudioGainLevel = levels[nextIdx];

    const label = doc.getElementById('audioBoosterLabel');
    if (label) label.innerText = `${Math.round(currentAudioGainLevel * 100)}% Volume`;

    if (win.streamEngine && typeof win.streamEngine.setVolumeBoost === 'function') {
      win.streamEngine.setVolumeBoost(currentAudioGainLevel);
    } else {
      try {
        if (!audioCtx) {
          audioCtx = new (win.AudioContext || win.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        if (gainNode) {
          gainNode.gain.setValueAtTime(currentAudioGainLevel, audioCtx.currentTime);
        }
      } catch (e) {}
    }

    if (typeof win.showToast === 'function') {
      win.showToast(`Audio Boost: ${Math.round(currentAudioGainLevel * 100)}%`);
    }

    if (win.p2pParty && win.p2pParty.isHost) {
      win.p2pParty.broadcastAudioBoost(currentAudioGainLevel);
    }
  };

  // ==========================================================================
  // 17. DEEP LINKING & EPISODE SHARER
  // ==========================================================================
  win.shareCurrentTitleLink = function () {
    if (win.Router && win.STATE.currentAnime) {
      win.Router.set({ watch: win.STATE.currentAnime.id, s: win.STATE.season, ep: win.STATE.episode }, false);
    }
    navigator.clipboard.writeText(win.location.href);
    if (typeof win.showToast === 'function') {
      win.showToast('Direct title link copied!');
    }
  };

  win.shareDeepLinkEpisode = function () {
    if (win.Router && win.STATE.currentAnime) {
      win.Router.set({ watch: win.STATE.currentAnime.id, s: win.STATE.season, ep: win.STATE.episode }, false);
    }
    navigator.clipboard.writeText(win.location.href);
    if (typeof win.showToast === 'function') {
      win.showToast(`Episode ${win.STATE.episode} link copied!`);
    }
  };

  // ==========================================================================
  // 18. SYNCHRONIZED PLAYER POSTMESSAGE EVENT LISTENER
  // ==========================================================================
  win.addEventListener('message', ({ data }) => {
    if (data && data.type === 'PLAYER_EVENT') {
      const ev = data.data;
      if (ev && typeof ev.currentTime === 'number') {
        handlePlayerTimeUpdate(ev.currentTime);

        if (win.STATE.currentAnime) {
          const isFin = Boolean(ev.duration > 0 && ev.currentTime / ev.duration > 0.90);
          win.recordWatchedEpisode(
            win.STATE.currentAnime.id,
            win.STATE.season,
            win.STATE.episode,
            ev.currentTime,
            ev.duration || 0,
            isFin
          );
        }

        if (win.p2pParty) {
          win.p2pParty.lastKnownTime = ev.currentTime;

          if (ev.state === 'playing') {
            win.p2pParty.notifyBufferStatus(false);
            win.p2pParty.sendPlay(ev.currentTime);
          } else if (ev.state === 'paused') {
            win.p2pParty.sendPause(ev.currentTime);
          } else if (ev.state === 'buffering') {
            win.p2pParty.notifyBufferStatus(true);
          }
        }
      }
    }
  });

})();
