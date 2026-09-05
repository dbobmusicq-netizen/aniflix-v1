/**
 * AnimeDrift - Precision Anti-DevTools Guard
 * File: secure.js
 * Version: 10.0.0 High-Precision Detection Engine
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
  // 1. HARDWARE KEYBOARD SHORTCUTS & INPUT GUARDS
  // ===============================================================
  window.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    },
    { capture: true }
  );

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
        triggerLockdown();
        return false;
      }
    },
    { capture: true }
  );

  // ===============================================================
  // 2. STABLE DOCKED DEVTOOLS DETECTION (WITH VIEWPORT SANITY CHECKS)
  // ===============================================================
  let dockViolations = 0;

  function checkDockedDevTools() {
    // Exclude mobile viewports and soft keyboard expansion
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) return;

    // Outer dimensions represent full OS window; inner represents client viewport
    const widthDiff = window.outerWidth - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;

    // Threshold high enough to ignore browser sidebars, scrollbars, and bookmarks bar
    const threshold = 180;
    const isDocked = widthDiff > threshold || heightDiff > threshold;

    if (isDocked) {
      dockViolations++;
      // Require 2 consecutive checks to prevent false triggers during window restore/resize
      if (dockViolations >= 2) {
        triggerLockdown();
      }
    } else {
      dockViolations = 0;
    }
  }

  setInterval(checkDockedDevTools, 1000);

  // ===============================================================
  // 3. TARGETED CONSOLE FORMATTER DETECTION (UNDOCKED / DETACHED)
  // ===============================================================
  // Chromium triggers the toString/getter property when an object is printed to an OPEN console
  let consoleViolations = 0;
  const detector = {
    isOpen: false
  };

  const devtoolsElement = new Image();
  Object.defineProperty(devtoolsElement, 'id', {
    get: function () {
      consoleViolations++;
      if (consoleViolations >= 2) {
        triggerLockdown();
      }
      return 'devtools-active';
    }
  });

  // Delay startup by 2.5s to let initial scripts, P2P, and stylesheets load smoothly
  setTimeout(() => {
    setInterval(() => {
      // Evaluate only when page has active user focus to avoid background tab throttling
      if (document.hasFocus()) {
        console.dir(devtoolsElement);
        if (typeof console.clear === 'function') {
          console.clear();
        }
      }
    }, 2000);
  }, 2500);

  // Prevent overriding the lockdown trigger
  try {
    Object.freeze(triggerLockdown);
  } catch (_) {}
})();
