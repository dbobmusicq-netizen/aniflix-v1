/**
 * AniFlix Ultra - Multi-Device Synchronized Core Engine
 * Complete Production-Grade JavaScript Controller (Version 28.0 Enterprise Master Architecture)
 *
 * Core Capabilities & Fixes:
 *  - Enriched Multi-Source Episode Engine: Fetches real episode names, still thumbnails,
 *    runtimes, air dates, and overviews for Anime, Web Series, and K-Dramas / Live-Action.
 *  - Seamless Triple Fallback Cascade: episode.still_path -> media.backdrop_path -> media.poster_path.
 *  - Modern Responsive Episode Grid: Fully eliminates full-width stretched button pill rows,
 *    rendering a clean 16:9 thumbnail preview card layout with play states.
 *  - Batch Slicing (1-50, 51-100, etc.) & Multi-Season Selector State Synchronization.
 *  - Mode-Aware Dual-Universe Transformer (Anime Universe vs. Netflix Live-Action Mode).
 *  - 4-Tier Stream Server Matrix (NxSha [Hindi Default], Filmu, VidCore, VidFast).
 *  - Memory Cache & IndexedDB Dexie.js Persistence with Instant Telemetry Recovery.
 */

// ============================================================================
// 1. GLOBAL CONSTANTS, TMDB TAXONOMY & SERVER MATRIX
// ============================================================================
const CONFIG = {
  APIS: {
    ANILIST: 'https://graphql.anilist.co',
    JIKAN: 'https://api.jikan.moe/v4',
    KITSU: 'https://kitsu.io/api/edge',
    ANISKIP: 'https://api.aniskip.com/v2/skip-times',
    TMDB_BASE: 'https://db.speedracelight.com/3'
  },
  TMDB_GENRES: {
    ACTION: { movie: 28, tv: 10759 },
    ROMANCE: { movie: 10749, tv: 10766 },
    SCI_FI: { movie: 878, tv: 10765 },
    THRILLER_CRIME: { movie: 53, tv: 80 },
    ANIMATION_EXCLUDE_ID: 16
  },
  STORAGE_KEYS: {
    WATCHLIST: 'aniflix_watchlist_v5',
    HISTORY: 'aniflix_history_v5',
    PREFS: 'aniflix_prefs_v5',
    DUB_PREF: 'aniflix_dub_pref_v5',
    ACTIVE_SERVER: 'aniflix_active_server_v5'
  },
  DEFAULT_TMDB_FALLBACK: 533535
};
window.CONFIG = CONFIG;

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
    caption: 'Server 2 (Filmu Ultra HD - Dedicated TMDB/AniList Master)',
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
// 2. STATE MANAGER & IN-MEMORY CACHES
// ============================================================================
const animeCache = new Map();
const episodeDataCache = new Map();
window.animeCache = animeCache;
window.episodeDataCache = episodeDataCache;

let STATE = {
  currentAnime: null,
  currentTMDBId: CONFIG.DEFAULT_TMDB_FALLBACK,
  season: 1,
  episode: 1,
  activeServer: parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.ACTIVE_SERVER), 10) || 1,
  totalEpisodes: 1,
  episodeBatchOffset: 0,
  isTheaterMode: false,
  isCinemaLights: false,
  isNetflixMode: false,
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
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

// ============================================================================
// 3. PERSISTENT STORAGE LAYER (INDEXEDDB VIA DEXIE)
// ============================================================================
class LocalStorageDatabase {
  constructor() {
    this.ready = false;
    this.init();
  }

  init() {
    if (window.Dexie) {
      try {
        this.db = new Dexie('AniFlixDatabase');
        this.db.version(1).stores({
          watchHistory: '&animeId, title, season, episode, timestamp, duration, updated, isFinished',
          playbackProgress: '&streamKey, currentTime, duration, progressPercent',
          appPreferences: 'key, value'
        });
        this.ready = true;
      } catch (err) {
        console.warn('[DB Engine] Dexie initialization warning:', err);
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
    } catch (e) {
      console.warn('[DB Engine] LocalStorage quota reached');
    }

    if (this.ready && this.db) {
      try {
        await this.db.watchHistory.put(entry);
      } catch (e) {
        console.error('[DB Engine] IndexedDB update error:', e);
      }
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
      } catch (e) {
        return STATE.watchHistory[animeId] || null;
      }
    }
    return STATE.watchHistory[animeId] || null;
  }
}
const DB = new LocalStorageDatabase();
window.DB = DB;

