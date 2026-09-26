/**
 * ============================================================================
 * AnimeDrift Core Engine — Secure Edge Proxy Architecture
 * Production-Grade JavaScript Controller (Version 58.0.0 Resilient Architecture)
 * ============================================================================
 */

// ============================================================================
// 0. ANTI-WIPE DOM PROTECTION SHIELD
// ============================================================================
(function () {
  'use strict';
  try {
    if (window.__shield_active) return;
    window.__shield_active = true;

    const noopWarn = function (method) {
      console.warn(`[AnimeDrift Shield] Blocked unauthorized document.${method} invocation.`);
    };

    Object.defineProperty(document, 'write', {
      value: () => noopWarn('write'),
      writable: false,
      configurable: false
    });

    Object.defineProperty(document, 'writeln', {
      value: () => noopWarn('writeln'),
      writable: false,
      configurable: false
    });
  } catch (e) {
    console.error('[AnimeDrift Shield] Initialization failed:', e);
  }
})();

// ============================================================================
// 1. GLOBAL CONSTANTS, TAXONOMY & SERVER CONFIGURATION
// ============================================================================
const CONFIG = {
  APIS: {
    ANILIST: 'https://graphql.anilist.co',
    KITSU: 'https://kitsu.io/api/edge',
    ANISKIP: 'https://api.aniskip.com/v2/skip-times',
    TMDB_PROXY: '/api/tmdb' // Secure Vercel Serverless Edge Gateway
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

// ============================================================================
// 1.1 SECURE TMDB URL BUILDER (QUERY PARAMETER SEPARATION ENGINE)
// ============================================================================
function buildSecureTmdbUrl(endpointPath, customParams = {}) {
  let rawPath = String(endpointPath || '').replace(/^\/+/, '');
  if (rawPath.startsWith('3/')) {
    rawPath = rawPath.replace(/^3\//, '');
  }

  // Force clean separation of route path and query string to prevent %3F escaping
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

  // Parse and append embedded query strings seamlessly
  if (queryString) {
    const embedded = new URLSearchParams(queryString);
    embedded.forEach((val, key) => {
      url.searchParams.set(key, val);
    });
  }

  // Smart Discovery Defaults without dropping regional Indian titles
  if (pathOnly.startsWith('discover/')) {
    if (!url.searchParams.has('without_genres')) url.searchParams.set('without_genres', '16');
    if (!url.searchParams.has('include_adult')) url.searchParams.set('include_adult', 'false');
    if (!url.searchParams.has('include_video')) url.searchParams.set('include_video', 'false');
    if (!url.searchParams.has('language')) url.searchParams.set('language', 'en-US');

    // Only apply global vote_count threshold to non-regional feeds
    if (
      !url.searchParams.has('vote_count.gte') &&
      !url.searchParams.has('with_original_language') &&
      !url.searchParams.has('with_origin_country')
    ) {
      url.searchParams.set('vote_count.gte', '15');
    }
  }

  // Explicit function-level Custom Params
  for (const [key, value] of Object.entries(customParams)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}
window.buildSecureTmdbUrl = buildSecureTmdbUrl;

// ============================================================================
// 2. ADVANCED CIRCUIT BREAKER & API REQUEST RATE-LIMIT GUARD
// ============================================================================
(function () {
  'use strict';
  if (window.__AnimeDriftRequestGuard) return;

  const nativeFetch = window.fetch.bind(window);

  const GUARD = {
    minDelay: 420,
    maxConcurrent: 4,
    maxRetries: 2,
    cacheTTL: 5 * 60 * 1000,
    queue: [],
    active: 0,
    lastRequestAt: 0,
    cache: new Map(),
    pending: new Map(),
    circuitOpenUntil: 0
  };

  window.__AnimeDriftRequestGuard = GUARD;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function getUrl(input) {
    return typeof input === 'string' ? input : (input && input.url) || String(input);
  }

  function isProtectedAPI(url) {
    return (
      url.includes('graphql.anilist.co') ||
      url.includes('kitsu.io/api') ||
      url.includes('api.aniskip.com') ||
      url.includes('/api/tmdb')
    );
  }

  function requestKey(url, method, body) {
    let bodyHash = '';
    if (body) {
      bodyHash = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return `${method}:${url}:${bodyHash}`;
  }

  function enqueue(job) {
    return new Promise((resolve, reject) => {
      GUARD.queue.push({ job, resolve, reject });
      drain();
    });
  }

  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      while (GUARD.queue.length) {
        const item = GUARD.queue.shift();
        try {
          const result = await runLimited(item.job);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      draining = false;
    }
  }

  async function runLimited(job) {
    while (GUARD.active >= GUARD.maxConcurrent) {
      await sleep(80);
    }

    const now = Date.now();
    if (GUARD.circuitOpenUntil > now) {
      const waitTime = GUARD.circuitOpenUntil - now;
      console.warn(`[AnimeDrift Guard] Circuit Open. Pausing for ${waitTime}ms.`);
      await sleep(waitTime);
    }

    const elapsed = Date.now() - GUARD.lastRequestAt;
    const remaining = GUARD.minDelay - elapsed;
    if (remaining > 0) {
      await sleep(remaining);
    }

    GUARD.active++;
    GUARD.lastRequestAt = Date.now();

    try {
      return await job();
    } finally {
      GUARD.active--;
    }
  }

  async function guardedFetch(input, init = {}) {
    let url = getUrl(input);
    const method = String(init.method || 'GET').toUpperCase();

    // Reroute legacy direct TMDB calls securely through the Vercel Proxy
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

    if (!isProtectedAPI(url)) {
      return nativeFetch(input, init);
    }

    const key = requestKey(url, method, init.body);
    const cached = GUARD.cache.get(key);

    if (cached && (Date.now() - cached.timestamp < GUARD.cacheTTL)) {
      return cached.response.clone();
    }

    if (GUARD.pending.has(key)) {
      const pendingResponse = await GUARD.pending.get(key);
      return pendingResponse.clone();
    }

    const requestPromise = enqueue(async () => {
      let attempt = 0;

      while (attempt <= GUARD.maxRetries) {
        try {
          const response = await nativeFetch(input, init);

          if (response.status === 400 || response.status === 404) {
            return response;
          }

          if (response.status === 429) {
            let retryAfterMs = Number(response.headers.get('Retry-After')) * 1000;
            if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
              retryAfterMs = Math.min(18000, 3000 * Math.pow(2, attempt));
            }
            retryAfterMs += Math.floor(Math.random() * 800);

            GUARD.circuitOpenUntil = Date.now() + retryAfterMs;
            console.warn(`[AnimeDrift Guard] 429 rate limit hit. Throttling for ${retryAfterMs}ms.`);

            await sleep(retryAfterMs);
            attempt++;
            continue;
          }

          if (response.status >= 500 && attempt < GUARD.maxRetries) {
            const retryDelay = Math.min(8000, 1500 * Math.pow(2, attempt));
            await sleep(retryDelay);
            attempt++;
            continue;
          }

          if (response.ok) {
            GUARD.cache.set(key, {
              timestamp: Date.now(),
              response: response.clone()
            });
          }

          return response;
        } catch (error) {
          if (attempt >= GUARD.maxRetries) {
            throw error;
          }
          const retryDelay = Math.min(8000, 1200 * Math.pow(2, attempt));
          await sleep(retryDelay);
          attempt++;
        }
      }

      throw new Error('API request failed after retries exhausted.');
    });

    GUARD.pending.set(key, requestPromise);

    try {
      const response = await requestPromise;
      return response.clone();
    } finally {
      GUARD.pending.delete(key);
    }
  }

  window.fetch = guardedFetch;

  GUARD.clearCache = function () {
    GUARD.cache.clear();
  };

  GUARD.clearRequest = function (url, method = 'GET', body = null) {
    GUARD.cache.delete(requestKey(url, method, body));
  };
})();

// ============================================================================
// 3. STREAM SERVER CONFIGURATION & MULTI-ROUTE MATRIX
// ============================================================================
const SERVER_CONFIG = {
  1: {
    id: 1,
    name: 'Server 1 (NxSha Ultra 4K)',
    caption: 'Server 1 (NxSha Ultra CDN - Default Hindi Dubbed 4K)',
    type: 'extractor',
    subHost: 'MbPly-[Multi-Lang]',
    healthStatus: 'optimal',
    latency: null,
    endpoint: (tmdbId, season, ep, isMovie, anilistId) => {
      const base = 'https://nxsha.space';
      const params = 'server=MbPly-[Multi-Lang]&lang=hi&color=netflix&disable_app_ad=true';
      return isMovie
        ? `${base}/embed/movie/${tmdbId}?${params}`
        : `${base}/embed/tv/${tmdbId}/${season}/${ep}?${params}`;
    }
  },
  2: {
    id: 2,
    name: 'Server 2 (Filmu Native HD)',
    caption: 'Server 2 (Filmu Ultra HD - Dedicated Multi-Route Master)',
    type: 'embed',
    healthStatus: 'optimal',
    latency: null,
    endpoint: (tmdbId, season, ep, isMovie, anilistId) => {
      const base = 'https://embed.filmu.in';
      if (isMovie) return `${base}/movie/${tmdbId}`;
      if (anilistId && !window.STATE.isNetflixMode) return `${base}/anime/${anilistId}/${season}/${ep}`;
      return `${base}/tv/${tmdbId}/${season}/${ep}`;
    }
  },
  3: {
    id: 3,
    name: 'Server 3 (VidCore 4K)',
    caption: 'Server 3 (VidCore - Low Latency High Bitrate Pipeline)',
    type: 'embed',
    healthStatus: 'optimal',
    latency: null,
    endpoint: (tmdbId, season, ep, isMovie, anilistId) => {
      const base = 'https://vidcore.org';
      const params = 'autoplay=true&theme=ff0844';
      return isMovie
        ? `${base}/embed/movie/${tmdbId}?${params}`
        : `${base}/embed/tv/${tmdbId}/${season}/${ep}?${params}`;
    }
  },
  4: {
    id: 4,
    name: 'Server 4 (VidFast Sync)',
    caption: 'Server 4 (VidFast - AutoNext Synchronizer CDN)',
    type: 'embed',
    healthStatus: 'optimal',
    latency: null,
    endpoint: (tmdbId, season, ep, isMovie, anilistId) => {
      const base = 'https://vidfast.vc';
      return isMovie
        ? `${base}/movie/${tmdbId}?autoPlay=true`
        : `${base}/tv/${tmdbId}/${season}/${ep}?autoPlay=true&nextButton=true&autoNext=true`;
    }
  }
};
window.SERVER_CONFIG = SERVER_CONFIG;

// ============================================================================
// 4. APPLICATION STATE & MEMORY CACHES (ZERO-BLEED URL INITIALIZATION)
// ============================================================================
const animeCache = new Map();
const episodeDataCache = new Map();
const seriesSeasonsCache = new Map();
const tmdbResolvedIdCache = new Map();
const scheduleCache = new Map();

window.animeCache = animeCache;
window.episodeDataCache = episodeDataCache;
window.seriesSeasonsCache = seriesSeasonsCache;
window.tmdbResolvedIdCache = tmdbResolvedIdCache;

const urlParamsInit = new URLSearchParams(window.location.search);
const initialNetflixMode = urlParamsInit.get('mode') === 'netflix';

let STATE = {
  currentAnime: null,
  currentTMDBId: CONFIG.DEFAULT_TMDB_FALLBACK,
  season: 1,
  episode: 1,
  totalEpisodes: 1,
  availableSeasons: [],
  episodeBatchOffset: 0,
  activeServer: parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.ACTIVE_SERVER), 10) || 1,
  isTheaterMode: false,
  isCinemaLights: false,
  isNetflixMode: initialNetflixMode,
  isSmartAutoPlayNext: true,
  isMuted: false,
  savedScrollY: 0,
  defaultDubPref: localStorage.getItem(CONFIG.STORAGE_KEYS.DUB_PREF) || 'HINDI',
  watchlist: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.WATCHLIST) || '[]'),
  watchHistory: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.HISTORY) || '{}'),
  userPreferences: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.PREFS) || '{"autoSkipIntro": true, "ambientAmbilight": true}'),
  isMobile: window.innerWidth <= 768,
  activeAniSkipData: null,
  isIframeStreamLive: false,
  searchDebounce: null
};
window.STATE = STATE;

