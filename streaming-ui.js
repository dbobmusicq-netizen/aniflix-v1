/**
 * AniFlix Ultra - Multi-Device Synchronized UI & API Integration Module
 * File: streaming-ui.js
 * Version: 23.0.0 Enterprise Hybrid Architecture
 * 
 * Card UI Overhaul Fix:
 *  - Unified Clean Card Architecture: Completely removed detached footer blocks (.card-info), 
 *    replacing them with an integrated full-height poster and sleek inner gradient overlay.
 *  - Fixed Text Offset & Clipping: Ensured text sits completely inside card bounds with absolute zero clipping.
 *  - Official TMDB v3 API Parameter Deduplication Engine (Zero status_code:5 / HTTP 400 errors).
 *  - Dual-Universe Aware: Live-Action Isolation (without_genres=16) vs Anime Universe.
 */

// ===============================================================
// 0. IN-MEMORY CACHE & RUNTIME EXECUTION TRACKERS
// ===============================================================
const queryCache = new Map();
let streamLoadTimeout = null;
let healthProbeAbortControllers = [];
let aniSkipIntervals = [];
let aniSkipPollTimer = null;
let currentAudioGainLevel = 1.0;
let audioCtx = null;
let gainNode = null;

// Anti-429 Throttle & Queue Control State
let lastGqlRequestTime = 0;
const GQL_MIN_INTERVAL_MS = 380;
let gqlQueue = Promise.resolve();

const FALLBACK_POSTER = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%22200%22%20height%3D%22300%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%2316161c%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20fill%3D%22%23666%22%20font-size%3D%2214%22%20text-anchor%3D%22middle%22%20alignment-baseline%3D%22middle%22%3ENo%20Image%3C%2Ftext%3E%3C%2Fsvg%3E';

// ===============================================================
// 1. INDEXEDDB PERSISTENCE LAYER (DEXIE.JS WITH SAFE FALLBACK)
// ===============================================================
const db = window.Dexie ? new Dexie('AniFlixUltraDB') : null;
if (db) {
  try {
    db.version(1).stores({
      watchHistory: 'id, animeId, title, season, episode, currentTime, duration, lastUpdated',
      cachedQueries: 'key, data, timestamp'
    });
  } catch (e) {
    console.warn('[DB Engine] Dexie initialization warning:', e);
  }
}
window.db = db;

// ===============================================================
// 2. NETWORK ENGINE & OFFICIAL TMDB PARAMETER DEDUPLICATOR
// ===============================================================
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

function enqueueGQL(taskFn) {
  gqlQueue = gqlQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - lastGqlRequestTime;
    if (elapsed < GQL_MIN_INTERVAL_MS) {
      await new Promise(res => setTimeout(res, GQL_MIN_INTERVAL_MS - elapsed));
    }
    lastGqlRequestTime = Date.now();
    return taskFn();
  }).catch(err => {
    console.warn('[GQL Queue] Task evaluation rejected:', err);
    return null;
  });
  return gqlQueue;
}

async function fetchWithRetry(url, options = {}, retries = 2, delay = 2500) {
  try {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const retryHeader = response.headers.get('Retry-After');
      const waitSeconds = retryHeader ? parseInt(retryHeader, 10) : (delay / 1000);
      console.warn(`[API Rate Limit]: Backing off for ${waitSeconds}s...`);
      
      if (retries > 0) {
        await new Promise(res => setTimeout(res, Math.max(waitSeconds, 2) * 1000));
        return fetchWithRetry(url, options, retries - 1, delay * 2);
      }
      return null;
    }

    if (!response.ok) {
      if (response.status === 400 || response.status === 500) {
        console.warn(`[API Network ${response.status}]: ${url}`);
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
window.fetchWithRetry = fetchWithRetry;

async function fetchGQL(query, variables = {}) {
  const cacheKey = JSON.stringify({ query, variables });

  if (queryCache.has(cacheKey)) {
    return queryCache.get(cacheKey);
  }

  if (db && db.cachedQueries) {
    try {
      const cached = await db.cachedQueries.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < 900000)) {
        queryCache.set(cacheKey, cached.data);
        return cached.data;
      }
    } catch (e) {}
  }

  return enqueueGQL(async () => {
    try {
      const json = await fetchWithRetry(window.CONFIG?.APIS?.ANILIST || 'https://graphql.anilist.co', {
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
        setTimeout(() => queryCache.delete(cacheKey), 900000);
        return json.data;
      }
      return null;
    } catch (err) {
      return null;
    }
  });
}
window.fetchGQL = fetchGQL;

const GQL_BASIC = `
  query ($page: Int, $perPage: Int, $sort: [MediaSort], $genre: String, $search: String, $status: MediaStatus) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: $sort, genre: $genre, search: $search, status: $status, isAdult: false) {
        id idMal title { romaji english native } description bannerImage
        coverImage { extraLarge large medium color } episodes duration format status genres averageScore seasonYear
      }
    }
  }
`;

const GQL_DEEP = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id idMal trailer { id site }
      characters(sort: [ROLE, RELEVANCE_DESC], perPage: 14) {
        edges {
          node { id name { full } image { large } }
          voiceActors(language: JAPANESE) { name { full } image { large } }
        }
      }
      recommendations(sort: [RATING_DESC], perPage: 8) {
        nodes {
          mediaRecommendation {
            id idMal title { romaji english }
            coverImage { extraLarge large }
            format episodes averageScore bannerImage
          }
        }
      }
    }
  }
