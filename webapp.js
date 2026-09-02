/**
 * AniFlix Ultra - Progressive Web App Capabilities, Desktop/Mobile Installer & Native APIs
 * File: webapp.js
 * Version: 4.0.0 (Enterprise Cloud Sync)
 * 
 * Features:
 * 1. Native PWA Install Prompt Engine (Captures `beforeinstallprompt`, dynamic UI toggles)
 * 2. Push Notification Framework (Permission workflows, sound/vibrate triggers, dynamic app badges)
 * 3. Screen Wake Lock Lifecycle (Keeps display awake during NxSha / native playback)
 * 4. Micro-Haptic Vibration Physics (Subtle tactile clicks on buttons, chips, and error states)
 * 5. Background Sync & Offline Recovery (IndexedDB persistence hook for watch progress)
 * 6. Native Share Target Interceptor & System Share Sheet Bridge
 * 7. Unified Picture-in-Picture (HTML5 Video PiP & Document PiP for custom UI overlays)
 * 8. Real-time Network Status & Global MediaSession Bridge
 */

class WebAppExclusiveEngine {
  constructor() {
    this.isStandalone = this.checkIsStandalone();
    this.wakeLock = null;
    this.unreadBadgeCount = 0;
    this.deferredPrompt = null;
    this.swRegistration = null;

    this.init();
  }

  async init() {
    this.setupInstallPromptHandlers();
    await this.initServiceWorkerBridge();
    this.bindStandaloneEvents();
    this.handleIncomingShareTarget();
    this.setupPageVisibilityWakeLock();
    this.setupAutoPictureInPicture();
    this.setupNetworkMonitors();

    if (this.isStandalone) {
      document.body.classList.add('pwa-standalone');
      this.updateInstallButtonsVisibility(false);
      console.log('[AniFlix PWA] Initialized in Standalone App Mode.');
    }
  }