// ============================================================================
// 5. INDEXEDDB PERSISTENCE LAYER (VIA DEXIE)
// ============================================================================
class LocalStorageDatabase {
  constructor() {
    this.ready = false;
    this.init();
  }

  init() {
    if (window.Dexie) {
      try {
        this.db = new window.Dexie('AnimeDriftDatabase');
        this.db.version(1).stores({
          watchHistory: '&animeId, title, season, episode, timestamp, duration, updated, isFinished',
          playbackProgress: '&streamKey, currentTime, duration, progressPercent',
          appPreferences: 'key, value'
        });
        this.ready = true;
      } catch (err) {
        console.warn('[DB Engine] IndexedDB initialization warning:', err);
      }
    }
  }

  async saveWatchProgress(animeId, progressMeta) {
    if (!animeId) return;
    const duration = progressMeta.duration || 1;
    const currentTime = progressMeta.currentTime || 0;
    const percent = progressMeta.progressPercent || ((currentTime / duration) * 100);

    const entry = {
      animeId: String(animeId),
      title: STATE.currentAnime?.title?.english || STATE.currentAnime?.title?.romaji || 'Unknown Title',
      season: STATE.season,
      episode: STATE.episode,
      timestamp: currentTime,
      duration: duration,
      progressPercent: Math.min(100, Math.max(0, percent)),
      updated: Date.now(),
      isFinished: (currentTime / duration) > 0.92
    };

    STATE.watchHistory[animeId] = entry;
    try {
      localStorage.setItem(CONFIG.STORAGE_KEYS.HISTORY, JSON.stringify(STATE.watchHistory));
    } catch (e) {}

    if (this.ready && this.db) {
      try {
        await this.db.watchHistory.put(entry);
      } catch (e) {}
    }

    const syncPill = document.getElementById('pwaSyncStatusPill');
    if (syncPill) {
      syncPill.classList.add('syncing');
      clearTimeout(this.syncPillTimer);
      this.syncPillTimer = setTimeout(() => syncPill.classList.remove('syncing'), 1800);
    }
  }

  async getWatchHistoryItem(animeId) {
    if (this.ready && this.db) {
      try {
        return await this.db.watchHistory.get(String(animeId));
      } catch (e) {}
    }
    return STATE.watchHistory[animeId] || null;
  }
}
const DB = new LocalStorageDatabase();
window.DB = DB;

// ============================================================================
// 6. BIDIRECTIONAL URL ROUTER & NAVIGATION CONTROLLER
// ============================================================================
const Router = {
  getURL() {
    try {
      return new URL(window.location.href);
    } catch {
      return null;
    }
  },

  get(param) {
    const url = this.getURL();
    return url ? url.searchParams.get(param) : null;
  },

  has(param) {
    const url = this.getURL();
    return url ? url.searchParams.has(param) : false;
  },

  getAll() {
    const url = this.getURL();
    return url ? Object.fromEntries(url.searchParams.entries()) : {};
  },

  set(params = {}, push = false) {
    const url = this.getURL();
    if (!url) return;

    Object.keys(params).forEach(key => {
      const val = params[key];
      if (val === null || val === undefined || val === '') {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, String(val));
      }
    });

    if (url.href === window.location.href) return;
    push
      ? window.history.pushState(Object.fromEntries(url.searchParams), '', url)
      : window.history.replaceState(Object.fromEntries(url.searchParams), '', url);
  },

  closeAllUI() {
    ['closeModal', 'closeWatchlistModal', 'closeScheduleModal', 'closeTraceMoeModal', 'closeWatchPartyModal'].forEach(fn => {
      if (typeof window[fn] === 'function') {
        try { window[fn](true); } catch (e) {}
      }
    });
    if (typeof window.toggleShortcutsModal === 'function') {
      try { window.toggleShortcutsModal(false, true); } catch (e) {}
    }
    if (typeof window.toggleMobileNav === 'function') {
      try { window.toggleMobileNav(false, true); } catch (e) {}
    }
  },

  async syncUIFromURL() {
    const p = this.getAll();
    const shouldBeNetflix = p.mode === 'netflix';

    if (STATE.isNetflixMode !== shouldBeNetflix) {
      await window.toggleNetflixMode(shouldBeNetflix, true);
    }

    if (p.drawer === 'menu' && typeof window.toggleMobileNav === 'function') {
      window.toggleMobileNav(true, true);
    }
    if (p.drawer === 'watchlist' && typeof window.openWatchlistModal === 'function') {
      window.openWatchlistModal(true);
    }

    if (p.modal === 'schedule' && typeof window.openScheduleModal === 'function') window.openScheduleModal(true);
    if (p.modal === 'tracemoe' && typeof window.openTraceMoeModal === 'function') window.openTraceMoeModal(true);
    if (p.modal === 'watchparty' && typeof window.openWatchPartyModal === 'function') window.openWatchPartyModal(true);
    if (p.modal === 'shortcuts' && typeof window.toggleShortcutsModal === 'function') window.toggleShortcutsModal(true, true);

    if (p.watch) {
      const watchId = parseInt(p.watch, 10);
      const ep = parseInt(p.ep, 10) || 1;
      const s = parseInt(p.s, 10) || 1;
      let srv = parseInt(p.srv, 10) || STATE.activeServer;
      if (srv < 1 || srv > 4) srv = 1;
      STATE.activeServer = srv;

      if (!isNaN(watchId) && (!STATE.currentAnime || STATE.currentAnime.id !== watchId)) {
        if (typeof window.openModalById === 'function') {
          await window.openModalById(watchId, ep, s);
        }
      }

      if (p.fs === '1' && !STATE.isTheaterMode && typeof window.toggleTheaterMode === 'function') {
        window.toggleTheaterMode();
      }
    }
  }
};
window.Router = Router;

