/**
 * ============================================================================
 * AnimeDrift Core Engine — Secure Edge Proxy Architecture
 * Production-Grade JavaScript Controller (Version 46.0.8 Resilient Architecture)
 * ============================================================================
 */

(function () {
  'use strict';
  try {
    if (window.__shield_active) return;
    window.__shield_active = true;

    const noopWarn = function (method) {
      console.warn(`[AnimeDrift Shield] Blocked unauthorized document.${method} invocation.`);
    };
    Object.defineProperty(document, 'write', { value: () => noopWarn('write'), writable: false, configurable: false });
    Object.defineProperty(document, 'writeln', { value: () => noopWarn('writeln'), writable: false, configurable: false });
  } catch (e) {}
})();

const CONFIG = {
  APIS: {
    ANILIST: 'https://graphql.anilist.co',
    KITSU: 'https://kitsu.io/api/edge',
    ANISKIP: 'https://api.aniskip.com/v2/skip-times',
    TMDB_PROXY: '/api/tmdb'
  },
  TMDB_GENRES: {
    ACTION: { movie: 28, tv: 10759 },
    ROMANCE: { movie: 10749, tv: 10766 },
    SCI_FI: { movie: 878, tv: 10765 },
    THRILLER_CRIME: { movie: 53, tv: 80 },
    ANIMATION_EXCLUDE_ID: 16
  },
  STORAGE_KEYS: {
    WATCHLIST: 'animedrift_watchlist_v6',
    HISTORY: 'animedrift_history_v6',
    PREFS: 'animedrift_prefs_v6',
    DUB_PREF: 'animedrift_dub_pref_v6',
    ACTIVE_SERVER: 'animedrift_active_server_v6'
  },
  DEFAULT_TMDB_FALLBACK: 533535
};
window.CONFIG = CONFIG;

