/**
 * AnimeDrift - Enterprise Anti-Inspection & Tamper-Defense Kernel
 * File: secure.js
 * Version: 8.5.0 Hardened Security Suite
 * Host: https://animedrift.vercel.app
 *
 * Capabilities:
 * - Zero False Positives: Completely removes CPU timing/debugger pauses and viewport dimension
 *   traps that cause false redirects on page refresh, mode changes (Netflix mode), or DOM re-renders.
 * - Hardware Shortcut Neutralizer: Traps Windows/Linux (F12, Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+S)
 *   and macOS (Cmd+Opt+I/J/C/U, Cmd+S, Cmd+Shift+C).
 * - Context Menu & Auxiliary Click Traps: Blocks right-clicks and auxiliary mouse triggers without
 *   interfering with normal touch gestures or taps.
 * - Extension-Resistant oncontextmenu Protection: Detects extensions attempting to overwrite
 *   the native contextmenu blocker.
 * - AdBlocker Compatibility: Does not flag element removals or style adjustments made by ad blockers.
 * - Selective Console Inspection Probe: Only triggers when DevTools actively evaluates console elements.
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
  // 1. CONTEXT MENU & EXTENSION TAMPER DEFENSE
  // ===============================================================
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

  // Guard against extensions that attempt to reassign oncontextmenu to null/undefined
  try {
    Object.defineProperty(document, 'oncontextmenu', {
      get: () => (e) => { e.preventDefault(); return false; },
      set: () => { triggerLockdown(); },
      configurable: false
    });

    Object.defineProperty(window, 'oncontextmenu', {
      get: () => (e) => { e.preventDefault(); return false; },
      set: () => { triggerLockdown(); },
      configurable: false
    });
  } catch (_) {}

  // ===============================================================
  // 2. HARDWARE KEYBOARD SHORTCUT TRAP (WINDOWS, LINUX & MACOS)
  // ===============================================================
  window.addEventListener(
    'keydown',
    (e) => {
      const key = (e.key || '').toLowerCase();
      const code = e.keyCode || e.which;

      const ctrl = e.ctrlKey;
      const meta = e.metaKey; // Cmd on macOS
      const shift = e.shiftKey;
      const alt = e.altKey;

      const isF12 = code === 123 || key === 'f12';
      const isCtrlShiftI = (ctrl || meta) && shift && (key === 'i' || code === 73);
      const isCtrlShiftJ = (ctrl || meta) && shift && (key === 'j' || code === 74);
      const isCtrlShiftC = (ctrl || meta) && shift && (key === 'c' || code === 67);
      const isCtrlU = (ctrl || meta) && (key === 'u' || code === 85);
      const isCtrlS = (ctrl || meta) && (key === 's' || code === 83);
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
  // 3. TARGETED CONSOLE INSPECTION PROBE (ZERO CPU LAG)
  // ===============================================================
  // Triggers lockdown strictly when DevTools actively renders and accesses element getters
  const probeElement = new Image();
  Object.defineProperty(probeElement, 'id', {
    get: function () {
      triggerLockdown();
      return 'secured-node';
    }
  });

  let probeCycle = 0;
  setInterval(() => {
    // Only inspect when window is active to avoid false positives in background tabs
    if (document.hasFocus()) {
      probeCycle++;
      if (probeCycle % 4 === 0) {
        console.dir(probeElement);
        if (typeof console.clear === 'function') {
          console.clear();
        }
      }
    }
  }, 2500);

  // Freeze lockdown reference to prevent script override
  try {
    Object.freeze(triggerLockdown);
  } catch (_) {}
})();