// ============================================================================
// 4. BI-DIRECTIONAL ROUTER & HISTORY SYSTEM
// ============================================================================
const Router = {
  set(params = {}, push = false) {
    const url = new URL(window.location);
    Object.keys(params).forEach(key => {
      if (params[key] === null || params[key] === undefined) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, params[key]);
      }
    });

    if (url.href === window.location.href) return;

    if (push) {
      window.history.pushState(Object.fromEntries(url.searchParams), '', url);
    } else {
      window.history.replaceState(Object.fromEntries(url.searchParams), '', url);
    }
  },

  get(param) {
    return new URLSearchParams(window.location.search).get(param);
  },

  getAll() {
    return Object.fromEntries(new URLSearchParams(window.location.search));
  },

  closeAllUI() {
    ['closeModal', 'closeWatchlistModal', 'closeScheduleModal', 'closeTraceMoeModal', 'closeWatchPartyModal'].forEach(fn => {
      if (typeof window[fn] === 'function') window[fn](true);
    });
    if (typeof window.toggleShortcutsModal === 'function') window.toggleShortcutsModal(false, true);
    if (typeof window.toggleMobileNav === 'function') window.toggleMobileNav(false, true);
  },

  async syncUIFromURL() {
    const p = this.getAll();

    if (p.mode === 'netflix' && !STATE.isNetflixMode) await window.toggleNetflixMode(true);
    else if (p.mode !== 'netflix' && STATE.isNetflixMode) await window.toggleNetflixMode(true);

    if (p.q) {
      const searchWrap = document.getElementById('searchWrapper');
      const searchInput = document.getElementById('searchInput');
      if (searchWrap && searchInput) {
        searchWrap.classList.add('open');
        searchInput.value = decodeURIComponent(p.q);
        searchInput.dispatchEvent(new Event('input'));
      }
    }

    if (p.drawer === 'menu') window.toggleMobileNav(true, true);
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

      if (!STATE.currentAnime || STATE.currentAnime.id !== watchId) {
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
// 5. HARDWARE-ACCELERATED CHROMA AMBILIGHT EXTRACTION
// ============================================================================
window.extractChromaAmbilight = function(imageUrl) {
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
          r += imgData[i];
          g += imgData[i + 1];
          b += imgData[i + 2];
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
    } catch (e) {
      console.warn('[Ambilight Engine] Canvas extraction bypassed due to CORS policy limits');
    }
  };
};

// ============================================================================
// 6. STREAM MATRIX RESOLVER & AUTO-FAILOVER PIPELINE
// ============================================================================
window.resolveActiveStreamUrl = function() {
  const isMovie = STATE.currentAnime?.format === 'MOVIE';
  const server = SERVER_CONFIG[STATE.activeServer] || SERVER_CONFIG[1];
  return server.endpoint(STATE.currentTMDBId, STATE.season, STATE.episode, isMovie, STATE.currentAnime?.id);
};