window.addEventListener('popstate', async () => {
  Router.closeAllUI();
  await Router.syncUIFromURL();
});

// ============================================================================
// 7. HARDWARE-ACCELERATED CHROMA EXTRACTION & AMBILIGHT
// ============================================================================
window.extractChromaAmbilight = function (imageUrl) {
  if (!STATE.userPreferences.ambientAmbilight || !imageUrl) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = new Image();

  img.crossOrigin = 'Anonymous';
  img.src = imageUrl + (imageUrl.includes('?') ? '&' : '?') + 'chroma_isolation=1';

  img.onload = () => {
    canvas.width = 24;
    canvas.height = 24;
    ctx.drawImage(img, 0, 0, 24, 24);

    try {
      const imgData = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, count = 0;

      for (let i = 0; i < imgData.length; i += 16) {
        const brightness = (imgData[i] * 299 + imgData[i + 1] * 587 + imgData[i + 2] * 114) / 1000;
        if (brightness > 25 && brightness < 215) {
          r += imgData[i]; g += imgData[i + 1]; b += imgData[i + 2];
          count++;
        }
      }

      if (count > 0) {
        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);

        const glow = document.getElementById('ambientGlow');
        if (glow) {
          glow.style.transition = 'box-shadow 1.2s cubic-bezier(0.16, 1, 0.3, 1), background 1.2s ease';
          glow.style.boxShadow = `inset 0 0 260px rgba(${r}, ${g}, ${b}, 0.28), 0 0 130px rgba(${r}, ${g}, ${b}, 0.22)`;
        }
        document.documentElement.style.setProperty('--chroma-r', r);
        document.documentElement.style.setProperty('--chroma-g', g);
        document.documentElement.style.setProperty('--chroma-b', b);
        document.documentElement.style.setProperty('--accent-dynamic-glow', `rgba(${r}, ${g}, ${b}, 0.6)`);
      }
    } catch (e) {}
  };
};

// ============================================================================
// 8. STREAM MATRIX RESOLUTION & PIPELINE EXECUTION
// ============================================================================
window.resolveActiveStreamUrl = function () {
  const isMovie = STATE.currentAnime?.format === 'MOVIE';
  const server = SERVER_CONFIG[STATE.activeServer] || SERVER_CONFIG[1];
  return server.endpoint(STATE.currentTMDBId, STATE.season, STATE.episode, isMovie, STATE.currentAnime?.id);
};

window.executeStream = function (seekTimestamp = 0) {
  const wrap = document.getElementById('modalPlayerWrap');
  if (!wrap || !STATE.currentAnime) return;

  STATE.isIframeStreamLive = true;
  const streamUrl = window.resolveActiveStreamUrl();
  const title = STATE.currentAnime.title?.english || STATE.currentAnime.title?.romaji || 'Stream Master';

  const modalNowPlayingTitle = document.getElementById('modalNowPlayingTitle');
  const playerStreamTitle = document.getElementById('playerStreamTitle');
  const isMovie = STATE.currentAnime?.format === 'MOVIE';

  if (isMovie) {
    if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Feature Film`;
    if (playerStreamTitle) playerStreamTitle.innerText = `Full Movie`;
  } else {
    if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • S${STATE.season} Ep ${STATE.episode}`;
    if (playerStreamTitle) playerStreamTitle.innerText = `Season ${STATE.season} • Episode ${STATE.episode}`;
  }

  wrap.innerHTML = `
    <div class="stream-frame-container" id="streamContainer" onclick="this.classList.add('is-interacting')" style="position:relative; width:100%; height:100%; background:#000;">
      <iframe 
        id="streamFrame" 
        src="${streamUrl}" 
        title="${title}"
        frameborder="0" 
        allowfullscreen 
        allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
        style="position:absolute; top:0; left:0; width:100%; height:100%; border:0; z-index:5;">
      </iframe>
      <div id="playerBufferingLoader" class="player-buffering-indicator">
        <div class="spinner-ring"></div>
      </div>
      <button id="aniSkipIntroBtn" class="aniskip-pill-btn" style="display:none;" onclick="window.triggerAniSkipJump()">
        <i class="fas fa-forward"></i> <span id="aniSkipLabel">Skip Opening (OP)</span>
      </button>
    </div>
  `;

  if (typeof window.renderServerSwitcherGrid === 'function') window.renderServerSwitcherGrid();
  if (typeof window.renderEpisodeGrid === 'function') window.renderEpisodeGrid();

  if (window.Router) {
    Router.set({ srv: STATE.activeServer, ep: STATE.episode, s: STATE.season });
  }

  if (STATE.currentAnime.idMal && !STATE.isNetflixMode) {
    resolveAndPollAniSkip(STATE.currentAnime.idMal, STATE.episode);
  } else {
    const skipBtn = document.getElementById('aniSkipIntroBtn');
    if (skipBtn) skipBtn.style.display = 'none';
  }

  if (window.p2pParty && window.p2pParty.isHost) {
    window.p2pParty.broadcastTitleChange(STATE.currentAnime, STATE.season, STATE.episode, STATE.activeServer);
  }
};

window.switchStreamServer = function (serverId) {
  const targetId = parseInt(serverId, 10);
  if (!SERVER_CONFIG[targetId]) return;
  STATE.activeServer = targetId;
  localStorage.setItem(CONFIG.STORAGE_KEYS.ACTIVE_SERVER, targetId);
  if (typeof window.showToast === 'function') {
    window.showToast(`Switched active node to: ${SERVER_CONFIG[targetId].name}`);
  }
  window.executeStream(0);
};

window.renderServerSwitcherGrid = function () {
  const container = document.getElementById('serverSelectionContainer') || document.getElementById('serverButtonsContainer');
  if (!container) return;

  container.innerHTML = Object.values(SERVER_CONFIG).map(srv => {
    const isActive = srv.id === STATE.activeServer;
    const isPro = srv.id === 1;
    return `
      <button 
        type="button" 
        class="server-node-btn ${isActive ? 'active-server' : ''} ${isPro ? 'nxsha-node' : ''}" 
        onclick="window.switchStreamServer(${srv.id})"
        title="${srv.caption}">
        <span class="server-status-dot ${srv.healthStatus}"></span>
        <span class="server-node-name">${srv.name}</span>
        ${isPro ? '<span class="server-tag">PRO</span>' : ''}
      </button>
    `;
  }).join('');
};

// ============================================================================
// 9. ANISKIP TELEMETRY INTEGRATION
// ============================================================================
let __AniSkipRequest = 0;

async function resolveAndPollAniSkip(malId, episodeNumber) {
  if (STATE.isNetflixMode || !STATE.userPreferences.autoSkipIntro) return;

  const requestId = ++__AniSkipRequest;
  const skipBtn = document.getElementById('aniSkipIntroBtn');
  const skipLabel = document.getElementById('aniSkipLabel');

  if (skipBtn) skipBtn.style.display = 'none';

  await new Promise(resolve => setTimeout(resolve, 400));
  if (requestId !== __AniSkipRequest) return;

  try {
    const url =
      `${CONFIG.APIS.ANISKIP}?` +
      `malId=${encodeURIComponent(malId)}` +
      `&episodeNumber=${encodeURIComponent(episodeNumber)}` +
      `&types[]=op&types[]=ed&episodeLength=0`;

    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    if (requestId !== __AniSkipRequest) return;

    if (data.found && data.results?.length > 0) {
      STATE.activeAniSkipData = data.results;
      const opResult = data.results.find(x => x.skipType === 'op');

      if (opResult && skipBtn && skipLabel) {
        skipLabel.innerText =
          `Skip Opening (${Math.round(opResult.interval.startTime)}s - ` +
          `${Math.round(opResult.interval.endTime)}s)`;
        skipBtn.style.display = 'inline-flex';
      }
    }
  } catch (err) {
    console.warn('[AniSkip] Request failed:', err);
  }
}
window.resolveAndPollAniSkip = resolveAndPollAniSkip;

