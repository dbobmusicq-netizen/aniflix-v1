/**
 * File: api/stream-provider.js
 * Advanced Stream Provider & Manifest Resolver Engine
 * 
 * Core Capabilities:
 * 1. Multi-tier resolution: Direct API / JSON endpoint fast-path before Chromium delegation
 * 2. In-memory LRU TTL caching to prevent duplicate upstream calls and rate limits
 * 3. Server-side health verification & latency benchmarking for fallback nodes
 * 4. Automatic header spoofing (Referer/Origin) and parameter binding
 * 5. Downstream manifest normalization compatible with dash-player.js and api/proxy.js
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const NXSHA_BASE = process.env.STREAM_PROVIDER_BASE || 'https://nxsha.space';

// Keep-alive agent for low-latency upstream handshakes
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 8000 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 8000 });

// In-memory provider cache (15-minute TTL)
const providerCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

// Known valid streaming nodes prioritized by default stability
// Reduced to only the four supported nodes (NxSha, Filmu, VidCore, VidFast)
const SUPPORTED_SERVERS = [
  'MbPly-[Multi-Lang]', // NxSha subHost
  'Filmu',
  'VidCore',
  'VidFast'
];

/**
 * Universal HTTP client with automatic redirect resolution and JSON/Text parsing
 */
function fetchUpstream(targetUrl, headers = {}, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Exceeded maximum redirect hops.'));

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL format: ' + targetUrl));
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const requestOptions = {
      agent,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': `${parsed.origin}/`,
        'Origin': parsed.origin,
        'Accept': 'application/json, text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      },
      timeout: 8000
    };

    const req = client.request(targetUrl, requestOptions, (res) => {
      // Traverse redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, targetUrl).href;
        return resolve(fetchUpstream(nextUrl, headers, maxRedirects - 1));
      }

      let rawData = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        let parsedJson = null;
        try {
          parsedJson = JSON.parse(rawData);
        } catch {}

        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsedJson,
          raw: rawData,
          finalUrl: targetUrl
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upstream gateway request timed out.'));
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Fast-path heuristic scanner: checks if upstream response body already
 * contains manifests or Base64 ?q= payloads without triggering Chromium.
 */
function quickScanManifests(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return [];
  const found = new Set();

  // Match direct manifest extensions
  const manifestRegex = /(https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\]*)?)/gi;
  let match;
  while ((match = manifestRegex.exec(bodyText)) !== null) {
    found.add(match[1].replace(/\\/g, ''));
  }

  // Check for nested Base64 strings (e.g., MhPly sacdn parameter payloads)
  const b64Regex = /([A-Za-z0-9+/=]{28,})/g;
  let b64Match;
  while ((b64Match = b64Regex.exec(bodyText)) !== null) {
    try {
      const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
      if (decoded.includes('.mpd') || decoded.includes('.m3u8') || decoded.includes('http')) {
        while ((match = manifestRegex.exec(decoded)) !== null) {
          found.add(match[1].replace(/\\/g, ''));
        }
      }
    } catch {}
  }

  return Array.from(found);
}