// Flawlessly parses and isolates endpoint path from sub-query strings
function buildSecureTmdbUrl(endpointPath, customParams = {}) {
  let rawPath = String(endpointPath || '').replace(/^\/+/, '');
  if (rawPath.startsWith('3/')) rawPath = rawPath.replace(/^3\//, '');

  let pathOnly = rawPath;
  let queryString = '';

  if (rawPath.includes('?')) {
    const parts = rawPath.split('?');
    pathOnly = parts[0].replace(/\/+$/, '');
    queryString = parts.slice(1).join('?');
  } else {
    pathOnly = pathOnly.replace(/\/+$/, '');
  }

  const url = new URL(CONFIG.APIS.TMDB_PROXY, window.location.origin);
  url.searchParams.set('endpoint', pathOnly);

  if (queryString) {
    const embedded = new URLSearchParams(queryString);
    embedded.forEach((val, key) => url.searchParams.set(key, val));
  }

  if (pathOnly.startsWith('discover/')) {
    if (!url.searchParams.has('without_genres')) url.searchParams.set('without_genres', '16');
    if (!url.searchParams.has('vote_count.gte')) url.searchParams.set('vote_count.gte', '15');
    if (!url.searchParams.has('include_adult')) url.searchParams.set('include_adult', 'false');
  }

  for (const [key, value] of Object.entries(customParams)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
window.buildSecureTmdbUrl = buildSecureTmdbUrl;

(function () {
  'use strict';
  if (window.__AnimeDriftRequestGuard) return;

  const nativeFetch = window.fetch.bind(window);

  const GUARD = {
    minDelay: 500, maxConcurrent: 3, maxRetries: 2, cacheTTL: 5 * 60 * 1000,
    queue: [], active: 0, lastRequestAt: 0, cache: new Map(), pending: new Map(), circuitOpenUntil: 0
  };
  window.__AnimeDriftRequestGuard = GUARD;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function getUrl(input) { return typeof input === 'string' ? input : (input && input.url) || String(input); }

  function isProtectedAPI(url) {
    return url.includes('graphql.anilist.co') || url.includes('kitsu.io/api') || url.includes('api.aniskip.com') || url.includes('/api/tmdb');
  }

  function requestKey(url, method, body) {
    return `${method}:${url}:${body ? (typeof body === 'string' ? body : JSON.stringify(body)) : ''}`;
  }

  function enqueue(job) {
    return new Promise((resolve, reject) => { GUARD.queue.push({ job, resolve, reject }); drain(); });
  }

  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (GUARD.queue.length) {
        const item = GUARD.queue.shift();
        try { item.resolve(await runLimited(item.job)); } catch (e) { item.reject(e); }
      }
    } finally { draining = false; }
  }

  async function runLimited(job) {
    while (GUARD.active >= GUARD.maxConcurrent) await sleep(100);
    const now = Date.now();
    if (GUARD.circuitOpenUntil > now) await sleep(GUARD.circuitOpenUntil - now);
    const elapsed = Date.now() - GUARD.lastRequestAt;
    if (GUARD.minDelay - elapsed > 0) await sleep(GUARD.minDelay - elapsed);

    GUARD.active++;
    GUARD.lastRequestAt = Date.now();
    try { return await job(); } finally { GUARD.active--; }
  }

  async function guardedFetch(input, init = {}) {
    let url = getUrl(input);
    let method = String(init.method || 'GET').toUpperCase();
    let body = init.body;
    let headers = init.headers ? new Headers(init.headers) : new Headers();

    if (url.includes('db.speedracelight.com/3/')) {
      try {
        const parsed = new URL(url);
        const ep = parsed.pathname.replace(/^\/?3\/?/, '');
        const newUrl = new URL('/api/tmdb', window.location.origin);
        newUrl.searchParams.set('endpoint', ep);
        parsed.searchParams.forEach((v, k) => newUrl.searchParams.set(k, v));
        url = newUrl.toString();
        input = url;
      } catch (err) {}
    }

    const fetchInit = { ...init, method, headers };
    if (body) fetchInit.body = body;

    if (!isProtectedAPI(url)) return nativeFetch(url, fetchInit);

    const key = requestKey(url, method, body);
    if (GUARD.cache.has(key) && (Date.now() - GUARD.cache.get(key).timestamp < GUARD.cacheTTL)) {
      return GUARD.cache.get(key).response.clone();
    }
    if (GUARD.pending.has(key)) return (await GUARD.pending.get(key)).clone();

    const requestPromise = enqueue(async () => {
      let attempt = 0;
      while (attempt <= GUARD.maxRetries) {
        try {
          const response = await nativeFetch(url, fetchInit);
          if (response.status === 400 || response.status === 404) return response;
          if (response.status === 429) {
            let retryAfterMs = (Number(response.headers.get('Retry-After')) * 1000) || Math.min(20000, 4000 * Math.pow(2, attempt));
            GUARD.circuitOpenUntil = Date.now() + retryAfterMs + Math.floor(Math.random() * 1000);
            await sleep(retryAfterMs);
            attempt++; continue;
          }
          if (response.status >= 500 && attempt < GUARD.maxRetries) {
            await sleep(Math.min(8000, 1500 * Math.pow(2, attempt)));
            attempt++; continue;
          }
          if (response.ok) GUARD.cache.set(key, { timestamp: Date.now(), response: response.clone() });
          return response;
        } catch (error) {
          if (attempt >= GUARD.maxRetries) throw error;
          await sleep(Math.min(8000, 1200 * Math.pow(2, attempt)));
          attempt++;
        }
      }
    });

    GUARD.pending.set(key, requestPromise);
    try { return (await requestPromise).clone(); } finally { GUARD.pending.delete(key); }
  }

  window.fetch = guardedFetch;
})();

const SERVER_CONFIG = {
  1: { id: 1, name: 'Server 1 (NxSha Ultra 4K)', type: 'extractor', healthStatus: 'optimal', endpoint: (t, s, e, m) => m ? `https://nxsha.space/embed/movie/${t}?server=MbPly-[Multi-Lang]&lang=hi&color=netflix` : `https://nxsha.space/embed/tv/${t}/${s}/${e}?server=MbPly-[Multi-Lang]&lang=hi&color=netflix` },
  2: { id: 2, name: 'Server 2 (Filmu HD)', type: 'embed', healthStatus: 'optimal', endpoint: (t, s, e, m, a) => m ? `https://embed.filmu.in/movie/${t}` : (a && !window.STATE.isNetflixMode ? `https://embed.filmu.in/anime/${a}/${s}/${e}` : `https://embed.filmu.in/tv/${t}/${s}/${e}`) },
  3: { id: 3, name: 'Server 3 (VidCore)', type: 'embed', healthStatus: 'optimal', endpoint: (t, s, e, m) => m ? `https://vidcore.org/embed/movie/${t}?autoplay=true&theme=ff0844` : `https://vidcore.org/embed/tv/${t}/${s}/${e}?autoplay=true&theme=ff0844` },
  4: { id: 4, name: 'Server 4 (VidFast)', type: 'embed', healthStatus: 'optimal', endpoint: (t, s, e, m) => m ? `https://vidfast.vc/movie/${t}?autoPlay=true` : `https://vidfast.vc/tv/${t}/${s}/${e}?autoPlay=true&nextButton=true&autoNext=true` }
};
window.SERVER_CONFIG = SERVER_CONFIG;

window.animeCache = new Map();
window.episodeDataCache = new Map();
window.seriesSeasonsCache = new Map();
window.tmdbResolvedIdCache = new Map();

let STATE = {
  currentAnime: null, currentTMDBId: CONFIG.DEFAULT_TMDB_FALLBACK, season: 1, episode: 1, totalEpisodes: 1,
  availableSeasons: [], episodeBatchOffset: 0, activeServer: parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.ACTIVE_SERVER), 10) || 1,
  isTheaterMode: false, isNetflixMode: false, isSmartAutoPlayNext: true,
  defaultDubPref: localStorage.getItem(CONFIG.STORAGE_KEYS.DUB_PREF) || 'HINDI',
  watchlist: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.WATCHLIST) || '[]'),
  watchHistory: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.HISTORY) || '{}'),
  userPreferences: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PREFS) || '{"autoSkipIntro": true, "ambientAmbilight": true}'),
  isMobile: window.innerWidth <= 768
};
window.STATE = STATE;