window.executeStream = function(seekTimestamp = 0) {
  const wrap = document.getElementById('modalPlayerWrap');
  if (!wrap || !STATE.currentAnime) return;

  STATE.isIframeStreamLive = true;
  const streamUrl = window.resolveActiveStreamUrl();
  const title = STATE.currentAnime.title?.english || STATE.currentAnime.title?.romaji || 'Stream Master';

  wrap.innerHTML = `
    <div class="stream-frame-container" id="streamContainer" style="position:relative; width:100%; height:100%; background:#000;">
      <iframe 
        id="streamFrame" 
        src="${streamUrl}" 
        title="${title}"
        frameborder="0" 
        allowfullscreen 
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
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

window.switchStreamServer = function(serverId) {
  const targetId = parseInt(serverId, 10);
  if (!SERVER_CONFIG[targetId]) return;
  STATE.activeServer = targetId;
  localStorage.setItem(CONFIG.STORAGE_KEYS.ACTIVE_SERVER, targetId);

  if (typeof window.showToast === 'function') {
    window.showToast(`Switched active node to: ${SERVER_CONFIG[targetId].name}`);
  }
  window.executeStream(0);
};

window.renderServerSwitcherGrid = function() {
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

// ===============================================================
// 7. ANISKIP TELEMETRY (ANIMATION DEDICATED)
// ===============================================================
async function resolveAndPollAniSkip(malId, episodeNumber) {
  if (STATE.isNetflixMode || !STATE.userPreferences.autoSkipIntro) return;
  const skipBtn = document.getElementById('aniSkipIntroBtn');
  const skipLabel = document.getElementById('aniSkipLabel');
  if (skipBtn) skipBtn.style.display = 'none';

  try {
    const url = `${CONFIG.APIS.ANISKIP}?malId=${malId}&episodeNumber=${episodeNumber}&types[]=op&types[]=ed&episodeLength=0`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    if (data.found && data.results?.length > 0) {
      STATE.activeAniSkipData = data.results;
      const opResult = data.results.find(x => x.skipType === 'op');
      if (opResult && skipBtn && skipLabel) {
        skipLabel.innerText = `Skip Opening (${Math.round(opResult.interval.startTime)}s - ${Math.round(opResult.interval.endTime)}s)`;
        skipBtn.style.display = 'inline-flex';
      }
    }
  } catch (err) {
    console.debug('[AniSkip] Skip intervals unavailable.');
  }
}
window.resolveAndPollAniSkip = resolveAndPollAniSkip;

window.triggerAniSkipJump = function() {
  if (!STATE.activeAniSkipData) return;
  const opData = STATE.activeAniSkipData.find(x => x.skipType === 'op');
  if (!opData) return;

  const video = document.getElementById('nativeStreamVideo');
  if (video) {
    video.currentTime = opData.interval.endTime + 1;
  } else {
    const iframe = document.getElementById('streamFrame');
    if (iframe) {
      iframe.contentWindow?.postMessage({
        type: 'SEEK_ABSOLUTE',
        time: opData.interval.endTime + 1
      }, '*');
    }
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
// 8. DEEP EPISODE & MULTI-SEASON HYDRATION ENGINE (METADATA ENRICHMENT)
// ============================================================================
window.resolveTMDBId = async function(rawTitle, isMovie = false) {
  if (STATE.isNetflixMode && STATE.currentAnime?.tmdbId) {
    STATE.currentTMDBId = STATE.currentAnime.tmdbId;
    return;
  }
  try {
    const sanitized = encodeURIComponent(rawTitle.replace(/[^a-zA-Z0-9 ]/g, '').trim());
    const searchType = isMovie ? 'movie' : 'tv';
    const endpoint = `${CONFIG.APIS.TMDB_BASE}/search/${searchType}?query=${sanitized}`;
    const res = await fetch(endpoint);
    const data = await res.json();
    if (data.results?.length > 0) {
      STATE.currentTMDBId = data.results[0].id;
    } else {
      STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
    }
  } catch (e) {
    STATE.currentTMDBId = CONFIG.DEFAULT_TMDB_FALLBACK;
  }
};

/**
 * Loads real episode titles, high-resolution still previews, overviews, runtimes,
 * and air dates for Anime, Web Series, and K-Dramas with cascading image fallbacks.
 */
window.fetchSeasonEpisodesData = async function(tmdbId, seasonNum) {
  const cacheKey = `ep_cache_${tmdbId}_s${seasonNum}`;
  if (episodeDataCache.has(cacheKey)) {
    return episodeDataCache.get(cacheKey);
  }

  try {
    const endpoint = `${CONFIG.APIS.TMDB_BASE}/tv/${tmdbId}/season/${seasonNum}`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error('Season query not available');
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
  } catch (err) {
    console.debug('[Episode Hydration] TMDB Season request bypassed:', err);
  }

  // Anime fallback via Jikan v4 for rich episode naming
  if (STATE.currentAnime?.idMal && !STATE.isNetflixMode) {
    try {
      const jikanEndpoint = `${CONFIG.APIS.JIKAN}/anime/${STATE.currentAnime.idMal}/episodes?page=1`;
      const jRes = await fetch(jikanEndpoint);
      if (jRes.ok) {
        const jData = await jRes.json();
        if (jData.data?.length > 0) {
          const jikanParsed = jData.data.map(jEp => ({
            number: jEp.mal_id,
            title: jEp.title || jEp.title_romanji || `Episode ${jEp.mal_id}`,
            overview: 'Tap to stream this anime episode in high definition.',
            still: null,
            runtime: null,
            airDate: jEp.aired ? jEp.aired.slice(0, 4) : ''
          }));
          episodeDataCache.set(cacheKey, jikanParsed);
          return jikanParsed;
        }
      }
    } catch (jErr) {}
  }

  return null;
};

/**
 * Modern Responsive Episode Grid Renderer
 * Eliminates full-width stretched button rows and displays rich, clickable preview cards.
 */
window.renderEpisodeGrid = async function() {
  const isMovie = STATE.currentAnime?.format === 'MOVIE';
  const container = document.getElementById('episodesMasterSection');
  const epList = document.getElementById('epList');
  const seasonSelect = document.getElementById('seasonSelect');
  const episodeRangeSelect = document.getElementById('episodeRangeSelect');
  const episodesTotalPill = document.getElementById('episodesTotalPill');

  if (isMovie) {
    if (container) container.style.display = 'none';
    return;
  }
  if (container) container.style.display = 'block';
  if (!epList) return;

  const total = STATE.currentAnime?.episodes || 12;
  STATE.totalEpisodes = total;

  if (episodesTotalPill) episodesTotalPill.innerText = `Total ${total}`;

  // 1. Season Select UI Sync
  if (seasonSelect) {
    seasonSelect.innerHTML = `
      <option value="${STATE.season}" selected>Season ${STATE.season}</option>
    `;
  }

  // 2. Episode Range Select UI Sync (Batches of 50)
  if (episodeRangeSelect) {
    episodeRangeSelect.innerHTML = '';
    const batches = Math.ceil(total / 50);
    for (let b = 0; b < batches; b++) {
      const start = b * 50 + 1;
      const end = Math.min((b + 1) * 50, total);
      const opt = document.createElement('option');
      opt.value = b;
      opt.innerText = `Episodes ${start} - ${end}`;
      if (b === STATE.episodeBatchOffset) opt.selected = true;
      episodeRangeSelect.appendChild(opt);
    }
  }

  // 3. Fallback Images Cascade: Episode Still -> Backdrop -> Poster
  const posterFallback = STATE.currentAnime?.bannerImage ||
    STATE.currentAnime?.coverImage?.extraLarge ||
    STATE.currentAnime?.coverImage?.large || '';

  // 4. Hydrate rich episode data
  let richEpisodes = null;
  if (STATE.currentTMDBId && STATE.currentTMDBId !== CONFIG.DEFAULT_TMDB_FALLBACK) {
    richEpisodes = await window.fetchSeasonEpisodesData(STATE.currentTMDBId, STATE.season);
  }

  // 5. Slice active batch window
  const batchStart = STATE.episodeBatchOffset * 50 + 1;
  const batchEnd = Math.min((STATE.episodeBatchOffset + 1) * 50, total);

  // 6. Build High-Performance Card Grid
  let cardsHTML = '';
  for (let ep = batchStart; ep <= batchEnd; ep++) {
    const isPlaying = ep === STATE.episode;
    const isWatched = STATE.watchHistory[STATE.currentAnime.id]?.episode > ep;
    const epData = richEpisodes ? richEpisodes.find(x => x.number === ep) : null;

    const title = epData?.title || `Episode ${ep}`;
    const stillImg = epData?.still || posterFallback;
    const airDate = epData?.airDate ? ` • ${epData.airDate}` : '';
    const runtime = epData?.runtime ? ` • ${epData.runtime}` : '';
    const overview = epData?.overview || 'Tap to stream this episode in full high-definition.';

    cardsHTML += `
      <div class="ep-modern-card ${isPlaying ? 'playing' : ''} ${isWatched ? 'watched' : ''}" 
           onclick="window.switchEpisode(${ep})"
           style="display: flex; gap: 14px; padding: 12px; border-radius: 12px; background: rgba(255,255,255,${isPlaying ? '0.14' : '0.04'}); border: 1px solid rgba(255,255,255,${isPlaying ? '0.38' : '0.08'}); margin-bottom: 10px; cursor: pointer; transition: all 0.25s ease; align-items: center; box-sizing: border-box;">
        
        <div class="ep-thumb-preview" style="position: relative; width: 124px; min-width: 124px; height: 72px; border-radius: 8px; overflow: hidden; background: #0b0b12; flex-shrink: 0;">
          <img src="${stillImg}" alt="${title}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover; display: block;" />
          <div class="ep-play-overlay" style="position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center;">
            <i class="fas ${isPlaying ? 'fa-play' : 'fa-circle-play'}" style="color: ${isPlaying ? 'var(--accent-red)' : '#ffffff'}; font-size: 20px;"></i>
          </div>
          <span style="position: absolute; bottom: 4px; right: 6px; background: rgba(0,0,0,0.8); color: #fff; font-size: 10px; font-weight: 800; padding: 1px 5px; border-radius: 4px;">EP ${ep}</span>
        </div>

        <div class="ep-meta-content" style="flex: 1; min-width: 0; overflow: hidden;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <h4 style="font-size: 14px; font-weight: 800; color: ${isPlaying ? 'var(--accent-red)' : '#ffffff'}; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${ep}. ${title}
            </h4>
            ${isPlaying ? '<span style="font-size: 10px; font-weight: 800; color: var(--accent-red); text-transform: uppercase; flex-shrink: 0;">Streaming</span>' : ''}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px; font-weight: 600;">
            Season ${STATE.season}${runtime}${airDate}
          </div>
          <p style="font-size: 12px; color: var(--text-secondary); margin: 4px 0 0 0; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
            ${overview}
          </p>
        </div>
      </div>
    `;
  }

  epList.className = 'ep-grid-flow';
  epList.innerHTML = cardsHTML;
};

window.changeEpisodeRange = function(offsetIndex) {
  STATE.episodeBatchOffset = parseInt(offsetIndex, 10);
  window.renderEpisodeGrid();
};

window.changeSeason = function(seasonNum) {
  STATE.season = parseInt(seasonNum, 10);
  STATE.episode = 1;
  window.renderEpisodeGrid();
  window.executeStream(0);
};

window.switchEpisode = function(epNum) {
  const ep = parseInt(epNum, 10);
  if (ep === STATE.episode) return;
  STATE.episode = ep;
  window.executeStream(0);
  if (typeof window.showToast === 'function') {
    window.showToast(`Switched to Episode ${ep}`);
  }
};

window.nextEpisode = function() {
  if (STATE.episode < STATE.totalEpisodes) {
    window.switchEpisode(STATE.episode + 1);
  } else {
    if (typeof window.showToast === 'function') {
      window.showToast('You are currently on the final episode.');
    }
  }
};

// ============================================================================
// 9. TMDB DISCOVER ENGINE & DUAL-UNIVERSE TRANSFORMER
// ============================================================================
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

window.fetchTmdbLiveActionRail = async function(endpoint, title, forceFormat = null) {
  try {
    const sanitizedUrl = cleanTMDBUrl(endpoint);
    const res = await fetch(sanitizedUrl);
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
    console.warn('[TMDB Engine] Error querying live-action catalog:', err);
    return null;
  }
};

window.renderTmdbLiveActionHome = async function() {
  const contentRows = document.getElementById('contentRows');
  if (!contentRows) return;
  contentRows.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Initializing Netflix Live-Action Catalog...</div>';

  const G = CONFIG.TMDB_GENRES;
  const rowPromises = [
    window.fetchTmdbLiveActionRail('/discover/movie?sort_by=popularity.desc', 'Trending Movies Worldwide', 'MOVIE'),
    window.fetchTmdbLiveActionRail('/discover/tv?sort_by=popularity.desc', 'Top Binge-Worthy TV Series', 'TV'),
    window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.ACTION.movie}&sort_by=popularity.desc`, 'Explosive Action & Thrillers', 'MOVIE'),
    window.fetchTmdbLiveActionRail(`/discover/tv?with_genres=${G.ACTION.tv}&sort_by=popularity.desc`, 'Action & Adventure Series', 'TV'),
    window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.ROMANCE.movie}&sort_by=popularity.desc`, 'Romance & Heartwarming Dramas', 'MOVIE'),
    window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.SCI_FI.movie}&sort_by=popularity.desc`, 'Sci-Fi & High Concept Cinema', 'MOVIE'),
    window.fetchTmdbLiveActionRail('/discover/movie?with_original_language=hi&sort_by=popularity.desc', 'Hindi Dubbed & Bollywood Cinema', 'MOVIE')
  ];

  const rows = (await Promise.all(rowPromises)).filter(Boolean);
  if (!rows.length) {
    contentRows.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">Failed loading live-action catalog. Please verify connectivity.</div>';
    return;
  }

  if (rows[0] && rows[0].list && rows[0].list.length > 0) {
    const heroItem = rows[0].list[0];
    STATE.currentAnime = heroItem;
    STATE.currentTMDBId = heroItem.id;
    window.updateHeroBillboard(heroItem);
  }

  contentRows.innerHTML = rows.map((r, i) => window.generateRowHTML(r.title, r.list, i)).join('');
};