`;

// ===============================================================
// 3. TOP BAR & CHIP CATEGORY STATE SYNCHRONIZER
// ===============================================================
window.syncCategoryState = function(categoryKey) {
  const topLinks = document.querySelectorAll('.nav-desktop .nav-link, .mobile-nav-list .mobile-nav-link');
  const chips = document.querySelectorAll('.chips-container .chip');

  topLinks.forEach(l => l.classList.remove('active'));
  chips.forEach(c => c.classList.remove('active'));

  const normKey = (categoryKey || 'ALL').toUpperCase();

  const targetChip = document.querySelector(`.chip[data-filter="${normKey}"]`) ||
                     document.querySelector(`.chip[onclick*="'${normKey}'"]`) ||
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

// ===============================================================
// 4. HERO SPOTLIGHT & BILLBOARD ENGINE
// ===============================================================
window.renderHeroSpotlight = async function() {
  const heroDubBadge = document.querySelector('.hero-tags .tag-hindi');

  if (window.STATE.isNetflixMode) {
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
          description: item.overview || 'Exclusive live-action blockbuster stream.',
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

        window.animeCache.set(mockMediaObj.id, mockMediaObj);
        window.STATE.currentAnime = mockMediaObj;
        window.STATE.currentTMDBId = mockMediaObj.id;

        const heroBg = document.getElementById('heroBg');
        if (heroBg) {
          heroBg.src = poster;
          if (typeof window.extractChromaAmbilight === 'function') {
            window.extractChromaAmbilight(poster);
          }
        }
        
        const heroTitle = document.getElementById('heroTitle');
        const heroScore = document.getElementById('heroScore');
        const heroYear = document.getElementById('heroYear');
        const heroFormat = document.getElementById('heroFormat');
        const heroStatus = document.getElementById('heroStatus');
        const heroDesc = document.getElementById('heroDesc');
        const heroFormatBadge = document.getElementById('heroFormatBadge');

        if (heroTitle) heroTitle.innerText = title;
        if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${mockMediaObj.averageScore}% Match`;
        if (heroYear) heroYear.innerText = mockMediaObj.seasonYear;
        if (heroFormat) heroFormat.innerText = mockMediaObj.format;
        if (heroStatus) heroStatus.innerText = 'NETFLIX LIVE';
        if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> NETFLIX LIVE SPOTLIGHT`;
        
        if (heroDubBadge) {
          heroDubBadge.innerHTML = `<i class="fas fa-film"></i> 4K ULTRA HD / MULTI AUDIO`;
        }
        
        if (heroDesc) heroDesc.innerText = window.cleanHTML ? window.cleanHTML(mockMediaObj.description) : mockMediaObj.description;

        const playBtn = document.getElementById('heroPlayBtn');
        const infoBtn = document.getElementById('heroInfoBtn');
        const bookmarkBtn = document.getElementById('heroBookmarkBtn');

        if (playBtn) playBtn.onclick = () => window.openModal(mockMediaObj, 1, 1, true);
        if (infoBtn) infoBtn.onclick = () => window.openModal(mockMediaObj, 1, 1, false);
        if (bookmarkBtn) bookmarkBtn.onclick = () => window.toggleWatchlist(mockMediaObj);
        return;
      }
    } catch (e) {
      console.warn('[Netflix Spotlight Error]:', e);
    }
  }

  // Anime Spotlight Query
  const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 1, sort: ['TRENDING_DESC'] });
  const anime = data?.Page?.media?.[0];
  if (!anime) return;

  window.animeCache.set(anime.id, anime);

  const title = anime.title.english || anime.title.romaji || 'Stream Master';
  const banner = anime.bannerImage || anime.coverImage?.extraLarge;

  const heroBg = document.getElementById('heroBg');
  if (heroBg) {
    heroBg.src = banner;
    if (typeof window.extractChromaAmbilight === 'function') {
      window.extractChromaAmbilight(banner);
    }
  }
  
  const heroTitle = document.getElementById('heroTitle');
  const heroScore = document.getElementById('heroScore');
  const heroYear = document.getElementById('heroYear');
  const heroFormat = document.getElementById('heroFormat');
  const heroStatus = document.getElementById('heroStatus');
  const heroDesc = document.getElementById('heroDesc');
  const heroFormatBadge = document.getElementById('heroFormatBadge');

  if (heroTitle) heroTitle.innerText = title;
  if (heroScore) heroScore.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 95}% Rating`;
  if (heroYear) heroYear.innerText = anime.seasonYear || '2026';
  if (heroFormat) heroFormat.innerText = anime.format || 'TV SERIES';
  if (heroStatus) heroStatus.innerText = anime.status || 'AIRING';
  if (heroFormatBadge) heroFormatBadge.innerHTML = `<i class="fas fa-play"></i> FEATURED SPOTLIGHT`;

  if (heroDubBadge) {
    heroDubBadge.innerHTML = `<i class="fas fa-microphone"></i> HINDI / SUB / DUB`;
  }

  if (heroDesc) heroDesc.innerText = window.cleanHTML ? window.cleanHTML(anime.description) : anime.description;

  const playBtn = document.getElementById('heroPlayBtn');
  const infoBtn = document.getElementById('heroInfoBtn');
  const bookmarkBtn = document.getElementById('heroBookmarkBtn');

  if (playBtn) playBtn.onclick = () => window.openModal(anime, 1, 1, true);
  if (infoBtn) infoBtn.onclick = () => window.openModal(anime, 1, 1, false);
  if (bookmarkBtn) bookmarkBtn.onclick = () => window.toggleWatchlist(anime);
};