class LocalStorageDatabase {
  constructor() { this.ready = false; this.init(); }
  init() {
    if (window.Dexie) {
      try {
        this.db = new window.Dexie('AnimeDriftDatabase');
        this.db.version(1).stores({ watchHistory: '&animeId, title, season, episode, timestamp, duration, updated, isFinished' });
        this.ready = true;
      } catch (err) {}
    }
  }
  async saveWatchProgress(animeId, meta) {
    if (!animeId) return;
    const duration = meta.duration || 1;
    const currentTime = meta.currentTime || 0;
    const entry = { animeId: String(animeId), title: STATE.currentAnime?.title?.english || 'Title', season: STATE.season, episode: STATE.episode, timestamp: currentTime, duration, progressPercent: Math.min(100, (currentTime / duration) * 100), updated: Date.now(), isFinished: (currentTime / duration) > 0.92 };
    STATE.watchHistory[animeId] = entry;
    localStorage.setItem(CONFIG.STORAGE_KEYS.HISTORY, JSON.stringify(STATE.watchHistory));
    if (this.ready && this.db) try { await this.db.watchHistory.put(entry); } catch (e) {}
  }
}
window.DB = new LocalStorageDatabase();

// Format TMDB media item to normalized schema
window.formatTmdbMediaItem = function(item, forceFormat = null) {
  const isMovie = forceFormat === 'MOVIE' || item.media_type === 'movie' || Boolean(item.title && !item.name);
  const title = item.title || item.name || 'Untitled';
  const poster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '';
  const backdrop = item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : poster;
  const rating = item.vote_average ? Math.round(item.vote_average * 10) : 82;
  const year = (item.release_date || item.first_air_date || '2026').slice(0, 4);

  return {
    id: item.id,
    idMal: null,
    tmdbId: item.id,
    title: { english: title, romaji: title, native: item.original_title || item.original_name || title },
    format: isMovie ? 'MOVIE' : 'TV',
    episodes: isMovie ? 1 : 16,
    description: item.overview || 'Synopsis not available for this live-action title.',
    coverImage: { extraLarge: poster, large: poster, medium: poster },
    bannerImage: backdrop,
    averageScore: rating,
    status: 'FINISHED',
    year: parseInt(year, 10) || 2026,
    isLiveAction: true
  };
};