window.updateHeroBillboard = function(item) {
  const heroTitle = document.getElementById('heroTitle');
  const heroDesc = document.getElementById('heroDesc');
  const heroBg = document.getElementById('heroBg');
  const heroScore = document.getElementById('heroScore');
  const heroYear = document.getElementById('heroYear');
  const heroFormat = document.getElementById('heroFormat');
  const heroFormatBadge = document.getElementById('heroFormatBadge');
  const heroPlayBtn = document.getElementById('heroPlayBtn');
  const heroInfoBtn = document.getElementById('heroInfoBtn');

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

window.generateRowHTML = function(title, items, rowIndex) {
  const cardsHTML = items.map(item => {
    const displayTitle = item.title?.english || item.title?.romaji || 'Title';
    const poster = item.coverImage?.large || item.coverImage?.extraLarge || '';
    const score = item.averageScore ? `${item.averageScore}%` : '85%';
    const format = item.format || 'TV';

    return `
      <div class="anime-card" 
           style="flex: 0 0 176px !important; max-width: 176px !important; width: 176px !important; height: 265px !important; position: relative !important; border-radius: 12px !important; overflow: hidden !important; cursor: pointer !important; transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s ease !important; user-select: none !important; background: #16161c !important; box-sizing: border-box !important;"
           onmouseover="this.style.transform='scale(1.05)'; this.style.boxShadow='0 12px 28px rgba(0,0,0,0.75)';"
           onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='none';"
           onclick="if(typeof window.openModalById === 'function') window.openModalById(${item.id});">
        
        <img src="${poster}" 
             alt="${displayTitle}" 
             loading="lazy" 
             style="width: 100% !important; height: 100% !important; object-fit: cover !important; display: block !important; border-radius: 12px !important;" />
             
        <div class="card-badge-top" 
             style="position: absolute !important; top: 8px !important; right: 8px !important; background: rgba(0, 0, 0, 0.78) !important; backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px !important; border-radius: 6px !important; z-index: 3 !important; border: 1px solid rgba(255, 255, 255, 0.12) !important;">
          ${format}
        </div>
        
        <div class="card-overlay" 
             style="position: absolute !important; inset: auto 0 0 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100% !important; margin: 0 !important; padding: 42px 12px 10px 12px !important; box-sizing: border-box !important; background: linear-gradient(to top, rgba(4, 4, 6, 0.98) 0%, rgba(4, 4, 6, 0.7) 62%, transparent 100%) !important; display: flex !important; flex-direction: column !important; justify-content: flex-end !important; z-index: 2 !important; pointer-events: none !important;">
          <div class="card-title" 
               style="font-size: 13px !important; font-weight: 700 !important; color: #ffffff !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95) !important; width: 100% !important; text-align: left !important; margin: 0 !important; padding: 0 !important; display: block !important;">
            ${displayTitle}
          </div>
          <div class="card-meta" 
               style="font-size: 11px !important; color: #a1a1aa !important; display: flex !important; gap: 8px !important; align-items: center !important; margin-top: 4px !important; width: 100% !important; text-align: left !important;">
            <span class="card-score" style="color: #46d369 !important; font-weight: 700 !important; display: inline-flex !important; align-items: center !important; gap: 3px !important;"><i class="fas fa-star" style="font-size: 9px;"></i> ${score}</span>
            <span class="card-year" style="color: #a1a1aa !important;">${item.year || '2026'}</span>
          </div>
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

// ============================================================================
// 10. UNIFIED CATEGORY FILTERING & TAB NAVIGATION PIPELINE
// ============================================================================
window.applyQuickFilter = async function(filterKey, element) {
  const key = (filterKey || 'ALL').toUpperCase();

  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  if (element) {
    element.classList.add('active');
  } else {
    const match = document.querySelector(`.chip[data-filter="${key}"]`) ||
                  document.querySelector(`.chip[onclick*="'${filterKey}'"]`);
    if (match) match.classList.add('active');
  }

  // --- NETFLIX LIVE-ACTION PIPELINE ---
  if (STATE.isNetflixMode) {
    const contentRows = document.getElementById('contentRows');
    if (!contentRows) return;
    contentRows.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Filtering Live-Action Catalog...</div>';

    const G = CONFIG.TMDB_GENRES;
    let fetchPromises = [];

    if (key === 'ALL') {
      await window.renderTmdbLiveActionHome();
      return;
    } else if (key === 'MOVIES') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail('/discover/movie?sort_by=popularity.desc', 'Trending Movies Worldwide', 'MOVIE'),
        window.fetchTmdbLiveActionRail('/discover/movie?sort_by=vote_average.desc&vote_count.gte=200', 'Critically Acclaimed Movies', 'MOVIE'),
        window.fetchTmdbLiveActionRail('/discover/movie?with_original_language=hi&sort_by=popularity.desc', 'Bollywood & Hindi Cinema', 'MOVIE')
      ];
    } else if (key === 'TOP_AIRING' || key === 'SHOWS' || key === 'TV') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail('/discover/tv?sort_by=popularity.desc', 'Top Binge Series', 'TV'),
        window.fetchTmdbLiveActionRail('/discover/tv?sort_by=vote_average.desc&vote_count.gte=100', 'All-Time Greatest TV Shows', 'TV')
      ];
    } else if (key === 'HINDI') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail('/discover/movie?with_original_language=hi&sort_by=popularity.desc', 'Hindi Blockbuster Movies', 'MOVIE'),
        window.fetchTmdbLiveActionRail('/discover/tv?with_original_language=hi&sort_by=popularity.desc', 'Hindi Web Series & Dramas', 'TV'),
        window.fetchTmdbLiveActionRail('/discover/movie?with_original_language=hi&sort_by=vote_average.desc&vote_count.gte=50', 'Critically Acclaimed Hindi Hits', 'MOVIE')
      ];
    } else if (key === 'ACTION') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.ACTION.movie}&sort_by=popularity.desc`, 'Action Blockbusters & Adrenaline', 'MOVIE'),
        window.fetchTmdbLiveActionRail(`/discover/tv?with_genres=${G.ACTION.tv}&sort_by=popularity.desc`, 'Action & Military TV Series', 'TV')
      ];
    } else if (key === 'ROMANCE') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.ROMANCE.movie}&sort_by=popularity.desc`, 'Romantic Comedies & Dramas', 'MOVIE'),
        window.fetchTmdbLiveActionRail(`/discover/tv?with_genres=${G.ROMANCE.tv}&sort_by=popularity.desc`, 'Romantic Drama Series', 'TV')
      ];
    } else if (key === 'SCI_FI') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.SCI_FI.movie}&sort_by=popularity.desc`, 'Sci-Fi Explorations & Cyberpunk', 'MOVIE'),
        window.fetchTmdbLiveActionRail(`/discover/tv?with_genres=${G.SCI_FI.tv}&sort_by=popularity.desc`, 'Sci-Fi & Futuristic TV Shows', 'TV')
      ];
    } else if (key === 'THRILLER' || key === 'CRIME') {
      fetchPromises = [
        window.fetchTmdbLiveActionRail(`/discover/movie?with_genres=${G.THRILLER_CRIME.movie}&sort_by=popularity.desc`, 'Gripping Crime & Mystery Films', 'MOVIE'),
        window.fetchTmdbLiveActionRail(`/discover/tv?with_genres=${G.THRILLER_CRIME.tv}&sort_by=popularity.desc`, 'Psychological Thriller Series', 'TV')
      ];
    }

    const rows = (await Promise.all(fetchPromises)).filter(Boolean);
    if (!rows.length) {
      contentRows.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">No live-action media found for this category.</div>';
      return;
    }

    contentRows.innerHTML = rows.map((r, i) => window.generateRowHTML(r.title, r.list, i)).join('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  // --- ANIME UNIVERSE PIPELINE ---
  if (key === 'ALL') {
    if (typeof window.renderHomeRows === 'function') await window.renderHomeRows();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (key === 'HINDI') {
    if (typeof window.loadHindiDubbed === 'function') await window.loadHindiDubbed();
  } else if (key === 'MOVIES') {
    if (typeof window.navigateGenre === 'function') await window.navigateGenre('Movie', 'Top Anime Movies');
  } else if (key === 'TOP_AIRING' || key === 'TOP_RATED') {
    if (typeof window.navigateGenre === 'function') await window.navigateGenre('Top', 'Top Airing Anime');
  } else if (key === 'ACTION') {
    if (typeof window.navigateGenre === 'function') await window.navigateGenre('Action', 'Action Anime');
  } else if (key === 'ROMANCE') {
    if (typeof window.navigateGenre === 'function') await window.navigateGenre('Romance', 'Romance & Drama');
  } else if (key === 'SCI_FI') {
    if (typeof window.navigateGenre === 'function') await window.navigateGenre('Sci-Fi', 'Sci-Fi & Cyberpunk');
  } else if (key === 'SECONDARY' || key === 'FANTASY') {
    if (typeof window.navigateGenre === 'function') await window.navigateGenre('Fantasy', 'Isekai & Fantasy');
  }
};

window.navigateGenre = async function(genre, label) {
  document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
    const match = link.innerText.toLowerCase().includes((label || '').toLowerCase());
    link.classList.toggle('active', Boolean(match));
  });

  if (STATE.isNetflixMode) {
    if (!genre || genre === 'Home') {
      await window.applyQuickFilter('ALL');
    } else if (genre === 'Movies' || genre === 'Movie') {
      await window.applyQuickFilter('MOVIES');
    } else if (genre === 'TV' || genre === 'TV Shows') {
      await window.applyQuickFilter('TOP_AIRING');
    } else if (genre === 'Action') {
      await window.applyQuickFilter('ACTION');
    } else if (genre === 'Romance') {
      await window.applyQuickFilter('ROMANCE');
    } else if (genre === 'Hindi') {
      await window.applyQuickFilter('HINDI');
    } else if (genre === 'Thriller' || genre === 'Crime') {
      await window.applyQuickFilter('THRILLER');
    }
    return;
  }

  const contentRows = document.getElementById('contentRows');
  if (contentRows) contentRows.innerHTML = '';

  if (!genre) {
    if (typeof window.renderHomeRows === 'function') await window.renderHomeRows();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (typeof window.renderRow === 'function') {
    await window.renderRow(label || genre, { page: 1, perPage: 24, genre: genre, sort: ['TRENDING_DESC'] }, false);
    await window.renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre: genre, sort: ['SCORE_DESC'] }, false);
  }
  window.scrollTo({ top: 350, behavior: 'smooth' });
};

