/**
 * AniFlix Ultra - Advanced Security & Anti-Inspection Engine
 * File: secure.js
 * Features: Multi-Layer DevTools Trap, Infinite Debugger Loop, Keyboard Shortcut Interception,
 * Context Menu Suppression, and Automatic Persistent Telegram Redirection Guard.
 */

(function () {
  'use strict';

  const TARGET_TG_URL = 'https://t.me/New_Hindi_Dub_Anime_Crunchyroll';

  // 1. Immediate Redirection Trigger
  function triggerLockdown() {
    try {
      window.location.replace(TARGET_TG_URL);
    } catch (e) {
      window.location.href = TARGET_TG_URL;
    }
  }

  // 2. Disable Right-Click Context Menu
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, { capture: true });

  // 3. Intercept Keyboard Shortcuts (F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U)
  window.addEventListener('keydown', (e) => {
    const isF12 = e.keyCode === 123 || e.key === 'F12';
    const isCtrlShift = e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 75 || e.keyCode === 67 || e.key.toLowerCase() === 'i' || e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'c');
    const isCtrlU = e.ctrlKey && (e.keyCode === 85 || e.key.toLowerCase() === 'u');
    const isCtrlS = e.ctrlKey && (e.keyCode === 83 || e.key.toLowerCase() === 's');

    if (isF12 || isCtrlShift || isCtrlU || isCtrlS) {
      e.preventDefault();
      e.stopPropagation();
      triggerLockdown();
      return false;
    }
  }, { capture: true });

  // 4. Advanced DevTools Dimension & Performance Trap (Detects Docked/Undocked Inspector)
  let devToolsCheckInterval = setInterval(() => {
    const threshold = 160;
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;

    // Check performance debugger hook
    const start = performance.now();
    debugger; // Triggers CPU stall / breakpoint pause when inspector is open
    const duration = performance.now() - start;

    if ((widthThreshold || heightThreshold) || duration > 100) {
      triggerLockdown();
    }
  }, 1000);

  // 5. Console/Debugger Element Inspection Trap
  const elementTrap = new Image();
  Object.defineProperty(elementTrap, 'id', {
    get: function () {
      triggerLockdown();
      return 'Secured';
    }
  });

  // 6. Persistent Return Guard (If user tries to come back or click 'Back' button)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted || window.performance && window.performance.navigation.type === 2) {
      triggerLockdown();
    }
  });

  // Periodic heartbeat safeguard
  setInterval(() => {
    if (window.location.href !== TARGET_TG_URL) {
      // Check for console open indicators
      if (window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 200) {
        triggerLockdown();
      }
    }
  }, 500);

})();