  // ===============================================================
  // 1. RUNTIME ARCHITECTURE & PWA INSTALL ENGINE
  // ===============================================================
  checkIsStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  setupInstallPromptHandlers() {
    // Intercept native browser install offer (Chrome, Edge, Android)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.updateInstallButtonsVisibility(true);
      console.log('[AniFlix PWA] beforeinstallprompt captured and ready.');
    });

    // Detect when installation finishes successfully
    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.isStandalone = true;
      document.body.classList.add('pwa-standalone');
      this.updateInstallButtonsVisibility(false);

      if (typeof window.showToast === 'function') {
        window.showToast('AniFlix Ultra installed successfully!');
      }
      this.triggerHaptic('party');
    });
  }

  updateInstallButtonsVisibility(show) {
    const installBtns = [
      document.getElementById('pwaInstallBtn'),
      document.getElementById('headerInstallBtn'),
      document.getElementById('drawerInstallBtn')
    ];

    installBtns.forEach((btn) => {
      if (btn) {
        btn.style.display = show ? 'inline-flex' : 'none';
      }
    });
  }

  async triggerPwaInstall() {
    this.triggerHaptic('medium');

    if (!this.deferredPrompt) {
      if (this.checkIsStandalone()) {
        if (typeof window.showToast === 'function') {
          window.showToast('AniFlix Ultra is already installed on this device.');
        }
        return;
      }
      if (typeof window.showToast === 'function') {
        window.showToast('Use the install icon (monitor with down arrow) in your browser URL bar.');
      }
      return;
    }

    try {
      this.deferredPrompt.prompt();
      const { outcome } = await this.deferredPrompt.userChoice;

      if (outcome === 'accepted') {
        if (typeof window.showToast === 'function') {
          window.showToast('Installing AniFlix Ultra...');
        }
      } else {
        if (typeof window.showToast === 'function') {
          window.showToast('Installation dismissed.');
        }
      }
      this.deferredPrompt = null;
    } catch (err) {
      console.warn('[PWA Install Error]:', err);
    }
  }

  async initServiceWorkerBridge() {
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.ready;

        navigator.serviceWorker.addEventListener('message', (event) => {
          this.handleServiceWorkerMessage(event.data);
        });
      } catch (err) {
        console.warn('[AniFlix PWA] Service Worker registration bridge error:', err);
      }
    }
  }

  handleServiceWorkerMessage(payload) {
    if (!payload || !payload.type) return;

    switch (payload.type) {
      case 'NOTIFICATION_ACTION_PLAY':
        if (payload.animeId && typeof window.openModalById === 'function') {
          window.openModalById(payload.animeId, payload.episode || 1, payload.season || 1);
        }
        break;
      case 'SYNC_COMPLETE': {
        const pill = document.getElementById('pwaSyncStatusPill');
        if (pill) {
          pill.classList.remove('syncing');
        }
        if (typeof window.showToast === 'function') {
          window.showToast('Offline playback synced with cloud.');
        }
        break;
      }
      default:
        break;
    }
  }

  setupNetworkMonitors() {
    window.addEventListener('online', () => {
      document.body.classList.remove('pwa-offline');
      if (typeof window.showToast === 'function') {
        window.showToast('Internet restored! Reconnecting stream services...');
      }
      this.triggerHaptic('light');

      // Attempt to auto-resume active network connections (NxSha, Proxy) if video was stalled
      if (window.streamEngine && typeof window.streamEngine._handlePlaybackStall === 'function') {
        window.streamEngine._handlePlaybackStall();
      }
    });

    window.addEventListener('offline', () => {
      document.body.classList.add('pwa-offline');
      if (typeof window.showToast === 'function') {
        window.showToast('Operating in Offline Mode.');
      }
      this.triggerHaptic('error');
    });
  }

  // ===============================================================
  // 2. NOTIFICATIONS & OS APP BADGES
  // ===============================================================
  async requestNotificationPermission() {
    this.triggerHaptic('light');

    if (!('Notification' in window)) {
      if (typeof window.showToast === 'function') {
        window.showToast('Notifications are not supported on this browser engine.');
      }
      return false;
    }

    try {
      const permission = await Notification.requestPermission();

      if (permission === 'granted') {
        this.triggerHaptic('party');
        if (typeof window.showToast === 'function') {
          window.showToast('Simulcast alerts & party notifications enabled!');
        }
        this.sendNotification('AniFlix Ultra Connected', {
          body: 'You will receive notifications for newly released episodes and watch parties.',
          tag: 'welcome-notification'
        });
        return true;
      } else {
        this.triggerHaptic('error');
        if (typeof window.showToast === 'function') {
          window.showToast('Notification permission blocked in browser settings.');
        }
        return false;
      }
    } catch (err) {
      console.error('[PWA Notification Error]:', err);
      return false;
    }
  }

  async sendNotification(title, options = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const defaultOptions = {
      icon: '/android-chrome-192x192.png',
      badge: '/favicon-32x32.png',
      vibrate: [120, 40, 120, 40, 200],
      dir: 'auto',
      data: {
        dateOfArrival: Date.now(),
        url: window.location.href
      },
      ...options
    };

    try {
      if (this.swRegistration && 'showNotification' in this.swRegistration) {
        await this.swRegistration.showNotification(title, defaultOptions);
      } else {
        const notif = new Notification(title, defaultOptions);
        notif.onclick = (e) => {
          e.preventDefault();
          window.focus();
          if (defaultOptions.data?.url) {
            window.location.href = defaultOptions.data.url;
          }
          notif.close();
        };
      }
      this.incrementBadge();
    } catch (err) {
      console.warn('[PWA Notification Dispatch Error]:', err);
    }
  }

  setBadge(count) {
    this.unreadBadgeCount = Math.max(0, count);
    if ('setAppBadge' in navigator) {
      navigator.setAppBadge(this.unreadBadgeCount).catch(() => {});
    }
  }

  incrementBadge() {
    this.setBadge(this.unreadBadgeCount + 1);
  }

  clearBadge() {
    this.unreadBadgeCount = 0;
    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  }

  // ===============================================================
  // 3. SCREEN WAKE LOCK CONTROLLER
  // ===============================================================
  async requestScreenWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      if (!this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        const indicator = document.getElementById('pwaWakeLockIndicator');
        if (indicator) indicator.classList.add('active');

        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
          if (indicator) indicator.classList.remove('active');
        });
      }
    } catch (err) {
      console.warn('[PWA WakeLock Notice]:', err);
    }
  }

  async releaseScreenWakeLock() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        const indicator = document.getElementById('pwaWakeLockIndicator');
        if (indicator) indicator.classList.remove('active');
      } catch (err) {
        console.warn('[PWA WakeLock Release Error]:', err);
      }
    }
  }

  setupPageVisibilityWakeLock() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        const modalContainer = document.getElementById('modalContainer');
        if (modalContainer && modalContainer.classList.contains('active')) {
          await this.requestScreenWakeLock();
        }
        this.clearBadge();
      } else {
        await this.releaseScreenWakeLock();
      }
    });
  }

  // ===============================================================
  // 4. TACTILE HAPTIC VIBRATION MOTOR
  // ===============================================================
  triggerHaptic(type = 'light') {
    if (!('vibrate' in navigator)) return;

    switch (type) {
      case 'light':
        navigator.vibrate(20);
        break;
      case 'medium':
        navigator.vibrate(45);
        break;
      case 'reaction':
        navigator.vibrate([20, 30, 20]);
        break;
      case 'party':
        navigator.vibrate([40, 40, 80]);
        break;
      case 'error':
        navigator.vibrate([60, 50, 60, 50, 60]);
        break;
      default:
        navigator.vibrate(20);
        break;
    }
  }

  // ===============================================================
  // 5. BACKGROUND SYNC (OFFLINE ACTIONS)
  // ===============================================================
  async registerBackgroundWatchSync(animeId, season, episode, currentTime) {
    if (window.DB && typeof window.DB.saveWatchProgress === 'function') {
      try {
        await window.DB.saveWatchProgress(animeId, {
          currentTime,
          progressPercent: 0 // Defer full calculation to the DB engine
        });

        const pill = document.getElementById('pwaSyncStatusPill');
        if (pill) pill.classList.add('syncing');
      } catch (err) {
        console.warn('[PWA Local Sync Stash Error]:', err);
      }
    }

    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;

    try {
      const sw = await navigator.serviceWorker.ready;
      await sw.sync.register('sync-watch-progress');
    } catch (err) {
      console.warn('[PWA BackgroundSync Error]:', err);
    }
  }

  // ===============================================================
  // 6. NATIVE SHARING & SHARE TARGET ENGINE
  // ===============================================================
  async shareNative(title, text, url = window.location.href) {
    this.triggerHaptic('light');

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        if (typeof window.showToast === 'function') {
          window.showToast('Shared successfully!');
        }
        return;
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('[PWA WebShare Error]:', err);
        }
      }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        if (typeof window.showToast === 'function') {
          window.showToast('Direct link copied to clipboard!');
        }
      }).catch(() => {});
    }
  }

  handleIncomingShareTarget() {
    const urlParams = new URLSearchParams(window.location.search);
    const sharedTitle = urlParams.get('title');
    const sharedText = urlParams.get('text');
    const sharedUrl = urlParams.get('url');

    if (sharedTitle || sharedText || sharedUrl) {
      const searchQuery = sharedTitle || sharedText || sharedUrl;
      setTimeout(() => {
        if (typeof window.searchAndOpenByTitle === 'function') {
          window.searchAndOpenByTitle(searchQuery);
        }
      }, 500);

      if (window.Router && typeof window.Router.set === 'function') {
        window.Router.set({ title: null, text: null, url: null }, false);
      } else {
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
    }
  }

  // ===============================================================
  // 7. PICTURE-IN-PICTURE (PIP) ENGINE
  // ===============================================================
  async togglePictureInPicture(targetElement) {
    this.triggerHaptic('medium');

    try {
      // 1. Direct HTML5 Video Tag (Used by NxSha Extractor & Shaka Player)
      if (targetElement && targetElement.tagName === 'VIDEO') {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled) {
          await targetElement.requestPictureInPicture();
        }
        return;
      }

      // 2. Document Picture-in-Picture API for arbitrary wrappers/iframes (Used by 2Embed/VidSrc)
      if ('documentPictureInPicture' in window) {
        if (window.documentPictureInPicture.window) {
          window.documentPictureInPicture.window.close();
          return;
        }

        const pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 640,
          height: 360
        });

        [...document.styleSheets].forEach((styleSheet) => {
          try {
            const cssRules = [...styleSheet.cssRules].map((r) => r.cssText).join('');
            const style = document.createElement('style');
            style.textContent = cssRules;
            pipWindow.document.head.appendChild(style);
          } catch (e) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = styleSheet.type || 'text/css';
            link.media = styleSheet.media;
            link.href = styleSheet.href;
            pipWindow.document.head.appendChild(link);
          }
        });

        const playerWrap = document.getElementById('modalPlayerWrap');
        if (playerWrap) {
          pipWindow.document.body.appendChild(playerWrap);
          pipWindow.addEventListener('pagehide', () => {
            const modalDialog = document.getElementById('modalDialog');
            const actionStrip = document.querySelector('.player-action-strip');
            if (modalDialog && actionStrip) {
              modalDialog.insertBefore(playerWrap, actionStrip);
            } else if (modalDialog) {
              modalDialog.appendChild(playerWrap);
            }
          });
        }
      } else {
        if (typeof window.showToast === 'function') {
          window.showToast('Floating Mini-Player is not supported on this browser.');
        }
      }
    } catch (err) {
      console.warn('[PWA PiP Exception]:', err);
    }
  }

  setupAutoPictureInPicture() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        const modalContainer = document.getElementById('modalContainer');
        
        // Target native Shaka video element first, then fallback to iframe wrapper
        const nativeVideo = document.getElementById('nativeStreamVideo');
        const streamFrame = document.getElementById('streamFrame');

        if (modalContainer && modalContainer.classList.contains('active')) {
          try {
            if (nativeVideo && !document.pictureInPictureElement) {
              nativeVideo.requestPictureInPicture?.().catch(() => {});
            } else if (streamFrame) {
              const localVideo = streamFrame.contentDocument?.querySelector('video');
              if (localVideo && !document.pictureInPictureElement) {
                localVideo.requestPictureInPicture?.().catch(() => {});
              }
            }
          } catch (e) {}
        }
      }
    });
  }

  // ===============================================================
  // 8. SYSTEM INTERCEPTORS & HOOKS
  // ===============================================================
  bindStandaloneEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('.p2p-emote-btn') || e.target.closest('.dock-btn')) {
        this.triggerHaptic('reaction');
      } else if (e.target.closest('.btn-play') || e.target.closest('.chip') || e.target.closest('.ep-badge-btn')) {
        this.triggerHaptic('light');
      }
    });

    window.shareCurrentTitleLink = () => {
      const title = window.STATE?.currentAnime?.title?.english || window.STATE?.currentAnime?.title?.romaji || 'Anime';
      this.shareNative(title, `Watch ${title} in HD on AniFlix Ultra:`, window.location.href);
    };

    window.shareDeepLinkEpisode = () => {
      const title = window.STATE?.currentAnime?.title?.english || window.STATE?.currentAnime?.title?.romaji || 'Anime';
      const ep = window.STATE?.episode || 1;
      this.shareNative(`${title} - Ep ${ep}`, `Watch Episode ${ep} of ${title} on AniFlix Ultra:`, window.location.href);
    };

    // Override executeStream to lock screen awake during playback
    const origExecuteStream = window.executeStream;
    if (typeof origExecuteStream === 'function') {
      const self = this;
      window.executeStream = function (...args) {
        origExecuteStream.apply(this, args);
        self.requestScreenWakeLock();
      };
    }

    // Override closeModal to release screen awake lock
    const origCloseModal = window.closeModal;
    if (typeof origCloseModal === 'function') {
      const self = this;
      window.closeModal = function (...args) {
        origCloseModal.apply(this, args);
        self.releaseScreenWakeLock();
      };
    }
  }
}

// Global Singleton Initialization
window.webApp = new WebAppExclusiveEngine();

// Top-Level Window Exports for Direct HTML onclick Attributes
window.triggerPwaInstall = () => window.webApp?.triggerPwaInstall();
window.requestNotificationPermission = () => window.webApp?.requestNotificationPermission();