window.loadHindiDubbed = async function() {
  if (STATE.isNetflixMode) {
    await window.applyQuickFilter('HINDI');
    return;
  }
  if (typeof window.renderHindiDubRow === 'function') {
    const contentRows = document.getElementById('contentRows');
    if (contentRows) contentRows.innerHTML = '';
    await window.renderHindiDubRow();
    if (typeof window.renderRow === 'function') {
      await window.renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
      await window.renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['POPULARITY_DESC'] }, false);
    }
    window.scrollTo({ top: 350, behavior: 'smooth' });
  }
};

// ============================================================================
// 11. DUAL-UNIVERSE TRANSFORMER (NETFLIX VS ANIME)
// ============================================================================
window.toggleNetflixMode = async function(skipUrlSync = false) {
  STATE.isNetflixMode = !STATE.isNetflixMode;

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
    await window.renderTmdbLiveActionHome();
  } else {
    document.body.classList.remove('netflix-theme-active');
    if (btn) btn.classList.remove('netflix-mode-active');
    if (brandText) brandText.innerHTML = 'ANIFLIX<small class="brand-badge">ULTRA</small>';
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
// 12. MODAL, DRAWER & WATCHLIST CONTROLLERS
// ============================================================================
window.toggleMobileNav = function(isOpen, skipUrlSync = false) {
  const drawer = document.getElementById('mobileNavDrawer');
  const overlay = document.getElementById('mobileDrawerOverlay');
  if (!drawer || !overlay) return;

  const shouldOpen = (isOpen !== undefined) ? Boolean(isOpen) : !drawer.classList.contains('open');

  if (shouldOpen) {
    drawer.classList.add('open');
    overlay.classList.add('active');
    document.documentElement.style.overflowY = 'hidden';
    if (!skipUrlSync && window.Router) Router.set({ drawer: 'menu' }, true);
  } else {
    drawer.classList.remove('open');
    overlay.classList.remove('active');
    document.documentElement.style.overflowY = 'scroll';
    if (!skipUrlSync && window.Router && Router.get('drawer') === 'menu') {
      Router.set({ drawer: null });
    }
  }
};

window.openWatchlistModal = function(skipUrlSync = false) {
  window.toggleMobileNav(false, true);
  const drawer = document.getElementById('watchlistDrawer');
  const overlay = document.getElementById('drawerOverlay');
  const listContainer = document.getElementById('watchlistItemsList');

  if (drawer && overlay) {
    drawer.classList.add('open');
    overlay.classList.add('active');
    document.documentElement.style.overflowY = 'hidden';
    if (!skipUrlSync && window.Router) Router.set({ drawer: 'watchlist' }, true);
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

window.closeWatchlistModal = function(skipUrlSync = false) {
  const drawer = document.getElementById('watchlistDrawer');
  const overlay = document.getElementById('drawerOverlay');
  if (drawer && overlay) {
    drawer.classList.remove('open');
    overlay.classList.remove('active');
    document.documentElement.style.overflowY = 'scroll';
    if (!skipUrlSync && window.Router && Router.get('drawer') === 'watchlist') {
      Router.set({ drawer: null });
    }
  }
};

window.toggleWatchlist = function(anime = STATE.currentAnime) {
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

window.toggleModalWatchlist = function() {
  window.toggleWatchlist(STATE.currentAnime);
};

window.updateModalWatchlistButtonState = function() {
  const btn = document.getElementById('modalWatchlistBtn');
  if (!btn || !STATE.currentAnime) return;
  const exists = STATE.watchlist.some(item => item.id === STATE.currentAnime.id);
  btn.innerHTML = exists
    ? `<i class="fas fa-check" style="color:#46d369;"></i> <span>In My List</span>`
    : `<i class="fas fa-plus"></i> <span>My List</span>`;
};

window.updateWatchlistBadge = function() {
  const counter = document.getElementById('watchlistCount');
  const mobileCounter = document.getElementById('mobileWatchlistCount');
  if (counter) counter.innerText = STATE.watchlist.length;
  if (mobileCounter) mobileCounter.innerText = STATE.watchlist.length;
};

// ============================================================================
// 13. POWER-USER PHYSICAL KEYBOARD HOTKEYS
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
        window.toggleTheaterMode();
        break;
      case 'n':
      case 'N':
        if (typeof window.nextEpisode === 'function') window.nextEpisode();
        break;
    }
  });
}

