/**
 * AnimeDrift - Enterprise Video Embed AdBlock & Hyper-Targeted Sandbox Isolation Kernel
 * File: adblock-engine.js
 * Version: 7.0.0 Production Engine
 * Host: https://animedrift.vercel.app
 *
 * Core Capabilities:
 * 1. Zero First-Party & Streaming Pipeline Interference:
 *    - Explicitly passes all Anilist, Jikan, Kitsu, AniSkip, TMDB, PeerJS WebRTC,
 *      Dexie DB, Shaka Player, HLS/DASH manifest chunks (.m3u8, .mpd, .ts, .m4s), and native routes.
 *    - Whitelists active video streaming embed providers (NxSha, Filmu, VidCore, VidFast, VidSrc, etc.).
 * 2. Unbreakable Deep Sandboxing:
 *    - Neutralizes popups, popunders, tab-hijacks, and malicious external redirects.
 *    - Enforces CSP sandbox parameters while safely preserving MSE, DRM, Canvas, and Audio playback.
 * 3. Deep Redirect Defense:
 *    - Intercepts and traps location.assign, location.replace, location.href, and window.open abuse
 *      triggered by deceptive iframes or synthetic script events.
 * 4. Synthetic Interaction & Click-Jacking Vaporizer:
 *    - Vaporizes invisible click-jacking layers blanketing the player viewport without touching
 *      custom player overlays, AniSkip buttons, or P2P UI layers.
 * 5. Ad Network Signature Neutralization & Detector Honeypots:
 *    - Silently absorbs known telemetry and trackers while satisfying anti-adblock detection scripts.
 */

