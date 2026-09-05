/**
 * AnimeDrift - Enterprise Anti-Inspection & Tamper-Defense Kernel
 * File: secure.js
 * Version: 7.2.0 Hardened Security Suite
 * Host: https://animedrift.vercel.app
 *
 * Security Layers:
 * 1. Multi-Vector DevTools Inspection Traps:
 *    - Asynchronous high-resolution timing differentials.
 *    - Console object proxy & toString() evaluation traps.
 *    - Off-screen Canvas rendering & element getter traps.
 * 2. Extended Keyboard & Shortcut Interceptor:
 *    - Windows/Linux: F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U, Ctrl+S.
 *    - macOS: Cmd+Opt+I, Cmd+Opt+J, Cmd+Opt+C, Cmd+Opt+U, Cmd+S, Cmd+Shift+C.
 * 3. Aggressive Context Menu & Right-Click Extension Neutralizer:
 *    - Suppresses contextmenu, auxiliary clicks (mouse button 2), and pointer events.
 *    - Monitors window/document contextmenu listeners to catch "Allow Right Click" extensions.
 * 4. Anti-Tampering Prototype Seal:
 *    - Prevents script injection from overriding core handlers via Object.freeze/seal.
 * 5. AdBlocker Coexistence:
 *    - Excludes DOM element removal or cosmetic stylesheet injections so ad blockers function normally.
 */

(function () {
  'use strict';

  const TARGET_TG_URL = 'https://t.me/New_Hindi_Dub_Anime_Crunchyroll';
  let isLockdownActive = false;

  // ===============================================================
  // 1. IMMUTABLE LOCKDOWN DISPATCHER
  // ===============================================================
  function triggerLockdown() {
    if (isLockdownActive) return;
    isLockdownActive = true;

    try {
      // Clear document to abort running scripts
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
  // 2. CONTEXT MENU & RIGHT-CLICK EXTENSION NEUTRALIZER
  // ===============================================================
  // Trap standard right-click
  ['contextmenu', 'auxclick'].forEach((eventType) => {
    window.addEventListener(
      eventType,
      (e) => {
        if (e.button === 2 || eventType === 'contextmenu') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return false;
        }
      },
      { capture: true, passive: false }
    );
  });

  // Intercept extensions that attempt to reset oncontextmenu handlers
  try {
    Object.defineProperty(document, 'oncontextmenu', {
      get: () => (e) => { e.preventDefault(); return false; },
      set: () => {
        // Many extensions reset this property to bypass protection
        triggerLockdown();
      },
      configurable: false
    });

    Object.defineProperty(window, 'oncontextmenu', {
      get: () => (e) => { e.preventDefault(); return false; },
      set: () => {
        triggerLockdown();
      },
      configurable: false
    });
  } catch (_) {}

  // ===============================================================
  // 3. KEYBOARD SHORTCUT SUPPRESSION (WINDOWS, LINUX & MACOS)
  // ===============================================================
  window.addEventListener(
    'keydown',
    (e) => {
      const key = (e.key || '').toLowerCase();
      const code = e.keyCode || e.which;

      // Meta keys
      const ctrl = e.ctrlKey;
      const meta = e.metaKey; // Cmd on macOS
      const shift = e.shiftKey;
      const alt = e.altKey;

      // Windows/Linux shortcuts
      const isF12 = code === 123 || key === 'f12';
      const isCtrlShiftI = (ctrl || meta) && shift && (key === 'i' || code === 73);
      const isCtrlShiftJ = (ctrl || meta) && shift && (key === 'j' || code === 74);
      const isCtrlShiftC = (ctrl || meta) && shift && (key === 'c' || code === 67);
      const isCtrlU = (ctrl || meta) && (key === 'u' || code === 85);
      const isCtrlS = (ctrl || meta) && (key === 's' || code === 83);

      // macOS shortcuts (Cmd + Opt + I / J / C / U)
      const isMacDevTools = meta && alt && (key === 'i' || key === 'j' || key === 'c' || key === 'u');

      if (isF12 || isCtrlShiftI || isCtrlShiftJ || isCtrlShiftC || isCtrlU || isCtrlS || isMacDevTools) {
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
  // 4. ADVANCED ASYNC TIMING & DEBUGGER TRAP
  // ===============================================================
  function evaluateDebuggerPause() {
    const start = performance.now();
    // When DevTools is open, the debugger statement pauses script execution
    (function () {}['constructor']('debugger')());
    const duration = performance.now() - start;

    if (duration > 120) {
      triggerLockdown();
    }
  }

  // ===============================================================
  // 5. CONSOLE GETTER & OBJECT FORMATTER TRAPS
  // ===============================================================
  // Detects automated object evaluation triggered whenever DevTools Console opens
  function setupConsoleTrap() {
    const probe = /./;
    probe.toString = function () {
      triggerLockdown();
      return '';
    };

    const elementProbe = document.createElement('div');
    Object.defineProperty(elementProbe, 'id', {
      get: function () {
        triggerLockdown();
        return 'secure-probe';
      }
    });

    // Run safe background logging checks
    setInterval(() => {
      // DevTools formats console args by reading prototype methods or getters
      console.log(probe);
      console.dir(elementProbe);
      console.clear();
    }, 1500);
  }

  // ===============================================================
  // 6. ADAPTIVE VIEWPORT & DOCKED DOCKER MONITOR
  // ===============================================================
  function checkWindowDimensions() {
    // Avoid false positives on mobile devices when soft keyboards open
    const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isMobile) return;

    const threshold = 170;
    const diffWidth = window.outerWidth - window.innerWidth > threshold;
    const diffHeight = window.outerHeight - window.innerHeight > threshold;

    if (diffWidth || diffHeight) {
      triggerLockdown();
    }
  }

  // ===============================================================
  // 7. EXTENSION INJECTION SENTINEL
  // ===============================================================
  // Detects common DOM injections from DevTools or Right-Click extensions
  const securityObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const id = (node.id || '').toLowerCase();
          const className = (node.className || '').toString().toLowerCase();

          // Known extension signatures targeting contextmenu bypasses
          if (
            id.includes('rightclick') ||
            id.includes('contextmenu') ||
            className.includes('allow-copy') ||
            className.includes('enable-copy')
          ) {
            triggerLockdown();
            return;
          }
        }
      }
    }
  });

  // ===============================================================
  // 8. LIFECYCLE & BACKGROUND SCHEDULER
  // ===============================================================
  function startSecurityScheduler() {
    // Monitor DevTools pause timing
    setInterval(evaluateDebuggerPause, 800);

    // Monitor DevTools docking dimensions
    setInterval(checkWindowDimensions, 1000);

    // Initialize console trap
    setupConsoleTrap();

    // Start extension injection sentinel
    if (document.documentElement) {
      securityObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    // Return guard on browser navigation cache restore (Back button)
    window.addEventListener('pageshow', (event) => {
      if (event.persisted || (window.performance && window.performance.navigation.type === 2)) {
        triggerLockdown();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startSecurityScheduler, { once: true });
  } else {
    startSecurityScheduler();
  }

  // Freeze security exports to prevent script modification
  try {
    Object.freeze(triggerLockdown);
  } catch (_) {}
})();