module.exports = async function handler(req, res) {
  // Setup open CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    id = '550',                    // TMDB / IMDB ID
    type = 'movie',                // 'movie' or 'tv'
    season = '1',
    episode = '1',
    server = 'MbPly-[Multi-Lang]', // Target server node
    one_server = 'false',
    lang = 'hi',                   // Audio language ISO 639-1
    sub = 'en',                    // Subtitle track ISO 639-1
    color = 'netflix',
    mode = 'embed'                 // 'embed', 'download', or 'probe'
  } = req.query;

  // Build a unique cache key based on content and operational parameters
  const cacheKey = `${type}_${id}_${season}_${episode}_${server}_${lang}_${sub}_${mode}`;

  // 1. In-memory cache verification
  const cached = providerCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ success: true, cached: true, ...cached.payload });
  }

  try {
    // -------------------------------------------------------------
    // MODE 1: PROBE (Lightweight health check without scraping)
    // -------------------------------------------------------------
    if (mode === 'probe') {
      const startTime = Date.now();
      const probeTarget = `${NXSHA_BASE}/embed/${type === 'tv' ? `tv/${id}/${season}/${episode}` : `movie/${id}`}?server=${encodeURIComponent(server)}`;
      
      try {
        const pingResult = await fetchUpstream(probeTarget);
        const latencyMs = Date.now() - startTime;
        return res.json({
          success: true,
          mode: 'probe',
          server,
          online: pingResult.status >= 200 && pingResult.status < 400,
          status: pingResult.status,
          latencyMs
        });
      } catch (probeErr) {
        return res.json({
          success: false,
          mode: 'probe',
          server,
          online: false,
          error: probeErr.message
        });
      }
    }

    // -------------------------------------------------------------
    // MODE 2: DOWNLOAD (Direct CDN / File Extraction Path)
    // -------------------------------------------------------------
    if (mode === 'download') {
      const dlEndpoint = type === 'tv'
        ? `${NXSHA_BASE}/dl/tv/${id}/${season}/${episode}`
        : `${NXSHA_BASE}/dl/movie/${id}`;

      const dlResult = await fetchUpstream(dlEndpoint);
      const payload = {
        mode: 'download',
        endpoint: dlEndpoint,
        result: dlResult.data || dlResult.raw
      };

      providerCache.set(cacheKey, { timestamp: Date.now(), payload });
      return res.json({ success: true, ...payload });
    }

    // -------------------------------------------------------------
    // MODE 3: EMBED STREAM RESOLVER
    // -------------------------------------------------------------
    const basePath = type === 'tv'
      ? `${NXSHA_BASE}/embed/tv/${id}/${season}/${episode}`
      : `${NXSHA_BASE}/embed/movie/${id}`;

    const queryParams = new URLSearchParams({
      server,
      lang,
      sub,
      disable_dl_button: 'true',
      disable_app_ad: 'true',
      color
    });

    if (one_server === 'true') {
      queryParams.append('one_server', 'true');
    }

    const targetEndpoint = `${basePath}?${queryParams.toString()}`;

    // Step A: Fast-path attempt (Fetch raw HTML/JSON directly)
    const directFetch = await fetchUpstream(targetEndpoint);
    let extractedUrls = [];

    if (directFetch.data && (directFetch.data.sources || directFetch.data.url || directFetch.data.stream)) {
      if (Array.isArray(directFetch.data.sources)) {
        extractedUrls = directFetch.data.sources.map(s => s.file || s.url).filter(Boolean);
      } else if (directFetch.data.url) {
        extractedUrls = [directFetch.data.url];
      }
    } else if (directFetch.raw) {
      extractedUrls = quickScanManifests(directFetch.raw);
    }

    // Step B: Fast-path success -> format and return immediately
    if (extractedUrls.length > 0) {
      const formattedStreams = extractedUrls.map(url => ({
        url,
        type: url.toLowerCase().includes('.mpd') ? 'DASH' : 'HLS',
        headers: { 'Referer': NXSHA_BASE }
      }));

      const payload = {
        provider: 'nxsha',
        method: 'direct_fastpath',
        targetEndpoint,
        count: formattedStreams.length,
        streams: formattedStreams
      };

      providerCache.set(cacheKey, { timestamp: Date.now(), payload });
      return res.json({ success: true, ...payload });
    }

    // Step C: Fallback to Headless Browser Extractor (/api/extract)
    const currentHost = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const extractorUrl = `${protocol}://${currentHost}/api/extract?url=${encodeURIComponent(targetEndpoint)}`;

    const extractionResponse = await fetchUpstream(extractorUrl);

    if (extractionResponse.data && extractionResponse.data.success) {
      const payload = {
        provider: 'nxsha',
        method: 'headless_extraction',
        targetEndpoint,
        count: extractionResponse.data.count || extractionResponse.data.streams?.length || 0,
        streams: extractionResponse.data.streams || []
      };

      providerCache.set(cacheKey, { timestamp: Date.now(), payload });
      return res.json({ success: true, ...payload });
    }

    // Return partial failure if extraction failed
    return res.status(404).json({
      success: false,
      message: 'Failed to extract active media streams from upstream node.',
      targetEndpoint,
      availableServers: SUPPORTED_SERVERS
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal Provider Failure'
    });
  }
};