window.fetchTmdbLiveActionRail = async function(endpoint, title, forceFormat = null) {
  try {
    const proxyUrl = buildSecureTmdbUrl(endpoint);
    const res = await fetch(proxyUrl);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || !data.results.length) return null;

    const cleanResults = data.results.filter(item => {
      const genres = item.genre_ids || [];
      return !genres.includes(CONFIG.TMDB_GENRES.ANIMATION_EXCLUDE_ID);
    });

    if (!cleanResults.length) return null;

    const list = cleanResults.map(item => {
      const formatted = window.formatTmdbMediaItem(item, forceFormat);
      window.animeCache.set(formatted.id, formatted);
      return formatted;
    });

    return { title, list };
  } catch (err) {
    return null;
  }
};

window.renderTmdbLiveActionHome = async function() {
  const contentRows = document.getElementById('contentRows');
  if (!contentRows) return;
  contentRows.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading Netflix Live-Action Catalog...</div>';

  const G = CONFIG.TMDB_GENRES;
  const rowConfigs = [
    { endpoint: 'discover/movie?sort_by=popularity.desc', title: 'Trending Movies Worldwide', format: 'MOVIE' },
    { endpoint: 'discover/tv?sort_by=popularity.desc', title: 'Top Binge-Worthy TV Series', format: 'TV' },
    { endpoint: 'discover/movie?with_original_language=hi&sort_by=popularity.desc', title: 'Bollywood & Hindi Cinema', format: 'MOVIE' },
    { endpoint: 'discover/tv?with_original_language=hi&sort_by=popularity.desc', title: 'Top Hindi Web Series & Dramas', format: 'TV' },
    { endpoint: 'discover/movie?with_original_language=te|ta&sort_by=popularity.desc', title: 'South Indian Cinema (Telugu & Tamil Hits)', format: 'MOVIE' },
    { endpoint: `discover/movie?with_genres=${G.ACTION.movie}&sort_by=popularity.desc`, title: 'Explosive Action & Thrillers', format: 'MOVIE' },
    { endpoint: `discover/tv?with_genres=${G.ACTION.tv}&sort_by=popularity.desc`, title: 'Action & Adventure Series', format: 'TV' },
    { endpoint: `discover/movie?with_genres=${G.SCI_FI.movie}&sort_by=popularity.desc`, title: 'Sci-Fi & High Concept Cinema', format: 'MOVIE' },
    { endpoint: `discover/movie?with_genres=${G.THRILLER_CRIME.movie}&sort_by=popularity.desc`, title: 'Gripping Crime & Mystery Thrillers', format: 'MOVIE' },
    { endpoint: `discover/movie?with_genres=${G.ROMANCE.movie}&sort_by=popularity.desc`, title: 'Romance & Heartwarming Dramas', format: 'MOVIE' }
  ];

  const rowPromises = rowConfigs.map(c => window.fetchTmdbLiveActionRail(c.endpoint, c.title, c.format));
  const rows = (await Promise.all(rowPromises)).filter(Boolean);

  if (!rows.length) {
    contentRows.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">Failed loading live-action catalog. Please verify connectivity.</div>';
    return;
  }

  if (rows[0] && rows[0].list && rows[0].list.length > 0) {
    const heroItem = rows[0].list[0];
    STATE.currentAnime = heroItem;
    STATE.currentTMDBId = heroItem.id;
    if (typeof window.updateHeroBillboard === 'function') {
      window.updateHeroBillboard(heroItem);
    }
  }

  contentRows.innerHTML = rows.map((r, i) => window.generateRowHTML(r.title, r.list, i)).join('');
};