window.triggerAniSkipJump = function () {
  if (!STATE.activeAniSkipData) return;
  const opData = STATE.activeAniSkipData.find(x => x.skipType === 'op');
  if (!opData) return;

  const iframe = document.getElementById('streamFrame');
  if (iframe) {
    iframe.contentWindow?.postMessage({
      type: 'SEEK_ABSOLUTE',
      time: opData.interval.endTime + 1
    }, '*');
  }

  if (typeof window.showToast === 'function') {
    window.showToast(`Skipped ahead to ${Math.round(opData.interval.endTime)}s`);
  }
  const skipBtn = document.getElementById('aniSkipIntroBtn');
  if (skipBtn) skipBtn.style.display = 'none';

  if (window.p2pParty) {
    window.p2pParty.sendSeek(opData.interval.endTime + 1);
  }
};

// ============================================================================
// 10. MULTI-SEASON QUERY & REAL-TIME EPISODE HYDRATION (EDGE PROXIED)
// ============================================================================
window.resolveTMDBId = async function (rawTitle, isMovie = false) {
  if (STATE.isNetflixMode && STATE.currentAnime?.tmdbId) {
    STATE.currentTMDBId = STATE.currentAnime.tmdbId;
    return;
  }
  if (!rawTitle) {
    STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
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
  if (tmdbResolvedIdCache.has(cacheKey)) {
    STATE.currentTMDBId = tmdbResolvedIdCache.get(cacheKey);
    return;
  }

  try {
    const searchType = isMovie ? 'movie' : 'tv';
    const proxyUrl = buildSecureTmdbUrl(`search/${searchType}`, { query: cleanQuery });
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error('Proxy search failed');
    const data = await res.json();

    if (data.results?.length > 0) {
      STATE.currentTMDBId = data.results[0].id;
    } else {
      const words = cleanQuery.split(' ').slice(0, 2).join(' ');
      if (words.length > 2 && words !== cleanQuery) {
        const fallbackRes = await fetch(buildSecureTmdbUrl(`search/${searchType}`, { query: words }));
        const fallbackData = await fallbackRes.json();
        if (fallbackData?.results?.length > 0) {
          STATE.currentTMDBId = fallbackData.results[0].id;
        } else {
          STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
        }
      } else {
        STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
      }
    }
  } catch (e) {
    STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
  }

  tmdbResolvedIdCache.set(cacheKey, STATE.currentTMDBId);
};

window.fetchSeriesSeasons = async function (tmdbId) {
  if (!tmdbId || tmdbId === CONFIG.DEFAULT_TMDB_FALLBACK) return [];
  const cacheKey = `series_seasons_${tmdbId}`;
  if (seriesSeasonsCache.has(cacheKey)) {
    return seriesSeasonsCache.get(cacheKey);
  }

  try {
    const proxyUrl = buildSecureTmdbUrl(`tv/${tmdbId}`);
    const res = await fetch(proxyUrl);
    if (!res.ok) return [];
    const data = await res.json();

    if (data.seasons?.length > 0) {
      const validSeasons = data.seasons
        .filter(s => s.season_number > 0)
        .map(s => ({
          season_number: s.season_number,
          name: s.name || `Season ${s.season_number}`,
          episode_count: s.episode_count || 12,
          overview: s.overview || '',
          poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null
        }));
      seriesSeasonsCache.set(cacheKey, validSeasons);
      return validSeasons;
    }
  } catch (err) {}

  return [];
};

window.fetchSeasonEpisodesData = async function (tmdbId, seasonNum) {
  const cacheKey = `ep_cache_${tmdbId}_s${seasonNum}`;
  if (episodeDataCache.has(cacheKey)) {
    return episodeDataCache.get(cacheKey);
  }

  try {
    const proxyUrl = buildSecureTmdbUrl(`tv/${tmdbId}/season/${seasonNum}`);
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error('Season query rejected');
    const data = await res.json();

    if (data.episodes?.length > 0) {
      const parsed = data.episodes.map(ep => ({
        number: ep.episode_number,
        title: ep.name ? String(ep.name).trim() : `Episode ${ep.episode_number}`,
        overview: ep.overview ? String(ep.overview).trim() : 'No synopsis available for this episode.',
        still: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
        runtime: ep.runtime ? `${ep.runtime}m` : null,
        airDate: ep.air_date ? ep.air_date.slice(0, 4) : ''
      }));
      episodeDataCache.set(cacheKey, parsed);
      return parsed;
    }
  } catch (err) {}

  return null;
};

// ============================================================================
// 11. DUAL-UNIVERSE TMDB CATALOG ENGINE (NETFLIX & LIVE ACTION VIA EDGE PROXY)
// ============================================================================
window.formatTmdbMediaItem = function (item, forceFormat = null) {
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
    title: {
      english: title,
      romaji: title,
      native: item.original_title || item.original_name || title
    },
    format: isMovie ? 'MOVIE' : 'TV',
    episodes: isMovie ? 1 : 16,
    description: item.overview || 'Synopsis not available for this live-action title.',
    coverImage: {
      extraLarge: poster,
      large: poster,
      medium: poster
    },
    bannerImage: backdrop,
    averageScore: rating,
    status: 'FINISHED',
    year: parseInt(year, 10) || 2026,
    isLiveAction: true
  };
};

window.fetchTmdbLiveActionRail = async function (endpoint, title, forceFormat = null) {
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
      animeCache.set(formatted.id, formatted);
      return formatted;
    });

    return { title, list };
  } catch (err) {
    return null;
  }
};

window.renderTmdbLiveActionHome = async function () {
  if (typeof window.renderHomeRows === 'function') {
    await window.renderHomeRows();
  }
};

window.updateHeroBillboard = function (item) {
  const heroTitle = document.getElementById('heroTitle');
  const heroDesc = document.getElementById('heroDesc');
  const heroBg = document.getElementById('heroBg');
  const heroScore = document.getElementById('heroScore');
  const heroYear = document.getElementById('heroYear');
  const heroFormat = document.getElementById('heroFormat');
  const heroFormatBadge = document.getElementById('heroFormatBadge');
  const heroPlayBtn = document.getElementById('heroPlayBtn');
  const infoBtn = document.getElementById('heroInfoBtn');

  if (heroTitle) heroTitle.innerText = item.title?.english || item.title?.romaji || 'Featured Title';
  if (heroDesc) heroDesc.innerText = item.description || '';
  if (heroBg && item.bannerImage) heroBg.src = item.bannerImage;
  if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${item.averageScore || 95}% Match`;
  if (heroYear) heroYear.innerText = item.year || '2026';
  if (heroFormat) heroFormat.innerText = item.format === 'MOVIE' ? 'MOVIE' : 'TV SERIES';
  if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> NETFLIX LIVE SPOTLIGHT`;

  if (heroPlayBtn) {
    heroPlayBtn.onclick = () => {
      if (typeof window.openModalById === 'function') window.openModalById(item.id, 1, 1);
    };
  }
  if (heroInfoBtn) {
    heroInfoBtn.onclick = () => {
      if (typeof window.openModalById === 'function') window.openModalById(item.id, 1, 1);
    };
  }
};

