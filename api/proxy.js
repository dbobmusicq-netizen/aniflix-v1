/**
 * File: api/proxy.js
 * High-Performance Serverless HLS & MPEG-DASH Stream Manifest Relay & Chunk Proxy
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');
const net = require('net');

// Persistent socket agents with keep-alive
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 150,
  maxFreeSockets: 50,
  timeout: 12000,
  freeSocketTimeout: 4000
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 150,
  maxFreeSockets: 50,
  timeout: 12000,
  freeSocketTimeout: 4000
});

const MAX_REDIRECT_DEPTH = 5;

/**
 * Validates URLs against internal networks and SSRF attacks
 */
function isSafeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const hostname = parsed.hostname.toLowerCase();

    // Prevent local loopback and cloud metadata access
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '169.254.169.254' ||
      hostname === 'metadata.google.internal'
    ) {
      return false;
    }

    // IP address checks for private subnets
    if (net.isIP(hostname)) {
      const parts = hostname.split('.').map(Number);
      if (parts[0] === 10) return false;
      if (parts[0] === 127) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Handles upstream fetching with automated decompressors and redirect recursion
 */
function fetchWithRedirects(targetUrl, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECT_DEPTH) {
      return reject(new Error('Exceeded maximum redirect hops. Potential loop.'));
    }

    if (!isSafeUrl(targetUrl)) {
      return reject(new Error('Forbidden target URL or IP range.'));
    }

    const parsedUrl = new URL(targetUrl);
    const isSecure = parsedUrl.protocol === 'https:';
    const client = isSecure ? https : http;
    const agent = isSecure ? httpsAgent : httpAgent;

    const reqHeaders = {
      ...options.headers,
      'Host': parsedUrl.host,
      'Accept-Encoding': 'gzip, deflate, br'
    };

    const req = client.request(targetUrl, {
      method: options.method || 'GET',
      agent,
      headers: reqHeaders,
      timeout: 12000
    }, (res) => {
      // Handle redirect status codes
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // Flush the stream buffer
        const nextUrl = new URL(res.headers.location, targetUrl).href;
        return resolve(fetchWithRedirects(nextUrl, options, redirectCount + 1));
      }

      resolve({ res, finalUrl: targetUrl });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Upstream socket connection timed out.'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Decompresses upstream stream buffers based on content-encoding
 */
function unpackStream(res) {
  const encoding = (res.headers['content-encoding'] || '').toLowerCase().trim();
  if (encoding === 'gzip') {
    return res.pipe(zlib.createGunzip());
  } else if (encoding === 'deflate') {
    return res.pipe(zlib.createInflate());
  } else if (encoding === 'br') {
    return res.pipe(zlib.createBrotliDecompress());
  }
  return res;
}

/**
 * Rewrites HLS Manifests (m3u8) accurately preserving media tags, keys, and relative chunks
 */
function rewriteHls(manifest, manifestUrl, proxyBaseUrl, referer) {
  const lines = manifest.split(/\r?\n/);
  const baseManifestUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);

  const formatProxiedUrl = (rawTarget) => {
    const absUrl = new URL(rawTarget, baseManifestUrl).href;
    return `${proxyBaseUrl}?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
  };

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Attribute URIs inside metadata tags
    if (trimmed.startsWith('#')) {
      return line.replace(/URI=(["'])(.*?)\1/g, (match, quote, uri) => {
        return `URI="${formatProxiedUrl(uri)}"`;
      });
    }

    // Media segment lines / sub-playlist index lines
    try {
      return formatProxiedUrl(trimmed);
    } catch {
      return line;
    }
  }).join('\n');
}

/**
 * Patches MPEG-DASH manifests (mpd) by resolving initialization/media attributes and BaseURL nodes
 */
function rewriteDash(manifest, manifestUrl, proxyBaseUrl, referer) {
  const baseManifestUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);

  const formatProxiedUrl = (rawTarget) => {
    const absUrl = new URL(rawTarget, baseManifestUrl).href;
    return `${proxyBaseUrl}?url=${encodeURIComponent(absUrl)}&ref=${encodeURIComponent(referer)}`;
  };

  let output = manifest;

  // 1. Rewrite existing BaseURL tags
  output = output.replace(/<BaseURL([^>]*)>([\s\S]*?)<\/BaseURL>/gi, (match, attrs, innerUrl) => {
    const trimmed = innerUrl.trim();
    return `<BaseURL${attrs}>${formatProxiedUrl(trimmed)}</BaseURL>`;
  });

  // 2. Rewrite explicit Initialization and media URLs if present
  output = output.replace(/(initialization|media)=["']([^"']+)["']/gi, (match, attr, target) => {
    // Avoid double prefixing DASH parameter dynamic placeholders ($Number$, $Time$)
    if (target.includes('$')) {
      return match;
    }
    return `${attr}="${formatProxiedUrl(target)}"`;
  });

  // 3. Inject root proxy BaseURL if no BaseURL tags were declared
  if (!/<BaseURL[\s>]/i.test(output)) {
    const proxiedBase = formatProxiedUrl('./');
    output = output.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  <BaseURL>${proxiedBase}</BaseURL>`);
  }

  return output;
}

