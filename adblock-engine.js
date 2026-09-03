/**
 * AniFlix Ultra - Smart Video Embed AdBlock & Sandbox Isolation Engine
 * File: adblock-engine.js
 * Version: 6.0.0 Hyper-Targeted Stream Isolation Kernel
 *
 * Core Objectives:
 * 1. Absolute Protection for First-Party & System APIs:
 *    - Explicitly whitelists AniList, Jikan, Kitsu, AniSkip, TMDB, PeerJS, Dexie,
 *      Shaka Player, FontAwesome, CDNs, and all internal origin requests.
 *    - ZERO interference with internal fetch(), XHR, WebSockets, or UI interactions.
 * 2. Deep Sandboxing for Third-Party Video Embeds:
 *    - Neutralizes popups, popunders, tab-hijacks, and redirects from iframe stream hosts.
 *    - Strips 'allow-top-navigation', 'allow-top-navigation-by-user-activation',
 *      and 'allow-popups-to-escape-sandbox' while preserving video, DRM, and audio playback.
 * 3. Invisible Overlay & Click-Jack Vaporizer:
 *    - Destroys deceptive transparent overlays placed above video player viewports.
 *    - Safely bypasses whitelisted player controls, custom overlays, and AniFlix UI.
 * 4. Fake Gesture & Synthetic Click Disarm:
 *    - Prevents embedded scripts from forging synthetic .click() dispatches to trigger ads.
 */