// ============================================================================
// 12. UNIFIED CATEGORY DISCOVERY & QUICK CHIPS HANDLER (CROSS-SCRIPT SAFE)
// ============================================================================
window.applyQuickFilter = async function (filterKey, element) {
  const norm = String(filterKey || 'ALL').toUpperCase();

  const chips = document.querySelectorAll('.chips-container .chip');
  chips.forEach(c => c.classList.remove('active'));

  if (element && element.nodeType === 1) {
    element.classList.add('active');
  } else {
    const match = document.querySelector(`.chip[data-filter="${norm}"]`) ||
                  Array.from(chips).find(c => c.innerText.toUpperCase().includes(norm));
    if (match) match.classList.add('active');
  }

  if (typeof window.syncCategoryState === 'function') {
    window.syncCategoryState(norm);
  }

  if (STATE.isNetflixMode) {
    switch (norm) {
      case 'ALL':
        return window.navigateGenre(null, 'Home');
      case 'MOVIES':
      case 'MOVIE':
        return window.navigateGenre('Movies', 'Feature Films');
      case 'TOP_AIRING':
      case 'TV':
      case 'SHOWS':
        return window.navigateGenre('TV', 'TV Series');
      case 'HINDI':
        return window.loadHindiDubbed();
      case 'ACTION':
        return window.navigateGenre('Action', 'Action');
      case 'THRILLER':
      case 'CRIME':
        return window.navigateGenre('Thriller', 'Thriller');
      case 'SCI_FI':
      case 'SCIFI':
        return window.navigateGenre('Sci-Fi', 'Sci-Fi');
      case 'ROMANCE':
        return window.navigateGenre('Romance', 'Romance');
      default:
        return window.navigateGenre(null, 'Home');
    }
  }

  // Anime Universe Navigation Mode
  switch (norm) {
    case 'ALL':
      return window.navigateGenre(null, 'Home');
    case 'HINDI':
      return window.loadHindiDubbed();
    case 'MOVIES':
    case 'MOVIE':
      return window.navigateGenre('Movie', 'Top Anime Movies');
    case 'TOP_AIRING':
    case 'AIRING':
    case 'TOP_RATED':
      return window.navigateGenre('Top', 'Top Airing Anime');
    case 'ACTION':
      return window.navigateGenre('Action', 'Action Hits');
    case 'ROMANCE':
      return window.navigateGenre('Romance', 'Romance & Drama');
    case 'SCI_FI':
    case 'SCIFI':
      return window.navigateGenre('Sci-Fi', 'Sci-Fi & Cyberpunk');
    case 'SECONDARY':
    case 'FANTASY':
      return window.navigateGenre('Fantasy', 'Isekai & Fantasy');
    default:
      return window.navigateGenre(null, 'Home');
  }
};

window.navigateGenre = async function (genre, label) {
  document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
    const match = link.innerText.toLowerCase().includes((label || genre || '').toLowerCase());
    link.classList.toggle('active', Boolean(match));
  });

  const contentRows = document.getElementById('contentRows');
  if (contentRows) contentRows.innerHTML = '';

  if (!genre || genre === 'Home') {
    if (typeof window.renderHomeRows === 'function') await window.renderHomeRows();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (STATE.isNetflixMode) {
    if (genre === 'Movies' || genre === 'Movie') {
      await window.renderTMDBRow?.('Trending Feature Films', 'discover/movie?sort_by=popularity.desc&vote_count.gte=100&_rail=filter_movies', '<i class="fas fa-film"></i>', 'MOVIE');
      await window.renderTMDBRow?.('Top Rated Blockbusters', 'discover/movie?sort_by=vote_average.desc&vote_count.gte=300&_rail=filter_top_movies', '<i class="fas fa-star"></i>', 'MOVIE');
    } else if (genre === 'TV' || genre === 'TV Shows') {
      await window.renderTMDBRow?.('Top Binge TV Series', 'discover/tv?sort_by=popularity.desc&vote_count.gte=50&_rail=filter_tv', '<i class="fas fa-tv"></i>', 'TV');
      await window.renderTMDBRow?.('Critically Acclaimed Series', 'discover/tv?sort_by=vote_average.desc&vote_count.gte=200&_rail=filter_top_tv', '<i class="fas fa-star"></i>', 'TV');
    } else if (genre === 'Action') {
      await window.renderTMDBRow?.('Action Movies & Thrillers', 'discover/movie?with_genres=28&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_action_m', '<i class="fas fa-bolt"></i>', 'MOVIE');
      await window.renderTMDBRow?.('Action & Adventure Series', 'discover/tv?with_genres=10759&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_action_tv', '<i class="fas fa-shield"></i>', 'TV');
    } else if (genre === 'Thriller' || genre === 'Crime') {
      await window.renderTMDBRow?.('Gripping Crime & Mystery Films', 'discover/movie?with_genres=53&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_crime_m', '<i class="fas fa-mask"></i>', 'MOVIE');
      await window.renderTMDBRow?.('Psychological Thriller Series', 'discover/tv?with_genres=80&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_crime_tv', '<i class="fas fa-user-secret"></i>', 'TV');
    } else if (genre === 'Sci-Fi') {
      await window.renderTMDBRow?.('Sci-Fi Feature Cinema', 'discover/movie?with_genres=878&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_scifi_m', '<i class="fas fa-microchip"></i>', 'MOVIE');
      await window.renderTMDBRow?.('Futuristic TV Shows', 'discover/tv?with_genres=10765&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_scifi_tv', '<i class="fas fa-tv"></i>', 'TV');
    } else if (genre === 'Romance') {
      await window.renderTMDBRow?.('Romantic Comedies & Dramas', 'discover/movie?with_genres=10749&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_romance_m', '<i class="fas fa-heart"></i>', 'MOVIE');
      await window.renderTMDBRow?.('Romantic TV Series', 'discover/tv?with_genres=10766&sort_by=popularity.desc&vote_count.gte=50&_rail=filter_romance_tv', '<i class="fas fa-tv"></i>', 'TV');
    } else if (genre === 'Hindi') {
      await window.loadHindiDubbed();
    }
    window.scrollTo({ top: 350, behavior: 'smooth' });
    return;
  }

  // Anime Universe Rendering
  if (typeof window.renderRow === 'function') {
    if (genre === 'Movie' || genre === 'Movies') {
      await window.renderRow('Anime Feature Films', { page: 1, perPage: 24, format: 'MOVIE', sort: ['POPULARITY_DESC'] }, false);
      await window.renderRow('Top Rated Movies', { page: 1, perPage: 24, format: 'MOVIE', sort: ['SCORE_DESC'] }, false);
    } else if (genre === 'Top') {
      await window.renderRow('Top Airing Simulcasts', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);
      await window.renderRow('All-Time Popular', { page: 1, perPage: 24, sort: ['POPULARITY_DESC'] }, false);
    } else {
      await window.renderRow(label || genre, { page: 1, perPage: 24, genre: genre, sort: ['TRENDING_DESC'] }, false);
      await window.renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre: genre, sort: ['SCORE_DESC'] }, false);
    }
  }
  window.scrollTo({ top: 350, behavior: 'smooth' });
};

window.loadHindiDubbed = async function () {
  if (typeof window.toggleMobileNav === 'function') window.toggleMobileNav(false);
  if (typeof window.syncCategoryState === 'function') window.syncCategoryState('HINDI');

  const contentRows = document.getElementById('contentRows');
  if (contentRows) contentRows.innerHTML = '';

  if (STATE.isNetflixMode) {
    if (typeof window.renderTMDBRow === 'function') {
      await window.renderTMDBRow(
        'Hindi Blockbuster Movies',
        'discover/movie?with_origin_country=IN&with_original_language=hi&without_genres=16&sort_by=popularity.desc&_rail=hindi_dub_m',
        '<i class="fas fa-film"></i>',
        'MOVIE'
      );
      await window.renderTMDBRow(
        'Hindi Web Series & Dramas',
        'discover/tv?with_origin_country=IN&with_original_language=hi&without_genres=16&sort_by=popularity.desc&_rail=hindi_dub_tv',
        '<i class="fas fa-tv"></i>',
        'TV'
      );
      await window.renderTMDBRow(
        'South Indian Cinema (Telugu Hits)',
        'discover/movie?with_origin_country=IN&with_original_language=te&without_genres=16&sort_by=popularity.desc&_rail=telugu_dub_m',
        '<i class="fas fa-fire"></i>',
        'MOVIE'
      );
    }
    window.scrollTo({ top: 350, behavior: 'smooth' });
    return;
  }

  // Anime Universe Hindi Content
  if (typeof window.renderHindiDubRow === 'function') {
    await window.renderHindiDubRow();
    if (typeof window.renderRow === 'function') {
      await window.renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
      await window.renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['POPULARITY_DESC'] }, false);
    }
  }
  window.scrollTo({ top: 350, behavior: 'smooth' });
};