module.exports = async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Origin, Referer, User-Agent, X-Requested-With');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { url: targetUrl, ref: customReferer } = req.query;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Valid query parameter ?url= is required.' });
  }

  if (!isSafeUrl(targetUrl)) {
    return res.status(403).json({ error: 'Access to the specified address is restricted.' });
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const refererHeader = customReferer || parsedTarget.origin;
    let originHeader = '';

    try {
      originHeader = new URL(refererHeader).origin;
    } catch {
      originHeader = parsedTarget.origin;
    }

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': refererHeader,
      'Origin': originHeader,
      'Accept': '*/*',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site'
    };

    // Forward byte-range requests for audio/video scrub seeking
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const { res: upstreamRes, finalUrl } = await fetchWithRedirects(targetUrl, {
      method: req.method,
      headers: upstreamHeaders
    });

    // Clean up connections if client disconnects early
    req.on('close', () => {
      if (!upstreamRes.destroyed) {
        upstreamRes.destroy();
      }
    });

    const contentType = (upstreamRes.headers['content-type'] || '').toLowerCase();
    const isHls = contentType.includes('mpegurl') || contentType.includes('application/x-mpegurl') || finalUrl.includes('.m3u8');
    const isDash = contentType.includes('dash+xml') || finalUrl.includes('.mpd');

    // Build dynamic base URL of the current proxy deployment
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proxyBaseUrl = `${protocol}://${host}/api/proxy`;

    // Forward caching and streaming headers
    const passthroughHeaders = [
      'content-type',
      'accept-ranges',
      'content-range',
      'last-modified',
      'etag'
    ];

    passthroughHeaders.forEach((name) => {
      if (upstreamRes.headers[name]) {
        res.setHeader(name, upstreamRes.headers[name]);
      }
    });

    // CASE 1: Manifests (HLS / DASH) -> Decompress, rewrite, send buffer
    if (isHls || isDash) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      const decompressedStream = unpackStream(upstreamRes);
      const chunks = [];

      decompressedStream.on('data', (chunk) => chunks.push(chunk));
      decompressedStream.on('error', (err) => {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Manifest decompression failure', details: err.message });
        }
      });

      decompressedStream.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        let processedBody = rawBody;

        try {
          if (isHls) {
            processedBody = rewriteHls(rawBody, finalUrl, proxyBaseUrl, refererHeader);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          } else if (isDash) {
            processedBody = rewriteDash(rawBody, finalUrl, proxyBaseUrl, refererHeader);
            res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
          }

          const responseBuffer = Buffer.from(processedBody, 'utf-8');
          res.setHeader('Content-Length', responseBuffer.length);
          res.status(upstreamRes.statusCode).end(responseBuffer);
        } catch (rewriteError) {
          // If parsing fails, fall back to the unparsed manifest
          const fallbackBuffer = Buffer.from(rawBody, 'utf-8');
          res.setHeader('Content-Length', fallbackBuffer.length);
          res.status(upstreamRes.statusCode).end(fallbackBuffer);
        }
      });

      return;
    }

    // CASE 2: Binary Video/Audio Chunks (TS, M4S, AAC, MP4) -> Direct Stream Pipe
    if (upstreamRes.headers['content-length']) {
      res.setHeader('Content-Length', upstreamRes.headers['content-length']);
    }

    if (upstreamRes.statusCode === 206) {
      res.setHeader('Cache-Control', 'private, no-cache, no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }

    res.status(upstreamRes.statusCode);
    upstreamRes.pipe(res);

  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to relay stream segment', details: err.message });
    }
  }
};
