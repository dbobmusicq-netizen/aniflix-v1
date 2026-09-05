/**
 * AnimeDrift - Enterprise Anti-Inspection & DevTools Guard
 * File: secure.js
 * Version: 9.0.0 Multi-Vector Defense
 * Host: https://animedrift.vercel.app
 */

(function () {
  'use strict';

  const TARGET_TG_URL = 'https://t.me/New_Hindi_Dub_Anime_Crunchyroll';
  let isRedirecting = false;

  function triggerLockdown() {
    if (isRedirecting) return;
    isRedirecting = true;

    try {
      window.stop();
      if (document.documentElement) {
        document.documentElement.innerHTML = '';
      }
    } catch (_) {}

    try {
      window.location.replace(TARGET_TG_URL);
    } catch (_) {
      window.location.href = TARGET_TG_URL;
    }
  }

  // ===============================================================
  // 1. HARDENED INPUT & SHORTCUT INTERCEPTOR
  // ===============================================================
  // Block Right-Click & Auxiliary Clicks
  ['contextmenu', 'auxclick'].forEach((evt) => {
    window.addEventListener(
      evt,
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return false;
      },
      { capture: true, passive: false }
    );
  });

  // Block Keyboard Combinations (Windows, Linux, macOS)
  window.addEventListener(
    'keydown',
    (e) => {
      const key = (e.key || '').toLowerCase();
      const code = e.keyCode || e.which;
      const ctrl = e.ctrlKey;
      const meta = e.metaKey; // Command on macOS
      const shift = e.shiftKey;
      const alt = e.altKey;

      const isF12 = code === 123 || key === 'f12';
      const isDevToolsCombo = (ctrl || meta) && shift && ['i', 'j', 'c'].includes(key);
      const isMacInspector = meta && alt && ['i', 'j', 'c', 'u'].includes(key);
      const isViewSource = (ctrl || meta) && key === 'u';
      const isSavePage = (ctrl || meta) && key === 's';

      if (isF12 || isDevToolsCombo || isMacInspector || isViewSource || isSavePage) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        triggerLockdown();
        return false;
      }
    },
    { capture: true, passive: false }
  );

  // ===============================================================
  // 2. CONSOLE FORMATTER & REGEX GETTER TRAPS
  // ===============================================================
  const regexTrap = /./;
  regexTrap.toString = function () {
    triggerLockdown();
    return '';
  };

  const objTrap = {};
  Object.defineProperty(objTrap, 'id', {
    get: function () {
      triggerLockdown();
      return 'trap';
    }
  });

  // Table formatter probe (Chromium triggers getters immediately when table view opens)
  const tableTrap = [{ a: 1 }];
  Object.defineProperty(tableTrap[0], 'a', {
    get: function () {
      triggerLockdown();
      return 1;
    }
  });

  function fireConsoleProbes() {
    if (!document.hasFocus()) return;
    console.log('%c', regexTrap);
    console.dir(objTrap);
    console.table(tableTrap);
    if (typeof console.clear === 'function') {
      console.clear();
    }
  }

  setInterval(fireConsoleProbes, 1500);

  // ===============================================================
  // 3. BACKGROUND WEB WORKER HEARTBEAT (STALL DETECTION)
  // ===============================================================
  // Spawns an isolated background worker thread to monitor main thread stalls caused by DevTools breakpoints
  try {
    const workerScript = `
      let lastPing = Date.now();
      self.onmessage = function(e) {
        if (e.data === 'pong') {
          lastPing = Date.now();
        }
      };
      setInterval(function() {
        self.postMessage('ping');
        if (Date.now() - lastPing > 3500) {
          self.postMessage('trigger_lockdown');
        }
      }, 1000);
    `;

    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    worker.onmessage = function (e) {
      if (e.data === 'ping') {
        worker.postMessage('pong');
      } else if (e.data === 'trigger_lockdown') {
        triggerLockdown();
      }
    };
  } catch (_) {}

  // ===============================================================
  // 4. DEVTOOLS WINDOW PROPORTION DETECTOR
  // ===============================================================
  function evaluateWindowDimensions() {
    const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isMobile) return;

    const threshold = 160;
    const widthDiff = window.outerWidth - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;

    // Checks for dock attachment (right, bottom, or left)
    if (widthDiff > threshold || heightDiff > threshold) {
      triggerLockdown();
    }
  }

  setInterval(evaluateWindowDimensions, 1000);

  // ===============================================================
  // 5. EXTENSION TAMPER DEFENSE
  // ===============================================================
  // Overrides oncontextmenu so external scripts cannot unset it without alerting the engine
  try {
    Object.defineProperty(document, 'oncontextmenu', {
      get: () => (e) => { e.preventDefault(); return false; },
      set: () => triggerLockdown(),
      configurable: false
    });

    Object.defineProperty(window, 'oncontextmenu', {
      get: () => (e) => { e.preventDefault(); return false; },
      set: () => triggerLockdown(),
      configurable: false
    });
  } catch (_) {}

  try {
    Object.freeze(triggerLockdown);
  } catch (_) {}
})();
