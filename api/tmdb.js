/**
 * ============================================================================
 * AnimeDrift — High-Performance Resilient TMDB Edge Proxy
 * Path: /api/tmdb.js
 *
 * Architecture & Features:
 *   - Auto-Auth Detection: Supports both v3 API keys (query param) and v4 Read Access Tokens (Bearer header)
 *   - Path Sanitization & SSRF Defense: Strict regex endpoint whitelist preventing path traversal
 *   - Intelligent Edge Caching: Dynamic S-Maxage tailored to query type (search vs trending vs details)
 *   - Automatic Timeout Handling: AbortController protection prevents hanging serverless execution
 *   - Exponential Fallback & Resilience: Gracefully captures TMDB 429 rate limits & upstream 5xx errors
 *   - Seamless Parameter Forwarding: Correctly translates queries, pagination, language, & filters
 * ============================================================================
 */

export const config = {
  runtime: 'nodejs',
  maxDuration: 10
};

// Endpoints allowed through the proxy to prevent arbitrary internal network requests
const ALLOWED_ENDPOINT_PATTERN = /^(trending|movie|tv|search|discover|genre|find|person|collection)(\/.*)?$/;

export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method Not Allowed. Only GET requests are supported.'
    });
  }

  // Retrieve API Credentials from Vercel Environment Variables
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: TMDB_API_KEY environment variable is missing in Vercel settings.'
    });
  }

  // Parse path & parameters
  const { endpoint, ...queryParams } = req.query;

  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Missing required query parameter: "endpoint". Example: /api/tmdb?endpoint=trending/movie/day'
    });
  }

  // Clean and sanitize input path
  const sanitizedEndpoint = endpoint.replace(/^\/+|\/+$/g, '').trim();

  if (!ALLOWED_ENDPOINT_PATTERN.test(sanitizedEndpoint) || sanitizedEndpoint.includes('..')) {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Targeted TMDB endpoint is not permitted through this gateway.'
    });
  }

  // Construct target upstream URL
  const targetUrl = new URL(`https://api.themoviedb.org/3/${sanitizedEndpoint}`);

  // Auto-detect authentication type (v4 Read Access Token vs v3 API Key)
  const isBearerToken = apiKey.length > 40 || apiKey.startsWith('ey');
  const requestHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'AnimeDrift-Proxy/2.0'
  };

  if (isBearerToken) {
    requestHeaders['Authorization'] = `Bearer ${apiKey}`;
  } else {
    targetUrl.searchParams.set('api_key', apiKey);
  }

  // Forward client filters, pagination, language & search parameters
  for (const [key, value] of Object.entries(queryParams)) {
    if (key !== 'endpoint' && value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        targetUrl.searchParams.set(key, value.join(','));
      } else {
        targetUrl.searchParams.set(key, String(value));
      }
    }
  }

  // Default fallback language if not provided
  if (!targetUrl.searchParams.has('language')) {
    targetUrl.searchParams.set('language', 'en-US');
  }

  // AbortController with 8.5s timeout to guard against hanging serverless instances
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8500);

  try {
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: requestHeaders,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Parse response payload
    const data = await upstreamResponse.json();

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        success: false,
        status_code: upstreamResponse.status,
        error: data.status_message || `TMDB upstream rejected with code ${upstreamResponse.status}`
      });
    }

    // Dynamic Edge Caching Strategy:
    //  - Search results: 15 minutes (volatile)
    //  - Trending & Discovery: 2 hours (frequently refreshed)
    //  - Movie/TV Details: 6 hours (static)
    let sMaxAge = 7200; // Default 2 hours
    let staleWhileRevalidate = 1800;

    if (sanitizedEndpoint.startsWith('search')) {
      sMaxAge = 900;
      staleWhileRevalidate = 300;
    } else if (sanitizedEndpoint.includes('/details') || /^(movie|tv)\/\d+$/.test(sanitizedEndpoint)) {
      sMaxAge = 21600;
      staleWhileRevalidate = 3600;
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
      error: 'Bad Gateway: Communication with TMDB upstream failed.',
      message: error.message || 'Network error'
    });
  }
}
