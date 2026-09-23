/**
 * ============================================================================
 * AnimeDrift — ADVANCED STREAMING UI (ENTERPRISE MASTER SYSTEM)
 * ============================================================================
 *
 * File:
 *    streaming-ui.js
 *
 * Version:
 *    44.0.5 High-Availability Parameter Normalizer & Edge Proxy Client
 *
 * Resolved Systems in this Build:
 *    - Query Param Splitter: Correctly separates `endpoint` paths from sub-queries (?with_genres, ?with_original_language),
 *      preventing URL-encoding bugs that caused identical shows across all category rows[cite: 5].
 *    - Multi-Language Regional Hub: Independent Discovery pipelines for Bollywood Hindi, Telugu, Tamil, Malayalam, and Korean.
 *    - Strict AniList GraphQL Variable Sanitization (Zero HTTP 400 Bad Requests).
 *    - Quiet Exception Handling for AniSkip Offsets (Suppresses unindexed 404 console spam).
 *    - Automated 24-Hour IndexedDB/Dexie Cache Eviction & LRU Garbage Collector[cite: 5].
 *    - Image Blob Storage Nexus for Instant Offline Posters & Zero Layout Shifts[cite: 5].
 *    - Netflix/Anime Dual-Universe Navigation & Clean Chip Synchronization[cite: 5].
 *    - Responsive 16:9 Thumbnail Episode Grid with Air-Dates & Dynamic Truncation[cite: 5].
 *    - 4-Tier Verified Mirror Cluster (NxSha Ultra, Filmu Native, VidCore, VidFast)[cite: 5].
 *    - Cross-Origin Font / Tracking Sandbox Isolation & PostMessage P2P Mesh Engine[cite: 5].
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

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24-Hour Horizon[cite: 5]
  const FALLBACK_POSTER = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22200%22%20height%3D%22300%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%2316161c%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20fill%3D%22%23666%22%20font-size%3D%2214%22%20text-anchor%3D%22middle%22%20alignment-baseline%3D%22middle%22%3ENo%20Image%3C%2Ftext%3E%3C%2Fsvg%3E';[cite: 5]

  // ==========================================================================
  // 02. INDEXEDDB PERSISTENCE (DEXIE.JS WITH 24H PRUNING ENGINE)
  // ==========================================================================
  const db = win.Dexie ? new win.Dexie('AnimeDriftUltraDB') : null;[cite: 5]
  if (db) {
    try {
      db.version(2).stores({
        watchHistory: 'id, animeId, title, season, episode, currentTime, duration, lastUpdated, isFinished',
        cachedQueries: 'key, data, timestamp',
        cachedMetadata: 'id, data, timestamp',
        cachedImages: 'url, blob, timestamp'
      });[cite: 5]
    } catch (e) {
      console.warn('[Storage Nexus] Dexie schema warning:', e);
    }
  }
  win.db = db;[cite: 5]

  win.pruneStaleStorageCache = async function () {
    if (!db) return;[cite: 5]
    const cutoff = Date.now() - CACHE_TTL_MS;[cite: 5]
    try {
      await Promise.allSettled([
        db.cachedQueries.where('timestamp').below(cutoff).delete(),
        db.cachedMetadata.where('timestamp').below(cutoff).delete(),
        db.cachedImages.where('timestamp').below(cutoff).delete()
      ]);[cite: 5]
      console.info('[Storage Nexus] 24-hour cache pruning cycle completed.');[cite: 5]
    } catch (err) {}
  };

  setTimeout(() => win.pruneStaleStorageCache(), 5000);[cite: 5]
  setInterval(() => win.pruneStaleStorageCache(), 60 * 60 * 1000);[cite: 5]

  // ==========================================================================
  // 03. SECURE DOM & STRING UTILITIES
  // ==========================================================================
  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');[cite: 5]
  }

  function cleanText(value) {
    return String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();[cite: 5]
  }

  function titleOf(anime) {
    return (
      anime?.title?.english ||
      anime?.title?.romaji ||
      anime?.title?.native ||
      anime?.name ||
      anime?.title ||
      'Unknown Title'
    );[cite: 5]
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
    );[cite: 5]
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
    );[cite: 5]
  }

  function formatRating(score) {
    const val = Number(score);[cite: 5]
    if (!Number.isFinite(val) || val <= 0) return 'N/A';[cite: 5]
    return val <= 10 ? `${Math.round(val * 10)}%` : `${Math.round(val)}%`;[cite: 5]
  }

  // ==========================================================================
  // 04. VERCEL SERVERLESS PROXY URL BUILDER (PARAMETER SEPARATION ENGINE)
  // ==========================================================================
  function cleanTMDBUrl(endpointPath, customParams = {}) {
    let raw = String(endpointPath || '').replace(/^\/+/, '');
    if (raw.startsWith('3/')) {
      raw = raw.replace(/^3\//, '');
    }

    // Split route from sub-query parameters to prevent URL-encoding corruption
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

    // Forward embedded query string parameters individually
    if (queryStr) {
      const embedded = new URLSearchParams(queryStr);
      embedded.forEach((val, key) => {
        url.searchParams.set(key, val);
      });
    }

    // Discover defaults
    if (path.startsWith('discover/')) {
      if (!url.searchParams.has('without_genres')) url.searchParams.set('without_genres', '16');
      if (!url.searchParams.has('vote_count.gte')) url.searchParams.set('vote_count.gte', '15');
    }

    // Forward function-level customParams
    for (const [key, value] of Object.entries(customParams)) {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  function enqueueGQL(taskFn) {
    gqlQueue = gqlQueue.then(async () => {
      const now = Date.now();[cite: 5]
      const elapsed = now - lastGqlRequestTime;[cite: 5]
      if (elapsed < GQL_MIN_INTERVAL_MS) {
        await new Promise(res => setTimeout(res, GQL_MIN_INTERVAL_MS - elapsed));[cite: 5]
      }
      lastGqlRequestTime = Date.now();[cite: 5]
      return taskFn();[cite: 5]
    }).catch(err => null);[cite: 5]
    return gqlQueue;[cite: 5]
  }

  async function fetchWithRetry(url, options = {}, retries = 2, delay = 1500) {
    let finalUrl = url;[cite: 5]
    if (typeof url === 'string' && url.includes('db.speedracelight.com/3/')) {
      try {
        const parsed = new URL(url);[cite: 5]
        const ep = parsed.pathname.replace(/^\/?3\/?/, '');[cite: 5]
        const newUrl = new URL('/api/tmdb', win.location.origin);[cite: 5]
        newUrl.searchParams.set('endpoint', ep);[cite: 5]
        parsed.searchParams.forEach((v, k) => newUrl.searchParams.set(k, v));[cite: 5]
        finalUrl = newUrl.toString();[cite: 5]
      } catch (e) {}
    }

    try {
      const response = await fetch(finalUrl, options);[cite: 5]

      if (response.status === 429) {
        const retryHeader = response.headers.get('Retry-After');[cite: 5]
        const waitSeconds = retryHeader ? parseInt(retryHeader, 10) : (delay / 1000);[cite: 5]
        if (retries > 0) {
          await new Promise(res => setTimeout(res, Math.max(waitSeconds, 2) * 1000));[cite: 5]
          return fetchWithRetry(finalUrl, options, retries - 1, delay * 2);[cite: 5]
        }
        return null;[cite: 5]
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 404 || response.status === 500) {
          return null;[cite: 5]
        }
        if (retries > 0) {
          await new Promise(res => setTimeout(res, delay));[cite: 5]
          return fetchWithRetry(finalUrl, options, retries - 1, delay * 2);[cite: 5]
        }
        return null;[cite: 5]
      }

      return await response.json();[cite: 5]
    } catch (error) {
      if (retries > 0) {
        await new Promise(res => setTimeout(res, delay));[cite: 5]
        return fetchWithRetry(finalUrl, options, retries - 1, delay * 2);[cite: 5]
      }
      return null;[cite: 5]
    }
  }
  win.fetchWithRetry = fetchWithRetry;[cite: 5]

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
  `;[cite: 5]

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
  `;[cite: 5]

  async function fetchGQL(query, rawVariables = {}) {
    const variables = {};
    for (const [key, value] of Object.entries(rawVariables)) {
      if (value !== null && value !== undefined && value !== '') {
        if (key === 'page' || key === 'perPage' || key === 'id') {
          const num = parseInt(value, 10);[cite: 5]
          if (!isNaN(num)) variables[key] = num;[cite: 5]
        } else if (key === 'sort') {
          if (Array.isArray(value) && value.length > 0) {
            variables[key] = value;[cite: 5]
          } else if (typeof value === 'string' && value.length > 0) {
            variables[key] = [value];[cite: 5]
          }
        } else if (typeof value === 'string' && value.trim().length > 0) {
          variables[key] = value.trim();[cite: 5]
        }
      }
    }

    const cacheKey = JSON.stringify({ query, variables });[cite: 5]

    if (queryCache.has(cacheKey)) {
      return queryCache.get(cacheKey);[cite: 5]
    }

    if (db && db.cachedQueries) {
      try {
        const cached = await db.cachedQueries.get(cacheKey);[cite: 5]
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          queryCache.set(cacheKey, cached.data);[cite: 5]
          return cached.data;[cite: 5]
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
        });[cite: 5]

        if (json?.data) {
          queryCache.set(cacheKey, json.data);[cite: 5]
          if (db && db.cachedQueries) {
            db.cachedQueries.put({ key: cacheKey, data: json.data, timestamp: Date.now() }).catch(() => {});[cite: 5]
          }
          setTimeout(() => queryCache.delete(cacheKey), CACHE_TTL_MS);[cite: 5]
          return json.data;[cite: 5]
        }
        return null;[cite: 5]
      } catch (err) {
        return null;[cite: 5]
      }
    });
  }
  win.fetchGQL = fetchGQL;[cite: 5]

  // ==========================================================================
  // 05. CACHED IMAGE BLOB INTERCEPTOR & WATCH TELEMETRY
  // ==========================================================================
  win.fetchCachedImageBlob = async function (imageUrl) {
    if (!imageUrl || imageUrl.startsWith('data:')) return imageUrl;[cite: 5]
    if (imageBlobCache.has(imageUrl)) return imageBlobCache.get(imageUrl);[cite: 5]

    if (db && db.cachedImages) {
      try {
        const cached = await db.cachedImages.get(imageUrl);[cite: 5]
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          const objUrl = URL.createObjectURL(cached.blob);[cite: 5]
          imageBlobCache.set(imageUrl, objUrl);[cite: 5]
          return objUrl;[cite: 5]
        }
      } catch (e) {}
    }

    try {
      const res = await fetch(imageUrl, { mode: 'cors' });[cite: 5]
      if (!res.ok) return imageUrl;[cite: 5]
      const blob = await res.blob();[cite: 5]
      const objUrl = URL.createObjectURL(blob);[cite: 5]
      imageBlobCache.set(imageUrl, objUrl);[cite: 5]

      if (db && db.cachedImages) {
        db.cachedImages.put({ url: imageUrl, blob, timestamp: Date.now() }).catch(() => {});[cite: 5]
      }
      return objUrl;[cite: 5]
    } catch (e) {
      return imageUrl;[cite: 5]
    }
  };

  win.recordWatchedEpisode = async function (animeId, season, episode, currentTime = 0, duration = 0, isFinished = false) {
    const recordKey = `${animeId}_${season}_${episode}`;[cite: 5]
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
    };[cite: 5]

    if (db && db.watchHistory) {
      try {
        await db.watchHistory.put(telemetry);[cite: 5]
      } catch (e) {}
    }
    win.STATE.watchHistory[recordKey] = telemetry;[cite: 5]
    try {
      localStorage.setItem('animedrift_history_v6', JSON.stringify(win.STATE.watchHistory));[cite: 5]
    } catch (e) {}

    const epCard = doc.querySelector(`.ep-modern-card[onclick*="switchEpisode(${episode})"]`);[cite: 5]
    if (epCard && telemetry.isFinished) {
      epCard.classList.add('watched');[cite: 5]
    }
  };

  win.isEpisodeWatched = function (animeId, season, episode) {
    const recordKey = `${animeId}_${season}_${episode}`;[cite: 5]
    return Boolean(win.STATE.watchHistory[recordKey]?.isFinished);[cite: 5]
  };

  // ==========================================================================
  // 06. CATEGORY SYNCHRONIZER & TAB ROUTER
  // ==========================================================================
  win.syncCategoryState = function (categoryKey) {
    const topLinks = doc.querySelectorAll('.nav-desktop .nav-link, .mobile-nav-list .mobile-nav-link');[cite: 5]
    const chips = doc.querySelectorAll('.chips-container .chip');[cite: 5]

    topLinks.forEach(l => l.classList.remove('active'));[cite: 5]
    chips.forEach(c => c.classList.remove('active'));[cite: 5]

    const normKey = (categoryKey || 'ALL').toUpperCase();[cite: 5]

    const targetChip = doc.querySelector(`.chip[data-filter="${normKey}"]`) ||
      doc.querySelector(`.chip[onclick*="'${normKey}'"]`) ||
      chips[0];[cite: 5]
    if (targetChip) targetChip.classList.add('active');[cite: 5]

    topLinks.forEach(l => {
      const text = l.innerText.toUpperCase();[cite: 5]
      if (normKey === 'ALL' && text.includes('HOME')) l.classList.add('active');[cite: 5]
      else if ((normKey === 'MOVIES' || normKey === 'MOVIE') && text.includes('MOVIES')) l.classList.add('active');[cite: 5]
      else if ((normKey === 'TOP_AIRING' || normKey === 'TV' || normKey === 'SHOWS') && (text.includes('TV') || text.includes('SHOWS'))) l.classList.add('active');[cite: 5]
      else if (normKey === 'HINDI' && text.includes('HINDI')) l.classList.add('active');[cite: 5]
      else if (normKey === 'ACTION' && text.includes('ACTION')) l.classList.add('active');[cite: 5]
      else if (normKey === 'THRILLER' && (text.includes('THRILLER') || text.includes('CRIME'))) l.classList.add('active');[cite: 5]
      else if (normKey === 'ROMANCE' && text.includes('ROMANCE')) l.classList.add('active');[cite: 5]
      else if (normKey === 'FANTASY' && text.includes('FANTASY')) l.classList.add('active');[cite: 5]
    });
  };

  // ==========================================================================
  // 07. HERO SPOTLIGHT & BILLBOARD ENGINE
  // ==========================================================================
  win.renderHeroSpotlight = async function () {
    const heroDubBadge = doc.querySelector('.hero-tags .tag-hindi');[cite: 5]

    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('discover/movie', {
          sort_by: 'popularity.desc',
          'vote_count.gte': '100'
        });[cite: 5]
        const data = await fetchWithRetry(url);[cite: 5]
        const item = data?.results?.[0];[cite: 5]
        if (item) {
          const title = item.title || item.name || 'Featured Live-Action';[cite: 5]
          const poster = item.backdrop_path
            ? `https://image.tmdb.org/t/p/original${item.backdrop_path}`
            : `https://image.tmdb.org/t/p/original${item.poster_path}`;[cite: 5]
          const isMovie = item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));[cite: 5]

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
          };[cite: 5]

          win.animeCache.set(mockMediaObj.id, mockMediaObj);[cite: 5]
          win.STATE.currentAnime = mockMediaObj;[cite: 5]
          win.STATE.currentTMDBId = mockMediaObj.id;[cite: 5]

          const heroBg = doc.getElementById('heroBg');[cite: 5]
          if (heroBg) {
            heroBg.src = poster;[cite: 5]
            if (typeof win.extractChromaAmbilight === 'function') {
              win.extractChromaAmbilight(poster);[cite: 5]
            }
          }

          const heroTitle = doc.getElementById('heroTitle');[cite: 5]
          const heroScore = doc.getElementById('heroScore');[cite: 5]
          const heroYear = doc.getElementById('heroYear');[cite: 5]
          const heroFormat = doc.getElementById('heroFormat');[cite: 5]
          const heroStatus = doc.getElementById('heroStatus');[cite: 5]
          const heroDesc = doc.getElementById('heroDesc');[cite: 5]
          const heroFormatBadge = doc.getElementById('heroFormatBadge');[cite: 5]

          if (heroTitle) heroTitle.innerText = title;[cite: 5]
          if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${mockMediaObj.averageScore}% Match`;[cite: 5]
          if (heroYear) heroYear.innerText = mockMediaObj.seasonYear;[cite: 5]
          if (heroFormat) heroFormat.innerText = mockMediaObj.format;[cite: 5]
          if (heroStatus) heroStatus.innerText = 'NETFLIX LIVE';[cite: 5]
          if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> NETFLIX LIVE SPOTLIGHT`;[cite: 5]

          if (heroDubBadge) {
            heroDubBadge.innerHTML = `<i class="fas fa-film"></i> 4K ULTRA HD / MULTI AUDIO`;[cite: 5]
          }

          if (heroDesc) heroDesc.innerText = win.cleanHTML ? win.cleanHTML(mockMediaObj.description) : mockMediaObj.description;[cite: 5]

          const playBtn = doc.getElementById('heroPlayBtn');[cite: 5]
          const infoBtn = doc.getElementById('heroInfoBtn');[cite: 5]
          const bookmarkBtn = doc.getElementById('heroBookmarkBtn');[cite: 5]

          if (playBtn) playBtn.onclick = () => win.openModal(mockMediaObj, 1, 1, true);[cite: 5]
          if (infoBtn) infoBtn.onclick = () => win.openModal(mockMediaObj, 1, 1, false);[cite: 5]
          if (bookmarkBtn) bookmarkBtn.onclick = () => win.toggleWatchlist(mockMediaObj);[cite: 5]
          return;
        }
      } catch (e) {}
    }

    // Anime Spotlight query[cite: 5]
    const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 1, sort: ['TRENDING_DESC'] });[cite: 5]
    const anime = data?.Page?.media?.[0];[cite: 5]
    if (!anime) return;[cite: 5]

    win.animeCache.set(anime.id, anime);[cite: 5]

    const title = anime.title?.english || anime.title?.romaji || 'Stream Master';[cite: 5]
    const banner = anime.bannerImage || anime.coverImage?.extraLarge;[cite: 5]

    const heroBg = doc.getElementById('heroBg');[cite: 5]
    if (heroBg) {
      heroBg.src = banner;[cite: 5]
      if (typeof win.extractChromaAmbilight === 'function') {
        win.extractChromaAmbilight(banner);[cite: 5]
      }
    }

    const heroTitle = doc.getElementById('heroTitle');[cite: 5]
    const heroScore = doc.getElementById('heroScore');[cite: 5]
    const heroYear = doc.getElementById('heroYear');[cite: 5]
    const heroFormat = doc.getElementById('heroFormat');[cite: 5]
    const heroStatus = doc.getElementById('heroStatus');[cite: 5]
    const heroDesc = doc.getElementById('heroDesc');[cite: 5]
    const heroFormatBadge = doc.getElementById('heroFormatBadge');[cite: 5]

    if (heroTitle) heroTitle.innerText = title;[cite: 5]
    if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 95}% Rating`;[cite: 5]
    if (heroYear) heroYear.innerText = anime.seasonYear || '2026';[cite: 5]
    if (heroFormat) heroFormat.innerText = anime.format || 'TV SERIES';[cite: 5]
    if (heroStatus) heroStatus.innerText = anime.status || 'AIRING';[cite: 5]
    if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> FEATURED SPOTLIGHT`;[cite: 5]

    if (heroDubBadge) {
      heroDubBadge.innerHTML = `<i class="fas fa-microphone"></i> HINDI / SUB / DUB`;[cite: 5]
    }

    if (heroDesc) heroDesc.innerText = win.cleanHTML ? win.cleanHTML(anime.description) : anime.description;[cite: 5]

    const playBtn = doc.getElementById('heroPlayBtn');[cite: 5]
    const infoBtn = doc.getElementById('heroInfoBtn');[cite: 5]
    const bookmarkBtn = doc.getElementById('heroBookmarkBtn');[cite: 5]

    if (playBtn) playBtn.onclick = () => win.openModal(anime, 1, 1, true);[cite: 5]
    if (infoBtn) infoBtn.onclick = () => win.openModal(anime, 1, 1, false);[cite: 5]
    if (bookmarkBtn) bookmarkBtn.onclick = () => win.toggleWatchlist(anime);[cite: 5]
  };

  // ==========================================================================
  // 08. STAGGERED CATALOG RAILS & SEPARATED REGIONAL FEEDS
  // ==========================================================================
  win.renderHomeRows = async function () {
    const content = doc.getElementById('contentRows');[cite: 5]
    if (content) content.innerHTML = '';[cite: 5]

    if (win.STATE.isNetflixMode) {
      if (typeof win.showToast === 'function') win.showToast('Loading Netflix Live-Action Universe...');[cite: 5]

      // Completely independent routes with discrete genre and language queries
      await renderTMDBRow('Trending Movies Worldwide', 'discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Bollywood Blockbusters & Hindi Cinema', 'discover/movie?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-language"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Top Hindi Web Series & Dramas', 'discover/tv?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
      await renderTMDBRow('South Indian Cinema (Telugu & Tamil Hits)', 'discover/movie?with_original_language=te|ta&sort_by=popularity.desc', '<i class="fas fa-fire"></i>', 'MOVIE');
      await renderTMDBRow('Trending TV Shows Worldwide', 'discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
      await renderTMDBRow('Explosive Action & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Sci-Fi & High Concept Cinema', 'discover/movie?with_genres=878&sort_by=popularity.desc', '<i class="fas fa-microchip"></i>', 'MOVIE');
      await renderTMDBRow('Gripping Crime & Mystery Thrillers', 'discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Romance & Heartwarming Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');[cite: 5]
      return;
    }

    // Anime catalog flow[cite: 5]
    await renderRow('Trending Masterpieces', { page: 1, perPage: 14, sort: ['TRENDING_DESC'] }, false);[cite: 5]
    await renderRow('Top 10 Global Anime Today', { page: 1, perPage: 10, sort: ['POPULARITY_DESC'] }, true);[cite: 5]
    await renderHindiDubRow();[cite: 5]
    await renderRow('Action & Shonen Hits', { page: 1, perPage: 14, genre: 'Action', sort: ['TRENDING_DESC'] }, false);[cite: 5]
    await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 14, genre: 'Fantasy', sort: ['TRENDING_DESC'] }, false);[cite: 5]
    await renderRow('Romance & Slice of Life', { page: 1, perPage: 14, genre: 'Romance', sort: ['SCORE_DESC'] }, false);[cite: 5]
  };

  async function renderRow(title, vars, isTop10 = false) {
    try {
      const data = await fetchGQL(GQL_BASIC, vars);[cite: 5]
      if (!data?.Page?.media?.length) return;[cite: 5]
      buildUnifiedCarouselDOM(title, data.Page.media, isTop10, false);[cite: 5]
    } catch (e) {}
  }
  win.renderRow = renderRow;[cite: 5]

  async function renderHindiDubRow() {
    const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 14, sort: ['FAVOURITES_DESC'] });[cite: 5]
    if (data?.Page?.media?.length) {
      buildUnifiedCarouselDOM('<i class="fas fa-language" style="color:var(--accent-red,#e50914);"></i> Premium Hindi Dubbed Anime', data.Page.media, false, true);[cite: 5]
    }
  }
  win.renderHindiDubRow = renderHindiDubRow;[cite: 5]

  async function renderTMDBRow(title, endpoint, iconHtml = '<i class="fas fa-clapperboard"></i>', forceFormat = null) {
    try {
      const sanitizedUrl = cleanTMDBUrl(endpoint);[cite: 5]
      const data = await fetchWithRetry(sanitizedUrl);[cite: 5]
      if (data?.results?.length) {
        const cleanResults = data.results.filter(item => {
          const genres = item.genre_ids || [];[cite: 5]
          return !genres.includes(16);[cite: 5]
        });
        if (cleanResults.length) {
          buildUnifiedTMDBRowDOM(title, cleanResults, iconHtml, forceFormat);[cite: 5]
        }
      }
    } catch (e) {}
  }

  function buildUnifiedCarouselDOM(title, items, isTop10 = false, isHindi = false) {
    const container = doc.getElementById('contentRows');[cite: 5]
    if (!container) return;[cite: 5]
    const section = doc.createElement('section');[cite: 5]
    section.className = 'row-section content-row';[cite: 5]
    section.style.cssText = 'margin: 28px 0; padding: 0 4%; position: relative; width: 100%; box-sizing: border-box;';[cite: 5]

    section.innerHTML = `
      <h2 class="row-header" style="font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 12px; letter-spacing: 0.3px;">${title}</h2>
      <div class="row-container carousel-container" style="position: relative; width: 100%; overflow: hidden;">
        <div class="carousel-track carousel-rail" style="display: flex; flex-wrap: nowrap; align-items: stretch; gap: 16px; overflow-x: auto; overflow-y: hidden; scroll-behavior: smooth; padding: 10px 4px 16px 4px; -webkit-overflow-scrolling: touch; scrollbar-width: thin;"></div>
      </div>
    `;[cite: 5]
    const track = section.querySelector('.carousel-track');[cite: 5]

    items.forEach((anime, idx) => {
      if (!anime) return;[cite: 5]
      win.animeCache.set(anime.id, anime);[cite: 5]

      const dispTitle = anime.title?.english || anime.title?.romaji || 'Anime';[cite: 5]
      const poster = anime.coverImage?.extraLarge || anime.coverImage?.large || FALLBACK_POSTER;[cite: 5]
      const score = anime.averageScore ? `${anime.averageScore}%` : '85%';[cite: 5]
      const year = anime.seasonYear || '2026';[cite: 5]
      const format = anime.format || 'TV';[cite: 5]

      const card = doc.createElement('div');[cite: 5]
      card.className = 'anime-card card ui-card-locked';[cite: 5]
      card.style.cssText = 'flex: 0 0 185px !important; min-width: 185px !important; max-width: 185px !important; height: 275px !important; position: relative !important; border-radius: 12px !important; overflow: hidden !important; cursor: pointer !important; transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s ease !important; user-select: none !important; background: #16161c !important; box-sizing: border-box !important; display: flex !important; flex-direction: column !important;';[cite: 5]

      card.onmouseenter = () => {
        card.style.transform = 'translateY(-4px) scale(1.03)';[cite: 5]
        card.style.boxShadow = '0 14px 28px rgba(0,0,0,0.8)';[cite: 5]
        if (!win.STATE.isNetflixMode && !queryCache.has(JSON.stringify({ query: GQL_DEEP, variables: { id: anime.id } }))) {
          fetchGQL(GQL_DEEP, { id: anime.id }).catch(() => {});[cite: 5]
        }
      };
      card.onmouseleave = () => {
        card.style.transform = 'translateY(0) scale(1)';[cite: 5]
        card.style.boxShadow = 'none';[cite: 5]
      };
      card.onclick = () => {
        if (track.dataset.isDragging === 'true') return;[cite: 5]
        handleAnimeClick(anime.id);[cite: 5]
      };

      let rankHTML = '';[cite: 5]
      if (isTop10) {
        rankHTML = `<div class="top10-rank" style="font-size: 3.8rem; font-weight: 900; position: absolute; left: -2px; bottom: 12px; z-index: 3; color: rgba(255,255,255,0.95); -webkit-text-stroke: 1px rgba(0,0,0,0.7);">${idx + 1}</div>`;[cite: 5]
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
      `;[cite: 5]
      track.appendChild(card);[cite: 5]
    });

    enableCarouselDrag(track);[cite: 5]
    container.appendChild(section);[cite: 5]
  }

  function buildUnifiedTMDBRowDOM(title, items, iconHtml = '<i class="fas fa-clapperboard"></i>', forceFormat = null) {
    const formattedItems = items.map(item => {
      const isMovie = forceFormat === 'MOVIE' || item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));[cite: 5]
      const dispTitle = item.title || item.name || 'Title';[cite: 5]
      const posterPath = item.poster_path || item.backdrop_path;[cite: 5]
      const poster = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : FALLBACK_POSTER;[cite: 5]
      return {
        id: item.id,
        title: { english: dispTitle, romaji: dispTitle },
        coverImage: { extraLarge: poster, large: poster },
        format: isMovie ? 'MOVIE' : 'TV',
        averageScore: Math.round((item.vote_average || 8) * 10),
        seasonYear: (item.release_date || item.first_air_date || '2026').split('-')[0],
        isLiveAction: true
      };[cite: 5]
    });

    buildUnifiedCarouselDOM(`<span style="color:var(--accent-red,#e50914); margin-right:8px;">${iconHtml}</span>${title}`, formattedItems, false, false);[cite: 5]
  }

  function enableCarouselDrag(slider) {
    if (!slider) return;[cite: 5]
    let isDown = false;[cite: 5]
    let startX, scrollLeft;[cite: 5]

    slider.addEventListener('mousedown', (e) => {
      isDown = true;[cite: 5]
      slider.dataset.isDragging = 'false';[cite: 5]
      startX = e.pageX - slider.offsetLeft;[cite: 5]
      scrollLeft = slider.scrollLeft;[cite: 5]
      slider.style.cursor = 'grabbing';[cite: 5]
    });

    slider.addEventListener('mouseleave', () => {
      isDown = false;[cite: 5]
      slider.style.cursor = 'default';[cite: 5]
      setTimeout(() => { slider.dataset.isDragging = 'false'; }, 50);[cite: 5]
    });

    slider.addEventListener('mouseup', () => {
      isDown = false;[cite: 5]
      slider.style.cursor = 'default';[cite: 5]
      setTimeout(() => { slider.dataset.isDragging = 'false'; }, 50);[cite: 5]
    });

    slider.addEventListener('mousemove', (e) => {
      if (!isDown) return;[cite: 5]
      const x = e.pageX - slider.offsetLeft;[cite: 5]
      const walk = (x - startX) * 1.5;[cite: 5]
      if (Math.abs(walk) > 6) {
        slider.dataset.isDragging = 'true';[cite: 5]
      }
      slider.scrollLeft = scrollLeft - walk;[cite: 5]
    });
  }

  function handleAnimeClick(animeId) {
    const anime = win.animeCache.get(animeId);[cite: 5]
    if (anime) win.openModal(anime);[cite: 5]
  }
  win.handleAnimeClick = handleAnimeClick;[cite: 5]

  // ==========================================================================
  // 09. CATEGORY NAVIGATION DISPATCHERS
  // ==========================================================================
  win.navigateGenre = async function (genre, title) {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);[cite: 5]

    const key = genre ? genre.toUpperCase() : 'ALL';[cite: 5]
    win.syncCategoryState(key);[cite: 5]

    const contentRows = doc.getElementById('contentRows');[cite: 5]
    if (contentRows) contentRows.innerHTML = '';[cite: 5]

    if (!genre) {
      await win.renderHomeRows();[cite: 5]
      win.scrollTo({ top: 0, behavior: 'smooth' });[cite: 5]
      return;[cite: 5]
    }

    if (typeof win.showToast === 'function') win.showToast(`Loading ${title}...`);[cite: 5]

    if (win.STATE.isNetflixMode) {
      if (genre === 'Movies' || genre === 'Movie') {
        await renderTMDBRow('Trending Feature Films', 'discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');[cite: 5]
        await renderTMDBRow('Top Rated Blockbusters', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=200', '<i class="fas fa-star"></i>', 'MOVIE');[cite: 5]
      } else if (genre === 'TV' || genre === 'TV Shows') {
        await renderTMDBRow('Top Binge TV Series', 'discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
        await renderTMDBRow('Critically Acclaimed Series', 'discover/tv?sort_by=vote_average.desc&vote_count.gte=100', '<i class="fas fa-star"></i>', 'TV');[cite: 5]
      } else if (genre === 'Action') {
        await renderTMDBRow('Action Movies & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');[cite: 5]
        await renderTMDBRow('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
      } else if (genre === 'Thriller' || genre === 'Thriller & Crime') {
        await renderTMDBRow('Gripping Crime & Mystery Films', 'discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');[cite: 5]
        await renderTMDBRow('Psychological Thriller Series', 'discover/tv?with_genres=80&sort_by=popularity.desc', '<i class="fas fa-user-secret"></i>', 'TV');[cite: 5]
      } else if (genre === 'Romance') {
        await renderTMDBRow('Romantic Comedies & Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');[cite: 5]
        await renderTMDBRow('Romantic TV Series', 'discover/tv?with_genres=10766&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
      } else if (genre === 'Hindi') {
        await win.loadHindiDubbed();[cite: 5]
      }
    } else {
      await renderRow(title, { page: 1, perPage: 24, genre, sort: ['TRENDING_DESC'] }, false);[cite: 5]
      await renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre, sort: ['SCORE_DESC'] }, false);[cite: 5]
    }

    win.scrollTo({ top: 350, behavior: 'smooth' });[cite: 5]
  };

  win.loadHindiDubbed = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);[cite: 5]
    win.syncCategoryState('HINDI');[cite: 5]

    const contentRows = doc.getElementById('contentRows');[cite: 5]
    if (contentRows) contentRows.innerHTML = '';[cite: 5]

    if (typeof win.showToast === 'function') win.showToast('Loading Hindi & Regional Indian Releases...');[cite: 5]

    if (win.STATE.isNetflixMode) {
      await renderTMDBRow('Hindi Blockbuster Movies', 'discover/movie?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Hindi Web Series & Dramas', 'discover/tv?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
      await renderTMDBRow('Telugu Action Blockbusters', 'discover/movie?with_original_language=te&sort_by=popularity.desc', '<i class="fas fa-fire"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Tamil Thrillers & Hits', 'discover/movie?with_original_language=ta&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');[cite: 5]
      await renderTMDBRow('Critically Acclaimed Hindi Cinema', 'discover/movie?with_original_language=hi&sort_by=vote_average.desc&vote_count.gte=50', '<i class="fas fa-star"></i>', 'MOVIE');[cite: 5]
    } else {
      await renderHindiDubRow();[cite: 5]
      await renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);[cite: 5]
      await renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['POPULARITY_DESC'] }, false);[cite: 5]
    }

    win.scrollTo({ top: 350, behavior: 'smooth' });[cite: 5]
  };

  win.applyQuickFilter = async function (type, chipBtn) {
    const contentRows = doc.getElementById('contentRows');[cite: 5]
    if (contentRows) contentRows.innerHTML = '';[cite: 5]

    const normType = (type || 'ALL').toUpperCase();[cite: 5]

    if (win.STATE.isNetflixMode) {
      switch (normType) {
        case 'ALL':
          win.syncCategoryState('ALL');[cite: 5]
          await win.renderHomeRows();[cite: 5]
          break;
        case 'MOVIES':
          win.syncCategoryState('MOVIES');[cite: 5]
          await renderTMDBRow('Trending Movies Worldwide', 'discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');[cite: 5]
          await renderTMDBRow('Critically Acclaimed Feature Films', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=200', '<i class="fas fa-star"></i>', 'MOVIE');[cite: 5]
          break;
        case 'TOP_AIRING':
        case 'SHOWS':
        case 'TV':
          win.syncCategoryState('TOP_AIRING');[cite: 5]
          await renderTMDBRow('Top Binge TV Series', 'discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
          await renderTMDBRow('All-Time Greatest TV Shows', 'discover/tv?sort_by=vote_average.desc&vote_count.gte=100', '<i class="fas fa-star"></i>', 'TV');[cite: 5]
          break;
        case 'HINDI':
          await win.loadHindiDubbed();[cite: 5]
          break;
        case 'ACTION':
          win.syncCategoryState('ACTION');[cite: 5]
          await renderTMDBRow('Action Movies & Adrenaline', 'discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');[cite: 5]
          await renderTMDBRow('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
          break;
        case 'THRILLER':
        case 'CRIME':
          win.syncCategoryState('THRILLER');[cite: 5]
          await renderTMDBRow('Crime & Mystery Thrillers', 'discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');[cite: 5]
          await renderTMDBRow('Psychological Drama Series', 'discover/tv?with_genres=80&sort_by=popularity.desc', '<i class="fas fa-user-secret"></i>', 'TV');[cite: 5]
          break;
        case 'SCI_FI':
          win.syncCategoryState('SCI_FI');[cite: 5]
          await renderTMDBRow('Sci-Fi Explorations & Cyberpunk', 'discover/movie?with_genres=878&sort_by=popularity.desc', '<i class="fas fa-microchip"></i>', 'MOVIE');[cite: 5]
          await renderTMDBRow('Sci-Fi & Futuristic TV Shows', 'discover/tv?with_genres=10765&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
          break;
        case 'ROMANCE':
          win.syncCategoryState('ROMANCE');[cite: 5]
          await renderTMDBRow('Romantic Comedies & Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');[cite: 5]
          await renderTMDBRow('Romantic Drama Series', 'discover/tv?with_genres=10766&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');[cite: 5]
          break;
      }
      win.scrollTo({ top: 350, behavior: 'smooth' });[cite: 5]
      return;[cite: 5]
    }

    switch (normType) {
      case 'ALL':
        win.syncCategoryState('ALL');[cite: 5]
        await win.renderHomeRows();[cite: 5]
        win.scrollTo({ top: 0, behavior: 'smooth' });[cite: 5]
        break;
      case 'HINDI':
        await win.loadHindiDubbed();[cite: 5]
        break;
      case 'TOP_AIRING':
        win.syncCategoryState('TOP_AIRING');[cite: 5]
        await renderRow('Top Airing Worldwide', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);[cite: 5]
        break;
      case 'MOVIES':
        win.syncCategoryState('MOVIES');[cite: 5]
        await renderRow('Anime Movies & Films', { page: 1, perPage: 24, sort: ['SCORE_DESC'] }, false);[cite: 5]
        break;
      case 'ACTION':
        win.syncCategoryState('ACTION');[cite: 5]
        await renderRow('Action & Shonen Hits', { page: 1, perPage: 24, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);[cite: 5]
        break;
      case 'SECONDARY':
        win.syncCategoryState('FANTASY');[cite: 5]
        await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 24, genre: 'Fantasy', sort: ['TRENDING_DESC'] }, false);[cite: 5]
        break;
      case 'SCI_FI':
        win.syncCategoryState('SCI_FI');[cite: 5]
        await renderRow('Sci-Fi & Cyberpunk', { page: 1, perPage: 24, genre: 'Sci-Fi', sort: ['SCORE_DESC'] }, false);[cite: 5]
        break;
      case 'ROMANCE':
        win.syncCategoryState('ROMANCE');[cite: 5]
        await renderRow('Romance & Slice of Life', { page: 1, perPage: 24, genre: 'Romance', sort: ['POPULARITY_DESC'] }, false);[cite: 5]
        break;
    }
    win.scrollTo({ top: 350, behavior: 'smooth' });[cite: 5]
  };

  win.playRandomAnime = async function () {
    if (typeof win.toggleMobileNav === 'function') win.toggleMobileNav(false);[cite: 5]
    if (typeof win.showToast === 'function') win.showToast('Rolling for a random title...');[cite: 5]

    if (win.STATE.isNetflixMode) {
      try {
        const url = cleanTMDBUrl('discover/movie', { sort_by: 'popularity.desc' });[cite: 5]
        const data = await fetchWithRetry(url);[cite: 5]
        const results = data?.results || [];[cite: 5]
        if (results.length > 0) {
          const item = results[Math.floor(Math.random() * results.length)];[cite: 5]
          const poster = `https://image.tmdb.org/t/p/w500${item.poster_path}`;[cite: 5]
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
          };[cite: 5]
          win.animeCache.set(mockMediaObj.id, mockMediaObj);[cite: 5]
          win.openModal(mockMediaObj, 1, 1, false);[cite: 5]
          return;[cite: 5]
        }
      } catch (e) {}
    }

    const randomPage = Math.floor(Math.random() * 20) + 1;[cite: 5]
    const data = await fetchGQL(GQL_BASIC, { page: randomPage, perPage: 10, sort: ['POPULARITY_DESC'] });[cite: 5]
    const list = data?.Page?.media || [];[cite: 5]

    if (list.length > 0) {
      const selected = list[Math.floor(Math.random() * list.length)];[cite: 5]
      win.animeCache.set(selected.id, selected);[cite: 5]
      win.openModal(selected, 1, 1, false);[cite: 5]
      if (typeof win.showToast === 'function') {
        win.showToast(`Selected: ${selected.title?.english || selected.title?.romaji}`);[cite: 5]
      }
    } else {
      if (typeof win.showToast === 'function') win.showToast('Failed to fetch a random title.');[cite: 5]
    }
  };

  // ==========================================================================
  // 10. CINEMATIC MODAL & MEDIA PRESENTATION
  // ==========================================================================
  win.openModalById = async function (id, episode = 1, season = 1) {
    let anime = win.animeCache.get(id);[cite: 5]
    if (!anime) {
      if (win.STATE.isNetflixMode) {
        try {
          const item = await fetchWithRetry(cleanTMDBUrl(`movie/${id}`));[cite: 5]
          if (item) anime = win.formatTmdbMediaItem?.(item, 'MOVIE');[cite: 5]
        } catch (e) {}
      } else {
        const data = await fetchGQL(GQL_DEEP, { id: parseInt(id, 10) });[cite: 5]
        anime = data?.Media;[cite: 5]
      }
    }
    if (anime) {
      await win.openModal(anime, season, episode, true, true);[cite: 5]
    }
  };

  win.openModal = async function (anime, season = 1, episode = 1, autoStart = false, skipUrlSync = false) {
    win.STATE.savedScrollY = win.scrollY;[cite: 5]
    win.STATE.currentAnime = anime;[cite: 5]

    const isMovie = anime.format === 'MOVIE';[cite: 5]
    const seasonInfo = win.extractSeasonInfo ? win.extractSeasonInfo(anime) : { season: 1, cleanTitle: anime.title?.english || '' };[cite: 5]
    win.STATE.season = isMovie ? 1 : (season || seasonInfo.season);[cite: 5]
    win.STATE.episode = isMovie ? 1 : (episode || 1);[cite: 5]

    const overlay = doc.getElementById('modalOverlay');[cite: 5]
    const container = doc.getElementById('modalContainer');[cite: 5]

    if (overlay) overlay.classList.add('active');[cite: 5]
    if (container) container.classList.add('active');[cite: 5]
    doc.documentElement.style.overflowY = 'hidden';[cite: 5]

    const overviewTabBtn = doc.querySelector('.modal-tabs .tab-btn');[cite: 5]
    if (overviewTabBtn) switchTab('tab-overview', overviewTabBtn);[cite: 5]

    if (typeof win.updateModalWatchlistButtonState === 'function') {
      win.updateModalWatchlistButtonState();[cite: 5]
    }

    const title = anime.title?.english || anime.title?.romaji || 'Title';[cite: 5]
    const banner = anime.bannerImage || anime.coverImage?.extraLarge || '';[cite: 5]

    const modalNowPlayingTitle = doc.getElementById('modalNowPlayingTitle');[cite: 5]
    const playerStreamTitle = doc.getElementById('playerStreamTitle');[cite: 5]
    const nextEpBtnText = doc.getElementById('nextEpBtnText');[cite: 5]
    const episodesMasterSection = doc.getElementById('episodesMasterSection');[cite: 5]

    if (isMovie) {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Feature Film`;[cite: 5]
      if (playerStreamTitle) playerStreamTitle.innerText = `Full Movie`;[cite: 5]
      if (nextEpBtnText) nextEpBtnText.innerText = `Full Film`;[cite: 5]
      if (episodesMasterSection) episodesMasterSection.style.display = 'none';[cite: 5]
    } else {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • S${win.STATE.season} Ep ${win.STATE.episode}`;[cite: 5]
      if (playerStreamTitle) playerStreamTitle.innerText = `Season ${win.STATE.season} • Episode ${win.STATE.episode}`;[cite: 5]
      if (nextEpBtnText) nextEpBtnText.innerText = `Next Ep`;[cite: 5]
      if (episodesMasterSection) episodesMasterSection.style.display = 'block';[cite: 5]
    }

    if (typeof win.extractChromaAmbilight === 'function') {
      win.extractChromaAmbilight(banner);[cite: 5]
    }

    const scoreEl = doc.getElementById('modalScore');[cite: 5]
    const yearEl = doc.getElementById('modalYear');[cite: 5]
    const formatEl = doc.getElementById('modalFormat');[cite: 5]
    const epCountEl = doc.getElementById('modalEpisodesCount');[cite: 5]
    const descEl = doc.getElementById('modalDesc');[cite: 5]
    const nativeEl = doc.getElementById('modalNative');[cite: 5]
    const statusEl = doc.getElementById('modalStatus');[cite: 5]
    const genresEl = doc.getElementById('modalGenres');[cite: 5]
    const studioEl = doc.getElementById('modalStudio');[cite: 5]
    const durationEl = doc.getElementById('modalDuration');[cite: 5]

    if (scoreEl) scoreEl.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 90}% Score`;[cite: 5]
    if (yearEl) yearEl.innerText = anime.seasonYear || anime.year || '2026';[cite: 5]
    if (formatEl) formatEl.innerText = anime.format || (isMovie ? 'MOVIE' : 'TV');[cite: 5]
    if (epCountEl) epCountEl.innerText = isMovie ? 'Feature Film' : `${anime.episodes || '?'} Episodes`;[cite: 5]
    if (descEl) descEl.innerText = win.cleanHTML ? win.cleanHTML(anime.description) : (anime.description || '');[cite: 5]
    if (nativeEl) nativeEl.innerText = anime.title?.native || 'N/A';[cite: 5]
    if (statusEl) statusEl.innerText = anime.status || 'FINISHED';[cite: 5]
    if (genresEl) genresEl.innerText = (anime.genres || []).join(', ');[cite: 5]
    if (studioEl) studioEl.innerText = anime.studios?.nodes?.[0]?.name || (anime.isLiveAction ? 'Netflix Production' : 'Studio Animation');[cite: 5]
    if (durationEl) durationEl.innerText = `${anime.duration || (isMovie ? 110 : 24)} mins`;[cite: 5]

    const wrap = doc.getElementById('modalPlayerWrap');[cite: 5]
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
      `;[cite: 5]
    }

    if (typeof win.resolveTMDBId === 'function') {
      await win.resolveTMDBId(seasonInfo.cleanTitle, isMovie);[cite: 5]
    }
    await fetchAndPopulateDeepData(anime);[cite: 5]

    if (!isMovie && typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();[cite: 5]
    if (anime.idMal && !win.STATE.isNetflixMode) resolveAndPollAniSkip(anime.idMal, win.STATE.episode);[cite: 5]
    if (typeof win.renderServerSwitcherGrid === 'function') win.renderServerSwitcherGrid();[cite: 5]
    checkAllServersHealth();[cite: 5]

    if (!skipUrlSync && win.Router) {
      win.Router.set({ watch: anime.id, s: win.STATE.season, ep: win.STATE.episode, srv: win.STATE.activeServer }, true);[cite: 5]
    }

    if (autoStart) win.executeStream(0);[cite: 5]

    if (win.p2pParty && win.p2pParty.isHost) {
      win.p2pParty.broadcastTitleChange(anime, win.STATE.season, win.STATE.episode, win.STATE.activeServer);[cite: 5]
    }
  };

  win.closeModal = function (skipUrlSync = false) {
    clearTimeout(streamLoadTimeout);[cite: 5]

    const modalContainer = doc.getElementById('modalContainer');[cite: 5]
    if (!modalContainer || !modalContainer.classList.contains('active')) return;[cite: 5]

    const modalOverlay = doc.getElementById('modalOverlay');[cite: 5]
    if (modalOverlay) modalOverlay.classList.remove('active');[cite: 5]
    modalContainer.classList.remove('active');[cite: 5]

    const wrap = doc.getElementById('modalPlayerWrap');[cite: 5]
    if (wrap) {
      const activeIframe = wrap.querySelector('iframe');[cite: 5]
      if (activeIframe) activeIframe.src = 'about:blank';[cite: 5]

      const activeVideo = wrap.querySelector('video');[cite: 5]
      if (activeVideo) {
        activeVideo.pause();[cite: 5]
        activeVideo.removeAttribute('src');[cite: 5]
        activeVideo.load();[cite: 5]
      }
      wrap.innerHTML = '';[cite: 5]
    }

    if (win.streamEngine) {
      win.streamEngine.destroy();[cite: 5]
      win.streamEngine = null;[cite: 5]
    }

    doc.documentElement.style.overflowY = 'scroll';[cite: 5]
    win.scrollTo(0, win.STATE.savedScrollY);[cite: 5]

    win.STATE.currentAnime = null;[cite: 5]
    if (!skipUrlSync && win.Router) {
      win.Router.set({ watch: null, s: null, ep: null, fs: null, srv: null });[cite: 5]
    }
  };

  // ==========================================================================
  // 11. STREAMING ENGINE DISPATCH (4 AUTONOMOUS NODES)
  // ==========================================================================
  win.executeStream = async function (retryCount = 0) {
    const wrap = doc.getElementById('modalPlayerWrap');[cite: 5]
    if (!wrap || !win.STATE.currentAnime) return;[cite: 5]

    clearTimeout(streamLoadTimeout);[cite: 5]

    const tId = win.STATE.currentTMDBId || win.CONFIG?.DEFAULT_TMDB_FALLBACK;[cite: 5]
    const s = win.STATE.season;[cite: 5]
    const e = win.STATE.episode;[cite: 5]
    const isMovie = win.STATE.currentAnime?.format === 'MOVIE';[cite: 5]
    const title = win.STATE.currentAnime?.title?.english || win.STATE.currentAnime?.title?.romaji || 'Title';[cite: 5]
    const poster = win.STATE.currentAnime?.coverImage?.extraLarge || win.STATE.currentAnime?.bannerImage || '';[cite: 5]

    const modalNowPlayingTitle = doc.getElementById('modalNowPlayingTitle');[cite: 5]
    const playerStreamTitle = doc.getElementById('playerStreamTitle');[cite: 5]

    if (isMovie) {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Feature Film`;[cite: 5]
      if (playerStreamTitle) playerStreamTitle.innerText = `Full Movie`;[cite: 5]
    } else {
      if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Season ${s} Episode ${e}`;[cite: 5]
      if (playerStreamTitle) playerStreamTitle.innerText = `Season ${s} • Episode ${e}`;[cite: 5]
    }

    const activeServerConfig = win.SERVER_CONFIG[win.STATE.activeServer] || win.SERVER_CONFIG[1];[cite: 5]

    if (win.streamEngine) {
      await win.streamEngine.destroy();[cite: 5]
      win.streamEngine = null;[cite: 5]
    }

    const streamUrl = activeServerConfig.endpoint(tId, s, e, isMovie, win.STATE.currentAnime.id);[cite: 5]

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
    `;[cite: 5]

    setupMediaSessionHooks(isMovie, title, s, e, poster);[cite: 5]

    if (typeof win.renderServerSwitcherGrid === 'function') win.renderServerSwitcherGrid();[cite: 5]
    if (!isMovie && typeof win.renderEpisodeGrid === 'function') win.renderEpisodeGrid();[cite: 5]

    const iframe = doc.getElementById('streamFrame');[cite: 5]
    iframe.onerror = () => handleAutoFailover(retryCount);[cite: 5]

    streamLoadTimeout = setTimeout(() => {
      if (retryCount < 4) {
        handleAutoFailover(retryCount);[cite: 5]
      }
    }, 6500);[cite: 5]

    iframe.onload = () => {
      clearTimeout(streamLoadTimeout);[cite: 5]
    };
  };

  function setupMediaSessionHooks(isMovie, title, s, e, poster) {
    if ('mediaSession' in navigator && win.STATE.currentAnime) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: isMovie ? title : `Episode ${e} - ${title}`,
        artist: isMovie ? 'Feature Film' : `Season ${s}`,
        album: 'AnimeDrift Ultra',
        artwork: [{ src: poster, sizes: '512x512', type: 'image/jpeg' }]
      });[cite: 5]

      navigator.mediaSession.setActionHandler('nexttrack', () => win.nextEpisode());[cite: 5]
    }
  }

  function handleAutoFailover(currentRetry) {
    clearTimeout(streamLoadTimeout);[cite: 5]
    const totalServers = Object.keys(win.SERVER_CONFIG).length;[cite: 5]
    const nextServer = (win.STATE.activeServer % totalServers) + 1;[cite: 5]
    win.STATE.activeServer = nextServer;[cite: 5]

    if (typeof win.showToast === 'function') {
      win.showToast(`Node error. Failing over to ${win.SERVER_CONFIG[nextServer].name}...`);[cite: 5]
    }
    win.executeStream(currentRetry + 1);[cite: 5]
  }

  async function checkAllServersHealth() {
    const tId = win.STATE.currentTMDBId || win.CONFIG?.DEFAULT_TMDB_FALLBACK;[cite: 5]
    const s = win.STATE.season;[cite: 5]
    const e = win.STATE.episode;[cite: 5]
    const isMovie = win.STATE.currentAnime?.format === 'MOVIE';[cite: 5]

    healthProbeAbortControllers.forEach(ctrl => {
      try { ctrl.abort(); } catch (err) {}[cite: 5]
    });
    healthProbeAbortControllers = [];[cite: 5]

    const serverUrls = {
      1: isMovie ? `https://nxsha.space/embed/movie/${tId}` : `https://nxsha.space/embed/tv/${tId}/${s}/${e}`,
      2: isMovie ? `https://embed.filmu.in/movie/${tId}` : `https://embed.filmu.in/tv/${tId}/${s}/${e}`,
      3: isMovie ? `https://vidcore.org/embed/movie/${tId}` : `https://vidcore.org/embed/tv/${tId}/${s}/${e}`,
      4: isMovie ? `https://vidfast.vc/movie/${tId}` : `https://vidfast.vc/tv/${tId}/${s}/${e}`
    };[cite: 5]

    const buttons = doc.querySelectorAll('.server-node-btn');[cite: 5]

    Object.keys(serverUrls).forEach(async srvKey => {
      const btn = buttons[parseInt(srvKey, 10) - 1];[cite: 5]
      const dot = btn?.querySelector('.server-status-dot');[cite: 5]
      if (!dot) return;[cite: 5]

      const controller = new AbortController();[cite: 5]
      healthProbeAbortControllers.push(controller);[cite: 5]

      const timeoutId = setTimeout(() => {
        try { controller.abort(); } catch (err) {}[cite: 5]
      }, 4500);[cite: 5]

      const startTime = performance.now();[cite: 5]
      try {
        await fetch(serverUrls[srvKey], { method: 'HEAD', mode: 'no-cors', cache: 'no-cache', signal: controller.signal });[cite: 5]
        clearTimeout(timeoutId);[cite: 5]
        const latency = Math.round(performance.now() - startTime);[cite: 5]

        if (latency > 2200) {
          dot.className = 'server-status-dot slow';[cite: 5]
        } else {
          dot.className = 'server-status-dot optimal';[cite: 5]
        }
      } catch (err) {
        clearTimeout(timeoutId);[cite: 5]
        dot.className = 'server-status-dot offline';[cite: 5]
      }
    });
  }
  win.checkAllServersHealth = checkAllServersHealth;[cite: 5]

  // ==========================================================================
  // 12. MULTI-API DEEP DATA FETCHERS (CAST, RECS, TRAILERS)
  // ==========================================================================
  async function fetchAndPopulateDeepData(anime) {
    const numericId = parseInt(anime.id, 10);[cite: 5]

    const castGrid = doc.getElementById('castGrid');[cite: 5]
    if (castGrid) castGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading cast...</div>';[cite: 5]

    const moreGrid = doc.getElementById('moreGrid');[cite: 5]
    if (moreGrid) moreGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading recommendations...</div>';[cite: 5]

    const trailersGrid = doc.getElementById('trailersGrid');[cite: 5]
    if (trailersGrid) trailersGrid.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Fetching trailers...</div>';[cite: 5]

    let charactersLoaded = false;[cite: 5]
    let recommendationsLoaded = false;[cite: 5]
    let trailerLoaded = false;[cite: 5]

    if (db && db.cachedMetadata && !isNaN(numericId)) {
      try {
        const cached = await db.cachedMetadata.get(numericId);[cite: 5]
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          renderCharactersFromAniList(cached.data.characters || []);[cite: 5]
          renderRecommendationsFromAniList(cached.data.recommendations || []);[cite: 5]
          if (cached.data.trailerId) renderTrailerIframe(cached.data.trailerId);[cite: 5]
          return;[cite: 5]
        }
      } catch (e) {}
    }

    if (win.STATE.isNetflixMode || (win.STATE.currentTMDBId && win.STATE.currentTMDBId !== 533535)) {
      try {
        const isMovie = anime.format === 'MOVIE';[cite: 5]
        const proxyUrl = cleanTMDBUrl(`${isMovie ? 'movie' : 'tv'}/${win.STATE.currentTMDBId}`, {
          append_to_response: 'credits,videos,recommendations'
        });[cite: 5]
        const tmdbData = await fetchWithRetry(proxyUrl);[cite: 5]

        if (tmdbData) {
          if (tmdbData.credits?.cast?.length) {
            renderCharactersFromTMDB(tmdbData.credits.cast);[cite: 5]
            charactersLoaded = true;[cite: 5]
          }
          if (tmdbData.videos?.results?.length) {
            const yt = tmdbData.videos.results.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));[cite: 5]
            if (yt?.key) {
              renderTrailerIframe(yt.key);[cite: 5]
              trailerLoaded = true;[cite: 5]
            }
          }
          if (tmdbData.recommendations?.results?.length) {
            const cleanRecs = tmdbData.recommendations.results.filter(r => !(r.genre_ids || []).includes(16));[cite: 5]
            if (cleanRecs.length) {
              renderRecommendationsFromTMDB(cleanRecs);[cite: 5]
              recommendationsLoaded = true;[cite: 5]
            }
          }
        }
      } catch (e) {}
    }

    if (!win.STATE.isNetflixMode && (!charactersLoaded || !recommendationsLoaded || !trailerLoaded)) {
      if (!isNaN(numericId) && numericId > 0 && numericId < 300000) {
        try {
          const aniData = await fetchGQL(GQL_DEEP, { id: numericId });[cite: 5]
          const media = aniData?.Media;[cite: 5]

          if (media) {
            const edges = media.characters?.edges || [];[cite: 5]
            if (!charactersLoaded && edges.length > 0) {
              renderCharactersFromAniList(edges);[cite: 5]
              charactersLoaded = true;[cite: 5]
            }

            const recomms = media.recommendations?.nodes || [];[cite: 5]
            if (!recommendationsLoaded && recomms.length > 0) {
              renderRecommendationsFromAniList(recomms);[cite: 5]
              recommendationsLoaded = true;[cite: 5]
            }

            const trailer = media.trailer || anime.trailer;[cite: 5]
            let ytTrailerId = null;[cite: 5]
            if (!trailerLoaded && trailer?.site?.toLowerCase() === 'youtube' && trailer?.id) {
              renderTrailerIframe(trailer.id);[cite: 5]
              trailerLoaded = true;[cite: 5]
              ytTrailerId = trailer.id;[cite: 5]
            }

            if (db && db.cachedMetadata) {
              db.cachedMetadata.put({
                id: numericId,
                data: { characters: edges, recommendations: recomms, trailerId: ytTrailerId },
                timestamp: Date.now()
              }).catch(() => {});[cite: 5]
            }
          }
        } catch (err) {}
      }
    }

    if (!charactersLoaded && castGrid) {
      castGrid.innerHTML = '<p style="color:var(--text-muted); padding:30px; text-align:center; grid-column:1/-1;">No cast information available.</p>';[cite: 5]
    }
    if (!recommendationsLoaded && moreGrid) {
      moreGrid.innerHTML = '<p style="color:var(--text-muted); padding:30px; text-align:center; grid-column:1/-1;">No recommendations found.</p>';[cite: 5]
    }
    if (!trailerLoaded && trailersGrid) {
      trailersGrid.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:40px;">No official trailer available.</p>';[cite: 5]
    }
  }

  function renderCharactersFromAniList(edges) {
    const castGrid = doc.getElementById('castGrid');[cite: 5]
    if (!castGrid) return;[cite: 5]
    castGrid.innerHTML = '';[cite: 5]
    edges.slice(0, 16).forEach(edge => {
      const charName = edge.node?.name?.full || 'Character';[cite: 5]
      const charImg = edge.node?.image?.large || FALLBACK_POSTER;[cite: 5]
      const vaName = edge.voiceActors?.[0]?.name?.full || 'Japanese Cast';[cite: 5]

      castGrid.innerHTML += `
        <div class="cast-card">
          <img src="${charImg}" alt="${charName}" onerror="this.src='${FALLBACK_POSTER}'" />
          <div class="cast-names">
            <h4>${charName}</h4>
            <p><i class="fas fa-microphone"></i> ${vaName}</p>
          </div>
        </div>
      `;[cite: 5]
    });
  }

  function renderCharactersFromTMDB(cast) {
    const castGrid = doc.getElementById('castGrid');[cite: 5]
    if (!castGrid) return;[cite: 5]
    castGrid.innerHTML = '';[cite: 5]
    cast.slice(0, 16).forEach(item => {
      const charName = item.character || item.name;[cite: 5]
      const img = item.profile_path ? `https://image.tmdb.org/t/p/w185${item.profile_path}` : FALLBACK_POSTER;[cite: 5]
      castGrid.innerHTML += `
        <div class="cast-card">
          <img src="${img}" alt="${charName}" onerror="this.src='${FALLBACK_POSTER}'" />
          <div class="cast-names">
            <h4>${charName}</h4>
            <p><i class="fas fa-user"></i> ${item.name}</p>
          </div>
        </div>
      `;[cite: 5]
    });
  }

  function renderRecommendationsFromAniList(nodes) {
    const moreGrid = doc.getElementById('moreGrid');[cite: 5]
    if (!moreGrid) return;[cite: 5]
    moreGrid.innerHTML = '';[cite: 5]
    nodes.forEach(recNode => {
      const rec = recNode.mediaRecommendation;[cite: 5]
      if (!rec) return;[cite: 5]
      win.animeCache.set(rec.id, rec);[cite: 5]
      const title = rec.title?.english || rec.title?.romaji || 'Anime';[cite: 5]
      const cover = rec.coverImage?.extraLarge || rec.coverImage?.large || FALLBACK_POSTER;[cite: 5]

      moreGrid.innerHTML += `
        <div class="anime-card card ui-card-locked" style="cursor:pointer;" onclick="handleAnimeClick(${rec.id})">
          <img src="${cover}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="border-radius:8px; width:100%; aspect-ratio:2/3; object-fit:cover;" />
          <div class="card-overlay"><div class="card-title">${title}</div></div>
          <div class="card-badge-top">${rec.format || 'TV'}</div>
        </div>
      `;[cite: 5]
    });
  }

  function renderRecommendationsFromTMDB(results) {
    const moreGrid = doc.getElementById('moreGrid');[cite: 5]
    if (!moreGrid) return;[cite: 5]
    moreGrid.innerHTML = '';[cite: 5]
    results.slice(0, 12).forEach(item => {
      const title = item.name || item.title;[cite: 5]
      const img = item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : FALLBACK_POSTER;[cite: 5]

      const isMovie = item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));[cite: 5]
      const mockAnime = {
        id: item.id,
        tmdbId: item.id,
        title: { romaji: title, english: title },
        coverImage: { extraLarge: img, large: img },
        format: isMovie ? 'MOVIE' : 'TV',
        episodes: isMovie ? 1 : 16,
        averageScore: Math.round((item.vote_average || 8) * 10),
        isLiveAction: true
      };[cite: 5]
      win.animeCache.set(item.id, mockAnime);[cite: 5]

      moreGrid.innerHTML += `
        <div class="anime-card card ui-card-locked" style="cursor:pointer;" onclick="handleAnimeClick(${item.id})">
          <img src="${img}" loading="lazy" onerror="this.src='${FALLBACK_POSTER}'" style="border-radius:8px; width:100%; aspect-ratio:2/3; object-fit:cover;" />
          <div class="card-overlay"><div class="card-title">${title}</div></div>
          <div class="card-badge-top">TMDB</div>
        </div>
      `;[cite: 5]
    });
  }

  function renderTrailerIframe(youtubeId) {
    const trailersGrid = doc.getElementById('trailersGrid');[cite: 5]
    if (!trailersGrid || !youtubeId) return;[cite: 5]
    trailersGrid.innerHTML = `
      <div class="modal-player-wrap" style="border-radius:12px; max-width:750px; margin:0 auto; aspect-ratio:16/9;">
        <iframe src="https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
      </div>
    `;[cite: 5]
  }

  function switchTab(tabId, btn) {
    doc.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));[cite: 5]
    doc.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));[cite: 5]
    doc.getElementById(tabId)?.classList.add('active');[cite: 5]
    btn?.classList.add('active');[cite: 5]
  }
  win.switchTab = switchTab;[cite: 5]

  // ==========================================================================
  // 13. REAL-TIME SEARCH AUTOCOMPLETE
  // ==========================================================================
  win.toggleSearch = function () {
    const wrapper = doc.getElementById('searchWrapper');[cite: 5]
    const input = doc.getElementById('searchInput');[cite: 5]
    if (!wrapper || !input) return;[cite: 5]
    wrapper.classList.toggle('open');[cite: 5]
    if (wrapper.classList.contains('open')) {
      input.focus();[cite: 5]
    } else {
      win.clearSearch();[cite: 5]
    }
  };

  win.clearSearch = function () {
    const input = doc.getElementById('searchInput');[cite: 5]
    if (input) input.value = '';[cite: 5]
    const drop = doc.getElementById('searchDropdown');[cite: 5]
    if (drop) drop.classList.remove('visible');[cite: 5]
    const clearBtn = doc.getElementById('searchClearBtn');[cite: 5]
    if (clearBtn) clearBtn.style.display = 'none';[cite: 5]
    if (win.Router) win.Router.set({ q: null });[cite: 5]
  };

  doc.getElementById('searchInput')?.addEventListener('input', (e) => {
    clearTimeout(win.STATE.searchDebounce);[cite: 5]
    const q = e.target.value.trim();[cite: 5]
    const drop = doc.getElementById('searchDropdown');[cite: 5]
    const clearBtn = doc.getElementById('searchClearBtn');[cite: 5]

    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';[cite: 5]

    if (!q) {
      if (drop) drop.classList.remove('visible');[cite: 5]
      if (win.Router) win.Router.set({ q: null });[cite: 5]
      return;[cite: 5]
    }

    if (win.Router && win.Router.get('q') !== q) {
      win.Router.set({ q }, false);[cite: 5]
    }

    win.STATE.searchDebounce = setTimeout(async () => {
      if (win.STATE.isNetflixMode) {
        try {
          const searchUrl = cleanTMDBUrl('search/multi', { query: q });[cite: 5]
          const data = await fetchWithRetry(searchUrl);[cite: 5]
          drop.innerHTML = '';[cite: 5]
          const results = (data?.results || []).filter(item => {
            const isMedia = item.media_type === 'movie' || item.media_type === 'tv';[cite: 5]
            const notAnime = !(item.genre_ids || []).includes(16);[cite: 5]
            return isMedia && notAnime;[cite: 5]
          }).slice(0, 6);[cite: 5]

          if (!results.length) {
            drop.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center;">No live-action titles found for "${escapeHTML(q)}"</div>`;[cite: 5]
            drop.classList.add('visible');[cite: 5]
            return;[cite: 5]
          }

          results.forEach(item => {
            const title = item.title || item.name;[cite: 5]
            const img = item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : FALLBACK_POSTER;[cite: 5]
            const isMovie = item.media_type === 'movie' || (!item.number_of_episodes && Boolean(item.title));[cite: 5]
            const mockMediaObj = {
              id: item.id,
              tmdbId: item.id,
              title: { romaji: title, english: title },
              coverImage: { extraLarge: img, large: img },
              format: isMovie ? 'MOVIE' : 'TV',
              episodes: isMovie ? 1 : 16,
              averageScore: Math.round((item.vote_average || 8) * 10),
              isLiveAction: true
            };[cite: 5]
            win.animeCache.set(item.id, mockMediaObj);[cite: 5]

            const el = doc.createElement('div');[cite: 5]
            el.className = 'search-item';[cite: 5]
            el.onclick = () => {
              win.openModal(mockMediaObj);[cite: 5]
              win.clearSearch();[cite: 5]
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
            `;[cite: 5]
            drop.appendChild(el);[cite: 5]
          });
          drop.classList.add('visible');[cite: 5]
          return;[cite: 5]
        } catch (e) {}
      }

      const data = await fetchGQL(GQL_BASIC, { search: q, perPage: 6 });[cite: 5]
      if (!drop) return;[cite: 5]
      drop.innerHTML = '';[cite: 5]

      if (!data || !data.Page?.media?.length) {
        drop.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center;">No anime found for "${escapeHTML(q)}"</div>`;[cite: 5]
        drop.classList.add('visible');[cite: 5]
        return;[cite: 5]
      }

      data.Page.media.forEach(anime => {
        win.animeCache.set(anime.id, anime);[cite: 5]
        const title = anime.title?.english || anime.title?.romaji || 'Anime';[cite: 5]
        const img = anime.coverImage?.large || anime.coverImage?.extraLarge || FALLBACK_POSTER;[cite: 5]
        const item = doc.createElement('div');[cite: 5]
        item.className = 'search-item';[cite: 5]
        item.onclick = () => {
          win.openModal(anime);[cite: 5]
          win.clearSearch();[cite: 5]
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
        `;[cite: 5]
        drop.appendChild(item);[cite: 5]
      });

      drop.classList.add('visible');[cite: 5]
    }, 300);[cite: 5]
  });

  // ==========================================================================
  // 14. SCHEDULER & REVERSE TRACE.MOE ENGINE
  // ==========================================================================
  const DAYS_MAP = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];[cite: 5]

  win.openScheduleModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('scheduleModal');[cite: 5]
    const overlay = doc.getElementById('scheduleModalOverlay');[cite: 5]
    if (!modal || !overlay) return;[cite: 5]

    modal.style.display = 'flex';[cite: 5]
    overlay.classList.add('active');[cite: 5]
    doc.documentElement.style.overflowY = 'hidden';[cite: 5]

    if (!skipUrlSync && win.Router) win.Router.set({ modal: 'schedule' }, true);[cite: 5]

    const todayIndex = new Date().getDay();[cite: 5]
    renderScheduleTabs(todayIndex);[cite: 5]
    loadJikanScheduleDay(DAYS_MAP[todayIndex]);[cite: 5]
  };

  win.closeScheduleModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('scheduleModal');[cite: 5]
    const overlay = doc.getElementById('scheduleModalOverlay');[cite: 5]
    if (modal && overlay && modal.style.display === 'flex') {
      modal.style.display = 'none';[cite: 5]
      overlay.classList.remove('active');[cite: 5]
      doc.documentElement.style.overflowY = 'scroll';[cite: 5]
      if (!skipUrlSync && win.Router) win.Router.set({ modal: null });[cite: 5]
    }
  };

  function renderScheduleTabs(activeIdx) {
    const tabs = doc.getElementById('scheduleDayTabs');[cite: 5]
    if (!tabs) return;[cite: 5]
    tabs.innerHTML = '';[cite: 5]
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];[cite: 5]

    dayNames.forEach((name, idx) => {
      const btn = doc.createElement('button');[cite: 5]
      btn.className = `modal-pill-btn ${idx === activeIdx ? 'next-ep-btn' : ''}`;[cite: 5]
      btn.innerText = name + (idx === new Date().getDay() ? ' (Today)' : '');[cite: 5]
      btn.onclick = () => {
        doc.querySelectorAll('#scheduleDayTabs button').forEach(b => b.classList.remove('next-ep-btn'));[cite: 5]
        btn.classList.add('next-ep-btn');[cite: 5]
        loadJikanScheduleDay(DAYS_MAP[idx]);[cite: 5]
      };
      tabs.appendChild(btn);[cite: 5]
    });
  }

  async function loadJikanScheduleDay(dayName) {
    const container = doc.getElementById('scheduleItemsContainer');[cite: 5]
    if (!container) return;[cite: 5]
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Fetching broadcast schedules...</div>';[cite: 5]

    try {
      const data = await fetchWithRetry(`${win.CONFIG?.APIS?.JIKAN || 'https://api.jikan.moe/v4'}/schedules?filter=${dayName}&limit=20`);[cite: 5]
      const items = data?.data || [];[cite: 5]
      container.innerHTML = '';[cite: 5]

      if (!items.length) {
        container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">No broadcast data found for this day.</div>';[cite: 5]
        return;[cite: 5]
      }

      items.forEach(anime => {
        const title = anime.title_english || anime.title;[cite: 5]
        const img = anime.images?.webp?.image_url || anime.images?.jpg?.image_url || FALLBACK_POSTER;[cite: 5]
        const time = anime.broadcast?.time || 'TBA';[cite: 5]

        const row = doc.createElement('div');[cite: 5]
        row.className = 'search-item';[cite: 5]
        row.style.borderRadius = '12px';[cite: 5]
        row.onclick = () => {
          win.closeScheduleModal();[cite: 5]
          searchAndOpenByTitle(title);[cite: 5]
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
        `;[cite: 5]
        container.appendChild(row);[cite: 5]
      });
    } catch (e) {
      container.innerHTML = `
        <div style="text-align:center; padding:30px; color:var(--accent-red,#e50914);">
          <p>Jikan API Gateway is busy.</p>
          <button class="btn btn-info" style="margin-top:12px; font-size:12px; padding:6px 14px;" onclick="loadJikanScheduleDay('${dayName}')">
            <i class="fas fa-rotate-right"></i> Retry
          </button>
        </div>
      `;[cite: 5]
    }
  }

  async function searchAndOpenByTitle(title) {
    const data = await fetchGQL(GQL_BASIC, { search: title, perPage: 1 });[cite: 5]
    const anime = data?.Page?.media?.[0];[cite: 5]
    if (anime) {
      win.openModal(anime, 1, 1, false);[cite: 5]
    } else {
      if (typeof win.showToast === 'function') {
        win.showToast(`Could not locate "${title}" in library.`);[cite: 5]
      }
    }
  }
  win.searchAndOpenByTitle = searchAndOpenByTitle;[cite: 5]

  win.openTraceMoeModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('traceMoeModal');[cite: 5]
    const overlay = doc.getElementById('traceMoeOverlay');[cite: 5]
    if (!modal || !overlay) return;[cite: 5]

    modal.style.display = 'flex';[cite: 5]
    overlay.classList.add('active');[cite: 5]
    doc.documentElement.style.overflowY = 'hidden';[cite: 5]

    if (!skipUrlSync && win.Router) win.Router.set({ modal: 'tracemoe' }, true);[cite: 5]
    win.addEventListener('paste', handleTraceClipboardPaste);[cite: 5]
  };

  win.closeTraceMoeModal = function (skipUrlSync = false) {
    const modal = doc.getElementById('traceMoeModal');[cite: 5]
    const overlay = doc.getElementById('traceMoeOverlay');[cite: 5]
    if (modal && overlay && modal.style.display === 'flex') {
      modal.style.display = 'none';[cite: 5]
      overlay.classList.remove('active');[cite: 5]
      doc.documentElement.style.overflowY = 'scroll';[cite: 5]
      if (!skipUrlSync && win.Router) win.Router.set({ modal: null });[cite: 5]
    }
    win.removeEventListener('paste', handleTraceClipboardPaste);[cite: 5]
  };

  function handleTraceClipboardPaste(e) {
    const items = e.clipboardData?.items;[cite: 5]
    if (!items) return;[cite: 5]
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();[cite: 5]
        executeTraceSearch(file);[cite: 5]
        break;[cite: 5]
      }
    }
  }

  win.handleTraceFileUpload = function (event) {
    const file = event.target.files?.[0];[cite: 5]
    if (file) executeTraceSearch(file);[cite: 5]
  };

  async function executeTraceSearch(fileBlob) {
    const resultsArea = doc.getElementById('traceResultsArea');[cite: 5]
    if (!resultsArea) return;[cite: 5]
    resultsArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--accent-cyan,#00d2ff);"><i class="fas fa-spinner fa-spin"></i> Analyzing frame...</div>';[cite: 5]

    const formData = new FormData();[cite: 5]
    formData.append('image', fileBlob);[cite: 5]

    try {
      const res = await fetch('https://api.trace.moe/search?anilistInfo', {
        method: 'POST',
        body: formData
      });[cite: 5]
      const data = await res.json();[cite: 5]
      const matches = data?.result || [];[cite: 5]
      resultsArea.innerHTML = '';[cite: 5]

      if (!matches.length) {
        resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-muted);">No match found.</div>';[cite: 5]
        return;[cite: 5]
      }

      const best = matches[0];[cite: 5]
      const similarity = Math.round(best.similarity * 100);[cite: 5]
      const title = best.anilist?.title?.english || best.anilist?.title?.romaji || best.filename;[cite: 5]
      const ep = best.episode || 1;[cite: 5]
      const timestamp = Math.floor(best.from || 0);[cite: 5]
      const timeMins = Math.floor(timestamp / 60) + ':' + ('0' + (timestamp % 60)).slice(-2);[cite: 5]

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
      `;[cite: 5]
    } catch (err) {
      resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--accent-red,#e50914);">Search failed.</div>';[cite: 5]
    }
  }

  // ==========================================================================
  // 15. ANISKIP SKIP CHAPTER TELEMETRY
  // ==========================================================================
  async function resolveAndPollAniSkip(malId, episode) {
    clearTimeout(aniSkipPollTimer);[cite: 5]
    const skipBtn = doc.getElementById('aniSkipIntroBtn');[cite: 5]
    if (skipBtn) skipBtn.style.display = 'none';[cite: 5]
    aniSkipIntervals = [];[cite: 5]

    if (!malId || win.STATE.isNetflixMode) return;[cite: 5]

    try {
      const res = await fetch(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&types[]=recap&episodeLength=1440`);[cite: 5]
      if (!res.ok) return;[cite: 5]
      const data = await res.json();[cite: 5]
      if (data?.found && data?.results?.length) {
        aniSkipIntervals = data.results;[cite: 5]
      }
    } catch (e) {}
  }
  win.resolveAndPollAniSkip = resolveAndPollAniSkip;[cite: 5]

  function handlePlayerTimeUpdate(currentTimeSeconds) {
    const skipBtn = doc.getElementById('aniSkipIntroBtn');[cite: 5]
    const label = doc.getElementById('aniSkipLabel');[cite: 5]
    if (!skipBtn || !aniSkipIntervals.length) return;[cite: 5]

    const activeInterval = aniSkipIntervals.find(item =>
      currentTimeSeconds >= item.interval.startTime && currentTimeSeconds <= item.interval.endTime
    );[cite: 5]

    if (activeInterval) {
      const type = activeInterval.skipType.toUpperCase();[cite: 5]
      if (label) label.innerText = `Skip ${type === 'OP' ? 'Opening' : type === 'ED' ? 'Ending' : 'Recap'}`;[cite: 5]
      skipBtn.style.display = 'inline-flex';[cite: 5]
      skipBtn.dataset.targetTime = activeInterval.interval.endTime;[cite: 5]
    } else {
      skipBtn.style.display = 'none';[cite: 5]
    }
  }

  win.triggerAniSkipJump = function () {
    const skipBtn = doc.getElementById('aniSkipIntroBtn');[cite: 5]
    const targetTime = parseFloat(skipBtn?.dataset?.targetTime);[cite: 5]
    if (!isNaN(targetTime)) {
      const video = doc.getElementById('nativeStreamVideo');[cite: 5]
      if (video) {
        video.currentTime = targetTime;[cite: 5]
      } else {
        const iframe = doc.getElementById('streamFrame');[cite: 5]
        if (iframe) {
          iframe.contentWindow?.postMessage({ type: 'SEEK_TO', time: targetTime }, '*');[cite: 5]
        }
      }

      skipBtn.style.display = 'none';[cite: 5]
      if (typeof win.showToast === 'function') {
        win.showToast(`Skipped to ${Math.floor(targetTime)}s`);[cite: 5]
      }

      if (win.p2pParty) {
        win.p2pParty.sendSeek(targetTime);[cite: 5]
      }
    }
  };

  // ==========================================================================
  // 16. AUDIO GAIN BOOSTER (UP TO 250%)
  // ==========================================================================
  win.toggleAudioVolumeBooster = function () {
    const levels = [1.0, 1.5, 2.0, 2.5];[cite: 5]
    const nextIdx = (levels.indexOf(currentAudioGainLevel) + 1) % levels.length;[cite: 5]
    currentAudioGainLevel = levels[nextIdx];[cite: 5]

    const label = doc.getElementById('audioBoosterLabel');[cite: 5]
    if (label) label.innerText = `${Math.round(currentAudioGainLevel * 100)}% Volume`;[cite: 5]

    if (win.streamEngine && typeof win.streamEngine.setVolumeBoost === 'function') {
      win.streamEngine.setVolumeBoost(currentAudioGainLevel);[cite: 5]
    } else {
      try {
        if (!audioCtx) {
          audioCtx = new (win.AudioContext || win.webkitAudioContext)();[cite: 5]
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();[cite: 5]
        }
        if (gainNode) {
          gainNode.gain.setValueAtTime(currentAudioGainLevel, audioCtx.currentTime);[cite: 5]
        }
      } catch (e) {}
    }

    if (typeof win.showToast === 'function') {
      win.showToast(`Audio Boost: ${Math.round(currentAudioGainLevel * 100)}%`);[cite: 5]
    }

    if (win.p2pParty && win.p2pParty.isHost) {
      win.p2pParty.broadcastAudioBoost(currentAudioGainLevel);[cite: 5]
    }
  };

  // ==========================================================================
  // 17. DEEP LINKING & EPISODE SHARER
  // ==========================================================================
  win.shareCurrentTitleLink = function () {
    if (win.Router && win.STATE.currentAnime) {
      win.Router.set({ watch: win.STATE.currentAnime.id, s: win.STATE.season, ep: win.STATE.episode }, false);[cite: 5]
    }
    navigator.clipboard.writeText(win.location.href);[cite: 5]
    if (typeof win.showToast === 'function') {
      win.showToast('Direct title link copied!');[cite: 5]
    }
  };

  win.shareDeepLinkEpisode = function () {
    if (win.Router && win.STATE.currentAnime) {
      win.Router.set({ watch: win.STATE.currentAnime.id, s: win.STATE.season, ep: win.STATE.episode }, false);[cite: 5]
    }
    navigator.clipboard.writeText(win.location.href);[cite: 5]
    if (typeof win.showToast === 'function') {
      win.showToast(`Episode ${win.STATE.episode} link copied!`);[cite: 5]
    }
  };

  // ==========================================================================
  // 18. SYNCHRONIZED PLAYER POSTMESSAGE EVENT LISTENER
  // ==========================================================================
  win.addEventListener('message', ({ data }) => {
    if (data && data.type === 'PLAYER_EVENT') {
      const ev = data.data;[cite: 5]
      if (ev && typeof ev.currentTime === 'number') {
        handlePlayerTimeUpdate(ev.currentTime);[cite: 5]

        if (win.STATE.currentAnime) {
          const isFin = Boolean(ev.duration > 0 && ev.currentTime / ev.duration > 0.90);[cite: 5]
          win.recordWatchedEpisode(
            win.STATE.currentAnime.id,
            win.STATE.season,
            win.STATE.episode,
            ev.currentTime,
            ev.duration || 0,
            isFin
          );[cite: 5]
        }

        if (win.p2pParty) {
          win.p2pParty.lastKnownTime = ev.currentTime;[cite: 5]

          if (ev.state === 'playing') {
            win.p2pParty.notifyBufferStatus(false);[cite: 5]
            win.p2pParty.sendPlay(ev.currentTime);[cite: 5]
          } else if (ev.state === 'paused') {
            win.p2pParty.sendPause(ev.currentTime);[cite: 5]
          } else if (ev.state === 'buffering') {
            win.p2pParty.notifyBufferStatus(true);[cite: 5]
          }
        }
      }
    }
  });

})();
