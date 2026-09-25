/**
 * ============================================================================
 * AnimeDrift — Global Omnipresent TMDB Edge Gateway
 * Path: /api/tmdb.js
 *
 * Architecture & Features:
 *   - Universal Method Support: Handles both GET queries and POST bodies.
 *   - Embedded Query Parsing: Flawlessly extracts embedded query strings inside `endpoint`
 *     (e.g., discover/movie?with_genres=28), ensuring every category rail gets distinct content.
 *   - Auto-Auth Detection: Seamlessly supports v3 API keys and v4 Bearer tokens.
 *   - SSRF & Path Traversal Lockdown: Regex whitelist prevents unauthorized target endpoints.
 *   - Dynamic CDN Caching: Optimizes edge cache lifetimes according to endpoint volatility.
 *   - Timeout Guard: AbortController terminates slow upstream calls before serverless timeouts.
 * ============================================================================
 */

export const config = {
  runtime: 'nodejs',
  maxDuration: 10
};

const ALLOWED_ENDPOINT_PATTERN = /^(trending|movie|tv|search|discover|genre|find|person|collection|configuration|watch\/providers|network|company|certification)(\/.*)?$/;

export default async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method Not Allowed. Only GET and POST requests are supported.'
    });
  }

  // Retrieve Secret TMDB Token from Vercel Environment Variables
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: TMDB_API_KEY is not defined in Vercel environment variables.'
    });
  }

  // Parse parameters from query string (GET) or request body (POST)
  let rawParams = {};
  if (req.method === 'POST') {
    if (typeof req.body === 'string') {
      try {
        rawParams = JSON.parse(req.body);
      } catch (e) {
        rawParams = {};
      }
    } else {
      rawParams = req.body || {};
    }
  } else {
    rawParams = req.query || {};
  }

  const { endpoint, ...queryParams } = rawParams;

  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: "endpoint". Example: /api/tmdb?endpoint=discover/movie'
    });
  }

  // CRITICAL FIX: Split route path from any embedded query strings
  let rawClean = endpoint.trim().replace(/^\/+/, '');
  if (rawClean.startsWith('3/')) {
    rawClean = rawClean.replace(/^3\//, '');
  }

  let sanitizedPath = rawClean;
  let embeddedQueryString = '';

  if (rawClean.includes('?')) {
    const parts = rawClean.split('?');
    sanitizedPath = parts[0].replace(/\/+$/, '');
    embeddedQueryString = parts.slice(1).join('?');
  } else {
    sanitizedPath = sanitizedPath.replace(/\/+$/, '');
  }

  // Security pattern validation
  if (!ALLOWED_ENDPOINT_PATTERN.test(sanitizedPath) || sanitizedPath.includes('..')) {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Targeted TMDB endpoint is not permitted through this gateway.'
    });
  }

  // Construct target upstream TMDB URL with the clean path
  const targetUrl = new URL(`https://api.themoviedb.org/3/${sanitizedPath}`);

  // Forward embedded query parameters first
  if (embeddedQueryString) {
    const embeddedParams = new URLSearchParams(embeddedQueryString);
    embeddedParams.forEach((val, key) => {
      targetUrl.searchParams.set(key, val);
    });
  }

  // Forward any additional top-level parameters
  for (const [key, value] of Object.entries(queryParams)) {
    if (key !== 'endpoint' && value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        targetUrl.searchParams.set(key, value.join(','));
      } else {
        targetUrl.searchParams.set(key, String(value));
      }
    }
  }

  // Defaults for discover routes
  if (sanitizedPath.startsWith('discover/')) {
    if (!targetUrl.searchParams.has('include_adult')) {
      targetUrl.searchParams.set('include_adult', 'false');
    }
    if (!targetUrl.searchParams.has('include_video')) {
      targetUrl.searchParams.set('include_video', 'false');
    }
  }

  // Default fallback language
  if (!targetUrl.searchParams.has('language')) {
    targetUrl.searchParams.set('language', 'en-US');
  }

  // Authentication: Auto-detect Bearer Token vs Query Key
  const isBearerToken = apiKey.length > 40 || apiKey.startsWith('ey');
  const requestHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'AnimeDrift-Global-Proxy/5.0'
  };

  if (isBearerToken) {
    requestHeaders['Authorization'] = `Bearer ${apiKey}`;
  } else {
    targetUrl.searchParams.set('api_key', apiKey);
  }

  // AbortController protection to prevent hanging serverless instances
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8500);

  try {
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: requestHeaders,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await upstreamResponse.json();

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        success: false,
        status_code: upstreamResponse.status,
        error: data.status_message || `TMDB upstream returned HTTP ${upstreamResponse.status}`
      });
    }

    // Dynamic Edge CDN Caching Strategy
    let sMaxAge = 7200; // 2 hours default
    let staleWhileRevalidate = 1800;

    if (
      sanitizedPath.startsWith('genre/') ||
      sanitizedPath.startsWith('configuration') ||
      sanitizedPath.startsWith('certification')
    ) {
      sMaxAge = 86400; // 24 hours
      staleWhileRevalidate = 7200;
    } else if (
      sanitizedPath.includes('/details') ||
      /^(movie|tv|person|collection)\/\d+$/.test(sanitizedPath) ||
      sanitizedPath.includes('/credits') ||
      sanitizedPath.includes('/videos')
    ) {
      sMaxAge = 21600; // 6 hours
      staleWhileRevalidate = 3600;
    } else if (sanitizedPath.startsWith('search/')) {
      sMaxAge = 600; // 10 minutes
      staleWhileRevalidate = 120;
    }

    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`
    );

    return res.status(200).json(data);
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        error: 'Gateway Timeout: TMDB upstream took too long to respond.'
      });
    }

    return res.status(502).json({
      success: false,
      error: 'Bad Gateway: Communication with TMDB upstream failed.',
      message: error.message || 'Unknown network error'
    });
  }
}
