/**
 * ============================================================================
 * AnimeDrift — ADVANCED STREAMING UI (ENTERPRISE MASTER SYSTEM)
 * File: streaming-ui.js
 * Version: 65.0.0 Reliable Architecture & High-Density UI Matrix
 *
 * Core Fixes:
 *  - Fixed Search Takeover: clearSearch now removes .open and blurs the input.
 *  - Fixed Missing Synopsis/Genres: Directly populates modal metadata elements.
 *  - Native AniList Airing Schedules: Replaced discontinued Jikan v4 API.
 *  - Orthogonal Sorting: Eliminates duplicate shows across category rails.
 *  - High-Speed Deeplink Execution: Parallel non-blocking player pipeline.
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
  const GQL_MIN_INTERVAL_MS = 250;
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
      console.warn('[Storage Nexus] Dexie schema warning:', e);
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
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  win.cleanText = cleanText;

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
      (anime?.poster_path ? `https://image.tmdb.org/t/p/w500${anime.poster_path}` : '') ||
      FALLBACK_POSTER
    );
  }

  function backdropOf(anime) {
    return (
      anime?.bannerImage ||
      anime?.banner ||
      anime?.backdrop ||
      (anime?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${anime.backdrop_path}` : '') ||
      posterOf(anime)
    );
  }

  // ==========================================================================
  // 04. VERCEL SERVERLESS PROXY URL BUILDER
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

    if (queryStr) {
      const embedded = new URLSearchParams(queryStr);
      embedded.forEach((val, key) => {
        url.searchParams.set(key, val);
      });
    }

    if (path.startsWith('discover/')) {
      if (!url.searchParams.has('without_genres')) url.searchParams.set('without_genres', '16');
      if (!url.searchParams.has('include_adult')) url.searchParams.set('include_adult', 'false');
      if (!url.searchParams.has('include_video')) url.searchParams.set('include_video', 'false');
      if (!url.searchParams.has('language')) url.searchParams.set('language', 'en-US');

      if (
        !url.searchParams.has('vote_count.gte') &&
        !url.searchParams.has('with_original_language') &&
        !url.searchParams.has('with_origin_country')
      ) {
        url.searchParams.set('vote_count.gte', '15');
      }
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
    }).catch(() => null);
    return gqlQueue;
  }

  async function fetchWithRetry(url, options = {}, retries = 2, delay = 1000) {
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
    query ($page: Int, $perPage: Int, $sort: [MediaSort], $genre: String, $search: String, $format: MediaFormat) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: $sort, genre: $genre, search: $search, format: $format, isAdult: false) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large medium color }
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
        title { romaji english native }
        description(asHtml: false)
        genres
        status
        seasonYear
        episodes
        duration
        averageScore
        trailer { id site }
        studios(isMain: true) { nodes { name } }
        streamingEpisodes { title thumbnail url site }
        characters(sort: [ROLE, RELEVANCE_DESC], perPage: 14) {
          edges {
            node { id name { full } image { large } }
            voiceActors(language: JAPANESE) { name { full } image { large } }
          }
        }
        recommendations(sort: [RATING_DESC], perPage: 8) {
          nodes {
            mediaRecommendation {
              id
              idMal
              title { romaji english }
              coverImage { extraLarge large }
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
  // 05. CACHED IMAGE BLOB & WATCH TELEMETRY
  // ==========================================================================
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
  // 06. CATEGORY SYNCHRONIZER
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
  // 07. HERO SPOTLIGHT & BILLBOARD ENGINE
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
            genres: win.mapTmdbGenreIds ? win.mapTmdbGenreIds(item.genre_ids || []) : ['Live-Action'],
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
        console.warn('[Netflix Spotlight Failover]:', e);
      }
    }

    // Default Anime Spotlight
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
      }
    } catch (err) {
      console.warn('[Spotlight Query Error]:', err);
    }
  };

  // ==========================================================================
  // 08. STAGGERED CATALOG RAILS & DISCRETE REGIONAL FEEDS
  // ==========================================================================
  win.renderHomeRows = async function () {
    const content = doc.getElementById('contentRows');
    if (!content) return;
    content.innerHTML = '';

    if (win.STATE.isNetflixMode) {
      if (typeof win.showToast === 'function') win.showToast('Loading Netflix Live-Action Universe...');

      await renderTMDBRow('Trending Movies Worldwide', 'discover/movie?sort_by=popularity.desc&vote_count.gte=100&_rail=global_movies', '<i class="fas fa-film"></i>', 'MOVIE');
      await renderTMDBRow('Hindi Blockbuster Movies', 'discover/movie?with_origin_country=IN&with_original_language=hi&without_genres=16&sort_by=popularity.desc&_rail=hindi_movies', '<i class="fas fa-language"></i>', 'MOVIE');
      await renderTMDBRow('Hindi Web Series & Dramas', 'discover/tv?with_origin_country=IN&with_original_language=hi&without_genres=16&sort_by=popularity.desc&_rail=hindi_series', '<i class="fas fa-tv"></i>', 'TV');
      await renderTMDBRow('South Indian Cinema (Telugu Hits)', 'discover/movie?with_origin_country=IN&with_original_language=te&without_genres=16&sort_by=popularity.desc&_rail=telugu_movies', '<i class="fas fa-fire"></i>', 'MOVIE');
      await renderTMDBRow('Trending Worldwide TV Shows', 'discover/tv?sort_by=popularity.desc&vote_count.gte=100&_rail=global_tv', '<i class="fas fa-tv"></i>', 'TV');
      await renderTMDBRow('Explosive Action & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc&vote_count.gte=100&_rail=action_movies', '<i class="fas fa-bolt"></i>', 'MOVIE');
      await renderTMDBRow('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc&vote_count.gte=50&_rail=action_tv', '<i class="fas fa-shield"></i>', 'TV');
      await renderTMDBRow('Sci-Fi & High Concept Cinema', 'discover/movie?with_genres=878&sort_by=popularity.desc&vote_count.gte=50&_rail=scifi_movies', '<i class="fas fa-microchip"></i>', 'MOVIE');
      await renderTMDBRow('Gripping Crime & Mystery Thrillers', 'discover/movie?with_genres=53&sort_by=popularity.desc&vote_count.gte=50&_rail=thriller_movies', '<i class="fas fa-mask"></i>', 'MOVIE');
      await renderTMDBRow('Romance & Heartwarming Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc&vote_count.gte=50&_rail=romance_movies', '<i class="fas fa-heart"></i>', 'MOVIE');
      return;
    }

    // Anime Universe: Varied sorts to prevent duplicate cards across categories
    await renderRow('Trending Masterpieces', { page: 1, perPage: 14, sort: ['TRENDING_DESC'] }, false);
    await renderRow('Top 10 Global Anime Today', { page: 1, perPage: 10, sort: ['POPULARITY_DESC'] }, true);
    await renderHindiDubRow();
    await renderRow('Action & Shonen Hits', { page: 1, perPage: 14, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
    await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 14, genre: 'Fantasy', sort: ['SCORE_DESC'] }, false);
    await renderRow('Romance & Slice of Life', { page: 1, perPage: 14, genre: 'Romance', sort: ['FAVOURITES_DESC'] }, false);
  };

  async function renderRow(title, vars, isTop10 = false) {
    try {
      const data = await fetchGQL(GQL_BASIC, vars);
      if (!data?.Page?.media?.length) return;
      buildUnifiedCarouselDOM(title, data.Page.media, isTop10, false);
    } catch (e) {}
  }
  win.renderRow = renderRow;

  async function renderHindiDubRow() {
    const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 14, sort: ['FAVOURITES_DESC'] });
    if (data?.Page?.media?.length) {
      buildUnifiedCarouselDOM('<i class="fas fa-language" style="color:var(--accent-red,#ff0844);"></i> Premium Hindi Dubbed Anime', data.Page.media, false, true);
    }
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
        <span style="color:var(--accent-red,#ff0844); margin-right:8px;">${iconHtml}</span>${title}
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
        title: { english: dispTitle, romaji: dispTitle, native: item.original_title || item.original_name || dispTitle },
        description: item.overview || item.description || '',
        coverImage: { extraLarge: poster, large: poster },
        format: format,
        genres: item.genres || (item.genre_ids && win.mapTmdbGenreIds ? win.mapTmdbGenreIds(item.genre_ids) : []),
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
        <div class="card-badge" style="position: absolute !important; top: 8px !important; right: 8px !important; background: ${isHindi ? '#ff0844' : 'rgba(0,0,0,0.78)'} !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px !important; border-radius: 6px !important; z-index: 3 !important;">${isHindi ? 'HINDI DUB' : format}</div>
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
    slider.addEventListener('mousedown', (e) => {
      isDown = true;
      slider.dataset.isDragging = 'false';
      startX = e.pageX - slider.offsetLeft;
      scrollLeft = slider.scrollLeft;
      slider.style.cursor = 'grabbing';
    });
    slider.addEventListener('mouseleave', () => {
      isDown = false;
      slider.style.cursor = 'default';
      setTimeout(() => { slider.dataset.isDragging = 'false'; }, 50);
    });
    slider.addEventListener('mouseup', () => {
      isDown = false;
      slider.style.cursor = 'default';
      setTimeout(() => { slider.dataset.isDragging = 'false'; }, 50);
    });
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

  // ==========================================================================
  // 09. CATEGORY NAVIGATION DISPATCHERS
  // ==========================================================================
  win.applyQuickFilter = async function (filterType, element) {
    const norm = String(filterType || 'ALL').toUpperCase();

    const chips = doc.querySelectorAll('.chips-container .chip');
    chips.forEach(c => c.classList.remove('active'));

    if (element && element.nodeType === 1) {
      element.classList.add('active');
    } else {
      const match = doc.querySelector(`.chip[data-filter="${norm}"]`) ||
                    Array.from(chips).find(c => c.innerText.toUpperCase().includes(norm));
      if (match) match.classList.add('active');
    }

    win.syncCategoryState(norm);

    if (win.STATE.isNetflixMode) {
      switch (norm) {
        case 'ALL':
          await win.renderHomeRows();
          break;
        case 'MOVIES':
        case 'MOVIE':
          await win.navigateGenre('Movies', 'Feature Films');
          break;
        case 'TOP_AIRING':
        case 'TV':
        case 'SHOWS':
          await win.navigateGenre('TV', 'TV Series');
          break;
        case 'HINDI':
          await win.loadHindiDubbed();
          break;
        case 'ACTION':
          await win.navigateGenre('Action', 'Action');
          break;
        case 'THRILLER':
        case 'CRIME':
          await win.navigateGenre('Thriller', 'Thriller');
          break;
        case 'SCI_FI':
        case 'SCIFI': {
          const c = doc.getElementById('contentRows');
          if (c) c.innerHTML = '';
          await renderTMDBRow('Sci-Fi Feature Cinema', 'discover/movie?with_genres=878&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_scifi_m', '<i class="fas fa-microchip"></i>', 'MOVIE');
          await renderTMDBRow('Futuristic TV Shows', 'discover/tv?with_genres=10765&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_scifi_tv', '<i class="fas fa-tv"></i>', 'TV');
          win.scrollTo({ top: 350, behavior: 'smooth' });
          break;
        }
        case 'ROMANCE':
          await win.navigateGenre('Romance', 'Romance');
          break;
        default:
          await win.renderHomeRows();
          break;
      }
      return;
    }

    switch (norm) {
      case 'ALL':
        await win.renderHomeRows();
        win.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'HINDI':
        await win.loadHindiDubbed();
        break;
      case 'TOP_AIRING':
      case 'AIRING': {
        const c = doc.getElementById('contentRows');
        if (c) c.innerHTML = '';
        await renderRow('Top Airing Worldwide', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);
        win.scrollTo({ top: 350, behavior: 'smooth' });
        break;
      }
      case 'MOVIES':
      case 'MOVIE':
        await win.navigateGenre('Movie', 'Top Anime Movies');
        break;
      case 'ACTION':
        await win.navigateGenre('Action', 'Action Hits');
        break;
      case 'SECONDARY':
      case 'FANTASY':
        await win.navigateGenre('Fantasy', 'Isekai & Fantasy');
        break;
      case 'SCI_FI':
      case 'SCIFI':
        await win.navigateGenre('Sci-Fi', 'Sci-Fi & Cyberpunk');
        break;
      case 'ROMANCE':
        await win.navigateGenre('Romance', 'Romance & Drama');
        break;
      default:
        await win.renderHomeRows();
        break;
    }
  };

  win.navigateGenre = async function (genre, label) {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);

    const key = genre ? genre.toUpperCase() : 'ALL';
    win.syncCategoryState(key);

    const contentRows = doc.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';

    if (!genre || genre === 'Home') {
      await win.renderHomeRows();
      win.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (typeof win.showToast === 'function') win.showToast(`Loading ${label || genre}...`);

    if (win.STATE.isNetflixMode) {
      if (genre === 'Movies' || genre === 'Movie') {
        await renderTMDBRow('Trending Feature Films', 'discover/movie?sort_by=popularity.desc&vote_count.gte=100&_rail=filter_movies', '<i class="fas fa-film"></i>', 'MOVIE');
        await renderTMDBRow('Top Rated Blockbusters', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=300&_rail=filter_top_movies', '<i class="fas fa-star"></i>', 'MOVIE');
      } else if (genre === 'TV' || genre === 'TV Shows') {
        await renderTMDBRow('Top Binge TV Series', 'discover/tv?sort_by=popularity.desc&vote_count.gte=50&_rail=filter_tv', '<i class="fas fa-tv"></i>', 'TV');
        await renderTMDBRow('Critically Acclaimed Series', 'discover/tv?sort_by=vote_average.desc&vote_count.gte=200&_rail=filter_top_tv', '<i class="fas fa-star"></i>', 'TV');
      } else if (genre === 'Action') {
        await renderTMDBRow('Action Movies & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_action_m', '<i class="fas fa-bolt"></i>', 'MOVIE');
        await renderTMDBRow('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_action_tv', '<i class="fas fa-shield"></i>', 'TV');
      } else if (genre === 'Thriller' || genre === 'Crime') {
        await renderTMDBRow('Gripping Crime & Mystery Films', 'discover/movie?with_genres=53&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_crime_m', '<i class="fas fa-mask"></i>', 'MOVIE');
        await renderTMDBRow('Psychological Thriller Series', 'discover/tv?with_genres=80&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_crime_tv', '<i class="fas fa-user-secret"></i>', 'TV');
      } else if (genre === 'Sci-Fi') {
        await renderTMDBRow('Sci-Fi Feature Cinema', 'discover/movie?with_genres=878&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_scifi_m', '<i class="fas fa-microchip"></i>', 'MOVIE');
        await renderTMDBRow('Futuristic TV Shows', 'discover/tv?with_genres=10765&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_scifi_tv', '<i class="fas fa-tv"></i>', 'TV');
      } else if (genre === 'Romance') {
        await renderTMDBRow('Romantic Comedies & Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_romance_m', '<i class="fas fa-heart"></i>', 'MOVIE');
        await renderTMDBRow('Romantic TV Series', 'discover/tv?with_genres=10766&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_romance_tv', '<i class="fas fa-tv"></i>', 'TV');
      } else if (genre === 'Hindi') {
        await win.loadHindiDubbed();
      }
    } else {
      if (genre === 'Movie' || genre === 'Movies') {
        await renderRow('Anime Feature Films', { page: 1, perPage: 24, format: 'MOVIE', sort: ['POPULARITY_DESC'] }, false);
        await renderRow('Top Rated Movies', { page: 1, perPage: 24, format: 'MOVIE', sort: ['SCORE_DESC'] }, false);
      } else if (genre === 'Top') {
        await renderRow('Top Airing Simulcasts', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);
        await renderRow('All-Time Popular', { page: 1, perPage: 24, sort: ['POPULARITY_DESC'] }, false);
      } else if (genre === 'Action') {
        await renderRow('Action & Shonen Hits', { page: 1, perPage: 24, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
        await renderRow('Critically Acclaimed Action', { page: 1, perPage: 24, genre: 'Action', sort: ['SCORE_DESC'] }, false);
      } else if (genre === 'Fantasy') {
        await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 24, genre: 'Fantasy', sort: ['SCORE_DESC'] }, false);
        await renderRow('Top Trending Fantasy', { page: 1, perPage: 24, genre: 'Fantasy', sort: ['FAVOURITES_DESC'] }, false);
      } else if (genre === 'Romance') {
        await renderRow('Romance & Heartfelt Stories', { page: 1, perPage: 24, genre: 'Romance', sort: ['FAVOURITES_DESC'] }, false);
        await renderRow('Top Rated Romance', { page: 1, perPage: 24, genre: 'Romance', sort: ['SCORE_DESC'] }, false);
      } else {
        await renderRow(label || genre, { page: 1, perPage: 24, genre: genre, sort: ['TRENDING_DESC'] }, false);
        await renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre: genre, sort: ['SCORE_DESC'] }, false);
      }
    }

    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.loadHindiDubbed = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);
    win.syncCategoryState('HINDI');

    const contentRows = doc.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';

    if (typeof win.showToast === 'function') win.showToast('Loading Indian Regional Releases...');

    if (win.STATE.isNetflixMode) {
      await renderTMDBRow('Hindi Blockbuster Movies', 'discover/movie?with_origin_country=IN&with_original_language=hi&without_genres=16&sort_by=popularity.desc&_rail=hindi_dub_m', '<i class="fas fa-film"></i>', 'MOVIE');
      await renderTMDBRow('Hindi Web Series & Dramas', 'discover/tv?with_origin_country=IN&with_original_language=hi&without_genres=16&sort_by=popularity.desc&_rail=hindi_dub_tv', '<i class="fas fa-tv"></i>', 'TV');
      await renderTMDBRow('South Indian Cinema (Telugu Hits)', 'discover/movie?with_origin_country=IN&with_original_language=te&without_genres=16&sort_by=popularity.desc&_rail=telugu_dub_m', '<i class="fas fa-fire"></i>', 'MOVIE');
    } else {
      await renderHindiDubRow();
      await renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
      await renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['SCORE_DESC'] }, false);
    }
    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.playRandomAnime = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);
    if (typeof win.showToast === 'function') win.showToast('Rolling for a random title...');

    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('discover/movie', { sort_by: 'popularity.desc', 'vote_count.gte': 100 });
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
    } else {
      if (typeof win.showToast === 'function') win.showToast('Failed to fetch a random title.');
    }
  };

  // ==========================================================================
  // 10. CINEMATIC MODAL & MEDIA PRESENTATION (FAST DEEPLINKING)
  // ==========================================================================
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
    if (anime) {
      win.openModal(anime, season, episode, true, true);
    }
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
    if (overviewTabBtn) win.switchTab('tab-overview', overviewTabBtn);

    if (typeof win.updateModalWatchlistButtonState === 'function') {
      win.updateModalWatchlistButtonState();
    }

    const title = anime.title?.english || anime.title?.romaji || anime.title?.native || 'Title';
    const banner = anime.bannerImage || anime.coverImage?.extraLarge || '';

    const modalNowPlayingTitle = doc.getElementById('modalNowPlayingTitle');
    const playerStreamTitle = doc.getElementById('playerStreamTitle');
    const nextEpBtnText = doc.getElementById('nextEpBtnText');
    const episodesMasterSection = doc.getElementById('episodesMasterSection');

    if (isMovie) {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Feature Film`;
      if (playerStreamTitle) playerStreamTitle.innerText = `Full Movie`;
      if (nextEpBtnText) nextEpBtnText.innerText = `Full Film`;
      if (episodesMasterSection) episodesMasterSection.style.display = 'none';
    } else {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • S${win.STATE.season} Ep ${win.STATE.episode}`;
      if (playerStreamTitle) playerStreamTitle.innerText = `Season ${win.STATE.season} • Episode ${win.STATE.episode}`;
      if (nextEpBtnText) nextEpBtnText.innerText = `Next Ep`;
      if (episodesMasterSection) episodesMasterSection.style.display = 'block';
    }

    if (typeof win.extractChromaAmbilight === 'function') {
      win.extractChromaAmbilight(banner);
    }

    // Direct metadata infill so modal never opens empty
    const scoreEl = doc.getElementById('modalScore');
    const yearEl = doc.getElementById('modalYear');
    const formatEl = doc.getElementById('modalFormat');
    const epCountEl = doc.getElementById('modalEpisodesCount');
    const descEl = doc.getElementById('modalDesc');
    const nativeEl = doc.getElementById('modalNative');
    const statusEl = doc.getElementById('modalStatus');
    const genresEl = doc.getElementById('modalGenres');
    const studioEl = doc.getElementById('modalStudio');
    const durationEl = doc.getElementById('modalDuration');

    if (scoreEl) scoreEl.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 90}% Score`;
    if (yearEl) yearEl.innerText = anime.seasonYear || anime.year || '2026';
    if (formatEl) formatEl.innerText = anime.format || (isMovie ? 'MOVIE' : 'TV');
    if (epCountEl) epCountEl.innerText = isMovie ? 'Feature Film' : `${anime.episodes || '?'} Episodes`;
    if (descEl) descEl.innerText = cleanText(anime.description) || 'Tap play to stream this title in ultra HD.';
    if (nativeEl) nativeEl.innerText = anime.title?.native || anime.title?.romaji || 'N/A';
    if (statusEl) statusEl.innerText = anime.status || 'FINISHED';
    if (genresEl) genresEl.innerText = Array.isArray(anime.genres) ? anime.genres.join(', ') : (anime.genres || 'Animation');
    if (studioEl) studioEl.innerText = anime.studios?.nodes?.[0]?.name || (anime.isLiveAction ? 'Netflix Production' : 'Studio Animation');
    if (durationEl) durationEl.innerText = `${anime.duration || (isMovie ? 110 : 24)} mins`;

    const wrap = doc.getElementById('modalPlayerWrap');
    if (wrap) {
      wrap.innerHTML = `
        <img src="${banner}" class="modal-backdrop-preview" alt="" onerror="this.src='${FALLBACK_POSTER}'" style="width:100%; height:100%; object-fit:cover; filter:brightness(0.7);" />
        <div class="player-cover-overlay" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:15; background:rgba(0,0,0,0.45); cursor:pointer;" onclick="window.executeStream(0)">
          <div class="modal-big-play-btn" style="width:72px; height:72px; border-radius:50%; background:#ffffff; display:flex; align-items:center; justify-content:center; box-shadow:0 0 30px rgba(255,255,255,0.4); margin-bottom:14px; cursor:pointer;" onclick="event.stopPropagation(); window.executeStream(0);">
            <i class="fas fa-play" style="color:#000; font-size:24px; margin-left:4px;"></i>
          </div>
          <h2 style="color:#fff; text-shadow:0 2px 10px rgba(0,0,0,0.9); font-weight:800; font-size:clamp(1.2rem, 2.5vw, 1.8rem); text-align:center; padding:0 20px;">${title}</h2>
          <p style="color:var(--accent-cyan, #00d2ff); font-size:13px; font-weight:700; margin-top:6px;">Season ${win.STATE.season} • Episode ${win.STATE.episode}</p>
          <button class="btn btn-play" style="margin-top:16px; padding:10px 24px; font-size:14px; pointer-events:auto;" onclick="event.stopPropagation(); window.executeStream(0);">
            <i class="fas fa-play"></i> ${isMovie ? 'Play Movie' : `Watch Episode ${win.STATE.episode}`}
          </button>
        </div>
      `;
    }

    if (!skipUrlSync && win.Router) {
      win.Router.set({ watch: anime.id, s: win.STATE.season, ep: win.STATE.episode, srv: win.STATE.activeServer }, true);
    }

    // NON-BLOCKING PIPELINE: Execute stream immediately if autoStart, hydrate deep data in parallel
    if (autoStart) {
      win.executeStream(0);
    }

    (async () => {
      if (typeof win.resolveTMDBId === 'function') {
        await win.resolveTMDBId(seasonInfo.cleanTitle, isMovie);
      }
      await fetchAndPopulateDeepData(anime);
      if (!isMovie && typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();
      if (anime.idMal && !win.STATE.isNetflixMode && typeof win.resolveAndPollAniSkip === 'function') {
        win.resolveAndPollAniSkip(anime.idMal, win.STATE.episode);
      }
      if (typeof win.renderServerSwitcherGrid === 'function') win.renderServerSwitcherGrid();
      checkAllServersHealth();
    })();

    if (win.p2pParty && win.p2pParty.isHost) {
      win.p2pParty.broadcastTitleChange(anime, win.STATE.season, win.STATE.episode, win.STATE.activeServer);
    }
  };

  win.closeModal = function (skipUrlSync = false) {
    clearTimeout(streamLoadTimeout);

    const modalContainer = doc.getElementById('modalContainer');
    if (!modalContainer || !modalContainer.classList.contains('active')) return;

    const modalOverlay = doc.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('active');
    modalContainer.classList.remove('active');

    const wrap = doc.getElementById('modalPlayerWrap');
    if (wrap) {
      const activeIframe = wrap.querySelector('iframe');
      if (activeIframe) activeIframe.src = 'about:blank';
      wrap.innerHTML = '';
    }

    doc.documentElement.style.overflowY = 'scroll';
    win.scrollTo(0, win.STATE.savedScrollY);

    win.STATE.currentAnime = null;
    if (!skipUrlSync && win.Router) {
      win.Router.set({ watch: null, s: null, ep: null, fs: null, srv: null });
    }
  };

  // ==========================================================================
  // 11. STREAMING ENGINE DISPATCH (4 AUTONOMOUS NODES)
  // ==========================================================================
  win.executeStream = async function (retryCount = 0) {
    const wrap = doc.getElementById('modalPlayerWrap');
    if (!wrap || !win.STATE.currentAnime) return;

    clearTimeout(streamLoadTimeout);

    const tId = win.STATE.currentTMDBId || win.CONFIG?.DEFAULT_TMDB_FALLBACK;
    const s = win.STATE.season;
    const e = win.STATE.episode;
    const isMovie = win.STATE.currentAnime?.format === 'MOVIE';
    const title = win.STATE.currentAnime?.title?.english || win.STATE.currentAnime?.title?.romaji || 'Title';
    const poster = win.STATE.currentAnime?.coverImage?.extraLarge || win.STATE.currentAnime?.bannerImage || '';

    const modalNowPlayingTitle = doc.getElementById('modalNowPlayingTitle');
    const playerStreamTitle = doc.getElementById('playerStreamTitle');

    if (isMovie) {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Feature Film`;
      if (playerStreamTitle) playerStreamTitle.innerText = `Full Movie`;
    } else {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Season ${s} Episode ${e}`;
      if (playerStreamTitle) playerStreamTitle.innerText = `Season ${s} • Episode ${e}`;
    }

    const activeServerConfig = win.SERVER_CONFIG[win.STATE.activeServer] || win.SERVER_CONFIG[1];
    const streamUrl = activeServerConfig.endpoint(tId, s, e, isMovie, win.STATE.currentAnime.id);

    wrap.innerHTML = `
      <iframe 
        id="streamFrame" 
        src="${streamUrl}" 
        allowfullscreen 
        allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share" 
        style="position:absolute; inset:0; width:100%; height:100%; border:none; z-index:5; background:#000;">
      </iframe>
      <button id="aniSkipIntroBtn" class="aniskip-pill-btn" style="display:none;" onclick="window.triggerAniSkipJump()">
        <i class="fas fa-forward"></i> <span id="aniSkipLabel">Skip Opening (OP)</span>
      </button>
    `;

    setupMediaSessionHooks(isMovie, title, s, e, poster);

    if (typeof win.renderServerSwitcherGrid === 'function') win.renderServerSwitcherGrid();
    if (!isMovie && typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();

    const iframe = doc.getElementById('streamFrame');
    iframe.onerror = () => handleAutoFailover(retryCount);

    streamLoadTimeout = setTimeout(() => {
      if (retryCount < 4) {
        handleAutoFailover(retryCount);
      }
    }, 6500);

    iframe.onload = () => {
      clearTimeout(streamLoadTimeout);
    };
  };

  function setupMediaSessionHooks(isMovie, title, s, e, poster) {
    if ('mediaSession' in navigator && win.STATE.currentAnime) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: isMovie ? title : `Episode ${e} - ${title}`,
        artist: isMovie ? 'Feature Film' : `Season ${s}`,
        album: 'AnimeDrift Ultra',
        artwork: [{ src: poster, sizes: '512x512', type: 'image/jpeg' }]
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => win.nextEpisode());
    }
  }

  function handleAutoFailover(currentRetry) {
    clearTimeout(streamLoadTimeout);
    const totalServers = Object.keys(win.SERVER_CONFIG).length;
    const nextServer = (win.STATE.activeServer % totalServers) + 1;
    win.STATE.activeServer = nextServer;

    if (typeof win.showToast === 'function') {
      win.showToast(`Node error. Failing over to ${win.SERVER_CONFIG[nextServer].name}...`);
    }
    win.executeStream(currentRetry + 1);
  }

  async function checkAllServersHealth() {
    const tId = win.STATE.currentTMDBId || win.CONFIG?.DEFAULT_TMDB_FALLBACK;
    const s = win.STATE.season;
    const e = win.STATE.episode;
    const isMovie = win.STATE.currentAnime?.format === 'MOVIE';

    healthProbeAbortControllers.forEach(ctrl => {
      try { ctrl.abort(); } catch (err) {}
    });
    healthProbeAbortControllers = [];

    const serverUrls = {
      1: isMovie ? `https://nxsha.space/embed/movie/${tId}` : `https://nxsha.space/embed/tv/${tId}/${s}/${e}`,
      2: isMovie ? `https://embed.filmu.in/movie/${tId}` : `https://embed.filmu.in/tv/${tId}/${s}/${e}`,
      3: isMovie ? `https://vidcore.org/embed/movie/${tId}` : `https://vidcore.org/embed/tv/${tId}/${s}/${e}`,
      4: isMovie ? `https://vidfast.vc/movie/${tId}` : `https://vidfast.vc/tv/${tId}/${s}/${e}`
    };

    const buttons = doc.querySelectorAll('.server-node-btn');

    Object.keys(serverUrls).forEach(async srvKey => {
      const btn = buttons[parseInt(srvKey, 10) - 1];
      const dot = btn?.querySelector('.server-status-dot');
      if (!dot) return;

      const controller = new AbortController();
      healthProbeAbortControllers.push(controller);

      const timeoutId = setTimeout(() => {
        try { controller.abort(); } catch (err) {}
      }, 4500);

      const startTime = performance.now();
      try {
        await fetch(serverUrls[srvKey], { method: 'HEAD', mode: 'no-cors', cache: 'no-cache', signal: controller.signal });
        clearTimeout(timeoutId);
        const latency = Math.round(performance.now() - startTime);

        if (latency > 2200) {
          dot.className = 'server-status-dot slow';
        } else {
          dot.className = 'server-status-dot optimal';
        }
      } catch (err) {
        clearTimeout(timeoutId);
        dot.className = 'server-status-dot offline';
      }
    });
  }
  win.checkAllServersHealth = checkAllServersHealth;

  // ==========================================================================
  // 12. MULTI-API DEEP DATA FETCHERS (DEEP DETAILS HYDRATION INCLUDED)
  // ==========================================================================
  async function fetchAndPopulateDeepData(anime) {
    const numericId = parseInt(anime.id, 10);

    const castGrid = doc.getElementById('castGrid');
    if (castGrid) castGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading cast...</div>';

    const moreGrid = doc.getElementById('moreGrid');
    if (moreGrid) moreGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading recommendations...</div>';

    const trailersGrid = doc.getElementById('trailersGrid');
    if (trailersGrid) trailersGrid.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Fetching trailers...</div>';

    let charactersLoaded = false;
    let recommendationsLoaded = false;
    let trailerLoaded = false;

    // TMDB Deep Fetch for Live-Action / Netflix Mode
    if (win.STATE.isNetflixMode || (win.STATE.currentTMDBId && win.STATE.currentTMDBId !== 533535)) {
      try {
        const isMovie = anime.format === 'MOVIE';
        const proxyUrl = cleanTMDBUrl(`${isMovie ? 'movie' : 'tv'}/${win.STATE.currentTMDBId}`, {
          append_to_response: 'credits,videos,recommendations'
        });
        const tmdbData = await fetchWithRetry(proxyUrl);

        if (tmdbData) {
          // Immediately populate synopsis, genres, studio, runtime, status
          if (typeof win.hydrateModalDeepDetails === 'function') {
            win.hydrateModalDeepDetails({
              description: tmdbData.overview,
              nativeTitle: tmdbData.original_title || tmdbData.original_name,
              genres: tmdbData.genres ? tmdbData.genres.map(g => g.name) : [],
              studio: tmdbData.production_companies?.[0]?.name,
              duration: tmdbData.runtime || tmdbData.episode_run_time?.[0],
              status: tmdbData.status,
              averageScore: Math.round((tmdbData.vote_average || 8) * 10),
              year: (tmdbData.release_date || tmdbData.first_air_date || '').slice(0, 4)
            });
          }

          if (tmdbData.credits?.cast?.length) {
            renderCharactersFromTMDB(tmdbData.credits.cast);
            charactersLoaded = true;
          }
          if (tmdbData.videos?.results?.length) {
            const yt = tmdbData.videos.results.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
            if (yt?.key) {
              renderTrailerIframe(yt.key);
              trailerLoaded = true;
            }
          }
          if (tmdbData.recommendations?.results?.length) {
            const cleanRecs = tmdbData.recommendations.results.filter(r => !(r.genre_ids || []).includes(16));
            if (cleanRecs.length) {
              renderRecommendationsFromTMDB(cleanRecs);
              recommendationsLoaded = true;
            }
          }
        }
      } catch (e) {}
    }

    // AniList Deep Fetch for Anime Universe
    if (!win.STATE.isNetflixMode && (!charactersLoaded || !recommendationsLoaded || !trailerLoaded)) {
      if (!isNaN(numericId) && numericId > 0 && numericId < 300000) {
        try {
          const aniData = await fetchGQL(GQL_DEEP, { id: numericId });
          const media = aniData?.Media;

          if (media) {
            // Immediately populate synopsis, genres, studio, runtime, status
            if (typeof win.hydrateModalDeepDetails === 'function') {
              win.hydrateModalDeepDetails({
                description: media.description,
                nativeTitle: media.title?.native || media.title?.romaji,
                genres: media.genres,
                studio: media.studios?.nodes?.[0]?.name,
                duration: media.duration,
                status: media.status,
                averageScore: media.averageScore,
                year: media.seasonYear
              });
            }

            if (media.streamingEpisodes && media.streamingEpisodes.length > 0) {
              anime.streamingEpisodes = media.streamingEpisodes;
            }

            const edges = media.characters?.edges || [];
            if (!charactersLoaded && edges.length > 0) {
              renderCharactersFromAniList(edges);
              charactersLoaded = true;
            }

            const recomms = media.recommendations?.nodes || [];
            if (!recommendationsLoaded && recomms.length > 0) {
              renderRecommendationsFromAniList(recomms);
              recommendationsLoaded = true;
            }

            const trailer = media.trailer || anime.trailer;
            if (!trailerLoaded && trailer?.site?.toLowerCase() === 'youtube' && trailer?.id) {
              renderTrailerIframe(trailer.id);
              trailerLoaded = true;
            }
          }
        } catch (err) {}
      }
    }

    if (!charactersLoaded && castGrid) {
      castGrid.innerHTML = '<p style="color:var(--text-muted); padding:30px; text-align:center; grid-column:1/-1;">No cast information available.</p>';
    }
    if (!recommendationsLoaded && moreGrid) {
      moreGrid.innerHTML = '<p style="color:var(--text-muted); padding:30px; text-align:center; grid-column:1/-1;">No recommendations found.</p>';
    }
    if (!trailerLoaded && trailersGrid) {
      trailersGrid.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:40px;">No official trailer available.</p>';
    }
  }

  function renderCharactersFromAniList(edges) {
    const castGrid = doc.getElementById('castGrid');
    if (!castGrid) return;
    castGrid.innerHTML = '';
    edges.slice(0, 16).forEach(edge => {
      const charName = edge.node?.name?.full || 'Character';
      const charImg = edge.node?.image?.large || FALLBACK_POSTER;
      const vaName = edge.voiceActors?.[0]?.name?.full || 'Japanese Cast';

      castGrid.innerHTML += `
        <div class="cast-card">
          <img src="${charImg}" alt="${charName}" onerror="this.src='${FALLBACK_POSTER}'" />
          <div class="cast-names">
            <h4>${charName}</h4>
            <p><i class="fas fa-microphone"></i> ${vaName}</p>
          </div>
        </div>
      `;
    });
  }

  function renderCharactersFromTMDB(cast) {
    const castGrid = doc.getElementById('castGrid');
    if (!castGrid) return;
    castGrid.innerHTML = '';
    cast.slice(0, 16).forEach(item => {
      const charName = item.character || item.name;
      const img = item.profile_path ? `https://image.tmdb.org/t/p/w185${item.profile_path}` : FALLBACK_POSTER;
      castGrid.innerHTML += `
        <div class="cast-card">
          <img src="${img}" alt="${charName}" onerror="this.src='${FALLBACK_POSTER}'" />
          <div class="cast-names">
            <h4>${charName}</h4>
            <p><i class="fas fa-user"></i> ${item.name}</p>
          </div>
        </div>
      `;
    });
  }

  function renderRecommendationsFromAniList(nodes) {
    const moreGrid = doc.getElementById('moreGrid');
    if (!moreGrid) return;
    moreGrid.innerHTML = '';
    nodes.forEach(recNode => {
      const rec = recNode.mediaRecommendation;
      if (!rec) return;
      win.animeCache.set(rec.id, rec);
      const title = rec.title?.english || rec.title?.romaji || 'Anime';
      const cover = rec.coverImage?.extraLarge || rec.coverImage?.large || FALLBACK_POSTER;

      moreGrid.innerHTML += `
        <div class="anime-card card ui-card-locked" style="cursor:pointer;" onclick="handleAnimeClick(${rec.id})">
          <img src="${cover}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="border-radius:8px; width:100%; aspect-ratio:2/3; object-fit:cover;" />
          <div class="card-overlay"><div class="card-title">${title}</div></div>
          <div class="card-badge-top">${rec.format || 'TV'}</div>
        </div>
      `;
    });
  }

  function renderRecommendationsFromTMDB(results) {
    const moreGrid = doc.getElementById('moreGrid');
    if (!moreGrid) return;
    moreGrid.innerHTML = '';
    results.slice(0, 12).forEach(item => {
      const title = item.name || item.title;
      const img = item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : FALLBACK_POSTER;

      const isMovie = item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));
      const mockAnime = {
        id: item.id,
        tmdbId: item.id,
        title: { romaji: title, english: title },
        coverImage: { extraLarge: img, large: img },
        format: isMovie ? 'MOVIE' : 'TV',
        episodes: isMovie ? 1 : 16,
        averageScore: Math.round((item.vote_average || 8) * 10),
        isLiveAction: true
      };
      win.animeCache.set(item.id, mockAnime);

      moreGrid.innerHTML += `
        <div class="anime-card card ui-card-locked" style="cursor:pointer;" onclick="handleAnimeClick(${item.id})">
          <img src="${img}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="border-radius:8px; width:100%; aspect-ratio:2/3; object-fit:cover;" />
          <div class="card-overlay"><div class="card-title">${title}</div></div>
          <div class="card-badge-top">TMDB</div>
        </div>
      `;
    });
  }

  function renderTrailerIframe(youtubeId) {
    const trailersGrid = doc.getElementById('trailersGrid');
    if (!trailersGrid || !youtubeId) return;
    trailersGrid.innerHTML = `
      <div class="modal-player-wrap" style="border-radius:12px; max-width:750px; margin:0 auto; aspect-ratio:16/9;">
        <iframe src="https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
      </div>
    `;
  }

  win.switchTab = function (tabId, btn) {
    doc.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    doc.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    doc.getElementById(tabId)?.classList.add('active');
    btn?.classList.add('active');
  };

  // ==========================================================================
  // 13. EPISODE GRID RENDERING & SELECTION (ANILIST DEEP EPISODES INCLUDED)
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

    if (seasonSelect) {
      seasonSelect.innerHTML = seasons.map(s => `
        <option value="${s.season_number}" ${s.season_number === win.STATE.season ? 'selected' : ''}>
          ${escapeHTML(s.name)} (${s.episode_count} Eps)
        </option>
      `).join('');
    }

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
      const aniEp = win.STATE.currentAnime?.streamingEpisodes?.[ep - 1];

      const title = epData?.title || aniEp?.title || `Episode ${ep}`;
      const stillImg = epData?.still || aniEp?.thumbnail || posterFallback;
      const airDate = epData?.airDate ? ` • ${epData.airDate}` : '';
      const runtime = epData?.runtime ? ` • ${epData.runtime}` : (win.STATE.currentAnime.duration ? ` • ${win.STATE.currentAnime.duration}m` : '');
      const overview = epData?.overview || (win.STATE.currentAnime.description ? cleanText(win.STATE.currentAnime.description).slice(0, 160) + '...' : `Tap to stream Episode ${ep} in full high-definition.`);

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

  // ==========================================================================
  // 14. REAL-TIME SEARCH AUTOCOMPLETE & CLEAN DISMISSAL
  // ==========================================================================
  win.toggleSearch = function () {
    const wrapper = doc.getElementById('searchWrapper');
    const input = doc.getElementById('searchInput');
    const clearBtn = doc.getElementById('searchClearBtn');
    if (!wrapper || !input) return;

    const isOpen = wrapper.classList.toggle('open');
    if (isOpen) {
      if (clearBtn) clearBtn.style.display = 'flex';
      input.focus();
    } else {
      win.clearSearch();
    }
  };

  // CRITICAL FIX: Closes mobile search takeover immediately upon tapping ✕
  win.clearSearch = function () {
    const wrapper = doc.getElementById('searchWrapper');
    const input = doc.getElementById('searchInput');
    const drop = doc.getElementById('searchDropdown');
    const clearBtn = doc.getElementById('searchClearBtn');

    if (input) {
      input.value = '';
      input.blur();
    }
    if (drop) drop.classList.remove('visible');
    if (clearBtn) clearBtn.style.display = 'none';

    // Remove the .open class to dismiss takeover bar
    if (wrapper) wrapper.classList.remove('open');

    if (win.Router) win.Router.set({ q: null });
  };

  doc.getElementById('searchInput')?.addEventListener('input', (e) => {
    clearTimeout(win.STATE.searchDebounce);
    const q = e.target.value.trim();
    const drop = doc.getElementById('searchDropdown');
    const clearBtn = doc.getElementById('searchClearBtn');

    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

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
  // 15. NATIVE ANILIST AIRING SCHEDULE ENGINE (JIKAN DISCONTINUATION FIX)
  // ==========================================================================
  const DAYS_MAP = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  win.openScheduleModal = function (skipUrlSync = false) {
    if (typeof win.openScheduleModalNative === 'function') {
      return win.openScheduleModalNative(skipUrlSync);
    }
    const modal = doc.getElementById('scheduleModal');
    const overlay = doc.getElementById('scheduleModalOverlay');
    if (!modal || !overlay) return;

    modal.style.display = 'flex';
    modal.classList.add('open');
    overlay.classList.add('active');
    doc.documentElement.style.overflowY = 'hidden';

    if (!skipUrlSync && win.Router) win.Router.set({ modal: 'schedule' }, true);

    const todayIndex = new Date().getDay();
    renderScheduleDayTabs(todayIndex);
    loadAniListScheduleDay(todayIndex);
  };

  win.closeScheduleModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('scheduleModal');
    const overlay = doc.getElementById('scheduleModalOverlay');
    if (modal && overlay) {
      modal.style.display = 'none';
      modal.classList.remove('open');
      overlay.classList.remove('active');
      doc.documentElement.style.overflowY = 'scroll';
      if (!skipUrlSync && win.Router) win.Router.set({ modal: null });
    }
  };

  function renderScheduleDayTabs(activeIdx) {
    const tabs = doc.getElementById('scheduleDayTabs');
    if (!tabs) return;
    tabs.innerHTML = DAYS_MAP.map((name, idx) => `
      <button type="button" 
              class="chip ${idx === activeIdx ? 'active' : ''}" 
              onclick="window.onScheduleTabSelect(${idx})">
        ${name}${idx === new Date().getDay() ? ' (Today)' : ''}
      </button>
    `).join('');
  }

  win.onScheduleTabSelect = function (idx) {
    renderScheduleDayTabs(idx);
    loadAniListScheduleDay(idx);
  };

  async function loadAniListScheduleDay(dayIndex) {
    const container = doc.getElementById('scheduleItemsContainer');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading schedule from AniList...</div>';

    const now = new Date();
    const currentDayIndex = now.getDay();
    const distance = dayIndex - currentDayIndex;

    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + distance);
    targetDate.setHours(0, 0, 0, 0);

    const startTimestamp = Math.floor(targetDate.getTime() / 1000);
    const endTimestamp = startTimestamp + 86400;

    const query = `
      query ($airingAt_greater: Int, $airingAt_lesser: Int) {
        Page(page: 1, perPage: 40) {
          airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
            id
            airingAt
            episode
            media {
              id
              idMal
              format
              title { english romaji native }
              coverImage { large extraLarge }
              genres
              averageScore
            }
          }
        }
      }
    `;

    try {
      const data = await fetchGQL(query, {
        airingAt_greater: startTimestamp,
        airingAt_lesser: endTimestamp
      });
      const items = data?.Page?.airingSchedules || [];
      container.innerHTML = '';

      if (!items.length) {
        container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-tv" style="font-size:24px; margin-bottom:8px; opacity:0.4;"></i><p>No simulcasts scheduled for this day.</p></div>';
        return;
      }

      items.forEach(entry => {
        const media = entry.media;
        if (!media) return;
        win.animeCache.set(media.id, media);
        const title = media.title?.english || media.title?.romaji || 'Upcoming Title';
        const img = media.coverImage?.large || media.coverImage?.extraLarge || FALLBACK_POSTER;
        const time = new Date(entry.airingAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const row = doc.createElement('div');
        row.className = 'search-item';
        row.style.cssText = 'border-radius:10px; cursor:pointer; display:flex; gap:12px; padding:10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); align-items:center;';
        row.onclick = () => {
          win.closeScheduleModal();
          win.openModalById(media.id);
        };
        row.innerHTML = `
          <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" style="width:48px; height:68px; object-fit:cover; border-radius:6px; flex-shrink:0;" />
          <div class="search-info" style="flex:1; min-width:0;">
            <div class="search-title" style="font-size:13px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(title)}</div>
            <div class="search-meta" style="font-size:11px; color:var(--text-muted); margin-top:4px;">
              <span style="color:var(--accent-cyan,#00d2ff); font-weight:700;">${time}</span> &bull; 
              <span>Episode ${entry.episode}</span> &bull; 
              <span style="color:#46d369;"><i class="fas fa-star" style="font-size:9px;"></i> ${media.averageScore ? media.averageScore + '%' : 'N/A'}</span>
            </div>
          </div>
        `;
        container.appendChild(row);
      });
    } catch (e) {
      container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--accent-red,#ff0844);"><p>Airing schedule temporarily unavailable.</p></div>';
    }
  }

  // ==========================================================================
  // 16. TRACE.MOE SEARCH MODAL CONTROLLER
  // ==========================================================================
  win.openTraceMoeModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('traceMoeModal');
    const overlay = doc.getElementById('traceMoeOverlay');
    if (!modal || !overlay) return;

    modal.style.display = 'flex';
    modal.classList.add('open');
    overlay.classList.add('active');
    doc.documentElement.style.overflowY = 'hidden';

    if (!skipUrlSync && win.Router) win.Router.set({ modal: 'tracemoe' }, true);
    win.addEventListener('paste', handleTraceClipboardPaste);
  };

  win.closeTraceMoeModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('traceMoeModal');
    const overlay = doc.getElementById('traceMoeOverlay');
    if (modal && overlay) {
      modal.style.display = 'none';
      modal.classList.remove('open');
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
        resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-muted);">No match found for this image frame.</div>';
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
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">Episode ${ep} &bull; Frame at ${timeMins}</div>
          <button class="btn btn-play" style="width:100%; font-size:13px; padding:8px 0;" onclick="window.closeTraceMoeModal(); window.openModalById(${best.anilist?.id || best.anilist}, ${ep})">
            <i class="fas fa-play"></i> Watch Episode ${ep} Now
          </button>
        </div>
      `;
    } catch (err) {
      resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--accent-red,#ff0844);">Analysis failed. Please try a different frame image.</div>';
    }
  }

  // ==========================================================================
  // 17. ANISKIP SKIP CHAPTER TELEMETRY
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
  // 18. AUDIO GAIN BOOSTER & DEEP LINKING
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
        if (!audioCtx) audioCtx = new (win.AudioContext || win.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (gainNode) gainNode.gain.setValueAtTime(currentAudioGainLevel, audioCtx.currentTime);
      } catch (e) {}
    }

    if (typeof win.showToast === 'function') {
      win.showToast(`Audio Boost: ${Math.round(currentAudioGainLevel * 100)}%`);
    }

    if (win.p2pParty && win.p2pParty.isHost) {
      win.p2pParty.broadcastAudioBoost(currentAudioGainLevel);
    }
  };

  win.shareCurrentTitleLink = function () {
    if (win.Router && win.STATE.currentAnime) {
      win.Router.set({ watch: win.STATE.currentAnime.id, s: win.STATE.season, ep: win.STATE.episode }, false);
    }
    navigator.clipboard.writeText(win.location.href);
    if (typeof win.showToast === 'function') win.showToast('Direct title link copied!');
  };

  win.shareDeepLinkEpisode = function () {
    if (win.Router && win.STATE.currentAnime) {
      win.Router.set({ watch: win.STATE.currentAnime.id, s: win.STATE.season, ep: win.STATE.episode }, false);
    }
    navigator.clipboard.writeText(win.location.href);
    if (typeof win.showToast === 'function') win.showToast(`Episode ${win.STATE.episode} link copied!`);
  };

  // ==========================================================================
  // 19. SYNCHRONIZED PLAYER POSTMESSAGE EVENT LISTENER
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