(function () {
  'use strict';

  if (window.__ANIFLIX_ADBLOCK_ENGINE_ACTIVE__) return;
  Object.defineProperty(window, '__ANIFLIX_ADBLOCK_ENGINE_ACTIVE__', {
    value: true,
    writable: false,
    configurable: false
  });

  // ===============================================================
  // 1. COMPREHENSIVE SYSTEM & CORE API WHITELIST
  // ===============================================================
  const SYSTEM_WHITELISTED_DOMAINS = [
    location.hostname,
    'graphql.anilist.co',
    'api.jikan.moe',
    'kitsu.io',
    'api.aniskip.com',
    'speedracelight.com',
    'db.speedracelight.com',
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
    'github.io'
  ];

  // ===============================================================
  // 2. EMBED AD NETWORK BLACKLIST & SIGNATURE PATTERNS
  // ===============================================================
  const EMBED_AD_DOMAINS = [
    'onclickprediction', 'doubleclick', 'popads', 'adcash', 'adsterra',
    'exoclick', 'propellerads', 'trafficjunky', 'syndication', 'juicyads',
    'yllix', 'histats', 'adf.ly', 'directrev', 'anonimox', 'eroadvertising',
    'adkernel', 'clickadu', 'adtago', 'inpagepush', 'traffichaus', 'monetag',
    'hilltopads', 'clickaine', 'richaudience', 'mgid', 'taboola', 'outbrain',
    'alwingulla', 'wigetmedia', 'coinhive', 'crypto-loot', 'jscache', 'adx',
    'adnxs', 'bidswitch', 'openx', 'pubmatic', 'rubiconproject', 'smartadserver',
    'gloaphoo', 'deloplen', 'bidgear', 'ad-maven', 'onclickperformance',
    'awecr', 'realsrv', 'clarium', 'mobicow', 'tsyndicate', 'vidoomy'
  ];

  const EMBED_AD_URL_FRAGMENTS = [
    '/popunder', '/pop.', '/ad.', '/ads.', '/banner', '/click.', '/pixel',
    '/redirect.php', '/openx', '/vast', '/vpaid', '/prebid', '/engine.js',
    '/direct-link', 'click.php', 'serving.php', 'ad_type='
  ];

  /**
   * Evaluates if a request is first-party or critical system infrastructure.
   * If true, it must NEVER be blocked or touched.
   */
  function isSystemInfrastructure(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr, window.location.href);
      const host = parsed.hostname.toLowerCase();

      // Always allow identical origins and relative local files
      if (parsed.origin === window.location.origin) return true;

      // Always allow whitelisted system APIs, CDNs, and media repositories
      return SYSTEM_WHITELISTED_DOMAINS.some(
        (domain) => host === domain || host.endsWith('.' + domain)
      );
    } catch {
      return false;
    }
  }

  /**
   * Evaluates if a URL targets known ad networks, trackers, or suspicious redirects.
   */
  function isMaliciousEmbedTarget(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;

    // Never classify system infrastructure as malicious
    if (isSystemInfrastructure(urlStr)) return false;

    try {
      const parsed = new URL(urlStr, window.location.href);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase() + parsed.search.toLowerCase();

      if (EMBED_AD_DOMAINS.some((d) => host.includes(d))) return true;
      if (EMBED_AD_URL_FRAGMENTS.some((p) => path.includes(p))) return true;
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') return true;
    } catch {
      const lower = urlStr.toLowerCase();
      return (
        EMBED_AD_DOMAINS.some((d) => lower.includes(d)) ||
        EMBED_AD_URL_FRAGMENTS.some((p) => lower.includes(p))
      );
    }
    return false;
  }

  // Safe Property Lock
  function sealProperty(target, prop, value) {
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
  // 3. INTENTIONAL GESTURE VERIFIER (ANTI-POPUP & REDIRECT SHIELD)
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

  function isGenuineUserGesture() {
    const timeSinceInput = performance.now() - lastTrustedUserInteraction;
    const isRecent = timeSinceInput < 450;
    const hasActiveState = navigator.userActivation ? navigator.userActivation.isActive : true;
    return isRecent && hasActiveState;
  }

  // ===============================================================
  // 4. WINDOW OPEN & TAB HIJACK TRAPS
  // ===============================================================
  const realWindowOpen = window.open;

  const proxyWindowOpen = function (url, target, features) {
    const targetUrl = typeof url === 'string' ? url : (url?.toString() || '');

    // Allow genuine empty calls if not triggered by an active iframe
    if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
      console.warn('[AdBlock Engine] Suppressed popup triggered by video iframe:', targetUrl);
      return null;
    }

    if (isMaliciousEmbedTarget(targetUrl)) {
      console.warn('[AdBlock Engine] Blocked window.open to ad destination:', targetUrl);
      return null;
    }

    if (!isGenuineUserGesture()) {
      console.warn('[AdBlock Engine] Suppressed automated/synthetic window.open attempt:', targetUrl);
      return null;
    }

    return realWindowOpen.apply(this, arguments);
  };

  sealProperty(window, 'open', proxyWindowOpen);

  // Prevent dialog loops used by video ad-scripts
  sealProperty(window, 'alert', () => undefined);
  sealProperty(window, 'confirm', () => true);
  sealProperty(window, 'prompt', () => null);

  // Global Capture for Popunder Links
  window.addEventListener(
    'click',
    (e) => {
      let node = e.target;
      while (node && node !== document.body) {
        if (node.tagName === 'A') {
          const href = node.getAttribute('href');

          // Never touch internal navigation or whitelisted URLs
          if (href && !isSystemInfrastructure(href)) {
            if (isMaliciousEmbedTarget(href)) {
              console.warn('[AdBlock Engine] Neutralized click to ad URL:', href);
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }

            if (node.target === '_blank' && !isGenuineUserGesture()) {
              console.warn('[AdBlock Engine] Disarmed unprompted synthetic link popup.');
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

  // ===============================================================
  // 5. TARGETED NETWORK SHIELD (ONLY INTERCEPTS UNTRUSTED AD CALLS)
  // ===============================================================
  const realFetch = window.fetch;
  const realXHROpen = window.XMLHttpRequest.prototype.open;
  const realXHRSend = window.XMLHttpRequest.prototype.send;
  const realSendBeacon = navigator.sendBeacon;
  const RealWebSocket = window.WebSocket;

  // 5A. Safe Fetch Interception
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;

    // Immediately pass through all system infrastructure without delay
    if (isSystemInfrastructure(url)) {
      return realFetch.apply(this, arguments);
    }

    // Only drop confirmed malicious embed targets
    if (isMaliciousEmbedTarget(url)) {
      console.warn(`[AdBlock Engine] Blocked third-party ad telemetry fetch: ${url}`);
      return new Response(JSON.stringify({ status: 'blocked', code: 200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return realFetch.apply(this, arguments);
  };

  // 5B. Safe XHR Interception
  window.XMLHttpRequest.prototype.open = function (method, url) {
    if (!isSystemInfrastructure(url) && isMaliciousEmbedTarget(url)) {
      this.__isEmbedAdBlocked = true;
    }
    return realXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    if (this.__isEmbedAdBlocked) {
      console.warn('[AdBlock Engine] Silenced ad XHR request.');
      Object.defineProperty(this, 'readyState', { value: 4, writable: false });
      Object.defineProperty(this, 'status', { value: 200, writable: false });
      Object.defineProperty(this, 'responseText', { value: '{}', writable: false });
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
      return;
    }
    return realXHRSend.apply(this, arguments);
  };

  // 5C. SendBeacon Interception
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      if (!isSystemInfrastructure(url) && isMaliciousEmbedTarget(url)) {
        return true;
      }
      return realSendBeacon.apply(this, arguments);
    };
  }

  // 5D. WebSocket Guard
  window.WebSocket = function (url, protocols) {
    if (!isSystemInfrastructure(url) && isMaliciousEmbedTarget(url)) {
      console.warn(`[AdBlock Engine] Terminated malicious ad WebSocket: ${url}`);
      return {
        send: () => {},
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      };
    }
    return new RealWebSocket(url, protocols);
  };

  // ===============================================================
  // 6. AD NETWORK HONEYPOTS (DEFUSES EMBED AD DETECTORS)
  // ===============================================================
  const honeypots = {
    canRunAds: true,
    isAdBlockActive: false,
    adBlockDetected: false,
    showAds: true,
    google_ad_status: 1,
    adsbygoogle: { push: () => {} },
    ga: () => {},
    gtag: () => {}
  };

  Object.entries(honeypots).forEach(([key, val]) => {
    try {
      if (!(key in window)) window[key] = val;
    } catch {}
  });

  // ===============================================================
  // 7. DEEP IFRAME EMBED SANDBOXING (PREVENTS REDIRECTS & POPUPS)
  // ===============================================================
  /**
   * Essential sandbox flags for video embeds:
   * - allow-scripts: Permits video player execution.
   * - allow-same-origin: Allows video buffer decoding and DRM.
   * - allow-forms: Allows stream resolution interactions.
   * - allow-presentation: Enables Cast / AirPlay.
   * OMITTED (RESTRICTED):
   * - allow-popups
   * - allow-popups-to-escape-sandbox
   * - allow-top-navigation
   * - allow-top-navigation-by-user-activation
   * This completely prevents the video embed from launching tabs or redirecting your site.
   */
  const HARDENED_SANDBOX_POLICY = 'allow-scripts allow-same-origin allow-forms allow-presentation';

  function hardenStreamIframe(iframe) {
    if (!iframe || iframe.dataset.adblockHardened === 'true') return;

    try {
      iframe.dataset.adblockHardened = 'true';

      iframe.setAttribute('sandbox', HARDENED_SANDBOX_POLICY);
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute(
        'allow',
        'autoplay; fullscreen; picture-in-picture; encrypted-media; display-capture'
      );

      // Lock setAttribute against dynamic sandbox modification by ad scripts
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

      // Sanitize accessible child frames on load
      iframe.addEventListener('load', () => {
        try {
          if (iframe.contentWindow) {
            iframe.contentWindow.open = proxyWindowOpen;
            iframe.contentWindow.alert = () => undefined;
            iframe.contentWindow.confirm = () => true;
            iframe.contentWindow.prompt = () => null;
          }
        } catch {
          // Cross-origin boundaries will cleanly reject child access
        }
      });
    } catch (err) {
      console.warn('[AdBlock Engine] Error applying stream sandbox:', err);
    }
  }

  // ===============================================================
  // 8. INVISIBLE OVERLAY & CLICK-JACK TRAP VAPORIZER
  // ===============================================================
  function vaporizeClickTraps() {
    const playerWrap = document.getElementById('modalPlayerWrap');
    if (!playerWrap) return;

    const wrapBounds = playerWrap.getBoundingClientRect();
    if (wrapBounds.width === 0 || wrapBounds.height === 0) return;

    // Scan for potential click-traps injected over the video viewport
    const candidates = playerWrap.querySelectorAll('div, a, span, object, embed, svg');

    candidates.forEach((el) => {
      // Whitelist all legitimate AniFlix controls & elements
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
        el.classList.contains('shaka-controls-container')
      ) {
        return;
      }

      const style = window.getComputedStyle(el);
      const isPositioned = style.position === 'absolute' || style.position === 'fixed';
      if (!isPositioned) return;

      const zIndex = parseInt(style.zIndex, 10) || 0;
      const bounds = el.getBoundingClientRect();

      // Check if candidate blankets more than 60% of the player view
      const coversPlayerArea =
        bounds.width >= wrapBounds.width * 0.6 &&
        bounds.height >= wrapBounds.height * 0.6;

      if (!coversPlayerArea) return;

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
        console.warn('[AdBlock Engine] Vaporized deceptive click-jacking overlay:', el);
        el.remove();
      }
    });
  }

  // ===============================================================
  // 9. REAL-TIME DOM SENTINEL (MUTATION OBSERVER)
  // ===============================================================
  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Automatically sandbox newly added video frames
        if (node.tagName === 'IFRAME') {
          hardenStreamIframe(node);
        } else if (node.firstElementChild) {
          node.querySelectorAll('iframe').forEach(hardenStreamIframe);
        }

        // Intercept inline/external third-party ad-script injections
        if (node.tagName === 'SCRIPT') {
          const src = node.src || '';
          const body = node.textContent || '';

          if (!isSystemInfrastructure(src) && (isMaliciousEmbedTarget(src) || isMaliciousEmbedTarget(body))) {
            console.warn('[AdBlock Engine] Blocked rogue ad script injection:', src || 'inline script');
            node.type = 'text/plain';
            node.remove();
            continue;
          }
        }
      }

      // Prevent iframe sandbox escape mutations
      if (mutation.type === 'attributes' && mutation.target.tagName === 'IFRAME') {
        if (mutation.attributeName === 'sandbox') {
          const frame = mutation.target;
          const currentVal = frame.getAttribute('sandbox') || '';
          if (
            currentVal.includes('allow-popups') ||
            currentVal.includes('allow-top-navigation')
          ) {
            console.warn('[AdBlock Engine] Restoring hardened sandbox isolation on modified iframe.');
            frame.setAttribute('sandbox', HARDENED_SANDBOX_POLICY);
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

    // High-frequency sweep during stream initialization
    const sweepInterval = setInterval(vaporizeClickTraps, 800);
    setTimeout(() => clearInterval(sweepInterval), 25000);

    console.log('[AniFlix AdBlock Engine v6.0] Stream Isolation Online.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEngine, { once: true });
  } else {
    initializeEngine();
  }

  // Public Interface for manual stream sanitation
  sealProperty(window, 'sanitizePlayerEmbed', function (iframeEl) {
    if (iframeEl) hardenStreamIframe(iframeEl);
  });
})();