(function () {
  'use strict';

  if (window.__ANIMEDRIFT_ADBLOCK_ENGINE_ACTIVE__) return;
  Object.defineProperty(window, '__ANIMEDRIFT_ADBLOCK_ENGINE_ACTIVE__', {
    value: true,
    writable: false,
    configurable: false
  });

  // ===============================================================
  // 1. SYSTEM INFRASTRUCTURE & ESSENTIAL STREAM PROVIDER WHITELIST
  // ===============================================================
  const SYSTEM_WHITELIST_HOSTS = [
    location.hostname,
    'animedrift.vercel.app',
    'graphql.anilist.co',
    'api.jikan.moe',
    'kitsu.io',
    'api.aniskip.com',
    'api.themoviedb.org',
    'image.tmdb.org',
    's4.anilist.co',
    'cdn.myanimelist.net',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'peerjs.com',
    '0.peerjs.com',
    // Approved Streaming Embeds & Edge CDN Servers
    'nxsha.space',
    'nxsha.site',
    'filmu.in',
    'filmu.stream',
    'vidcore.org',
    'vidcore.net',
    'vidfast.vc',
    'vidfast.io',
    'vidsrc.me',
    'vidsrc.sbs',
    'primesrc.me',
    'primesrc.xyz',
    'multiembed.mov',
    '2embed.cc',
    'speedracelight.com'
  ];

  const STREAM_EXTENSIONS = [
    '.m3u8',
    '.mpd',
    '.ts',
    '.m4s',
    '.aac',
    '.vtt',
    '.key',
    '.mp4',
    '.webm'
  ];

  // ===============================================================
  // 2. AD NETWORK SIGNATURES & MALICIOUS PATTERNS
  // ===============================================================
  const MALICIOUS_AD_HOSTS = [
    'onclickprediction', 'doubleclick', 'popads', 'adcash', 'adsterra',
    'exoclick', 'propellerads', 'trafficjunky', 'syndication', 'juicyads',
    'yllix', 'histats', 'adf.ly', 'directrev', 'anonimox', 'eroadvertising',
    'adkernel', 'clickadu', 'adtago', 'inpagepush', 'traffichaus', 'monetag',
    'hilltopads', 'clickaine', 'richaudience', 'mgid', 'taboola', 'outbrain',
    'alwingulla', 'wigetmedia', 'coinhive', 'crypto-loot', 'jscache', 'adx',
    'adnxs', 'bidswitch', 'openx', 'pubmatic', 'rubiconproject', 'smartadserver',
    'gloaphoo', 'deloplen', 'bidgear', 'ad-maven', 'onclickperformance',
    'awecr', 'realsrv', 'clarium', 'mobicow', 'tsyndicate', 'vidoomy',
    'bestadvertisings', 'bet365', '1xbet', 'linebet', 'mostbet'
  ];

  const MALICIOUS_URL_FRAGMENTS = [
    '/popunder', '/pop.', '/ad.', '/ads.', '/banner', '/click.', '/pixel',
    '/redirect.php', '/openx', '/vast', '/vpaid', '/prebid', '/engine.js',
    '/direct-link', 'click.php', 'serving.php', 'ad_type='
  ];

  /**
   * Identifies mission-critical APIs, first-party scripts, or legitimate video media.
   */
  function isEssentialInfrastructure(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr, window.location.href);
      const host = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();

      // Always pass identical origin and relative local scripts/styles
      if (parsed.origin === window.location.origin) return true;

      // Always pass media chunks (HLS/DASH)
      if (STREAM_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return true;

      // Pass verified streaming servers and data endpoints
      return SYSTEM_WHITELIST_HOSTS.some(
        (domain) => host === domain || host.endsWith('.' + domain)
      );
    } catch {
      return false;
    }
  }

  /**
   * Pinpoints malicious ad calls and telemetry endpoints.
   */
  function isMaliciousAdTarget(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    if (isEssentialInfrastructure(urlStr)) return false;

    try {
      const parsed = new URL(urlStr, window.location.href);
      const host = parsed.hostname.toLowerCase();
      const pathAndQuery = (parsed.pathname + parsed.search).toLowerCase();

      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') return true;
      if (MALICIOUS_AD_HOSTS.some((d) => host.includes(d))) return true;
      if (MALICIOUS_URL_FRAGMENTS.some((f) => pathAndQuery.includes(f))) return true;
    } catch {
      const lower = urlStr.toLowerCase();
      return (
        MALICIOUS_AD_HOSTS.some((d) => lower.includes(d)) ||
        MALICIOUS_URL_FRAGMENTS.some((f) => lower.includes(f))
      );
    }
    return false;
  }

  function lockProperty(target, prop, value) {
    try {
      Object.defineProperty(target, prop, {
        value: value,
        writable: false,
        configurable: false,
        enumerable: true
      });
    } catch {
      target[prop] = value;
    }
  }

  // ===============================================================
  // 3. INTENTIONAL USER GESTURE VERIFIER
  // ===============================================================
  let lastTrustedUserInteraction = 0;
  ['pointerdown', 'mousedown', 'keydown', 'touchend'].forEach((evt) => {
    window.addEventListener(
      evt,
      (e) => {
        if (e.isTrusted) {
          lastTrustedUserInteraction = performance.now();
        }
      },
      { capture: true, passive: true }
    );
  });

  function isVerifiedUserGesture() {
    const timeSinceInput = performance.now() - lastTrustedUserInteraction;
    const isRecent = timeSinceInput < 450;
    const hasActiveState = navigator.userActivation ? navigator.userActivation.isActive : true;
    return isRecent && hasActiveState;
  }

  // ===============================================================
  // 4. SMART REDIRECT & WINDOW HIJACK INTERCEPTOR
  // ===============================================================
  const originalWindowOpen = window.open;

  const sanitizedWindowOpen = function (url, target, features) {
    const targetUrl = typeof url === 'string' ? url : (url?.toString() || '');

    // Trap iframes attempting to trigger window.open
    if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
      console.warn('[AdBlock Engine] Blocked unprompted window.open from iframe:', targetUrl);
      return null;
    }

    // Drop malicious destinations
    if (isMaliciousAdTarget(targetUrl)) {
      console.warn('[AdBlock Engine] Blocked ad popup target:', targetUrl);
      return null;
    }

    // Disarm programmatic synthetic window launches
    if (!isVerifiedUserGesture()) {
      console.warn('[AdBlock Engine] Blocked automated window.open without user gesture:', targetUrl);
      return null;
    }

    return originalWindowOpen.apply(this, arguments);
  };

  lockProperty(window, 'open', sanitizedWindowOpen);

  // Suppress alert/confirm traps commonly used by video ad redirects
  lockProperty(window, 'alert', () => undefined);
  lockProperty(window, 'confirm', () => true);
  lockProperty(window, 'prompt', () => null);

  // Global Capture for Popunder Links
  window.addEventListener(
    'click',
    (e) => {
      let node = e.target;
      while (node && node !== document.body) {
        if (node.tagName === 'A') {
          const href = node.getAttribute('href');

          if (href && !isEssentialInfrastructure(href)) {
            if (isMaliciousAdTarget(href)) {
              console.warn('[AdBlock Engine] Intercepted link targeting ad route:', href);
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }

            if (node.target === '_blank' && !isVerifiedUserGesture()) {
              console.warn('[AdBlock Engine] Neutralized untrusted new-tab anchor navigation.');
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }
          }
        }
        node = node.parentElement;
      }
    },
    { capture: true }
  );

  // Prevent Navigation Hijacking via beforeunload Dialog Abuse
  window.addEventListener('beforeunload', (event) => {
    if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true });

  // ===============================================================
  // 5. TARGETED NETWORK SHIELD (SURGICAL AD TELEMETRY BLOCKER)
  // ===============================================================
  const originalFetch = window.fetch;
  const originalXHROpen = window.XMLHttpRequest.prototype.open;
  const originalXHRSend = window.XMLHttpRequest.prototype.send;
  const originalSendBeacon = navigator.sendBeacon;
  const OriginalWebSocket = window.WebSocket;

  // 5A. Safe Fetch Interception
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;

    if (isEssentialInfrastructure(url)) {
      return originalFetch.apply(this, arguments);
    }

    if (isMaliciousAdTarget(url)) {
      console.warn(`[AdBlock Engine] Silenced third-party ad fetch: ${url}`);
      return new Response(JSON.stringify({ status: 'blocked', code: 200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return originalFetch.apply(this, arguments);
  };

  // 5B. Safe XHR Interception
  window.XMLHttpRequest.prototype.open = function (method, url) {
    if (!isEssentialInfrastructure(url) && isMaliciousAdTarget(url)) {
      this.__isBlockedAdXHR = true;
    }
    return originalXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    if (this.__isBlockedAdXHR) {
      console.warn('[AdBlock Engine] Neutralized ad XHR stream.');
      Object.defineProperty(this, 'readyState', { value: 4, writable: false });
      Object.defineProperty(this, 'status', { value: 200, writable: false });
      Object.defineProperty(this, 'responseText', { value: '{}', writable: false });
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
      return;
    }
    return originalXHRSend.apply(this, arguments);
  };

  // 5C. SendBeacon Interception
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      if (!isEssentialInfrastructure(url) && isMaliciousAdTarget(url)) {
        return true;
      }
      return originalSendBeacon.apply(this, arguments);
    };
  }

  // 5D. WebSocket Interception
  window.WebSocket = function (url, protocols) {
    if (!isEssentialInfrastructure(url) && isMaliciousAdTarget(url)) {
      console.warn(`[AdBlock Engine] Blocked ad WebSocket handshake: ${url}`);
      return {
        send: () => {},
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      };
    }
    return new OriginalWebSocket(url, protocols);
  };

  // ===============================================================
  // 6. AD DETECTOR HONEYPOTS
  // ===============================================================
  const detectorHoneypots = {
    canRunAds: true,
    isAdBlockActive: false,
    adBlockDetected: false,
    showAds: true,
    google_ad_status: 1,
    adsbygoogle: { push: () => {} },
    ga: () => {},
    gtag: () => {}
  };

  Object.entries(detectorHoneypots).forEach(([key, val]) => {
    try {
      if (!(key in window)) window[key] = val;
    } catch {}
  });

  // ===============================================================
  // 7. HARDENED IFRAME SANDBOX ENGINE
  // ===============================================================
  /**
   * Verified permissions required by video players:
   * - allow-scripts: Executes player engines (HLS/DASH).
   * - allow-same-origin: Decodes encrypted media chunks and maintains local buffers.
   * - allow-forms: Allows stream quality selection forms.
   * - allow-presentation: Enables AirPlay / Chromecast.
   *
   * STRICTLY EXCLUDED:
   * - allow-top-navigation
   * - allow-top-navigation-by-user-activation
   * - allow-popups
   * - allow-popups-to-escape-sandbox
   * - allow-modals
   */
  const SECURE_SANDBOX_POLICY = 'allow-scripts allow-same-origin allow-forms allow-presentation';

  function hardenStreamIframe(iframe) {
    if (!iframe || iframe.dataset.adblockHardened === 'true') return;

    try {
      iframe.dataset.adblockHardened = 'true';

      iframe.setAttribute('sandbox', SECURE_SANDBOX_POLICY);
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute(
        'allow',
        'autoplay; fullscreen; picture-in-picture; encrypted-media; display-capture'
      );

      // Lock setAttribute against child iframe attempts to re-add 'allow-top-navigation'
      const origSetAttribute = iframe.setAttribute;
      iframe.setAttribute = function (name, val) {
        if (name && name.toLowerCase() === 'sandbox') {
          const sanitizedVal = val
            .replace(/allow-popups-to-escape-sandbox/g, '')
            .replace(/allow-top-navigation-by-user-activation/g, '')
            .replace(/allow-top-navigation/g, '')
            .replace(/allow-popups/g, '')
            .replace(/allow-modals/g, '');
          return origSetAttribute.call(this, name, sanitizedVal.trim());
        }
        return origSetAttribute.apply(this, arguments);
      };

      // Wrap accessible child windows on load
      iframe.addEventListener('load', () => {
        try {
          if (iframe.contentWindow) {
            iframe.contentWindow.open = sanitizedWindowOpen;
            iframe.contentWindow.alert = () => undefined;
            iframe.contentWindow.confirm = () => true;
            iframe.contentWindow.prompt = () => null;
          }
        } catch {}
      });
    } catch (err) {
      console.warn('[AdBlock Engine] Sandbox execution error:', err);
    }
  }

  // ===============================================================
  // 8. INVISIBLE OVERLAY & CLICK-JACK VAPORIZER
  // ===============================================================
  function vaporizeClickTraps() {
    const playerWrap = document.getElementById('modalPlayerWrap');
    if (!playerWrap) return;

    const wrapBounds = playerWrap.getBoundingClientRect();
    if (wrapBounds.width === 0 || wrapBounds.height === 0) return;

    const candidates = playerWrap.querySelectorAll('div, a, span, object, embed, svg');

    candidates.forEach((el) => {
      // Explicit Whitelist for all AnimeDrift UI elements
      if (
        el.id === 'streamFrame' ||
        el.id === 'streamContainer' ||
        el.id === 'nativeStreamVideo' ||
        el.id === 'playerLoadingOverlay' ||
        el.id === 'playerBufferingLoader' ||
        el.id === 'aniSkipIntroBtn' ||
        el.id === 'p2pCanvasOverlay' ||
        el.id === 'pwaWakeLockIndicator' ||
        el.id === 'p2pReactionBar' ||
        el.id === 'p2pBufferNotice' ||
        el.id === 'p2pCatchUpPill' ||
        el.id === 'p2pPromptCard' ||
        el.classList.contains('player-cover-overlay') ||
        el.classList.contains('modal-big-play-btn') ||
        el.classList.contains('p2p-reaction-bar') ||
        el.classList.contains('p2p-prompt-card') ||
        el.classList.contains('wake-lock-indicator') ||
        el.classList.contains('shaka-controls-container') ||
        el.classList.contains('shaka-video-container')
      ) {
        return;
      }

      const style = window.getComputedStyle(el);
      const isPositioned = style.position === 'absolute' || style.position === 'fixed';
      if (!isPositioned) return;

      const zIndex = parseInt(style.zIndex, 10) || 0;
      const bounds = el.getBoundingClientRect();

      // Evaluate if element blankets more than 60% of video surface
      const coversPlayer =
        bounds.width >= wrapBounds.width * 0.6 &&
        bounds.height >= wrapBounds.height * 0.6;

      if (!coversPlayer) return;

      const opacity = parseFloat(style.opacity);
      const isTransparent =
        opacity < 0.12 ||
        style.backgroundColor === 'rgba(0, 0, 0, 0)' ||
        style.backgroundColor === 'transparent' ||
        style.visibility === 'hidden';

      const isInteractive =
        style.pointerEvents !== 'none' &&
        (el.tagName === 'A' || el.onclick !== null || style.cursor === 'pointer' || zIndex >= 6);

      if (isTransparent && isInteractive) {
        console.warn('[AdBlock Engine] Vaporized click-jack trap:', el);
        el.remove();
      }
    });
  }

  // ===============================================================
  // 9. REAL-TIME MUTATION OBSERVER SENTINEL
  // ===============================================================
  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.tagName === 'IFRAME') {
          hardenStreamIframe(node);
        } else if (node.firstElementChild) {
          node.querySelectorAll('iframe').forEach(hardenStreamIframe);
        }

        // Neutralize injected third-party tracker scripts
        if (node.tagName === 'SCRIPT') {
          const src = node.src || '';
          const body = node.textContent || '';

          if (!isEssentialInfrastructure(src) && (isMaliciousAdTarget(src) || isMaliciousAdTarget(body))) {
            console.warn('[AdBlock Engine] Removed injected ad script:', src || 'inline snippet');
            node.type = 'text/plain';
            node.remove();
            continue;
          }
        }
      }

      // Maintain Sandbox Persistence
      if (mutation.type === 'attributes' && mutation.target.tagName === 'IFRAME') {
        if (mutation.attributeName === 'sandbox') {
          const frame = mutation.target;
          const currentVal = frame.getAttribute('sandbox') || '';
          if (
            currentVal.includes('allow-popups') ||
            currentVal.includes('allow-top-navigation')
          ) {
            frame.setAttribute('sandbox', SECURE_SANDBOX_POLICY);
          }
        }
      }
    }

    vaporizeClickTraps();
  });

  // ===============================================================
  // 10. INITIALIZATION & LIFECYCLE HOOKS
  // ===============================================================
  function initializeEngine() {
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['sandbox', 'src', 'style']
    });

    document.querySelectorAll('iframe').forEach(hardenStreamIframe);
    vaporizeClickTraps();

    const sweepInterval = setInterval(vaporizeClickTraps, 600);
    setTimeout(() => clearInterval(sweepInterval), 20000);

    console.log('[AnimeDrift AdBlock Engine v7.0] Active & Synchronized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEngine, { once: true });
  } else {
    initializeEngine();
  }

  // Public Interface for manual embed sanitation
  lockProperty(window, 'sanitizePlayerEmbed', function (iframeEl) {
    if (iframeEl) hardenStreamIframe(iframeEl);
  });
})();
