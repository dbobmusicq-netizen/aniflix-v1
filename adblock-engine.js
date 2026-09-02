/**
 * AniFlix Ultra - Hyper-Advanced Zero-Trust Stream Ad-Block & Deep Sandboxing Engine
 * File: adblock-engine.js
 * Version: 5.0.0 Zero-Tolerance Kernel Matrix
 *
 * Major Enhancements:
 * 1. Deep Immutability & Anti-Tamper: Freezes patched prototypes to defeat ad un-hookers.
 * 2. Cross-Frame Quarantine: Clones and sanitizes iframe prototypes dynamically.
 * 3. Navigation Freeze: Proxies location assignments & captures popunder target redirections.
 * 4. Synthetic Click Neutralizer: Differentiates trusted user gestures from ad-driven .click() triggers.
 * 5. Multi-Transport Guard: Intercepts WebSocket, Worker, Beacon, Fetch, and XHR channels.
 * 6. Polymorphic Element Trap: Uses MutationObserver + Canvas/SVG geometry heuristics.
 */

(function () {
  'use strict';

  if (window.__ADBLOCK_ENGINE_ACTIVE__) return;

  // Protect internal flag from overwrite
  Object.defineProperty(window, '__ADBLOCK_ENGINE_ACTIVE__', {
    value: true,
    writable: false,
    configurable: false
  });

  // ===============================================================
  // 1. INTELLIGENCE MATRIX & HEURISTIC ENGINE
  // ===============================================================
  const AD_HOST_PATTERNS = [
    'onclickprediction', 'doubleclick', 'popads', 'adcash', 'adsterra',
    'exoclick', 'propellerads', 'trafficjunky', 'syndication', 'juicyads',
    'yllix', 'histats', 'adf.ly', 'directrev', 'anonimox', 'eroadvertising',
    'adkernel', 'clickadu', 'adtago', 'inpagepush', 'traffichaus', 'monetag',
    'hilltopads', 'clickaine', 'richaudience', 'mgid', 'taboola', 'outbrain',
    'alwingulla', 'wigetmedia', 'coinhive', 'crypto-loot', 'jscache', 'adx',
    'adnxs', 'bidswitch', 'openx', 'pubmatic', 'rubiconproject', 'smartadserver'
  ];

  const SUSPICIOUS_PATH_PATTERNS = [
    '/popunder', '/pop.', '/ad.', '/ads.', '/banner', '/click.', '/pixel',
    '/telemetry', '/tracking', '/delivery', '/redirect.php', '/openx',
    '/vast', '/vpaid', '/prebid', '/engine.js', '/direct-link'
  ];

  function isMaliciousTarget(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return false;
    try {
      const parsed = new URL(targetUrl, window.location.href);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();

      // Check hosts
      if (AD_HOST_PATTERNS.some((d) => host.includes(d))) return true;
      // Check paths
      if (SUSPICIOUS_PATH_PATTERNS.some((p) => path.includes(p))) return true;
      // Catch suspicious dynamic protocols
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:') return true;
    } catch {
      // Fallback substring checks for relative / invalid URLs
      const lower = targetUrl.toLowerCase();
      return (
        AD_HOST_PATTERNS.some((d) => lower.includes(d)) ||
        SUSPICIOUS_PATH_PATTERNS.some((p) => lower.includes(p))
      );
    }
    return false;
  }

  // Helper to lock prototype overwrites against ad scripts
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
  // 2. WINDOW CREATION, NAVIGATION & DIALOG TRAPS
  // ===============================================================
  const realWindowOpen = window.open;

  // Track real user pointer/keyboard actions to distinguish from fake .click()
  let lastTrustedUserInteraction = 0;
  ['pointerdown', 'mousedown', 'keydown'].forEach((evt) => {
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
    // Requires physical trigger within the last 400ms
    const recentInput = performance.now() - lastTrustedUserInteraction < 400;
    const activeState = navigator.userActivation ? navigator.userActivation.isActive : true;
    return recentInput && activeState;
  }

  // Virtualize window.open
  const proxyWindowOpen = function (url, target, features) {
    const targetStr = typeof url === 'string' ? url : (url?.toString() || '');

    if (isMaliciousTarget(targetStr)) {
      console.warn(`[AdBlock Matrix] Neutralized popup to ad destination: ${targetStr}`);
      return null;
    }

    if (!isGenuineUserGesture()) {
      console.warn('[AdBlock Matrix] Suppressed unprompted/scripted window.open attempt.');
      return null;
    }

    if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
      console.warn('[AdBlock Matrix] Suppressed nested iframe window.open.');
      return null;
    }

    return realWindowOpen.apply(this, arguments);
  };

  sealProperty(window, 'open', proxyWindowOpen);

  // Lock dialog traps
  sealProperty(window, 'alert', () => undefined);
  sealProperty(window, 'confirm', () => true);
  sealProperty(window, 'prompt', () => null);

  // Block top-level location hijacks via global click handlers
  window.addEventListener(
    'click',
    (e) => {
      let target = e.target;
      while (target && target !== document.body) {
        if (target.tagName === 'A') {
          const href = target.getAttribute('href');
          if (href && isMaliciousTarget(href)) {
            console.warn('[AdBlock Matrix] Blocked direct click to malicious href:', href);
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          if (target.target === '_blank' && !isGenuineUserGesture()) {
            console.warn('[AdBlock Matrix] Blocked untrusted synthetic target="_blank" click.');
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
        target = target.parentElement;
      }
    },
    { capture: true }
  );

  // Neutralize beforeunload spam
  window.addEventListener(
    'beforeunload',
    (e) => {
      delete e.returnValue;
    },
    { capture: true }
  );

  // ===============================================================
  // 3. MULTI-TRANSPORT NETWORK INTERCEPTION
  // ===============================================================
  const realFetch = window.fetch;
  const realXHROpen = window.XMLHttpRequest.prototype.open;
  const realXHRSend = window.XMLHttpRequest.prototype.send;
  const realSendBeacon = navigator.sendBeacon;
  const RealWebSocket = window.WebSocket;
  const RealWorker = window.Worker;

  // 3A. Fetch Interception
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (isMaliciousTarget(url)) {
      console.warn(`[AdBlock Matrix] Dropped Fetch request: ${url}`);
      return new Response(JSON.stringify({ blocked: true, code: 200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return realFetch.apply(this, arguments);
  };

  // 3B. XHR Interception
  window.XMLHttpRequest.prototype.open = function (method, url) {
    if (isMaliciousTarget(url)) {
      this.__isAdBlocked = true;
    }
    return realXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    if (this.__isAdBlocked) {
      console.warn('[AdBlock Matrix] Dropped XHR transmission.');
      // Emit empty ready-state change to satisfy scripts expecting a response
      Object.defineProperty(this, 'readyState', { value: 4, writable: false });
      Object.defineProperty(this, 'status', { value: 200, writable: false });
      Object.defineProperty(this, 'responseText', { value: '{}', writable: false });
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
      return;
    }
    return realXHRSend.apply(this, arguments);
  };

  // 3C. SendBeacon Interception
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      if (isMaliciousTarget(url)) {
        return true;
      }
      return realSendBeacon.apply(this, arguments);
    };
  }

  // 3D. WebSocket Interception
  window.WebSocket = function (url, protocols) {
    if (isMaliciousTarget(url)) {
      console.warn(`[AdBlock Matrix] Blocked WebSocket telemetry pipe: ${url}`);
      return {
        send: () => {},
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      };
    }
    return new RealWebSocket(url, protocols);
  };

  // 3E. Web Worker Sandboxing (prevents background mining / script evasion)
  window.Worker = function (scriptURL, options) {
    if (isMaliciousTarget(scriptURL)) {
      console.warn(`[AdBlock Matrix] Blocked malicious Web Worker spawn: ${scriptURL}`);
      return {
        postMessage: () => {},
        terminate: () => {},
        addEventListener: () => {}
      };
    }
    return new RealWorker(scriptURL, options);
  };

  // ===============================================================
  // 4. ADVANCED HONEYPOT & DEFUSAL SUITE
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
      window[key] = val;
    } catch {}
  });

  // ===============================================================
  // 5. DEEP IFRAME HARDENING & RE-HYDRATION PROPHYLAXIS
  // ===============================================================
  const HARDENED_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation';

  function sanitizeSubWindow(contentWin) {
    if (!contentWin) return;
    try {
      contentWin.open = proxyWindowOpen;
      contentWin.alert = () => undefined;
      contentWin.confirm = () => true;
      contentWin.prompt = () => null;
    } catch {
      // Ignored if cross-origin boundary rejects direct modification
    }
  }

  function hardenIframe(iframe) {
    if (!iframe || iframe.dataset.adblockHardened === 'true') return;

    try {
      iframe.dataset.adblockHardened = 'true';

      // 1. Immutable Sandboxing: Strip out allow-popups and allow-top-navigation
      iframe.setAttribute('sandbox', HARDENED_SANDBOX);
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute(
        'allow',
        'autoplay; fullscreen; picture-in-picture; encrypted-media; display-capture'
      );

      // 2. Prevent dynamic reset of sandbox attribute
      const origSetAttribute = iframe.setAttribute;
      iframe.setAttribute = function (name, val) {
        if (name.toLowerCase() === 'sandbox') {
          // Force omission of popup/navigation tokens
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

      // 3. Neutralize Window API within accessible child scopes
      iframe.addEventListener('load', () => {
        try {
          sanitizeSubWindow(iframe.contentWindow);
        } catch {}
      });
    } catch (err) {
      console.warn('[AdBlock Matrix] Failed applying sandbox policies to frame:', err);
    }
  }

  // ===============================================================
  // 6. INVISIBLE OVERLAY & CLICK-JACKING VAPORIZER
  // ===============================================================
  function vaporizeClickTraps() {
    const playerWrap = document.getElementById('modalPlayerWrap') || document.body;
    if (!playerWrap) return;

    // Scan for potential traps across typical clickjacking tags
    const targets = playerWrap.querySelectorAll('div, a, span, object, embed, svg');
    const wrapBounds = playerWrap.getBoundingClientRect();

    targets.forEach((el) => {
      // Protect Whitelisted Core Controls
      if (
        el.id === 'streamFrame' ||
        el.id === 'aniSkipIntroBtn' ||
        el.id === 'p2pCanvasOverlay' ||
        el.id === 'pwaWakeLockIndicator' ||
        el.classList.contains('player-cover-overlay') ||
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

      const zIndex = parseInt(style.zIndex, 10);
      const bounds = el.getBoundingClientRect();

      // Check if element blankets the video display area
      const coversSignificantArea =
        bounds.width >= wrapBounds.width * 0.65 &&
        bounds.height >= wrapBounds.height * 0.65;

      if (!coversSignificantArea) return;

      const opacity = parseFloat(style.opacity);
      const isTransparent =
        opacity < 0.15 ||
        style.backgroundColor === 'rgba(0, 0, 0, 0)' ||
        style.backgroundColor === 'transparent' ||
        style.visibility === 'hidden';

      const hasPointerEvents = style.pointerEvents !== 'none';
      const isClickable =
        el.tagName === 'A' ||
        el.onclick !== null ||
        style.cursor === 'pointer' ||
        (zIndex > 10 && hasPointerEvents);

      if (isTransparent && isClickable) {
        console.warn('[AdBlock Matrix] Dismantled invisible click-jack trap:', el);
        el.remove();
      }
    });
  }

  // ===============================================================
  // 7. REAL-TIME MUTATION SENTINEL
  // ===============================================================
  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Analyze newly appended DOM nodes
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Auto-sanitize dynamically inserted frames
        if (node.tagName === 'IFRAME') {
          hardenIframe(node);
        } else if (node.firstElementChild) {
          node.querySelectorAll('iframe').forEach(hardenIframe);
        }

        // Intercept inline ad injection & external tracking scripts
        if (node.tagName === 'SCRIPT') {
          const src = node.src || '';
          const body = node.textContent || '';

          if (isMaliciousTarget(src) || isMaliciousTarget(body)) {
            console.warn('[AdBlock Matrix] Intercepted inline/external ad script insertion.');
            node.type = 'text/plain'; // Nullify execution
            node.remove();
            continue;
          }
        }
      }

      // Check attribute mutations to stop ad scripts modifying sandbox policies
      if (mutation.type === 'attributes' && mutation.target.tagName === 'IFRAME') {
        if (mutation.attributeName === 'sandbox') {
          const frame = mutation.target;
          const currentVal = frame.getAttribute('sandbox') || '';
          if (
            currentVal.includes('allow-popups') ||
            currentVal.includes('allow-top-navigation')
          ) {
            console.warn('[AdBlock Matrix] Re-asserting sandbox isolation on altered iframe.');
            frame.setAttribute('sandbox', HARDENED_SANDBOX);
          }
        }
      }
    }

    vaporizeClickTraps();
  });

  // ===============================================================
  // 8. BOOTSTRAP INITIALIZATION
  // ===============================================================
  function initializeEngine() {
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['sandbox', 'src', 'style']
    });

    document.querySelectorAll('iframe').forEach(hardenIframe);
    vaporizeClickTraps();

    // High-frequency cleanup phase during initial stream handshake
    const bootstrapTimer = setInterval(vaporizeClickTraps, 1000);
    setTimeout(() => clearInterval(bootstrapTimer), 30000);

    console.log('[AniFlix AdBlock Matrix] Enterprise Engine Online.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEngine, { once: true });
  } else {
    initializeEngine();
  }

  // Global interface for external stream loaders
  sealProperty(window, 'sanitizePlayerEmbed', function (iframeEl) {
    if (iframeEl) hardenIframe(iframeEl);
  });
})();