// ============================================================================
// 13. DUAL-UNIVERSE TRANSFORMER (NETFLIX VS ANIME UNIVERSE)
// ============================================================================
window.toggleNetflixMode = async function (forcedState = null, skipUrlSync = false) {
  if (typeof forcedState === 'boolean') {
    STATE.isNetflixMode = forcedState;
  } else {
    STATE.isNetflixMode = !STATE.isNetflixMode;
  }

  if (!skipUrlSync && window.Router) {
    Router.set({ mode: STATE.isNetflixMode ? 'netflix' : null });
  }

  const btn = document.getElementById('netflixModeBtn');
  const brandText = document.getElementById('brandTitleText');
  const searchInput = document.getElementById('searchInput');
  const desktopNav = document.querySelector('.nav-desktop .nav-links');
  const mobileNav = document.querySelector('.mobile-nav-list');
  const filterChips = document.getElementById('filterChips');
  const quickDock = document.getElementById('floatingQuickDock');

  if (STATE.isNetflixMode) {
    document.body.classList.add('netflix-theme-active');
    if (btn) btn.classList.add('netflix-mode-active');
    if (brandText) brandText.innerHTML = 'NETFLIX<small class="brand-badge" style="background:#ff0844; color:#fff;">LIVE</small>';
    if (searchInput) searchInput.placeholder = "Search movies, TV series, actors, dramas...";

    if (quickDock) {
      const animeButtons = quickDock.querySelectorAll('button[onclick*="TraceMoe"], button[onclick*="Schedule"]');
      animeButtons.forEach(b => b.style.display = 'none');
    }

    if (desktopNav) {
      desktopNav.innerHTML = `
        <li><a class="nav-link active" id="navHome" onclick="window.navigateGenre(null, 'Home')"><i class="fas fa-house"></i> <span>Home</span></a></li>
        <li><a class="nav-link" onclick="window.applyQuickFilter('MOVIES', this)"><i class="fas fa-film"></i> <span>Movies</span></a></li>
        <li><a class="nav-link" onclick="window.applyQuickFilter('TOP_AIRING', this)"><i class="fas fa-tv"></i> <span>TV Shows</span></a></li>
        <li><a class="nav-link" onclick="window.applyQuickFilter('ACTION', this)"><span>Action</span></a></li>
        <li><a class="nav-link" onclick="window.applyQuickFilter('THRILLER', this)"><span>Thriller & Crime</span></a></li>
        <li><a class="nav-link" onclick="window.applyQuickFilter('ROMANCE', this)"><span>Romance</span></a></li>
        <li><a class="nav-link" onclick="window.applyQuickFilter('HINDI', this)"><i class="fas fa-language"></i> <span>Hindi Dubs</span></a></li>
      `;
    }

    if (mobileNav) {
      mobileNav.innerHTML = `
        <li><a class="mobile-nav-link active" onclick="window.toggleMobileNav(false); window.navigateGenre(null, 'Home')"><i class="fas fa-house"></i> Home</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.applyQuickFilter('MOVIES')"><i class="fas fa-film"></i> Movies</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.applyQuickFilter('TOP_AIRING')"><i class="fas fa-tv"></i> TV Shows</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.applyQuickFilter('HINDI')"><i class="fas fa-language"></i> Hindi Content</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.applyQuickFilter('ACTION')"><i class="fas fa-bolt"></i> Action</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.applyQuickFilter('THRILLER')"><i class="fas fa-mask"></i> Thriller & Crime</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.applyQuickFilter('ROMANCE')"><i class="fas fa-heart"></i> Romance</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.openWatchlistModal()"><i class="fas fa-bookmark"></i> My List (<span id="mobileWatchlistCount">${STATE.watchlist.length}</span>)</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.toggleShortcutsModal(true)"><i class="fas fa-keyboard"></i> Shortcuts</a></li>
      `;
    }

    if (filterChips) {
      filterChips.innerHTML = `
        <button class="chip active" type="button" data-filter="ALL" onclick="window.applyQuickFilter('ALL', this)"><i class="fas fa-border-all"></i> All</button>
        <button class="chip" type="button" data-filter="MOVIES" onclick="window.applyQuickFilter('MOVIES', this)"><i class="fas fa-film"></i> Movies</button>
        <button class="chip" type="button" data-filter="TOP_AIRING" onclick="window.applyQuickFilter('TOP_AIRING', this)"><i class="fas fa-tv"></i> TV Series</button>
        <button class="chip" type="button" data-filter="HINDI" onclick="window.applyQuickFilter('HINDI', this)"><i class="fas fa-language"></i> Hindi Dubs</button>
        <button class="chip" id="chipCategory1" type="button" data-filter="ACTION" onclick="window.applyQuickFilter('ACTION', this)"><i class="fas fa-bolt"></i> Action</button>
        <button class="chip" id="chipCategory2" type="button" data-filter="THRILLER" onclick="window.applyQuickFilter('THRILLER', this)"><i class="fas fa-mask"></i> Thriller</button>
        <button class="chip" id="chipCategory3" type="button" data-filter="SCI_FI" onclick="window.applyQuickFilter('SCI_FI', this)"><i class="fas fa-microchip"></i> Sci-Fi</button>
        <button class="chip" type="button" data-filter="ROMANCE" onclick="window.applyQuickFilter('ROMANCE', this)"><i class="fas fa-heart"></i> Romance</button>
      `;
    }

    if (typeof window.showToast === 'function') window.showToast('Switched to Netflix Live-Action Mode');
    if (typeof window.renderHeroSpotlight === 'function') await window.renderHeroSpotlight();
    if (typeof window.renderHomeRows === 'function') await window.renderHomeRows();
  } else {
    document.body.classList.remove('netflix-theme-active');
    if (btn) btn.classList.remove('netflix-mode-active');
    if (brandText) brandText.innerHTML = 'ANIMEDRIFT<small class="brand-badge">PORTAL</small>';
    if (searchInput) searchInput.placeholder = "Search anime, movies, series...";

    if (quickDock) {
      const animeButtons = quickDock.querySelectorAll('button[onclick*="TraceMoe"], button[onclick*="Schedule"]');
      animeButtons.forEach(b => b.style.display = '');
    }

    if (desktopNav) {
      desktopNav.innerHTML = `
        <li><a class="nav-link active" id="navHome" onclick="window.navigateGenre(null, 'Home')"><i class="fas fa-house"></i> <span>Home</span></a></li>
        <li><a class="nav-link" id="navHindi" onclick="window.loadHindiDubbed()"><i class="fas fa-language"></i> <span>Hindi Dubs</span></a></li>
        <li><a class="nav-link" onclick="window.navigateGenre('Action', 'Action Blockbusters')"><span>Action</span></a></li>
        <li><a class="nav-link" onclick="window.navigateGenre('Romance', 'Romance & Drama')"><span>Romance</span></a></li>
        <li><a class="nav-link" onclick="window.navigateGenre('Fantasy', 'Isekai & Fantasy')"><span>Fantasy</span></a></li>
      `;
    }

    if (mobileNav) {
      mobileNav.innerHTML = `
        <li><a class="mobile-nav-link active" onclick="window.toggleMobileNav(false); window.navigateGenre(null, 'Home')"><i class="fas fa-house"></i> Home</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.loadHindiDubbed()"><i class="fas fa-language"></i> Hindi Dubbed</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.openScheduleModal()"><i class="fas fa-calendar-days"></i> Airing Calendar</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.openTraceMoeModal()"><i class="fas fa-camera"></i> Screenshot Search</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.openWatchPartyModal()"><i class="fas fa-users-viewfinder"></i> Watch Party</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.navigateGenre('Action', 'Action Blockbusters')"><i class="fas fa-bolt"></i> Action</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.navigateGenre('Romance', 'Romance & Drama')"><i class="fas fa-heart"></i> Romance</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.navigateGenre('Fantasy', 'Isekai & Fantasy')"><i class="fas fa-dungeon"></i> Fantasy & Isekai</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.openWatchlistModal()"><i class="fas fa-bookmark"></i> My List (<span id="mobileWatchlistCount">${STATE.watchlist.length}</span>)</a></li>
        <li><a class="mobile-nav-link" onclick="window.toggleMobileNav(false); window.toggleShortcutsModal(true)"><i class="fas fa-keyboard"></i> Shortcuts</a></li>
      `;
    }

    if (filterChips) {
      filterChips.innerHTML = `
        <button class="chip active" type="button" data-filter="ALL" onclick="window.applyQuickFilter('ALL', this)"><i class="fas fa-border-all"></i> All</button>
        <button class="chip" type="button" data-filter="HINDI" onclick="window.applyQuickFilter('HINDI', this)"><i class="fas fa-language"></i> Hindi Dubs</button>
        <button class="chip" type="button" data-filter="TOP_AIRING" onclick="window.applyQuickFilter('TOP_AIRING', this)"><i class="fas fa-tower-broadcast"></i> Airing</button>
        <button class="chip" type="button" data-filter="MOVIES" onclick="window.applyQuickFilter('MOVIES', this)"><i class="fas fa-film"></i> Movies</button>
        <button class="chip" id="chipCategory1" type="button" data-filter="ACTION" onclick="window.applyQuickFilter('ACTION', this)"><i class="fas fa-bolt"></i> Action</button>
        <button class="chip" id="chipCategory2" type="button" data-filter="SECONDARY" onclick="window.applyQuickFilter('SECONDARY', this)"><i class="fas fa-dungeon"></i> Fantasy</button>
        <button class="chip" id="chipCategory3" type="button" data-filter="SCI_FI" onclick="window.applyQuickFilter('SCI_FI', this)"><i class="fas fa-microchip"></i> Sci-Fi</button>
        <button class="chip" type="button" data-filter="ROMANCE" onclick="window.applyQuickFilter('ROMANCE', this)"><i class="fas fa-heart"></i> Romance</button>
      `;
    }

    if (typeof window.showToast === 'function') window.showToast('Switched to Anime Universe');
    if (typeof window.renderHeroSpotlight === 'function') await window.renderHeroSpotlight();
    if (typeof window.renderHomeRows === 'function') await window.renderHomeRows();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ============================================================================
// 14. MODAL, DRAWER & WATCHLIST MANAGERS
// ============================================================================
window.toggleMobileNav = function (isOpen, skipUrlSync = false) {
  const drawer = document.getElementById('mobileNavDrawer');
  const overlay = document.getElementById('mobileDrawerOverlay');
  if (!drawer || !overlay) return;

  const shouldOpen = (isOpen !== undefined) ? Boolean(isOpen) : !drawer.classList.contains('open');

  if (shouldOpen) {
    drawer.classList.add('open');
    overlay.classList.add('active');
    document.body.classList.add('scroll-locked');
    document.documentElement.classList.add('scroll-locked');
    if (!skipUrlSync && window.Router && typeof window.Router.set === 'function') {
      window.Router.set({ drawer: 'menu' }, true);
    }
  } else {
    drawer.classList.remove('open');
    overlay.classList.remove('active');
    document.body.classList.remove('scroll-locked');
    document.documentElement.classList.remove('scroll-locked');
    if (!skipUrlSync && window.Router && typeof window.Router.get === 'function') {
      if (window.Router.get('drawer') === 'menu') {
        window.Router.set({ drawer: null });
      }
    }
  }
};

window.openWatchlistModal = function (skipUrlSync = false) {
  window.toggleMobileNav(false, true);
  const drawer = document.getElementById('watchlistDrawer');
  const overlay = document.getElementById('drawerOverlay');
  const listContainer = document.getElementById('watchlistItemsList');

  if (drawer && overlay) {
    drawer.classList.add('open');
    overlay.classList.add('active');
    document.body.classList.add('scroll-locked');
    document.documentElement.classList.add('scroll-locked');
    if (!skipUrlSync && window.Router && typeof window.Router.set === 'function') {
      window.Router.set({ drawer: 'watchlist' }, true);
    }
  }

  if (!listContainer) return;
  if (!STATE.watchlist.length) {
    listContainer.innerHTML = `
      <div style="text-align:center; padding:50px 20px; color:var(--text-muted);">
        <i class="fas fa-bookmark" style="font-size:36px; margin-bottom:12px; opacity:0.4;"></i>
        <p style="font-weight:700; color:#fff;">Your Watchlist is empty.</p>
        <small>Bookmark titles to track them here.</small>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = '';
  STATE.watchlist.forEach(anime => {
    animeCache.set(anime.id, anime);
    const title = anime.title?.english || anime.title?.romaji || 'Title';
    listContainer.innerHTML += `
      <div class="search-item" onclick="window.closeWatchlistModal(); if (typeof window.openModalById === 'function') window.openModalById(${anime.id});">
        <img src="${anime.coverImage?.extraLarge || anime.coverImage?.large || ''}" alt="${title}" />
        <div class="search-info">
          <div class="search-title">${title}</div>
          <div class="search-meta"><span>${anime.format || 'TV'}</span> &bull; <span>${anime.episodes || '?'} Episodes</span></div>
        </div>
      </div>
    `;
  });
};

window.closeWatchlistModal = function (skipUrlSync = false) {
  const drawer = document.getElementById('watchlistDrawer');
  const overlay = document.getElementById('drawerOverlay');
  if (drawer && overlay) {
    drawer.classList.remove('open');
    overlay.classList.remove('active');
    document.body.classList.remove('scroll-locked');
    document.documentElement.classList.remove('scroll-locked');
    if (!skipUrlSync && window.Router && typeof window.Router.get === 'function') {
      if (window.Router.get('drawer') === 'watchlist') {
        window.Router.set({ drawer: null });
      }
    }
  }
};

window.toggleWatchlist = function (anime = STATE.currentAnime) {
  if (!anime) return;
  const idx = STATE.watchlist.findIndex(item => item.id === anime.id);

  const bookmarkBtn = document.getElementById('heroBookmarkBtn');
  const modalBtn = document.getElementById('modalWatchlistBtn');
  [bookmarkBtn, modalBtn].forEach(b => {
    if (b) {
      b.classList.add('pulse-animated');
      setTimeout(() => b.classList.remove('pulse-animated'), 600);
    }
  });

  if (idx !== -1) {
    STATE.watchlist.splice(idx, 1);
    if (typeof window.showToast === 'function') window.showToast('Removed from Watchlist');
  } else {
    STATE.watchlist.unshift({
      id: anime.id,
      title: anime.title,
      coverImage: anime.coverImage,
      format: anime.format,
      episodes: anime.episodes,
      addedAt: Date.now()
    });
    if (typeof window.showToast === 'function') window.showToast('Added to Watchlist successfully!');
  }
  localStorage.setItem(CONFIG.STORAGE_KEYS.WATCHLIST, JSON.stringify(STATE.watchlist));
  window.updateWatchlistBadge();
  window.updateModalWatchlistButtonState();
};

window.toggleModalWatchlist = function () {
  window.toggleWatchlist(STATE.currentAnime);
};

window.updateModalWatchlistButtonState = function () {
  const btn = document.getElementById('modalWatchlistBtn');
  if (!btn || !STATE.currentAnime) return;
  const exists = STATE.watchlist.some(item => item.id === STATE.currentAnime.id);
  btn.innerHTML = exists
    ? `<i class="fas fa-check" style="color:#46d369;"></i> <span>In My List</span>`
    : `<i class="fas fa-plus"></i> <span>My List</span>`;
};

window.updateWatchlistBadge = function () {
  const counter = document.getElementById('watchlistCount');
  const mobileCounter = document.getElementById('mobileWatchlistCount');
  if (counter) counter.innerText = STATE.watchlist.length;
  if (mobileCounter) mobileCounter.innerText = STATE.watchlist.length;
};

// ============================================================================
// 15. NATIVE ANILIST AIRING SCHEDULE ENGINE
// ============================================================================
const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

window.openScheduleModal = function (skipUrlSync = false) {
  const modal = document.getElementById('scheduleModal');
  const overlay = document.getElementById('scheduleModalOverlay');
  if (!modal || !overlay) return;

  modal.classList.add('open');
  overlay.classList.add('active');
  document.body.classList.add('scroll-locked');
  document.documentElement.classList.add('scroll-locked');

  if (!skipUrlSync && window.Router) {
    Router.set({ modal: 'schedule' }, true);
  }

  const todayIndex = new Date().getDay();
  window.renderScheduleDayTabs(todayIndex);
  window.fetchAiringScheduleForDay(todayIndex);
};

window.closeScheduleModal = function (skipUrlSync = false) {
  const modal = document.getElementById('scheduleModal');
  const overlay = document.getElementById('scheduleModalOverlay');
  if (!modal || !overlay) return;

  modal.classList.remove('open');
  overlay.classList.remove('active');
  document.body.classList.remove('scroll-locked');
  document.documentElement.classList.remove('scroll-locked');

  if (!skipUrlSync && window.Router && window.Router.get('modal') === 'schedule') {
    Router.set({ modal: null });
  }
};

window.renderScheduleDayTabs = function (activeDayIndex) {
  const tabsContainer = document.getElementById('scheduleDayTabs');
  if (!tabsContainer) return;

  tabsContainer.innerHTML = DAYS_OF_WEEK.map((day, idx) => `
    <button type="button" 
            class="chip ${idx === activeDayIndex ? 'active' : ''}" 
            onclick="window.onScheduleDayTabClick(${idx})">
      ${day}
    </button>
  `).join('');
};

window.onScheduleDayTabClick = function (dayIndex) {
  window.renderScheduleDayTabs(dayIndex);
  window.fetchAiringScheduleForDay(dayIndex);
};

window.fetchAiringScheduleForDay = async function (dayIndex) {
  const container = document.getElementById('scheduleItemsContainer');
  if (!container) return;

  container.innerHTML = `
    <div style="text-align:center; padding:30px; color:var(--text-muted);">
      <i class="fas fa-spinner fa-spin"></i> Loading schedule from AniList...
    </div>
  `;

  const now = new Date();
  const currentDayIndex = now.getDay();
  const distance = dayIndex - currentDayIndex;

  const targetDate = new Date(now);
  targetDate.setDate(now.getDate() + distance);
  targetDate.setHours(0, 0, 0, 0);

  const startTimestamp = Math.floor(targetDate.getTime() / 1000);
  const endTimestamp = startTimestamp + 86400;

  const cacheKey = `schedule_${startTimestamp}_${endTimestamp}`;
  if (scheduleCache.has(cacheKey)) {
    window.renderScheduleList(scheduleCache.get(cacheKey));
    return;
  }

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
            title {
              english
              romaji
            }
            coverImage {
              large
              extraLarge
            }
            genres
            averageScore
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(CONFIG.APIS.ANILIST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        query: query,
        variables: {
          airingAt_greater: startTimestamp,
          airingAt_lesser: endTimestamp
        }
      })
    });

    if (!res.ok) throw new Error('AniList Airing Schedule fetch rejected.');

    const data = await res.json();
    const items = data.data?.Page?.airingSchedules || [];
    scheduleCache.set(cacheKey, items);
    window.renderScheduleList(items);
  } catch (err) {
    console.error('[AnimeDrift Schedule] Failed:', err);
    container.innerHTML = `
      <div style="text-align:center; padding:30px; color:var(--text-muted);">
        <i class="fas fa-triangle-exclamation" style="font-size:22px; margin-bottom:8px; color:var(--accent-red);"></i>
        <p>Could not fetch airing broadcast schedule. Please try again later.</p>
      </div>
    `;
  }
};

window.renderScheduleList = function (items) {
  const container = document.getElementById('scheduleItemsContainer');
  if (!container) return;

  if (!items.length) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <i class="fas fa-tv" style="font-size:32px; margin-bottom:12px; opacity:0.4;"></i>
        <p style="font-weight:700; color:#fff;">No Simulcast Airing Streams Scheduled</p>
        <small>Check back tomorrow for the latest broadcast lineups.</small>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(entry => {
    const media = entry.media;
    if (!media) return '';

    animeCache.set(media.id, media);
    const title = media.title?.english || media.title?.romaji || 'Upcoming Title';
    const poster = media.coverImage?.large || media.coverImage?.extraLarge || '';
    const airTime = new Date(entry.airingAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const score = media.averageScore ? `${media.averageScore}%` : 'N/A';

    return `
      <div class="search-item" onclick="window.closeScheduleModal(); if (typeof window.openModalById === 'function') window.openModalById(${media.id});" style="cursor:pointer; display:flex; gap:12px; padding:10px; border-radius:10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); align-items:center;">
        <img src="${poster}" alt="${title}" style="width:48px; height:68px; object-fit:cover; border-radius:6px; flex-shrink:0;" />
        <div class="search-info" style="flex:1; min-width:0;">
          <div class="search-title" style="font-size:13px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</div>
          <div class="search-meta" style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            <span style="color:var(--accent-cyan); font-weight:700;">${airTime}</span> &bull; <span>Episode ${entry.episode}</span> &bull; <span style="color:#46d369;"><i class="fas fa-star" style="font-size:9px;"></i> ${score}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
};

// ============================================================================
// 16. KEYBOARD ACCESSIBILITY & SHORTCUT ENGINE
// ============================================================================
function initKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (['input', 'textarea', 'select'].includes(document.activeElement.tagName.toLowerCase())) return;
    const iframe = document.getElementById('streamFrame');

    switch (e.key) {
      case 'Escape':
        Router.closeAllUI();
        break;
      case '/':
      case 's':
      case 'S':
        e.preventDefault();
        if (typeof window.toggleSearch === 'function') window.toggleSearch();
        break;
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        iframe?.contentWindow?.postMessage({ type: 'TOGGLE_PLAY' }, '*');
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        window.toggleFullscreenMode();
        break;
      case 't':
      case 'T':
        e.preventDefault();
        window.toggleTheaterMode();
        break;
      case 'n':
      case 'N':
        if (typeof window.nextEpisode === 'function') window.nextEpisode();
        break;
    }
  });
}