window.generateRowHTML = function(title, items, rowIndex) {
  const cardsHTML = items.map(item => {
    const displayTitle = item.title?.english || item.title?.romaji || 'Title';
    const poster = item.coverImage?.large || item.coverImage?.extraLarge || '';
    const score = item.averageScore ? `${item.averageScore}%` : '85%';
    const format = item.format || 'TV';

    return `
      <div class="anime-card card ui-card-locked" 
           style="flex: 0 0 185px !important; min-width: 185px !important; max-width: 185px !important; height: 275px !important; position: relative !important; border-radius: 12px !important; overflow: hidden !important; cursor: pointer !important; transition: transform 0.28s ease, box-shadow 0.28s ease !important; user-select: none !important; background: #16161c !important;"
           onmouseover="this.style.transform='translateY(-4px) scale(1.03)'; this.style.boxShadow='0 14px 28px rgba(0,0,0,0.8)';"
           onmouseout="this.style.transform='translateY(0) scale(1)'; this.style.boxShadow='none';"
           onclick="if (typeof window.openModalById === 'function') window.openModalById(${item.id});">
        
        <img src="${poster}" alt="${displayTitle}" loading="lazy" style="width: 100% !important; height: 100% !important; object-fit: cover !important; display: block;" />
        <div class="card-badge" style="position: absolute !important; top: 8px !important; right: 8px !important; background: rgba(0,0,0,0.78) !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px !important; border-radius: 6px !important; z-index: 3 !important;">${format}</div>
        <div class="card-overlay" style="position: absolute !important; inset: auto 0 0 0 !important; width: 100% !important; padding: 42px 12px 10px 12px !important; background: linear-gradient(to top, rgba(4, 4, 6, 0.98) 0%, rgba(4, 4, 6, 0.72) 60%, transparent 100%) !important; z-index: 2 !important;">
          <div class="card-title" style="font-size: 13px !important; font-weight: 700 !important; color: #ffffff !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;">${displayTitle}</div>
          <div class="card-meta" style="font-size: 11px !important; color: #a1a1aa !important; margin-top: 4px !important;"><span style="color: #46d369 !important; font-weight: 700 !important;"><i class="fas fa-star" style="font-size: 9px;"></i> ${score}</span> &bull; ${item.year || '2026'}</div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="content-row" style="margin: 24px 0; padding: 0 4%;">
      <div class="row-header" style="margin-bottom: 12px;">
        <h2 class="row-title" style="font-size: 19px; font-weight: 800; color: #fff; letter-spacing: 0.2px;">${title}</h2>
      </div>
      <div class="carousel-container" style="position: relative; width: 100%; overflow: hidden;">
        <div class="carousel-rail" id="rail-${rowIndex}" 
             style="display: flex; gap: 14px; overflow-x: auto; scroll-behavior: smooth; padding: 6px 0 16px 0; -webkit-overflow-scrolling: touch; scrollbar-width: thin;">
          ${cardsHTML}
        </div>
      </div>
    </section>
  `;
};

const Router = {
  getURL() { try { return new URL(window.location.href); } catch { return null; } },
  getAll() { const url = this.getURL(); return url ? Object.fromEntries(url.searchParams.entries()) : {}; },
  get(param) { const url = this.getURL(); return url ? url.searchParams.get(param) : null; },
  set(params = {}, push = false) {
    const url = this.getURL(); if (!url) return;
    Object.keys(params).forEach(key => params[key] == null || params[key] === '' ? url.searchParams.delete(key) : url.searchParams.set(key, String(params[key])));
    if (url.href !== window.location.href) push ? window.history.pushState(Object.fromEntries(url.searchParams), '', url) : window.history.replaceState(Object.fromEntries(url.searchParams), '', url);
  },
  closeAllUI() { ['closeModal', 'closeWatchlistModal', 'closeScheduleModal', 'closeTraceMoeModal'].forEach(fn => { if (typeof window[fn] === 'function') window[fn](true); }); if(window.toggleMobileNav) window.toggleMobileNav(false, true); },
  async syncUIFromURL() {
    const p = this.getAll();
    if (p.mode === 'netflix' && !STATE.isNetflixMode) await window.toggleNetflixMode(true);
    else if (p.mode !== 'netflix' && STATE.isNetflixMode) await window.toggleNetflixMode(true);
    if (p.drawer === 'menu') window.toggleMobileNav(true, true);
    if (p.watch) {
      STATE.activeServer = parseInt(p.srv, 10) || STATE.activeServer;
      if (!STATE.currentAnime || STATE.currentAnime.id !== parseInt(p.watch, 10)) await window.openModalById(p.watch, p.ep || 1, p.s || 1);
    }
  }
};
window.Router = Router;
window.addEventListener('popstate', async () => { Router.closeAllUI(); await Router.syncUIFromURL(); });