window.toggleFullscreenMode = function() {
  const wrap = document.getElementById('modalPlayerWrap');
  if (!wrap) return;

  if (!document.fullscreenElement) {
    wrap.requestFullscreen?.().then(() => Router.set({ fs: 1 }, true)).catch(() => {});
  } else {
    document.exitFullscreen?.().then(() => Router.set({ fs: null })).catch(() => {});
  }
};

window.toggleTheaterMode = function() {
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
// 14. AUXILIARY UTILITIES & APP LIFECYCLE INITIALIZER
// ============================================================================
window.showToast = function(msg) {
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

window.cleanHTML = function(str) {
  if (!str) return 'No synopsis available for this media title.';
  return str.replace(/<[^>]*>?/gm, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
};

window.extractSeasonInfo = function(anime) {
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

document.addEventListener('DOMContentLoaded', async () => {
  window.updateWatchlistBadge();
  initKeyboardShortcuts();

  const isPwaInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const pill = document.getElementById('appStatusPill');
  if (pill) {
    pill.style.display = isPwaInstalled ? 'inline-flex' : 'none';
  }

  if (typeof window.renderHeroSpotlight === 'function') {
    await window.renderHeroSpotlight();
  }
  if (typeof window.renderHomeRows === 'function') {
    await window.renderHomeRows();
  }

  setTimeout(() => {
    if (window.Router) Router.syncUIFromURL();
  }, 250);
});

window.addEventListener('resize', () => {
  STATE.isMobile = window.innerWidth <= 768;
});
