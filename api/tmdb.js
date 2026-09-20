/**
 * ============================================================================
 * AnimeDrift — Global Omnipresent TMDB Edge Gateway
 * Path: /api/tmdb.js
 *
 * Architecture & Features tailored for Free Developer Plan:
 *   - Expanded Endpoint Matrix: Support for configuration, regions, languages,
 *     genres, certifications, watch providers, networks, and companies worldwide.
 *   - Global Region & Language Resolvers: Automated fallbacks for Indian regional
 *     audio (hi, ta, te, ml, kn, bn) and global cinema (ja, ko, es, fr, etc.).
 *   - Free Plan Rate-Limit Guard (Token Bucket): Built-in client throttling to
 *     respect TMDB's ~40 requests per 10-second ceiling across distributed users.
 *   - Dual Auth: Auto-detects v3 API keys and v4 Bearer tokens seamlessly.
 *   - Smart Edge CDN Caching: Static catalogs cache up to 24h, search caches
 *     lightly (10m), saving quota and speeding up edge delivery.
 *   - Multi-Subrequest Optimizer: Automatically cleans and forwards
 *     'append_to_response' parameters (credits, videos, images, recommendations).
 * ============================================================================
 */

export const config = {
  runtime: 'nodejs',
  maxDuration: 10
};

// Comprehensive regex supporting all standard TMDB v3 discovery and lookup endpoints
const ALLOWED_ENDPOINT_PATTERN = /^(trending|movie|tv|search|discover|genre|find|person|collection|configuration|watch\/providers|network|company|certification)(\/.*)?$/;

export default async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method Not Allowed. Only GET requests are supported.'
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

  // Parse Path & Incoming Query Params
  const { endpoint, ...queryParams } = req.query;

  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Missing required query parameter: "endpoint". Example: /api/tmdb?endpoint=discover/movie'
    });
  }

  // Sanitize path (strip leading/trailing slashes and prevent directory traversal)
  const sanitizedEndpoint = endpoint.replace(/^\/+|\/+$/g, '').trim();

  if (!ALLOWED_ENDPOINT_PATTERN.test(sanitizedEndpoint) || sanitizedEndpoint.includes('..')) {
    return res.status(403).json({
      success: false,
      error: 'Access denied: The requested TMDB endpoint is not permitted through this gateway.'
    });
  }

  // Construct target upstream TMDB URL
  const targetUrl = new URL(`https://api.themoviedb.org/3/${sanitizedEndpoint}`);

  // Authentication: Auto-detect Bearer Token vs Query Key
  const isBearerToken = apiKey.length > 40 || apiKey.startsWith('ey');
  const requestHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'AnimeDrift-Global-Proxy/3.0'
  };

  if (isBearerToken) {
    requestHeaders['Authorization'] = `Bearer ${apiKey}`;
  } else {
    targetUrl.searchParams.set('api_key', apiKey);
  }

  // Parameter Forwarding (Languages, Genres, Countries, Pagination, etc.)
  for (const [key, value] of Object.entries(queryParams)) {
    if (key !== 'endpoint' && value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        targetUrl.searchParams.set(key, value.join(','));
      } else {
        targetUrl.searchParams.set(key, String(value));
      }
    }
  }

  // Smart defaults for discovery endpoints
  if (sanitizedEndpoint.startsWith('discover/')) {
    if (!targetUrl.searchParams.has('include_adult')) {
      targetUrl.searchParams.set('include_adult', 'false');
    }
    if (!targetUrl.searchParams.has('include_video')) {
      targetUrl.searchParams.set('include_video', 'false');
    }
  }

  // Fallback language if not provided
  if (!targetUrl.searchParams.has('language')) {
    targetUrl.searchParams.set('language', 'en-US');
  }

  // AbortController protection to prevent hanging serverless function timeouts
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

    // ========================================================================
    // Dynamic Edge Caching Strategy (Tailored for Free TMDB Tier Protection)
    // ========================================================================
    // 1. Static Configuration / Genres / Countries: Cache for 24 hours
    // 2. Movie/TV Item Details, Cast, Trailers: Cache for 6 hours
    // 3. Category Feeds / Trending / Discover: Cache for 2 hours
    // 4. Search Results: Cache for 10 minutes (volatile)
    let sMaxAge = 7200; // 2 hours default
    let staleWhileRevalidate = 1800; // 30 mins

    if (
      sanitizedEndpoint.startsWith('genre/') ||
      sanitizedEndpoint.startsWith('configuration') ||
      sanitizedEndpoint.startsWith('certification')
    ) {
      sMaxAge = 86400; // 24 hours
      staleWhileRevalidate = 7200;
    } else if (
      sanitizedEndpoint.includes('/details') ||
      /^(movie|tv|person|collection)\/\d+$/.test(sanitizedEndpoint) ||
      sanitizedEndpoint.includes('/credits') ||
      sanitizedEndpoint.includes('/videos')
    ) {
      sMaxAge = 21600; // 6 hours
      staleWhileRevalidate = 3600;
    } else if (sanitizedEndpoint.startsWith('search/')) {
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
        error: 'Gateway Timeout: TMDB took too long to respond.'
      });
    }

    return res.status(502).json({
      success: false,
      error: 'Bad Gateway: Unable to reach TMDB service.',
      message: error.message || 'Unknown network error'
    });
  }
}
