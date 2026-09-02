/**
 * File: api/extract.js
 * Advanced Serverless Stream Manifest Extractor & Deep-Deobfuscator Engine
 * Optimized for Vercel Serverless Functions + @sparticuz/chromium
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// In-memory cache for warm lambda executions (10-minute TTL)
const streamCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// High-impact ads, tracking, cryptominers, and pop-under networks to abort immediately
const AD_TRACKER_DOMAINS = [
  'google-analytics', 'doubleclick', 'popads', 'adcash', 'adsterra',
  'exoclick', 'propellerads', 'trafficjunky', 'juicyads', 'histats',
  'onclickprediction', 'coinhive', 'crypto-loot', 'monetag', 'yandex.ru',
  'bet365', '1xbet', 'onclick', 'tsyndicate', 'adxad', 'adnxs'
];

/**
 * P.A.C.K.E.R. script unpacker: Unpacks eval(function(p,a,c,k,e,d)...)
 */
function unpackDeanEdwards(packed) {
  try {
    const matcher = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)\s*\{[\s\S]*?\}\s*\(([\s\S]*?)\)\s*\)/i;
    const match = matcher.exec(packed);
    if (!match) return packed;

    const argsFn = new Function(`return [${match[1]}];`);
    const [p, a, c, k] = argsFn();

    let payload = p;
    let count = c;
    const dict = {};

    while (count--) {
      dict[count.toString(a)] = k[count] || count.toString(a);
    }

    return payload.replace(/\b(\w+)\b/g, (word) => dict[word] || word);
  } catch {
    return packed;
  }
}

/**
 * Cleans extracted URLs by removing JSON escapes, quotes, and invalid trailing symbols.
 */