window.toggleFullscreenMode = function () {
  const wrap = document.getElementById('modalPlayerWrap');
  if (!wrap) return;

  if (!document.fullscreenElement) {
    wrap.requestFullscreen?.().then(() => Router.set({ fs: 1 }, true)).catch(() => {});
  } else {
    document.exitFullscreen?.().then(() => Router.set({ fs: null })).catch(() => {});
  }
};

window.toggleTheaterMode = function () {
  const dialog = document.getElementById('modalDialog');
  STATE.isTheaterMode = !STATE.isTheaterMode;
  if (STATE.isTheaterMode) {
    if (dialog) dialog.style.maxWidth = '98vw';
    if (typeof window.showToast === 'function') window.showToast('Cinematic Theater Mode');
  } else {
    if (dialog) dialog.style.maxWidth = window.innerWidth > 1920 ? '1400px' : '1100px';
  }
};

// ============================================================================
// 17. RUNTIME UTILITIES & TELEMETRY LISTENERS
// ============================================================================
window.showToast = function (msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-info visible';
  toast.innerHTML = `<i class="fas fa-circle-info"></i> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 320);
  }, 3000);
};

window.cleanHTML = function (str) {
  if (!str) return 'No synopsis available for this media title.';
  return str.replace(/<[^>]*>?/gm, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
};

window.extractSeasonInfo = function (anime) {
  const title = anime?.title?.english || anime?.title?.romaji || '';
  let season = 1;
  let cleanTitle = title;

  const sNumMatch = title.match(/(?:season|s)\s*(\d+)/i) ||
                    title.match(/(\d+)(?:st|nd|rd|th)\s*season/i) ||
                    title.match(/(?:part|cour)\s*(\d+)/i);

  if (sNumMatch && sNumMatch[1]) {
    season = parseInt(sNumMatch[1], 10);
  }

  cleanTitle = cleanTitle
    .replace(/(?:season|s)\s*\d+/gi, '')
    .replace(/\d+(?:st|nd|rd|th)\s*season/gi, '')
    .replace(/(?:part|cour)\s*\d+/gi, '')
    .replace(/[:\-]\s*$/g, '')
    .trim();

  return { season, cleanTitle: cleanTitle || title };
};

window.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return;

  if (e.data.type === 'PLAYER_TIME_UPDATE' && STATE.currentAnime) {
    DB.saveWatchProgress(STATE.currentAnime.id, {
      currentTime: e.data.currentTime,
      duration: e.data.duration
    });
  }

  if (e.data.type === 'PLAYER_ENDED' && STATE.isSmartAutoPlayNext) {
    if (typeof window.showToast === 'function') window.showToast('Episode complete. Loading next...');
    if (typeof window.nextEpisode === 'function') window.nextEpisode();
  }
});

// ============================================================================
// 18. BOOTSTRAP ORCHESTRATOR (GUARANTEED DISPATCH & INSTANT FALLBACK)
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  window.updateWatchlistBadge();
  initKeyboardShortcuts();

  document.body.addEventListener('focusin', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      document.body.classList.add('keyboard-open');
    }
  });

  document.body.addEventListener('focusout', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      document.body.classList.remove('keyboard-open');
    }
  });

  try {
    const isPwaInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const pill = document.getElementById('appStatusPill');
    if (pill) pill.style.display = isPwaInstalled ? 'inline-flex' : 'none';
  } catch (e) {}

  // 1. Sync URL state FIRST
  if (window.Router) {
    try {
      await window.Router.syncUIFromURL();
    } catch (err) {
      console.warn('[Router Sync Error]:', err);
    }
  }

  // 2. Dispatch Hero Spotlight and Content Rows
  if (typeof window.renderHeroSpotlight === 'function') {
    window.renderHeroSpotlight().catch((err) => {
      console.warn('[Hero Spotlight Error]:', err);
    });
  }

  if (typeof window.renderHomeRows === 'function') {
    window.renderHomeRows().catch((err) => {
      console.warn('[Home Rows Error]:', err);
    });
  }
});

window.addEventListener('resize', () => {
  STATE.isMobile = window.innerWidth <= 768;
});
