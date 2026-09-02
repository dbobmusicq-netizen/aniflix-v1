/**
 * ============================================================================
 * AniFlix Ultra — ADVANCED STREAMING UI (ENTERPRISE MASTER SYSTEM)
 * ============================================================================
 *
 * File:
 *   streaming-ui.js
 *
 * Version:
 *   28.0.0 Unified Responsive Streaming Engine & Storage Nexus
 *
 * Resolved Systems in this Build:
 *   - Strict Variable Sanitization for AniList GraphQL (Zero HTTP 400 Bad Requests).
 *   - Quiet Exception Handling for AniSkip Offsets (Suppresses unindexed 404 logs).
 *   - Automated 24-Hour IndexedDB/Dexie Cache Eviction & LRU Garbage Collector.
 *   - Image Blob Storage Nexus for Instant Offline Posters & Reduced Bandwidth.
 *   - Netflix/Anime Dual-Universe Navigation & Chip Synchronization.
 *   - Responsive 16:9 Thumbnail Episode Grid with Air-Dates & Dynamic Truncation.
 *   - 4-Tier Verified Mirror Cluster (NxSha Ultra, Filmu Native, VidCore, VidFast).
 *   - Cross-Origin Font / Tracking Sandbox Isolation & PostMessage P2P Mesh Engine.
 *   - Strictly preserves layout hierarchy (No layout-shift or height collapse on scroll).
 *
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

  // Rate-limiting sequential token queue
  let lastGqlRequestTime = 0;
  const GQL_MIN_INTERVAL_MS = 380;
  let gqlQueue = Promise.resolve();

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24-Hour Cache Horizon
  const FALLBACK_POSTER = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22200%22%20height%3D%22300%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%2316161c%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20fill%3D%22%23666%22%20font-size%3D%2214%22%20text-anchor%3D%22middle%22%20alignment-baseline%3D%22middle%22%3ENo%20Image%3C%2Ftext%3E%3C%2Fsvg%3E';

  // ==========================================================================
  // 02. INDEXEDDB PERSISTENCE (DEXIE.JS WITH 24H PRUNING ENGINE)
  // ==========================================================================
  const db = win.Dexie ? new win.Dexie('AniFlixUltraDB') : null;
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
  // 04. NETWORK ENGINE & OFFICIAL GRAPHQL / TMDB DEDUPLICATOR
  // ==========================================================================
  function cleanTMDBUrl(endpointPath, customParams = {}) {
    const base = endpointPath.startsWith('http')
      ? endpointPath
      : `https://db.speedracelight.com/3${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`;

    const url = new URL(base);

    if (url.pathname.includes('/discover/')) {
      if (!url.searchParams.has('without_genres')) {
        url.searchParams.set('without_genres', '16');
      }
      if (!url.searchParams.has('vote_count.gte')) {
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

  async function fetchWithRetry(url, options = {}, retries = 2, delay = 2000) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');
        const waitSeconds = retryHeader ? parseInt(retryHeader, 10) : (delay / 1000);
        if (retries > 0) {
          await new Promise(res => setTimeout(res, Math.max(waitSeconds, 2) * 1000));
          return fetchWithRetry(url, options, retries - 1, delay * 2);
        }
        return null;
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 404 || response.status === 500) {
          return null;
        }
        if (retries > 0) {
          await new Promise(res => setTimeout(res, delay));
          return fetchWithRetry(url, options, retries - 1, delay * 2);
        }
        return null;
      }

      return await response.json();
    } catch (error) {
      if (retries > 0) {
        await new Promise(res => setTimeout(res, delay));
        return fetchWithRetry(url, options, retries - 1, delay * 2);
      }
      return null;
    }
  }
  win.fetchWithRetry = fetchWithRetry;

  // Fully validated AniList GraphQL schemas
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
    // Variable sanitization: guarantees no invalid data types trigger HTTP 400
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
      localStorage.setItem('aniflix_history_v6', JSON.stringify(win.STATE.watchHistory));
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
  // 07. HERO SPOTLIGHT & BILLBOARD ENGINE
  // ==========================================================================
  win.renderHeroSpotlight = async function () {
    const heroDubBadge = doc.querySelector('.hero-tags .tag-hindi');

    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('/discover/movie', {
          sort_by: 'popularity.desc',
          'vote_count.gte': '100'
        });
        const data = await fetchWithRetry(url);
        const item = data?.results?.[0];
        if (item) {
          const title = item.title || item.name || 'Featured Live-Action';
          const poster = item.backdrop_path
            ? `https://image.tmdb.org/t/p/original${item.backdrop_path}`
            : `https://image.tmdb.org/t/p/original${item.poster_path}`;
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

          const heroBg = doc.getElementById('heroBg');
          if (heroBg) {
            heroBg.src = poster;
            if (typeof win.extractChromaAmbilight === 'function') {
              win.extractChromaAmbilight(poster);
            }
          }

          const heroTitle = doc.getElementById('heroTitle');
          const heroScore = doc.getElementById('heroScore');
          const heroYear = doc.getElementById('heroYear');
          const heroFormat = doc.getElementById('heroFormat');
          const heroStatus = doc.getElementById('heroStatus');
          const heroDesc = doc.getElementById('heroDesc');
          const heroFormatBadge = doc.getElementById('heroFormatBadge');

          if (heroTitle) heroTitle.innerText = title;
          if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${mockMediaObj.averageScore}% Match`;
          if (heroYear) heroYear.innerText = mockMediaObj.seasonYear;
          if (heroFormat) heroFormat.innerText = mockMediaObj.format;
          if (heroStatus) heroStatus.innerText = 'NETFLIX LIVE';
          if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> NETFLIX LIVE SPOTLIGHT`;

          if (heroDubBadge) {
            heroDubBadge.innerHTML = `<i class="fas fa-film"></i> 4K ULTRA HD / MULTI AUDIO`;
          }

          if (heroDesc) heroDesc.innerText = win.cleanHTML ? win.cleanHTML(mockMediaObj.description) : mockMediaObj.description;

          const playBtn = doc.getElementById('heroPlayBtn');
          const infoBtn = doc.getElementById('heroInfoBtn');
          const bookmarkBtn = doc.getElementById('heroBookmarkBtn');

          if (playBtn) playBtn.onclick = () => win.openModal(mockMediaObj, 1, 1, true);
          if (infoBtn) infoBtn.onclick = () => win.openModal(mockMediaObj, 1, 1, false);
          if (bookmarkBtn) bookmarkBtn.onclick = () => win.toggleWatchlist(mockMediaObj);
          return;
        }
      } catch (e) {}
    }

    // Anime Spotlight query
    const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 1, sort: ['TRENDING_DESC'] });
    const anime = data?.Page?.media?.[0];
    if (!anime) return;

    win.animeCache.set(anime.id, anime);

    const title = anime.title?.english || anime.title?.romaji || 'Stream Master';
    const banner = anime.bannerImage || anime.coverImage?.extraLarge;

    const heroBg = doc.getElementById('heroBg');
    if (heroBg) {
      heroBg.src = banner;
      if (typeof win.extractChromaAmbilight === 'function') {
        win.extractChromaAmbilight(banner);
      }
    }

    const heroTitle = doc.getElementById('heroTitle');
    const heroScore = doc.getElementById('heroScore');
    const heroYear = doc.getElementById('heroYear');
    const heroFormat = doc.getElementById('heroFormat');
    const heroStatus = doc.getElementById('heroStatus');
    const heroDesc = doc.getElementById('heroDesc');
    const heroFormatBadge = doc.getElementById('heroFormatBadge');

    if (heroTitle) heroTitle.innerText = title;
    if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 95}% Rating`;
    if (heroYear) heroYear.innerText = anime.seasonYear || '2026';
    if (heroFormat) heroFormat.innerText = anime.format || 'TV SERIES';
    if (heroStatus) heroStatus.innerText = anime.status || 'AIRING';
    if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> FEATURED SPOTLIGHT`;

    if (heroDubBadge) {
      heroDubBadge.innerHTML = `<i class="fas fa-microphone"></i> HINDI / SUB / DUB`;
    }

    if (heroDesc) heroDesc.innerText = win.cleanHTML ? win.cleanHTML(anime.description) : anime.description;

    const playBtn = doc.getElementById('heroPlayBtn');
    const infoBtn = doc.getElementById('heroInfoBtn');
    const bookmarkBtn = doc.getElementById('heroBookmarkBtn');

    if (playBtn) playBtn.onclick = () => win.openModal(anime, 1, 1, true);
    if (infoBtn) infoBtn.onclick = () => win.openModal(anime, 1, 1, false);
    if (bookmarkBtn) bookmarkBtn.onclick = () => win.toggleWatchlist(anime);
  };

  // ==========================================================================
  // 08. STAGGERED CATALOG RAILS & CARD INTERFACE
  // ==========================================================================
  win.renderHomeRows = async function () {
    const content = doc.getElementById('contentRows');
    if (content) content.innerHTML = '';

    if (win.STATE.isNetflixMode) {
      if (typeof win.showToast === 'function') win.showToast('Loading Live-Action Universe...');
      await renderTMDBRow('Trending Movies Worldwide', '/discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
      await renderTMDBRow('Trending TV Series', '/discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
      await renderTMDBRow('Bollywood & Hindi Cinema', '/discover/movie?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-language"></i>', 'MOVIE');
      await renderTMDBRow('Action Blockbusters & Adrenaline', '/discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
      await renderTMDBRow('Gripping Crime & Mystery Thrillers', '/discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');
      await renderTMDBRow('Romance & Heartwarming Dramas', '/discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
      return;
    }

    // Anime catalog flow
    await renderRow('Trending Masterpieces', { page: 1, perPage: 14, sort: ['TRENDING_DESC'] }, false);
    await renderRow('Top 10 Global Anime Today', { page: 1, perPage: 10, sort: ['POPULARITY_DESC'] }, true);
    await renderHindiDubRow();
    await renderRow('Action & Shonen Hits', { page: 1, perPage: 14, genre: 'Action', sort: ['TRENDING_DESC'] }, false);
    await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 14, genre: 'Fantasy', sort: ['TRENDING_DESC'] }, false);
    await renderRow('Romance & Slice of Life', { page: 1, perPage: 14, genre: 'Romance', sort: ['SCORE_DESC'] }, false);
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
      buildUnifiedCarouselDOM('<i class="fas fa-language" style="color:var(--accent-red,#e50914);"></i> Premium Hindi Dubbed Series', data.Page.media, false, true);
    }
  }
  win.renderHindiDubRow = renderHindiDubRow;

  async function renderTMDBRow(title, endpoint, iconHtml = '<i class="fas fa-clapperboard"></i>', forceFormat = null) {
    try {
      const sanitizedUrl = cleanTMDBUrl(endpoint);
      const data = await fetchWithRetry(sanitizedUrl);
      if (data?.results?.length) {
        const cleanResults = data.results.filter(item => {
          const genres = item.genre_ids || [];
          return !genres.includes(16);
        });
        if (cleanResults.length) {
          buildUnifiedTMDBRowDOM(title, cleanResults, iconHtml, forceFormat);
        }
      }
    } catch (e) {}
  }

  function buildUnifiedCarouselDOM(title, items, isTop10 = false, isHindi = false) {
    const container = doc.getElementById('contentRows');
    if (!container) return;
    const section = doc.createElement('section');
    section.className = 'row-section content-row';
    section.style.cssText = 'margin: 28px 0; padding: 0 4%; position: relative; width: 100%; box-sizing: border-box;';

    section.innerHTML = `
      <h2 class="row-header" style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 12px; letter-spacing: 0.3px;">${title}</h2>
      <div class="row-container carousel-container" style="position: relative; width: 100%; overflow: hidden;">
        <div class="carousel-track carousel-rail" style="display: flex; flex-wrap: nowrap; align-items: stretch; gap: 16px; overflow-x: auto; overflow-y: hidden; scroll-behavior: smooth; padding: 10px 4px 16px 4px; -webkit-overflow-scrolling: touch; scrollbar-width: thin;"></div>
      </div>
    `;
    const track = section.querySelector('.carousel-track');

    items.forEach((anime, idx) => {
      if (!anime) return;
      win.animeCache.set(anime.id, anime);

      const dispTitle = anime.title?.english || anime.title?.romaji || 'Anime';
      const poster = anime.coverImage?.extraLarge || anime.coverImage?.large || FALLBACK_POSTER;
      const score = anime.averageScore ? `${anime.averageScore}%` : '85%';
      const year = anime.seasonYear || '2026';
      const format = anime.format || 'TV';

      const card = doc.createElement('div');
      card.className = 'anime-card card ui-card-locked';
      card.style.cssText = 'flex: 0 0 185px !important; min-width: 185px !important; max-width: 185px !important; height: 275px !important; position: relative !important; border-radius: 12px !important; overflow: hidden !important; cursor: pointer !important; transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s ease !important; user-select: none !important; background: #16161c !important; box-sizing: border-box !important; display: flex !important; flex-direction: column !important;';

      // Hover-intent pre-caching
      card.onmouseenter = () => {
        card.style.transform = 'translateY(-4px) scale(1.03)';
        card.style.boxShadow = '0 14px 28px rgba(0,0,0,0.8)';
        if (!win.STATE.isNetflixMode && !queryCache.has(JSON.stringify({ query: GQL_DEEP, variables: { id: anime.id } }))) {
          fetchGQL(GQL_DEEP, { id: anime.id }).catch(() => {});
        }
      };
      card.onmouseleave = () => {
        card.style.transform = 'translateY(0) scale(1)';
        card.style.boxShadow = 'none';
      };
      card.onclick = () => {
        if (track.dataset.isDragging === 'true') return;
        handleAnimeClick(anime.id);
      };

      let rankHTML = '';
      if (isTop10) {
        rankHTML = `<div class="top10-rank" style="font-size: 3.8rem; font-weight: 900; position: absolute; left: -2px; bottom: 12px; z-index: 3; color: rgba(255,255,255,0.95); -webkit-text-stroke: 1px rgba(0,0,0,0.7);">${idx + 1}</div>`;
      }

      card.innerHTML = `
        ${rankHTML}
        <img src="${poster}" alt="${dispTitle}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="width: 100% !important; height: 100% !important; object-fit: cover !important; display: block !important; border-radius: 12px !important;" />
        
        <div class="card-badge" style="position: absolute !important; top: 8px !important; right: 8px !important; background: ${isHindi ? '#e50914' : 'rgba(0,0,0,0.78)'} !important; backdrop-filter: blur(6px) !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px !important; border-radius: 6px !important; z-index: 3 !important; border: 1px solid rgba(255,255,255,0.12) !important;">
          ${isHindi ? 'HINDI DUB' : format}
        </div>

        <div class="card-overlay" style="position: absolute !important; inset: auto 0 0 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100% !important; margin: 0 !important; padding: 42px 12px 10px 12px !important; box-sizing: border-box !important; background: linear-gradient(to top, rgba(4, 4, 6, 0.98) 0%, rgba(4, 4, 6, 0.72) 60%, transparent 100%) !important; display: flex !important; flex-direction: column !important; justify-content: flex-end !important; z-index: 2 !important; pointer-events: none !important;">
          <div class="card-title" title="${dispTitle}" style="font-size: 13px !important; font-weight: 700 !important; color: #ffffff !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; text-shadow: 0 2px 4px rgba(0,0,0,0.95) !important; width: 100% !important; text-align: left !important; margin: 0 !important; padding: 0 !important; display: block !important;">
            ${dispTitle}
          </div>
          <div class="card-meta" style="font-size: 11px !important; color: #a1a1aa !important; display: flex !important; gap: 8px !important; align-items: center !important; margin-top: 4px !important; width: 100% !important; text-align: left !important;">
            <span class="card-score" style="color: #46d369 !important; font-weight: 700 !important; display: inline-flex !important; align-items: center !important; gap: 3px !important;"><i class="fas fa-star" style="font-size: 9px;"></i> ${score}</span>
            <span class="card-year" style="color: #a1a1aa !important;">${year}</span>
          </div>
        </div>
      `;
      track.appendChild(card);
    });

    enableCarouselDrag(track);
    container.appendChild(section);
  }

  function buildUnifiedTMDBRowDOM(title, items, iconHtml = '<i class="fas fa-clapperboard"></i>', forceFormat = null) {
    const formattedItems = items.map(item => {
      const isMovie = forceFormat === 'MOVIE' || item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));
      const dispTitle = item.title || item.name || 'Title';
      const posterPath = item.poster_path || item.backdrop_path;
      const poster = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : FALLBACK_POSTER;
      return {
        id: item.id,
        title: { english: dispTitle, romaji: dispTitle },
        coverImage: { extraLarge: poster, large: poster },
        format: isMovie ? 'MOVIE' : 'TV',
        averageScore: Math.round((item.vote_average || 8) * 10),
        seasonYear: (item.release_date || item.first_air_date || '2026').split('-')[0],
        isLiveAction: true
      };
    });

    buildUnifiedCarouselDOM(`<span style="color:var(--accent-red,#e50914); margin-right:8px;">${iconHtml}</span>${title}`, formattedItems, false, false);
  }

  function enableCarouselDrag(slider) {
    if (!slider) return;
    let isDown = false;
    let startX, scrollLeft;

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
      const x = e.pageX - slider.offsetLeft;
      const walk = (x - startX) * 1.5;
      if (Math.abs(walk) > 6) {
        slider.dataset.isDragging = 'true';
      }
      slider.scrollLeft = scrollLeft - walk;
    });
  }

  function handleAnimeClick(animeId) {
    const anime = win.animeCache.get(animeId);
    if (anime) win.openModal(anime);
  }
  win.handleAnimeClick = handleAnimeClick;

  // ==========================================================================
  // 09. CATEGORY NAVIGATION DISPATCHERS
  // ==========================================================================
  win.navigateGenre = async function (genre, title) {
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

    if (typeof win.showToast === 'function') win.showToast(`Loading ${title}...`);

    if (win.STATE.isNetflixMode) {
      if (genre === 'Movies' || genre === 'Movie') {
        await renderTMDBRow('Trending Feature Films', '/discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
        await renderTMDBRow('Top Rated Blockbusters', '/discover/movie?sort_by=vote_average.desc&vote_count.gte=200', '<i class="fas fa-star"></i>', 'MOVIE');
      } else if (genre === 'TV' || genre === 'TV Shows') {
        await renderTMDBRow('Top Binge TV Series', '/discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        await renderTMDBRow('Critically Acclaimed Series', '/discover/tv?sort_by=vote_average.desc&vote_count.gte=100', '<i class="fas fa-star"></i>', 'TV');
      } else if (genre === 'Action') {
        await renderTMDBRow('Action Movies & Thrillers', '/discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
        await renderTMDBRow('Action & Adventure Series', '/discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
      } else if (genre === 'Thriller' || genre === 'Thriller & Crime') {
        await renderTMDBRow('Gripping Crime & Mystery Films', '/discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');
        await renderTMDBRow('Psychological Thriller Series', '/discover/tv?with_genres=80&sort_by=popularity.desc', '<i class="fas fa-user-secret"></i>', 'TV');
      } else if (genre === 'Romance') {
        await renderTMDBRow('Romantic Comedies & Dramas', '/discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
        await renderTMDBRow('Romantic TV Series', '/discover/tv?with_genres=10766&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
      } else if (genre === 'Hindi') {
        await win.loadHindiDubbed();
      }
    } else {
      await renderRow(title, { page: 1, perPage: 24, genre, sort: ['TRENDING_DESC'] }, false);
      await renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre, sort: ['SCORE_DESC'] }, false);
    }

    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.loadHindiDubbed = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);
    win.syncCategoryState('HINDI');

    const contentRows = doc.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';

    if (typeof win.showToast === 'function') win.showToast('Loading Hindi Releases...');

    if (win.STATE.isNetflixMode) {
      await renderTMDBRow('Hindi Blockbuster Movies', '/discover/movie?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
      await renderTMDBRow('Hindi Web Series & Dramas', '/discover/tv?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
      await renderTMDBRow('Critically Acclaimed Hindi Cinema', '/discover/movie?with_original_language=hi&sort_by=vote_average.desc&vote_count.gte=50', '<i class="fas fa-star"></i>', 'MOVIE');
    } else {
      await renderHindiDubRow();
      await renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
      await renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['POPULARITY_DESC'] }, false);
    }

    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.applyQuickFilter = async function (type, chipBtn) {
    const contentRows = doc.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';

    const normType = (type || 'ALL').toUpperCase();

    if (win.STATE.isNetflixMode) {
      switch (normType) {
        case 'ALL':
          win.syncCategoryState('ALL');
          await win.renderHomeRows();
          break;
        case 'MOVIES':
          win.syncCategoryState('MOVIES');
          await renderTMDBRow('Trending Movies Worldwide', '/discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
          await renderTMDBRow('Critically Acclaimed Feature Films', '/discover/movie?sort_by=vote_average.desc&vote_count.gte=200', '<i class="fas fa-star"></i>', 'MOVIE');
          break;
        case 'TOP_AIRING':
        case 'SHOWS':
        case 'TV':
          win.syncCategoryState('TOP_AIRING');
          await renderTMDBRow('Top Binge TV Series', '/discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
          await renderTMDBRow('All-Time Greatest TV Shows', '/discover/tv?sort_by=vote_average.desc&vote_count.gte=100', '<i class="fas fa-star"></i>', 'TV');
          break;
        case 'HINDI':
          await win.loadHindiDubbed();
          break;
        case 'ACTION':
          win.syncCategoryState('ACTION');
          await renderTMDBRow('Action Movies & Adrenaline', '/discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
          await renderTMDBRow('Action & Adventure Series', '/discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
          break;
        case 'THRILLER':
        case 'CRIME':
          win.syncCategoryState('THRILLER');
          await renderTMDBRow('Crime & Mystery Thrillers', '/discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');
          await renderTMDBRow('Psychological Drama Series', '/discover/tv?with_genres=80&sort_by=popularity.desc', '<i class="fas fa-user-secret"></i>', 'TV');
          break;
        case 'SCI_FI':
          win.syncCategoryState('SCI_FI');
          await renderTMDBRow('Sci-Fi Explorations & Cyberpunk', '/discover/movie?with_genres=878&sort_by=popularity.desc', '<i class="fas fa-microchip"></i>', 'MOVIE');
          await renderTMDBRow('Sci-Fi & Futuristic TV Shows', '/discover/tv?with_genres=10765&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
          break;
        case 'ROMANCE':
          win.syncCategoryState('ROMANCE');
          await renderTMDBRow('Romantic Comedies & Dramas', '/discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
          await renderTMDBRow('Romantic Drama Series', '/discover/tv?with_genres=10766&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
          break;
      }
      win.scrollTo({ top: 350, behavior: 'smooth' });
      return;
    }

    switch (normType) {
      case 'ALL':
        win.syncCategoryState('ALL');
        await win.renderHomeRows();
        win.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'HINDI':
        await win.loadHindiDubbed();
        break;
      case 'TOP_AIRING':
        win.syncCategoryState('TOP_AIRING');
        await renderRow('Top Airing Worldwide', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);
        break;
      case 'MOVIES':
        win.syncCategoryState('MOVIES');
        await renderRow('Anime Movies & Films', { page: 1, perPage: 24, sort: ['SCORE_DESC'] }, false);
        break;
      case 'ACTION':
        win.syncCategoryState('ACTION');
        await renderRow('Action & Shonen Hits', { page: 1, perPage: 24, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
        break;
      case 'SECONDARY':
        win.syncCategoryState('FANTASY');
        await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 24, genre: 'Fantasy', sort: ['TRENDING_DESC'] }, false);
        break;
      case 'SCI_FI':
        win.syncCategoryState('SCI_FI');
        await renderRow('Sci-Fi & Cyberpunk', { page: 1, perPage: 24, genre: 'Sci-Fi', sort: ['SCORE_DESC'] }, false);
        break;
      case 'ROMANCE':
        win.syncCategoryState('ROMANCE');
        await renderRow('Romance & Slice of Life', { page: 1, perPage: 24, genre: 'Romance', sort: ['POPULARITY_DESC'] }, false);
        break;
    }
    win.scrollTo({ top: 350, behavior: 'smooth' });
  };

  win.playRandomAnime = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);
    if (typeof win.showToast === 'function') win.showToast('Rolling for a random title...');

    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('/discover/movie', { sort_by: 'popularity.desc' });
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
  // 10. CINEMATIC MODAL & MEDIA PRESENTATION
  // ==========================================================================
  win.openModalById = async function (id, episode = 1, season = 1) {
    let anime = win.animeCache.get(id);
    if (!anime) {
      if (win.STATE.isNetflixMode) {
        try {
          const item = await fetchWithRetry(`https://db.speedracelight.com/3/movie/${id}`);
          if (item) anime = win.formatTmdbMediaItem?.(item, 'MOVIE');
        } catch (e) {}
      } else {
        const data = await fetchGQL(GQL_DEEP, { id: parseInt(id, 10) });
        anime = data?.Media;
      }
    }
    if (anime) {
      await win.openModal(anime, season, episode, true, true);
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

    const overviewTabBtn = doc.querySelector('.modal-tabs .tab-btn');
    if (overviewTabBtn) switchTab('tab-overview', overviewTabBtn);

    if (typeof win.updateModalWatchlistButtonState === 'function') {
      win.updateModalWatchlistButtonState();
    }

    const title = anime.title?.english || anime.title?.romaji || 'Title';
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
    if (descEl) descEl.innerText = win.cleanHTML ? win.cleanHTML(anime.description) : (anime.description || '');
    if (nativeEl) nativeEl.innerText = anime.title?.native || 'N/A';
    if (statusEl) statusEl.innerText = anime.status || 'FINISHED';
    if (genresEl) genresEl.innerText = (anime.genres || []).join(', ');
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

    if (typeof win.resolveTMDBId === 'function') {
      await win.resolveTMDBId(seasonInfo.cleanTitle, isMovie);
    }
    await fetchAndPopulateDeepData(anime);

    if (!isMovie && typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();
    if (anime.idMal && !win.STATE.isNetflixMode) resolveAndPollAniSkip(anime.idMal, win.STATE.episode);
    if (typeof win.renderServerSwitcherGrid === 'function') win.renderServerSwitcherGrid();
    checkAllServersHealth();

    if (!skipUrlSync && win.Router) {
      win.Router.set({ watch: anime.id, s: win.STATE.season, ep: win.STATE.episode, srv: win.STATE.activeServer }, true);
    }

    if (autoStart) win.executeStream(0);

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

      const activeVideo = wrap.querySelector('video');
      if (activeVideo) {
        activeVideo.pause();
        activeVideo.removeAttribute('src');
        activeVideo.load();
      }
      wrap.innerHTML = '';
    }

    if (win.streamEngine) {
      win.streamEngine.destroy();
      win.streamEngine = null;
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

    if (win.streamEngine) {
      await win.streamEngine.destroy();
      win.streamEngine = null;
    }

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
        album: 'AniFlix Ultra',
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
  // 12. MULTI-API DEEP DATA FETCHERS (CAST, RECS, TRAILERS)
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

    if (db && db.cachedMetadata && !isNaN(numericId)) {
      try {
        const cached = await db.cachedMetadata.get(numericId);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          renderCharactersFromAniList(cached.data.characters || []);
          renderRecommendationsFromAniList(cached.data.recommendations || []);
          if (cached.data.trailerId) renderTrailerIframe(cached.data.trailerId);
          return;
        }
      } catch (e) {}
    }

    if (win.STATE.isNetflixMode || (win.STATE.currentTMDBId && win.STATE.currentTMDBId !== 533535)) {
      try {
        const isMovie = anime.format === 'MOVIE';
        const endpoint = `https://db.speedracelight.com/3/${isMovie ? 'movie' : 'tv'}/${win.STATE.currentTMDBId}?append_to_response=credits,videos,recommendations`;
        const tmdbData = await fetchWithRetry(endpoint);

        if (tmdbData) {
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

    if (!win.STATE.isNetflixMode && (!charactersLoaded || !recommendationsLoaded || !trailerLoaded)) {
      if (!isNaN(numericId) && numericId > 0 && numericId < 300000) {
        try {
          const aniData = await fetchGQL(GQL_DEEP, { id: numericId });
          const media = aniData?.Media;

          if (media) {
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
            let ytTrailerId = null;
            if (!trailerLoaded && trailer?.site?.toLowerCase() === 'youtube' && trailer?.id) {
              renderTrailerIframe(trailer.id);
              trailerLoaded = true;
              ytTrailerId = trailer.id;
            }

            if (db && db.cachedMetadata) {
              db.cachedMetadata.put({
                id: numericId,
                data: { characters: edges, recommendations: recomms, trailerId: ytTrailerId },
                timestamp: Date.now()
              }).catch(() => {});
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

  function switchTab(tabId, btn) {
    doc.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    doc.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    doc.getElementById(tabId)?.classList.add('active');
    btn?.classList.add('active');
  }
  win.switchTab = switchTab;

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
          const searchUrl = cleanTMDBUrl(`/search/multi?query=${encodeURIComponent(q)}`);
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
  // 15. ANISKIP SKIP CHAPTER TELEMETRY (QUIET 404 ABSORBER)
  // ==========================================================================
  async function resolveAndPollAniSkip(malId, episode) {
    clearTimeout(aniSkipPollTimer);
    const skipBtn = doc.getElementById('aniSkipIntroBtn');
    if (skipBtn) skipBtn.style.display = 'none';
    aniSkipIntervals = [];

    if (!malId || win.STATE.isNetflixMode) return;

    try {
      // Quiet fetch: Missing skip offsets will not populate errors or retries
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
  // 16. AUDIO GAIN BOOSTER (WEB AUDIO API UP TO 250%)
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