// ===============================================================
// 5. STAGGERED CATALOG PIPELINE & UNIFIED CARD ARCHITECTURE
// ===============================================================
window.renderHomeRows = async function() {
  const content = document.getElementById('contentRows');
  if (content) content.innerHTML = '';

  if (window.STATE.isNetflixMode) {
    if (typeof window.showToast === 'function') window.showToast('Loading Live-Action Universe...');
    await renderTMDBRow('Trending Movies Worldwide', '/discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
    await renderTMDBRow('Trending TV Series', '/discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
    await renderTMDBRow('Bollywood & Hindi Cinema', '/discover/movie?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-language"></i>', 'MOVIE');
    await renderTMDBRow('Action Blockbusters & Adrenaline', '/discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
    await renderTMDBRow('Gripping Crime & Mystery Thrillers', '/discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');
    await renderTMDBRow('Romance & Heartwarming Dramas', '/discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
    return;
  }

  // Anime catalog
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
  } catch (e) {
    console.warn(`[Catalog Row Error]: Failed rendering ${title}`);
  }
}
window.renderRow = renderRow;

async function renderHindiDubRow() {
  const data = await fetchGQL(GQL_BASIC, { page: 1, perPage: 14, sort: ['FAVOURITES_DESC'] });
  if (data?.Page?.media?.length) {
    buildUnifiedCarouselDOM('<i class="fas fa-language" style="color:var(--accent-red,#e50914);"></i> Premium Hindi Dubbed Series', data.Page.media, false, true);
  }
}
window.renderHindiDubRow = renderHindiDubRow;

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
  } catch (e) {
    console.warn(`[TMDB Row Error]: ${title}`, e);
  }
}

/**
 * UNIFIED CARD ARCHITECTURE:
 * Solves all UI bugs across both Anime & Netflix modes. 
 * Replaces broken external flex columns with an in-card bottom gradient vignette,
 * fixing text clipping, misaligned paddings, and vertical stacking.
 */
function buildUnifiedCarouselDOM(title, items, isTop10 = false, isHindi = false) {
  const container = document.getElementById('contentRows');
  if (!container) return;
  const section = document.createElement('section');
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
    window.animeCache.set(anime.id, anime);

    const dispTitle = anime.title?.english || anime.title?.romaji || 'Anime';
    const poster = anime.coverImage?.extraLarge || anime.coverImage?.large || FALLBACK_POSTER;
    const score = anime.averageScore ? `${anime.averageScore}%` : '85%';
    const year = anime.seasonYear || '2026';
    const format = anime.format || 'TV';

    const card = document.createElement('div');
    card.className = 'anime-card card ui-card-locked';
    card.style.cssText = 'flex: 0 0 185px !important; min-width: 185px !important; max-width: 185px !important; height: 275px !important; position: relative !important; border-radius: 12px !important; overflow: hidden !important; cursor: pointer !important; transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.28s ease !important; user-select: none !important; background: #16161c !important; box-sizing: border-box !important; display: flex !important; flex-direction: column !important;';
    
    card.onmouseenter = () => { card.style.transform = 'translateY(-4px) scale(1.03)'; card.style.boxShadow = '0 14px 28px rgba(0,0,0,0.8)'; };
    card.onmouseleave = () => { card.style.transform = 'translateY(0) scale(1)'; card.style.boxShadow = 'none'; };
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
      
      <!-- Top Badge -->
      <div class="card-badge" style="position: absolute !important; top: 8px !important; right: 8px !important; background: ${isHindi ? '#e50914' : 'rgba(0,0,0,0.78)'} !important; backdrop-filter: blur(6px) !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px !important; border-radius: 6px !important; z-index: 3 !important; border: 1px solid rgba(255,255,255,0.12) !important;">
        ${isHindi ? 'HINDI DUB' : format}
      </div>

      <!-- In-Card Bottom Vignette (Guarantees zero text offset or clipping) -->
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
  const anime = window.animeCache.get(animeId);
  if (anime) window.openModal(anime);
}
window.handleAnimeClick = handleAnimeClick;

// ===============================================================
// 6. TOP NAVIGATION & FILTER CHIPS DISPATCHERS
// ===============================================================
window.navigateGenre = async function(genre, title) {
  if (typeof window.toggleMobileNav === 'function') window.toggleMobileNav(false);

  const key = genre ? genre.toUpperCase() : 'ALL';
  window.syncCategoryState(key);

  const contentRows = document.getElementById('contentRows');
  if (contentRows) contentRows.innerHTML = '';

  if (!genre) {
    await window.renderHomeRows();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (typeof window.showToast === 'function') window.showToast(`Loading ${title}...`);

  if (window.STATE.isNetflixMode) {
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
      await window.loadHindiDubbed();
    }
  } else {
    await renderRow(title, { page: 1, perPage: 24, genre: genre, sort: ['TRENDING_DESC'] }, false);
    await renderRow(`Top Rated ${genre}`, { page: 1, perPage: 24, genre: genre, sort: ['SCORE_DESC'] }, false);
  }

  window.scrollTo({ top: 350, behavior: 'smooth' });
};

window.loadHindiDubbed = async function() {
  if (typeof window.toggleMobileNav === 'function') window.toggleMobileNav(false);
  window.syncCategoryState('HINDI');

  const contentRows = document.getElementById('contentRows');
  if (contentRows) contentRows.innerHTML = '';

  if (typeof window.showToast === 'function') window.showToast('Loading Hindi Releases...');

  if (window.STATE.isNetflixMode) {
    await renderTMDBRow('Hindi Blockbuster Movies', '/discover/movie?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
    await renderTMDBRow('Hindi Web Series & Dramas', '/discover/tv?with_original_language=hi&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
    await renderTMDBRow('Critically Acclaimed Hindi Cinema', '/discover/movie?with_original_language=hi&sort_by=vote_average.desc&vote_count.gte=50', '<i class="fas fa-star"></i>', 'MOVIE');
  } else {
    await renderHindiDubRow();
    await renderRow('Action Hindi Audio', { page: 1, perPage: 18, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
    await renderRow('Fantasy Hindi Audio', { page: 1, perPage: 18, genre: 'Fantasy', sort: ['POPULARITY_DESC'] }, false);
  }

  window.scrollTo({ top: 350, behavior: 'smooth' });
};

window.applyQuickFilter = async function(type, chipBtn) {
  const contentRows = document.getElementById('contentRows');
  if (contentRows) contentRows.innerHTML = '';

  const normType = (type || 'ALL').toUpperCase();

  if (window.STATE.isNetflixMode) {
    switch (normType) {
      case 'ALL':
        window.syncCategoryState('ALL');
        await window.renderHomeRows();
        break;
      case 'MOVIES':
        window.syncCategoryState('MOVIES');
        await renderTMDBRow('Trending Movies Worldwide', '/discover/movie?sort_by=popularity.desc', '<i class="fas fa-film"></i>', 'MOVIE');
        await renderTMDBRow('Critically Acclaimed Feature Films', '/discover/movie?sort_by=vote_average.desc&vote_count.gte=200', '<i class="fas fa-star"></i>', 'MOVIE');
        break;
      case 'TOP_AIRING':
      case 'SHOWS':
      case 'TV':
        window.syncCategoryState('TOP_AIRING');
        await renderTMDBRow('Top Binge TV Series', '/discover/tv?sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        await renderTMDBRow('All-Time Greatest TV Shows', '/discover/tv?sort_by=vote_average.desc&vote_count.gte=100', '<i class="fas fa-star"></i>', 'TV');
        break;
      case 'HINDI':
        await window.loadHindiDubbed();
        break;
      case 'ACTION':
        window.syncCategoryState('ACTION');
        await renderTMDBRow('Action Movies & Adrenaline', '/discover/movie?with_genres=28&sort_by=popularity.desc', '<i class="fas fa-bolt"></i>', 'MOVIE');
        await renderTMDBRow('Action & Adventure Series', '/discover/tv?with_genres=10759&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        break;
      case 'THRILLER':
      case 'CRIME':
        window.syncCategoryState('THRILLER');
        await renderTMDBRow('Crime & Mystery Thrillers', '/discover/movie?with_genres=53&sort_by=popularity.desc', '<i class="fas fa-mask"></i>', 'MOVIE');
        await renderTMDBRow('Psychological Drama Series', '/discover/tv?with_genres=80&sort_by=popularity.desc', '<i class="fas fa-user-secret"></i>', 'TV');
        break;
      case 'SCI_FI':
        window.syncCategoryState('SCI_FI');
        await renderTMDBRow('Sci-Fi Explorations & Cyberpunk', '/discover/movie?with_genres=878&sort_by=popularity.desc', '<i class="fas fa-microchip"></i>', 'MOVIE');
        await renderTMDBRow('Sci-Fi & Futuristic TV Shows', '/discover/tv?with_genres=10765&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        break;
      case 'ROMANCE':
        window.syncCategoryState('ROMANCE');
        await renderTMDBRow('Romantic Comedies & Dramas', '/discover/movie?with_genres=10749&sort_by=popularity.desc', '<i class="fas fa-heart"></i>', 'MOVIE');
        await renderTMDBRow('Romantic Drama Series', '/discover/tv?with_genres=10766&sort_by=popularity.desc', '<i class="fas fa-tv"></i>', 'TV');
        break;
    }
    window.scrollTo({ top: 350, behavior: 'smooth' });
    return;
  }

  // Anime Universe Filter Handling
  switch (normType) {
    case 'ALL':
      window.syncCategoryState('ALL');
      await window.renderHomeRows();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;
    case 'HINDI':
      await window.loadHindiDubbed();
      break;
    case 'TOP_AIRING':
      window.syncCategoryState('TOP_AIRING');
      await renderRow('Top Airing Worldwide', { page: 1, perPage: 24, status: 'RELEASING', sort: ['POPULARITY_DESC'] }, false);
      break;
    case 'MOVIES':
      window.syncCategoryState('MOVIES');
      await renderRow('Anime Movies & Films', { page: 1, perPage: 24, sort: ['SCORE_DESC'] }, false);
      break;
    case 'ACTION':
      window.syncCategoryState('ACTION');
      await renderRow('Action & Shonen Hits', { page: 1, perPage: 24, genre: 'Action', sort: ['POPULARITY_DESC'] }, false);
      break;
    case 'SECONDARY':
      window.syncCategoryState('FANTASY');
      await renderRow('Isekai & Fantasy Realms', { page: 1, perPage: 24, genre: 'Fantasy', sort: ['TRENDING_DESC'] }, false);
      break;
    case 'SCI_FI':
      window.syncCategoryState('SCI_FI');
      await renderRow('Sci-Fi & Cyberpunk', { page: 1, perPage: 24, genre: 'Sci-Fi', sort: ['SCORE_DESC'] }, false);
      break;
    case 'ROMANCE':
      window.syncCategoryState('ROMANCE');
      await renderRow('Romance & Slice of Life', { page: 1, perPage: 24, genre: 'Romance', sort: ['POPULARITY_DESC'] }, false);
      break;
  }
  window.scrollTo({ top: 350, behavior: 'smooth' });
};

window.playRandomAnime = async function() {
  if (typeof window.toggleMobileNav === 'function') window.toggleMobileNav(false);
  if (typeof window.showToast === 'function') window.showToast('Rolling for a random title...');

  if (window.STATE.isNetflixMode) {
    try {
      const url = cleanTMDBUrl('/discover/movie', { sort_by: 'popularity.desc' });
      const data = await fetchWithRetry(url);
      const results = data?.results || [];
      if (results.length > 0) {
        const item = results[Math.floor(Math.random() * results.length)];
        const poster = `https://image.tmdb.org/t/p/w500${item.poster_path}`;
        const mockMediaObj = {
          id: item.id,
          idMal: null,
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
        window.animeCache.set(mockMediaObj.id, mockMediaObj);
        window.openModal(mockMediaObj, 1, 1, false);
        return;
      }
    } catch (e) {}
  }

  const randomPage = Math.floor(Math.random() * 20) + 1;
  const data = await fetchGQL(GQL_BASIC, { page: randomPage, perPage: 10, sort: ['POPULARITY_DESC'] });
  const list = data?.Page?.media || [];

  if (list.length > 0) {
    const selected = list[Math.floor(Math.random() * list.length)];
    window.animeCache.set(selected.id, selected);
    window.openModal(selected, 1, 1, false);
    if (typeof window.showToast === 'function') {
      window.showToast(`Selected: ${selected.title?.english || selected.title?.romaji}`);
    }
  } else {
    if (typeof window.showToast === 'function') window.showToast('Failed to fetch a random title.');
  }
};

// ===============================================================
// 7. CINEMATIC MODAL & INTERACTIVE PLAY CONTROLLER
// ===============================================================
window.openModalById = async function(id, episode = 1, season = 1) {
  let anime = window.animeCache.get(id);
  if (!anime) {
    if (window.STATE.isNetflixMode) {
      try {
        const item = await fetchWithRetry(`https://db.speedracelight.com/3/movie/${id}`);
        if (item) anime = window.formatTmdbMediaItem?.(item, 'MOVIE');
      } catch (e) {}
    } else {
      const data = await fetchGQL(GQL_DEEP, { id: id });
      anime = data?.Media;
    }
  }
  if (anime) {
    await window.openModal(anime, season, episode, true, true);
  }
};

window.openModal = async function(anime, season = 1, episode = 1, autoStart = false, skipUrlSync = false) {
  window.STATE.savedScrollY = window.scrollY;
  window.STATE.currentAnime = anime;

  const isMovie = anime.format === 'MOVIE';
  const seasonInfo = window.extractSeasonInfo ? window.extractSeasonInfo(anime) : { season: 1, cleanTitle: anime.title?.english || '' };
  window.STATE.season = isMovie ? 1 : (season || seasonInfo.season);
  window.STATE.episode = isMovie ? 1 : (episode || 1);

  const overlay = document.getElementById('modalOverlay');
  const container = document.getElementById('modalContainer');

  if (overlay) overlay.classList.add('active');
  if (container) container.classList.add('active');
  document.documentElement.style.overflowY = 'hidden';

  const overviewTabBtn = document.querySelector('.modal-tabs .tab-btn');
  if (overviewTabBtn) switchTab('tab-overview', overviewTabBtn);

  if (typeof window.updateModalWatchlistButtonState === 'function') {
    window.updateModalWatchlistButtonState();
  }

  const title = anime.title?.english || anime.title?.romaji || 'Title';
  const banner = anime.bannerImage || anime.coverImage?.extraLarge || '';

  const modalNowPlayingTitle = document.getElementById('modalNowPlayingTitle');
  const playerStreamTitle = document.getElementById('playerStreamTitle');
  const nextEpBtnText = document.getElementById('nextEpBtnText');
  const episodesMasterSection = document.getElementById('episodesMasterSection');

  if (isMovie) {
    if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Movie`;
    if (playerStreamTitle) playerStreamTitle.innerText = `Feature Film`;
    if (nextEpBtnText) nextEpBtnText.innerText = `Full Film`;
    if (episodesMasterSection) episodesMasterSection.style.display = 'none';
  } else {
    if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • S${window.STATE.season} Ep ${window.STATE.episode}`;
    if (playerStreamTitle) playerStreamTitle.innerText = `Season ${window.STATE.season} • Episode ${window.STATE.episode}`;
    if (nextEpBtnText) nextEpBtnText.innerText = `Next Ep`;
    if (episodesMasterSection) episodesMasterSection.style.display = 'block';
  }

  if (typeof window.extractChromaAmbilight === 'function') {
    window.extractChromaAmbilight(banner);
  }

  const scoreEl = document.getElementById('modalScore');
  const yearEl = document.getElementById('modalYear');
  const formatEl = document.getElementById('modalFormat');
  const epCountEl = document.getElementById('modalEpisodesCount');
  const descEl = document.getElementById('modalDesc');
  const nativeEl = document.getElementById('modalNative');
  const statusEl = document.getElementById('modalStatus');
  const genresEl = document.getElementById('modalGenres');
  const studioEl = document.getElementById('modalStudio');
  const durationEl = document.getElementById('modalDuration');

  if (scoreEl) scoreEl.innerHTML = `<i class="fas fa-star"></i> ${anime.averageScore || 90}% Score`;
  if (yearEl) yearEl.innerText = anime.seasonYear || anime.year || '2026';
  if (formatEl) formatEl.innerText = anime.format || (isMovie ? 'MOVIE' : 'TV');
  if (epCountEl) epCountEl.innerText = isMovie ? 'Feature Film' : `${anime.episodes || '?'} Episodes`;
  if (descEl) descEl.innerText = window.cleanHTML ? window.cleanHTML(anime.description) : (anime.description || '');
  if (nativeEl) nativeEl.innerText = anime.title?.native || 'N/A';
  if (statusEl) statusEl.innerText = anime.status || 'FINISHED';
  if (genresEl) genresEl.innerText = (anime.genres || []).join(', ');
  if (studioEl) studioEl.innerText = anime.studios?.nodes?.[0]?.name || (anime.isLiveAction ? 'Netflix Production' : 'Studio Animation');
  if (durationEl) durationEl.innerText = `${anime.duration || (isMovie ? 110 : 24)} mins`;

  const wrap = document.getElementById('modalPlayerWrap');
  if (wrap) {
    wrap.innerHTML = `
      <img src="${banner}" class="modal-backdrop-preview" alt="" onerror="this.src='${FALLBACK_POSTER}'" style="width:100%; height:100%; object-fit:cover; filter:brightness(0.7);" />
      <div class="player-cover-overlay" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:15; background:rgba(0,0,0,0.45); cursor:pointer;" onclick="window.executeStream(0)">
        <div class="modal-big-play-btn" style="width:72px; height:72px; border-radius:50%; background:#ffffff; display:flex; align-items:center; justify-content:center; box-shadow:0 0 30px rgba(255,255,255,0.4); margin-bottom:14px; cursor:pointer;" onclick="event.stopPropagation(); window.executeStream(0);">
          <i class="fas fa-play" style="color:#000; font-size:24px; margin-left:4px;"></i>
        </div>
        <h2 style="color:#fff; text-shadow:0 2px 10px rgba(0,0,0,0.9); font-weight:800; font-size:clamp(1.2rem, 2.5vw, 1.8rem); text-align:center; padding:0 20px;">${title}</h2>
        <p style="color:var(--accent-cyan, #00d2ff); font-size:13px; font-weight:700; margin-top:6px;">Season ${window.STATE.season} • Episode ${window.STATE.episode}</p>
        <button class="btn btn-play" style="margin-top:16px; padding:10px 24px; font-size:14px; pointer-events:auto;" onclick="event.stopPropagation(); window.executeStream(0);">
          <i class="fas fa-play"></i> ${isMovie ? 'Play Movie' : `Watch Episode ${window.STATE.episode}`}
        </button>
      </div>
    `;
  }

  if (typeof window.resolveTMDBId === 'function') {
    await window.resolveTMDBId(seasonInfo.cleanTitle, isMovie);
  }
  await fetchAndPopulateDeepData(anime);

  if (!isMovie && typeof window.renderEpisodeGrid === 'function') window.renderEpisodeGrid();
  if (anime.idMal && !window.STATE.isNetflixMode) resolveAndPollAniSkip(anime.idMal, window.STATE.episode);
  if (typeof window.renderServerSwitcherGrid === 'function') window.renderServerSwitcherGrid();
  checkAllServersHealth();

  if (!skipUrlSync && window.Router) {
    window.Router.set({ watch: anime.id, s: window.STATE.season, ep: window.STATE.episode, srv: window.STATE.activeServer }, true);
  }

  if (autoStart) window.executeStream(0);

  if (window.p2pParty && window.p2pParty.isHost) {
    window.p2pParty.broadcastTitleChange(anime, window.STATE.season, window.STATE.episode, window.STATE.activeServer);
  }
};

window.closeModal = function(skipUrlSync = false) {
  clearTimeout(streamLoadTimeout);

  const modalContainer = document.getElementById('modalContainer');
  if (!modalContainer || !modalContainer.classList.contains('active')) return;

  const modalOverlay = document.getElementById('modalOverlay');
  if (modalOverlay) modalOverlay.classList.remove('active');
  modalContainer.classList.remove('active');

  const wrap = document.getElementById('modalPlayerWrap');
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

  if (window.streamEngine) {
    window.streamEngine.destroy();
    window.streamEngine = null;
  }

  document.documentElement.style.overflowY = 'scroll';
  window.scrollTo(0, window.STATE.savedScrollY);

  window.STATE.currentAnime = null;
  if (!skipUrlSync && window.Router) {
    window.Router.set({ watch: null, s: null, ep: null, fs: null, srv: null });
  }
};

// ===============================================================
// 8. 4-SERVER MIRROR DISPATCH PIPELINE
// ===============================================================
window.executeStream = async function(retryCount = 0) {
  const wrap = document.getElementById('modalPlayerWrap');
  if (!wrap || !window.STATE.currentAnime) return;

  clearTimeout(streamLoadTimeout);

  const tId = window.STATE.currentTMDBId || window.CONFIG?.DEFAULT_TMDB_FALLBACK;
  const s = window.STATE.season;
  const e = window.STATE.episode;
  const isMovie = window.STATE.currentAnime?.format === 'MOVIE';
  const title = window.STATE.currentAnime?.title?.english || window.STATE.currentAnime?.title?.romaji || 'Title';
  const poster = window.STATE.currentAnime?.coverImage?.extraLarge || window.STATE.currentAnime?.bannerImage || '';

  const modalNowPlayingTitle = document.getElementById('modalNowPlayingTitle');
  const playerStreamTitle = document.getElementById('playerStreamTitle');

  if (isMovie) {
    if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Movie`;
    if (playerStreamTitle) playerStreamTitle.innerText = `Feature Film`;
  } else {
    if (modalNowPlayingTitle) modalNowPlayingTitle.innerText = `${title} • Season ${s} Episode ${e}`;
    if (playerStreamTitle) playerStreamTitle.innerText = `Season ${s} • Episode ${e}`;
  }

  const activeServerConfig = window.SERVER_CONFIG[window.STATE.activeServer] || window.SERVER_CONFIG[1];

  if (window.streamEngine) {
    await window.streamEngine.destroy();
    window.streamEngine = null;
  }

  const streamUrl = activeServerConfig.endpoint(tId, s, e, isMovie, window.STATE.currentAnime.id);

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

  if (typeof window.renderServerSwitcherGrid === 'function') window.renderServerSwitcherGrid();
  if (!isMovie && typeof window.renderEpisodeGrid === 'function') window.renderEpisodeGrid();

  const iframe = document.getElementById('streamFrame');
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
  if ('mediaSession' in navigator && window.STATE.currentAnime) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: isMovie ? title : `Episode ${e} - ${title}`,
      artist: isMovie ? 'Feature Film' : `Season ${s}`,
      album: 'AniFlix Ultra',
      artwork: [{ src: poster, sizes: '512x512', type: 'image/jpeg' }]
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => window.nextEpisode());
  }
}

function handleAutoFailover(currentRetry) {
  clearTimeout(streamLoadTimeout);
  const totalServers = Object.keys(window.SERVER_CONFIG).length;
  const nextServer = (window.STATE.activeServer % totalServers) + 1;
  window.STATE.activeServer = nextServer;

  if (typeof window.showToast === 'function') {
    window.showToast(`Node error. Failing over to ${window.SERVER_CONFIG[nextServer].name}...`);
  }
  window.executeStream(currentRetry + 1);
}

async function checkAllServersHealth() {
  const tId = window.STATE.currentTMDBId || window.CONFIG?.DEFAULT_TMDB_FALLBACK;
  const s = window.STATE.season;
  const e = window.STATE.episode;
  const isMovie = window.STATE.currentAnime?.format === 'MOVIE';

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

  const buttons = document.querySelectorAll('.server-node-btn');

  Object.keys(serverUrls).forEach(async (srvKey) => {
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
window.checkAllServersHealth = checkAllServersHealth;

// ===============================================================
// 9. MULTI-API DEEP DATA FETCHERS (CAST, RECS, TRAILERS)
// ===============================================================
async function fetchAndPopulateDeepData(anime) {
  const numericId = parseInt(anime.id, 10);

  const castGrid = document.getElementById('castGrid');
  if (castGrid) castGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading cast...</div>';

  const moreGrid = document.getElementById('moreGrid');
  if (moreGrid) moreGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Loading recommendations...</div>';

  const trailersGrid = document.getElementById('trailersGrid');
  if (trailersGrid) trailersGrid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Fetching trailers...</div>';

  let charactersLoaded = false;
  let recommendationsLoaded = false;
  let trailerLoaded = false;

  if (window.STATE.isNetflixMode || (window.STATE.currentTMDBId && window.STATE.currentTMDBId !== 533535)) {
    try {
      const isMovie = anime.format === 'MOVIE';
      const endpoint = `https://db.speedracelight.com/3/${isMovie ? 'movie' : 'tv'}/${window.STATE.currentTMDBId}?append_to_response=credits,videos,recommendations`;
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

  if (!window.STATE.isNetflixMode && (!charactersLoaded || !recommendationsLoaded || !trailerLoaded)) {
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
  const castGrid = document.getElementById('castGrid');
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
  const castGrid = document.getElementById('castGrid');
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
  const moreGrid = document.getElementById('moreGrid');
  if (!moreGrid) return;
  moreGrid.innerHTML = '';
  nodes.forEach(recNode => {
    const rec = recNode.mediaRecommendation;
    if (!rec) return;
    window.animeCache.set(rec.id, rec);
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
  const moreGrid = document.getElementById('moreGrid');
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
    window.animeCache.set(item.id, mockAnime);

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
  const trailersGrid = document.getElementById('trailersGrid');
  if (!trailersGrid || !youtubeId) return;
  trailersGrid.innerHTML = `
    <div class="modal-player-wrap" style="border-radius:12px; max-width:750px; margin:0 auto; aspect-ratio:16/9;">
      <iframe src="https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
    </div>
  `;
}

function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId)?.classList.add('active');
  btn?.classList.add('active');
}
window.switchTab = switchTab;

// ===============================================================
// 10. REAL-TIME SEARCH ENGINE & DROPDOWN SYNC
// ===============================================================
window.toggleSearch = function() {
  const wrapper = document.getElementById('searchWrapper');
  const input = document.getElementById('searchInput');
  if (!wrapper || !input) return;
  wrapper.classList.toggle('open');
  if (wrapper.classList.contains('open')) {
    input.focus();
  } else {
    window.clearSearch();
  }
};

window.clearSearch = function() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  const drop = document.getElementById('searchDropdown');
  if (drop) drop.classList.remove('visible');
  const clearBtn = document.getElementById('searchClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  if (window.Router) window.Router.set({ q: null });
};

document.getElementById('searchInput')?.addEventListener('input', (e) => {
  clearTimeout(window.STATE.searchDebounce);
  const q = e.target.value.trim();
  const drop = document.getElementById('searchDropdown');
  const clearBtn = document.getElementById('searchClearBtn');

  if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

  if (!q) {
    if (drop) drop.classList.remove('visible');
    if (window.Router) window.Router.set({ q: null });
    return;
  }

  if (window.Router && window.Router.get('q') !== q) {
    window.Router.set({ q: q }, false);
  }

  window.STATE.searchDebounce = setTimeout(async () => {
    if (window.STATE.isNetflixMode) {
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
          drop.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center;">No live-action titles found for "${q}"</div>`;
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
          window.animeCache.set(item.id, mockMediaObj);

          const el = document.createElement('div');
          el.className = 'search-item';
          el.onclick = () => {
            window.openModal(mockMediaObj);
            window.clearSearch();
          };
          el.innerHTML = `
            <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" />
            <div class="search-info">
              <div class="search-title">${title}</div>
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

    // Anime Search Query
    const data = await fetchGQL(GQL_BASIC, { search: q, perPage: 6 });
    if (!drop) return;
    drop.innerHTML = '';

    if (!data || !data.Page?.media?.length) {
      drop.innerHTML = `<div style="padding:15px; color:var(--text-muted); text-align:center;">No anime found for "${q}"</div>`;
      drop.classList.add('visible');
      return;
    }

    data.Page.media.forEach(anime => {
      window.animeCache.set(anime.id, anime);
      const title = anime.title?.english || anime.title?.romaji || 'Anime';
      const img = anime.coverImage?.large || anime.coverImage?.extraLarge || FALLBACK_POSTER;
      const item = document.createElement('div');
      item.className = 'search-item';
      item.onclick = () => {
        window.openModal(anime);
        window.clearSearch();
      };
      item.innerHTML = `
        <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" />
        <div class="search-info">
          <div class="search-title">${title}</div>
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

// ===============================================================
// 11. AIRING SCHEDULE & TRACE.MOE MODAL CONTROLLERS
// ===============================================================
const DAYS_MAP = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

window.openScheduleModal = function(skipUrlSync = false) {
  const modal = document.getElementById('scheduleModal');
  const overlay = document.getElementById('scheduleModalOverlay');
  if (!modal || !overlay) return;

  modal.style.display = 'flex';
  overlay.classList.add('active');
  document.documentElement.style.overflowY = 'hidden';

  if (!skipUrlSync && window.Router) window.Router.set({ modal: 'schedule' }, true);

  const todayIndex = new Date().getDay();
  renderScheduleTabs(todayIndex);
  loadJikanScheduleDay(DAYS_MAP[todayIndex]);
};

window.closeScheduleModal = function(skipUrlSync = false) {
  const modal = document.getElementById('scheduleModal');
  const overlay = document.getElementById('scheduleModalOverlay');
  if (modal && overlay && modal.style.display === 'flex') {
    modal.style.display = 'none';
    overlay.classList.remove('active');
    document.documentElement.style.overflowY = 'scroll';
    if (!skipUrlSync && window.Router) window.Router.set({ modal: null });
  }
};

function renderScheduleTabs(activeIdx) {
  const tabs = document.getElementById('scheduleDayTabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  dayNames.forEach((name, idx) => {
    const btn = document.createElement('button');
    btn.className = `modal-pill-btn ${idx === activeIdx ? 'next-ep-btn' : ''}`;
    btn.innerText = name + (idx === new Date().getDay() ? ' (Today)' : '');
    btn.onclick = () => {
      document.querySelectorAll('#scheduleDayTabs button').forEach(b => b.classList.remove('next-ep-btn'));
      btn.classList.add('next-ep-btn');
      loadJikanScheduleDay(DAYS_MAP[idx]);
    };
    tabs.appendChild(btn);
  });
}

async function loadJikanScheduleDay(dayName) {
  const container = document.getElementById('scheduleItemsContainer');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Fetching broadcast schedules...</div>';

  try {
    const data = await fetchWithRetry(`${window.CONFIG?.APIS?.JIKAN || 'https://api.jikan.moe/v4'}/schedules?filter=${dayName}&limit=20`);
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

      const row = document.createElement('div');
      row.className = 'search-item';
      row.style.borderRadius = '12px';
      row.onclick = () => {
        window.closeScheduleModal();
        searchAndOpenByTitle(title);
      };
      row.innerHTML = `
        <img src="${img}" alt="" onerror="this.src='${FALLBACK_POSTER}'" />
        <div class="search-info">
          <div class="search-title">${title}</div>
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
        <p>Jikan API Gateway is currently busy.</p>
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
    window.openModal(anime, 1, 1, false);
  } else {
    if (typeof window.showToast === 'function') {
      window.showToast(`Could not locate "${title}" in library.`);
    }
  }
}
window.searchAndOpenByTitle = searchAndOpenByTitle;

window.openTraceMoeModal = function(skipUrlSync = false) {
  const modal = document.getElementById('traceMoeModal');
  const overlay = document.getElementById('traceMoeOverlay');
  if (!modal || !overlay) return;

  modal.style.display = 'flex';
  overlay.classList.add('active');
  document.documentElement.style.overflowY = 'hidden';

  if (!skipUrlSync && window.Router) window.Router.set({ modal: 'tracemoe' }, true);

  window.addEventListener('paste', handleTraceClipboardPaste);
};

window.closeTraceMoeModal = function(skipUrlSync = false) {
  const modal = document.getElementById('traceMoeModal');
  const overlay = document.getElementById('traceMoeOverlay');
  if (modal && overlay && modal.style.display === 'flex') {
    modal.style.display = 'none';
    overlay.classList.remove('active');
    document.documentElement.style.overflowY = 'scroll';
    if (!skipUrlSync && window.Router) window.Router.set({ modal: null });
  }
  window.removeEventListener('paste', handleTraceClipboardPaste);
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

window.handleTraceFileUpload = function(event) {
  const file = event.target.files?.[0];
  if (file) executeTraceSearch(file);
};

async function executeTraceSearch(fileBlob) {
  const resultsArea = document.getElementById('traceResultsArea');
  if (!resultsArea) return;
  resultsArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--accent-cyan,#00d2ff);"><i class="fas fa-spinner fa-spin"></i> Analyzing visual frame...</div>';

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
          <span style="font-weight:800; color:#fff;">${title}</span>
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
    resultsArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--accent-red,#e50914);">Visual search failed.</div>';
  }
}

// ===============================================================
// 12. ANISKIP SKIP OFFSET TELEMETRY
// ===============================================================
async function resolveAndPollAniSkip(malId, episode) {
  clearTimeout(aniSkipPollTimer);
  const skipBtn = document.getElementById('aniSkipIntroBtn');
  if (skipBtn) skipBtn.style.display = 'none';
  aniSkipIntervals = [];

  if (!malId || window.STATE.isNetflixMode) return;

  try {
    const data = await fetchWithRetry(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&types[]=recap&episodeLength=1440`);
    if (data?.found && data?.results?.length) {
      aniSkipIntervals = data.results;
    }
  } catch (e) {}
}
window.resolveAndPollAniSkip = resolveAndPollAniSkip;

function handlePlayerTimeUpdate(currentTimeSeconds) {
  const skipBtn = document.getElementById('aniSkipIntroBtn');
  const label = document.getElementById('aniSkipLabel');
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

window.triggerAniSkipJump = function() {
  const skipBtn = document.getElementById('aniSkipIntroBtn');
  const targetTime = parseFloat(skipBtn?.dataset?.targetTime);
  if (!isNaN(targetTime)) {
    const video = document.getElementById('nativeStreamVideo');
    if (video) {
      video.currentTime = targetTime;
    } else {
      const iframe = document.getElementById('streamFrame');
      if (iframe) {
        iframe.contentWindow?.postMessage({ type: 'SEEK_TO', time: targetTime }, '*');
      }
    }

    skipBtn.style.display = 'none';
    if (typeof window.showToast === 'function') {
      window.showToast(`Skipped to ${Math.floor(targetTime)}s`);
    }

    if (window.p2pParty) {
      window.p2pParty.sendSeek(targetTime);
    }
  }
};

// ===============================================================
// 13. WEB AUDIO API SOUND GAIN BOOSTER
// ===============================================================
window.toggleAudioVolumeBooster = function() {
  const levels = [1.0, 1.5, 2.0, 2.5];
  const nextIdx = (levels.indexOf(currentAudioGainLevel) + 1) % levels.length;
  currentAudioGainLevel = levels[nextIdx];

  const label = document.getElementById('audioBoosterLabel');
  if (label) label.innerText = `${Math.round(currentAudioGainLevel * 100)}% Volume`;

  if (window.streamEngine && typeof window.streamEngine.setVolumeBoost === 'function') {
    window.streamEngine.setVolumeBoost(currentAudioGainLevel);
  } else {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      if (gainNode) {
        gainNode.gain.setValueAtTime(currentAudioGainLevel, audioCtx.currentTime);
      }
    } catch (e) {}
  }

  if (typeof window.showToast === 'function') {
    window.showToast(`Audio Boost: ${Math.round(currentAudioGainLevel * 100)}%`);
  }

  if (window.p2pParty && window.p2pParty.isHost) {
    window.p2pParty.broadcastAudioBoost(currentAudioGainLevel);
  }
};

// ===============================================================
// 14. URL SHARING & DEEP LINK CLONER
// ===============================================================
window.shareCurrentTitleLink = function() {
  if (window.Router && window.STATE.currentAnime) {
    window.Router.set({ watch: window.STATE.currentAnime.id, s: window.STATE.season, ep: window.STATE.episode }, false);
  }
  navigator.clipboard.writeText(window.location.href);
  if (typeof window.showToast === 'function') {
    window.showToast('Direct title link copied to clipboard!');
  }
};

window.shareDeepLinkEpisode = function() {
  if (window.Router && window.STATE.currentAnime) {
    window.Router.set({ watch: window.STATE.currentAnime.id, s: window.STATE.season, ep: window.STATE.episode }, false);
  }
  navigator.clipboard.writeText(window.location.href);
  if (typeof window.showToast === 'function') {
    window.showToast(`Episode ${window.STATE.episode} link copied to clipboard!`);
  }
};

window.addEventListener('message', ({ data }) => {
  if (data && data.type === 'PLAYER_EVENT') {
    const ev = data.data;
    if (ev && typeof ev.currentTime === 'number') {
      handlePlayerTimeUpdate(ev.currentTime);

      if (window.STATE.currentAnime && db) {
        db.watchHistory.put({
          id: `${window.STATE.currentAnime.id}_${window.STATE.season}_${window.STATE.episode}`,
          animeId: window.STATE.currentAnime.id,
          title: window.STATE.currentAnime.title?.english || window.STATE.currentAnime.title?.romaji,
          season: window.STATE.season,
          episode: window.STATE.episode,
          currentTime: ev.currentTime,
          duration: ev.duration || 0,
          lastUpdated: Date.now()
        }).catch(() => {});
      }

      if (window.p2pParty) {
        window.p2pParty.lastKnownTime = ev.currentTime;

        if (ev.state === 'playing') {
          window.p2pParty.notifyBufferStatus(false);
          window.p2pParty.sendPlay(ev.currentTime);
        } else if (ev.state === 'paused') {
          window.p2pParty.sendPause(ev.currentTime);
        } else if (ev.state === 'buffering') {
          window.p2pParty.notifyBufferStatus(true);
        }
      }
    }
  }
});