function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let clean = rawUrl.replace(/\\/g, '').trim();
  clean = clean.replace(/^[('"`]+|[)'"`]+$/g, '');
  clean = clean.replace(/[;,]+$/, '');
  return clean.startsWith('http') ? clean : null;
}

/**
 * Recursive Scanner: Searches strings, URI-encoded segments, Base64 blobs,
 * JSON objects, and unpacked/deobfuscated scripts.
 */
function deepScanForManifests(text, results = new Set(), visited = new Set(), depth = 0) {
  if (!text || typeof text !== 'string' || depth > 5 || visited.has(text)) return results;
  visited.add(text);

  // 1. Regex to capture HLS (.m3u8), DASH (.mpd), and direct MP4 streams
  const manifestRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\]*)?)/gi;
  let match;
  while ((match = manifestRegex.exec(text)) !== null) {
    const clean = sanitizeUrl(match[1]);
    if (clean) results.add(clean);
  }

  // 2. Decode URL-encoded parameters (%2F, %3A%2F%2F)
  if (text.includes('%3A%2F%2F') || text.includes('%2F') || text.includes('%3a%2f%2f')) {
    try {
      const decodedUrl = decodeURIComponent(text);
      if (decodedUrl !== text) {
        deepScanForManifests(decodedUrl, results, visited, depth + 1);
      }
    } catch {}
  }

  // 3. Base64 payload detection (captures embedded player configuration and blobs)
  const b64Regex = /([A-Za-z0-9+/=]{24,})/g;
  let b64Match;
  while ((b64Match = b64Regex.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
      if (
        decoded.includes('.mpd') ||
        decoded.includes('.m3u8') ||
        decoded.includes('http') ||
        decoded.startsWith('{')
      ) {
        try {
          const parsedJSON = JSON.parse(decoded);
          deepScanForManifests(JSON.stringify(parsedJSON), results, visited, depth + 1);
        } catch {
          deepScanForManifests(decoded, results, visited, depth + 1);
        }
      }
    } catch {}
  }

  // 4. Dean Edwards Packer detection
  if (text.includes('function(p,a,c,k,e,d)')) {
    const unpacked = unpackDeanEdwards(text);
    if (unpacked !== text) {
      deepScanForManifests(unpacked, results, visited, depth + 1);
    }
  }

  return results;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Missing ?url= query parameter' });
  }

  // 1. Cache hit verification
  const cached = streamCache.get(targetUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ success: true, cached: true, ...cached.data });
  }

  let browser = null;
  const manifests = new Set();
  const requestHeadersMap = new Map();

  try {
    // 2. Chromium startup arguments optimized for Vercel Serverless Function lifecycle
    const chromiumArgs = [
      ...(chromium.args || []),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--mute-audio',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,720'
    ];

    const execPath = typeof chromium.executablePath === 'function'
      ? await chromium.executablePath()
      : await chromium.executablePath;

    browser = await puppeteer.launch({
      args: chromiumArgs,
      defaultViewport: { width: 1280, height: 720 },
      executablePath: execPath,
      headless: chromium.headless !== undefined ? chromium.headless : true,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();

    // Emulate realistic browser environment
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site'
    });

    // 3. Inject early anti-anti-debugging hooks & capture programmatic media sources
    await page.evaluateOnNewDocument(() => {
      // Patch navigator properties
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      window.__capturedManifests = [];

      // Hook window.open to suppress ad popups
      window.open = () => null;

      // Hook native HTMLMediaElement src descriptor
      const originalSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set(val) {
          if (val) window.__capturedManifests.push(val);
          if (originalSrcDesc && originalSrcDesc.set) {
            return originalSrcDesc.set.call(this, val);
          }
        },
        get() {
          if (originalSrcDesc && originalSrcDesc.get) {
            return originalSrcDesc.get.call(this);
          }
          return this.getAttribute('src');
        }
      });

      // Hook MediaSource.prototype.addSourceBuffer
      if (window.MediaSource) {
        const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mimeType) {
          window.__capturedManifests.push(mimeType);
          return origAddSourceBuffer.apply(this, arguments);
        };
      }

      // Hook fetch to trace runtime programmatic calls
      const originalFetch = window.fetch;
      window.fetch = async function (...args) {
        const resource = args[0];
        if (typeof resource === 'string') {
          window.__capturedManifests.push(resource);
        } else if (resource && resource.url) {
          window.__capturedManifests.push(resource.url);
        }
        return originalFetch.apply(this, args);
      };

      // Hook XMLHttpRequest.open
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (url) window.__capturedManifests.push(url);
        return originalOpen.apply(this, arguments);
      };
    });

    // 4. Request interception
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const reqUrl = request.url();
      const lowerUrl = reqUrl.toLowerCase();
      const resourceType = request.resourceType();

      // Drop advertising and tracking requests
      if (AD_TRACKER_DOMAINS.some((d) => lowerUrl.includes(d))) {
        return request.abort();
      }

      // Drop heavy assets to conserve bandwidth and execution time
      if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
        return request.abort();
      }

      // Identify direct stream signatures
      if (
        lowerUrl.includes('.m3u8') ||
        lowerUrl.includes('.mpd') ||
        lowerUrl.includes('/dash/') ||
        lowerUrl.includes('/hls/') ||
        lowerUrl.includes('manifest')
      ) {
        const clean = sanitizeUrl(reqUrl);
        if (clean) {
          manifests.add(clean);
          requestHeadersMap.set(clean, request.headers());
        }
      }

      deepScanForManifests(reqUrl, manifests);
      request.continue();
    });

    // 5. Response Sniffing (JSON APIs, XML MPD manifests, M3U8 playlists)
    page.on('response', async (response) => {
      try {
        const cType = (response.headers()['content-type'] || '').toLowerCase();
        if (
          cType.includes('json') ||
          cType.includes('dash+xml') ||
          cType.includes('mpegurl') ||
          cType.includes('javascript') ||
          cType.includes('text/plain')
        ) {
          const textBody = await response.text();
          deepScanForManifests(textBody, manifests);
        }
      } catch {}
    });

    // 6. Navigation
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 9000
    }).catch(() => {});

    // Inspect main document DOM & scripts
    const initialHtml = await page.content();
    deepScanForManifests(initialHtml, manifests);

    // 7. Recursive Frame Deep-Scraping (iframes often host the actual media player)
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const frameContent = await frame.content();
        deepScanForManifests(frameContent, manifests);
      } catch {}
    }

    // 8. If nothing captured yet, trigger user interactions & inspect player globals
    if (manifests.size === 0) {
      // Trigger common play and backdrop elements across all attached frames
      for (const frame of frames) {
        try {
          await frame.evaluate(() => {
            const triggers = document.querySelectorAll(
              'button, .play, .jw-display-icon-container, .vjs-big-play-button, #play, #player, [aria-label*="Play"], .plyr__control--overlaid, .art-video-player, video'
            );
            triggers.forEach((btn) => {
              try {
                btn.click();
              } catch {}
            });
          });
        } catch {}
      }

      // Small delay for dynamic AJAX requests to fire
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Query player state instances and hooked manifests across frames
      for (const frame of frames) {
        try {
          const framePlayerInfo = await frame.evaluate(() => {
            const found = [...(window.__capturedManifests || [])];

            // JWPlayer extraction
            try {
              if (window.jwplayer && typeof window.jwplayer === 'function') {
                const playlist = window.jwplayer().getPlaylist?.();
                if (playlist) found.push(JSON.stringify(playlist));
              }
            } catch {}

            // Video.js extraction
            try {
              if (window.videojs && typeof window.videojs.getAllPlayers === 'function') {
                const players = window.videojs.getAllPlayers();
                Object.values(players).forEach((p) => {
                  const src = p.currentSrc?.();
                  if (src) found.push(src);
                });
              }
            } catch {}

            // Generic window.player extraction
            try {
              if (window.player && typeof window.player.currentSrc === 'function') {
                found.push(window.player.currentSrc());
              }
            } catch {}

            // Scan DOM media elements
            document.querySelectorAll('video, source').forEach((el) => {
              if (el.src) found.push(el.src);
              if (el.getAttribute('data-src')) found.push(el.getAttribute('data-src'));
            });

            return found;
          });

          framePlayerInfo.forEach((item) => deepScanForManifests(item, manifests));
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[Extractor Trace]:', err.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  // 9. Format discovered manifests into response array
  const streamList = Array.from(manifests).map((streamUrl) => {
    const isMpd = streamUrl.toLowerCase().includes('.mpd') || streamUrl.includes('/dash/');
    const isMp4 = streamUrl.toLowerCase().includes('.mp4');
    return {
      url: streamUrl,
      type: isMpd ? 'DASH' : isMp4 ? 'MP4' : 'HLS',
      headers: requestHeadersMap.get(streamUrl) || {}
    };
  });

  if (streamList.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'No active stream manifests found.',
      targetUrl
    });
  }

  const payload = {
    embedUrl: targetUrl,
    count: streamList.length,
    streams: streamList
  };

  // Cache warm results
  streamCache.set(targetUrl, { timestamp: Date.now(), data: payload });

  return res.json({ success: true, ...payload });
};
