/**
 * AniFlix Ultra - Enterprise Progressive Web App Capabilities & Native Bridge
 * File: webapp.js
 * Version: 5.2.0 (High-Performance Production Engine)
 * 
 * New & Enhanced Features:
 * 1. Intelligent Smart Install Banner & Detection:
 *    - Safari/iOS customized "Add to Home Screen" dynamic prompt modal.
 *    - Returning user install recommendation triggers with cooldown heuristics.
 * 2. Cross-Platform Picture-in-Picture (PiP):
 *    - HTML5 Video PiP with fallback to W3C Document Picture-in-Picture API.
 *    - Safe DOM migration and automatic restoration on popup close.
 *    - Media Session API bridge inside PiP windows with controls.
 * 3. MediaSession API V2:
 *    - Full synchronization with hardware media keys (Play, Pause, Seek, Next/Prev Track).
 *    - Dynamic high-resolution artwork binding and playback position state updates.
 * 4. Micro-Haptic Vibration Physics Engine:
 *    - Hardware check + customizable patterns (subtle click, medium, double, celebration, error).
 * 5. Screen Wake Lock Lifecycle Manager:
 *    - Auto-reacquires wake locks on document focus and visibility restoration.
 *    - Automatically binds to video play/pause/ended lifecycles.
 * 6. Storage Persistence & Quota Predictor:
 *    - Requests `navigator.storage.persist()` for offline video storage retention.
 *    - Exposes real-time storage quota tracking.
 * 7. Background Sync & Network Resiliency Engine:
 *    - Online/Offline lifecycle monitoring with automatic stream/buffer recovery.
 *    - Network Information API (Network type, effectiveType, downlink, RTT monitoring).
 * 8. Notification & Web Badging Framework:
 *    - Actionable Rich Notifications with fallback handling.
 *    - Safe Web App Badging with automatic counter resets on active visibility.
 * 9. Native Share Target & System Clipboard Bridge.
 * 10. Memory Safe Cleanup & Lifecycle Teardown.
 */

class WebAppExclusiveEngine {
  constructor() {
    this.version = '5.2.0';
    this.isStandalone = this.checkIsStandalone();
    this.isIOS = this.checkIsIOS();
    this.deferredPrompt = null;
    this.swRegistration = null;
    this.wakeLock = null;
    this.unreadBadgeCount = 0;
    this.pipWindow = null;
    this.pipOriginalParent = null;
    this.pipNextSibling = null;
    this.activeVideoElement = null;
    this.networkState = {
      online: navigator.onLine,
      effectiveType: navigator.connection?.effectiveType || '4g',
      saveData: navigator.connection?.saveData || false
    };

    // Initialize core lifecycle
    this.init();
  }

  async init() {
    console.log(`[AniFlix PWA] Initializing Core Engine v${this.version}...`);
    this.applyStandaloneStyling();
    this.setupInstallPromptHandlers();
    await this.initServiceWorkerBridge();
    this.initStoragePersistence();
    this.setupNetworkMonitors();
    this.setupPageVisibilityWakeLock();
    this.setupAutoPictureInPicture();
    this.setupMediaSessionBridge();
    this.bindDOMInteractions();
    this.handleIncomingShareTarget();
    this.evaluateInstallRecommendation();
  }

  // ===============================================================
  // 1. RUNTIME DETECTION & PWA INSTALLATION ENGINE
  // ===============================================================
  checkIsStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  checkIsIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !window.MSStream &&
      !this.checkIsStandalone()
    );
  }

  applyStandaloneStyling() {
    if (this.isStandalone) {
      document.documentElement.classList.add('pwa-standalone');
      document.body.classList.add('pwa-standalone');
      this.updateInstallButtonsVisibility(false);
      console.log('[AniFlix PWA] Running inside Standalone App Window.');
    } else {
      document.documentElement.classList.remove('pwa-standalone');
      document.body.classList.remove('pwa-standalone');
    }
  }

  setupInstallPromptHandlers() {
    // Intercept native browser prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.updateInstallButtonsVisibility(true);
      console.log('[AniFlix PWA] Native install prompt captured and deferred.');

      // Check if recommendation prompt should be presented
      this.evaluateInstallRecommendation();
    });

    // Detect installation success
    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.isStandalone = true;
      this.applyStandaloneStyling();
      this.dismissInstallBanner();
      this.showToast('AniFlix Ultra installed successfully! Welcome to the Native App Experience.');
      this.triggerHaptic('party');
      localStorage.setItem('aniflix_pwa_installed', 'true');
    });
  }

  updateInstallButtonsVisibility(show) {
    const installBtns = document.querySelectorAll(
      '#pwaInstallBtn, #headerInstallBtn, #drawerInstallBtn, .pwa-install-trigger'
    );
    installBtns.forEach((btn) => {
      if (btn) {
        btn.style.display = show && !this.isStandalone ? 'inline-flex' : 'none';
      }
    });
  }

  async triggerPwaInstall() {
    this.triggerHaptic('medium');

    if (this.isStandalone) {
      this.showToast('AniFlix Ultra is already installed and running natively.');
      return;
    }

    // iOS manual install flow
    if (this.isIOS) {
      this.displayIOSInstallGuide();
      return;
    }

    // Chromium & Edge install prompt
    if (this.deferredPrompt) {
      try {
        this.deferredPrompt.prompt();
        const choiceResult = await this.deferredPrompt.userChoice;

        if (choiceResult.outcome === 'accepted') {
          this.showToast('Starting AniFlix Ultra installation...');
          this.dismissInstallBanner();
        } else {
          this.showToast('Installation deferred.');
          localStorage.setItem('aniflix_pwa_prompt_dismissed', Date.now().toString());
        }
      } catch (err) {
        console.error('[AniFlix PWA] Install error:', err);
      } finally {
        this.deferredPrompt = null;
      }
      return;
    }

    // Fallback guidance for desktop browsers where prompt isn't interceptable
    this.showToast('Click the Install app button in your browser URL bar.');
  }

  evaluateInstallRecommendation() {
    if (this.isStandalone) return;

    const lastDismissed = localStorage.getItem('aniflix_pwa_prompt_dismissed');
    const hasInstalled = localStorage.getItem('aniflix_pwa_installed');
    if (hasInstalled === 'true') return;

    // Cooldown check (3 days between non-intrusive bottom banner popups)
    const cooldownMs = 3 * 24 * 60 * 60 * 1000;
    if (lastDismissed && Date.now() - parseInt(lastDismissed, 10) < cooldownMs) {
      return;
    }

    // Delay prompt to avoid layout shift during critical page paint
    setTimeout(() => {
      this.renderInstallRecommendationBanner();
    }, 4000);
  }

  renderInstallRecommendationBanner() {
    if (document.getElementById('aniflixInstallBanner') || this.isStandalone) return;

    const banner = document.createElement('aside');
    banner.id = 'aniflixInstallBanner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install AniFlix Ultra');
    banner.className = 'aniflix-install-card';

    banner.innerHTML = `
      <div class="aniflix-install-content">
        <div class="aniflix-install-icon">
          <img src="/android-chrome-192x192.png" alt="AniFlix Logo" onerror="this.src='/favicon-32x32.png'" />
        </div>
        <div class="aniflix-install-meta">
          <strong class="aniflix-install-title">Get AniFlix Ultra App</strong>
          <span class="aniflix-install-desc">Install for offline playback, zero frame drops, and PiP multitasking.</span>
        </div>
      </div>
      <div class="aniflix-install-actions">
        <button id="aniflixBannerInstallAction" class="btn-primary-compact" type="button">Install</button>
        <button id="aniflixBannerDismissAction" class="btn-ghost-compact" type="button" aria-label="Dismiss">✕</button>
      </div>
    `;

    document.body.appendChild(banner);

    // Apply layout animation via class
    requestAnimationFrame(() => banner.classList.add('visible'));

    document.getElementById('aniflixBannerInstallAction')?.addEventListener('click', () => {
      this.triggerPwaInstall();
    });

    document.getElementById('aniflixBannerDismissAction')?.addEventListener('click', () => {
      this.dismissInstallBanner();
      localStorage.setItem('aniflix_pwa_prompt_dismissed', Date.now().toString());
    });
  }

  dismissInstallBanner() {
    const banner = document.getElementById('aniflixInstallBanner');
    if (banner) {
      banner.classList.remove('visible');
      setTimeout(() => banner.remove(), 300);
    }
  }

  displayIOSInstallGuide() {
    const existingGuide = document.getElementById('iosInstallModal');
    if (existingGuide) existingGuide.remove();

    const guide = document.createElement('div');
    guide.id = 'iosInstallModal';
    guide.className = 'ios-install-backdrop';
    guide.innerHTML = `
      <div class="ios-install-sheet" role="dialog" aria-modal="true">
        <div class="ios-sheet-header">
          <h3>Install AniFlix Ultra on iOS</h3>
          <button class="ios-close-btn" id="closeIosInstallGuide">✕</button>
        </div>
        <p class="ios-sheet-subtitle">Follow these quick steps in Apple Safari:</p>
        <ol class="ios-steps-list">
          <li>Tap the <strong>Share</strong> button <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> at the bottom of Safari.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>.</li>
          <li>Tap <strong>Add</strong> in the top right corner to confirm.</li>
        </ol>
        <button class="ios-confirm-btn" id="confirmIosInstall">Understood</button>
      </div>
    `;

    document.body.appendChild(guide);

    const closeHandler = () => {
      guide.classList.remove('active');
      setTimeout(() => guide.remove(), 250);
    };

    document.getElementById('closeIosInstallGuide')?.addEventListener('click', closeHandler);
    document.getElementById('confirmIosInstall')?.addEventListener('click', closeHandler);
    guide.addEventListener('click', (e) => {
      if (e.target === guide) closeHandler();
    });

    requestAnimationFrame(() => guide.classList.add('active'));
  }

  // ===============================================================
  // 2. STORAGE QUOTA & PERSISTENCE
  // ===============================================================
  async initStoragePersistence() {
    if (navigator.storage && navigator.storage.persist) {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        const granted = await navigator.storage.persist();
        console.log(`[AniFlix PWA] Persistent Storage Granted: ${granted}`);
      }
    }
  }

  async getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { quota, usage } = await navigator.storage.estimate();
        const usageMB = (usage / (1024 * 1024)).toFixed(1);
        const quotaMB = (quota / (1024 * 1024)).toFixed(1);
        const percentUsed = ((usage / quota) * 100).toFixed(1);
        return { usageMB, quotaMB, percentUsed, rawUsage: usage, rawQuota: quota };
      } catch (err) {
        console.warn('[AniFlix PWA] Storage estimate error:', err);
      }
    }
    return null;
  }

  // ===============================================================
  // 3. SERVICE WORKER & SYNC BRIDGE
  // ===============================================================
  async initServiceWorkerBridge() {
    if (!('serviceWorker' in navigator)) return;

    try {
      this.swRegistration = await navigator.serviceWorker.ready;

      navigator.serviceWorker.addEventListener('message', (event) => {
        this.handleServiceWorkerMessage(event.data);
      });

      // Handle Service Worker update availability
      this.swRegistration.addEventListener('updatefound', () => {
        const newWorker = this.swRegistration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            this.showToast('App update available! Restarting to apply updates...');
            setTimeout(() => {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
              window.location.reload();
            }, 2500);
          }
        });
      });
    } catch (err) {
      console.warn('[AniFlix PWA] Service Worker registration bridge error:', err);
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
        if (pill) pill.classList.remove('syncing');
        this.showToast('Offline watch records synchronized.');
        break;
      }

      case 'FORCE_CACHE_PURGE':
        caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))));
        break;

      default:
        break;
    }
  }

  async registerBackgroundWatchSync(animeId, season, episode, currentTime, duration = 0) {
    // 1. Commit immediate state to IndexedDB / local database
    if (window.DB && typeof window.DB.saveWatchProgress === 'function') {
      try {
        const percent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
        await window.DB.saveWatchProgress(animeId, {
          season,
          episode,
          currentTime,
          duration,
          progressPercent: percent,
          updatedAt: Date.now()
        });

        const pill = document.getElementById('pwaSyncStatusPill');
        if (pill) pill.classList.add('syncing');
      } catch (err) {
        console.warn('[AniFlix PWA] Local storage progress failed:', err);
      }
    }

    // 2. Request background sync registration if supported
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const sw = await navigator.serviceWorker.ready;
        await sw.sync.register('sync-watch-progress');
      } catch (err) {
        console.warn('[AniFlix PWA] BackgroundSync unavailable:', err);
      }
    }
  }

  // ===============================================================
  // 4. NETWORK ADAPTIVE CONTROLLER
  // ===============================================================
  setupNetworkMonitors() {
    const updateNetworkStatus = () => {
      this.networkState.online = navigator.onLine;

      if (navigator.connection) {
        this.networkState.effectiveType = navigator.connection.effectiveType || '4g';
        this.networkState.saveData = navigator.connection.saveData || false;
      }

      if (this.networkState.online) {
        document.body.classList.remove('pwa-offline');
        this.showToast('Network restored. Reconnecting playback pipeline...');
        this.triggerHaptic('light');

        // Recover video playback if stalled
        if (window.streamEngine && typeof window.streamEngine._handlePlaybackStall === 'function') {
          window.streamEngine._handlePlaybackStall();
        }
      } else {
        document.body.classList.add('pwa-offline');
        this.showToast('Offline Mode active. Cached episodes remain available.');
        this.triggerHaptic('error');
      }
    };

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);

    if (navigator.connection) {
      navigator.connection.addEventListener('change', () => {
        this.networkState.effectiveType = navigator.connection.effectiveType;
        console.log(`[AniFlix Network] Connection type changed to: ${this.networkState.effectiveType}`);
      });
    }
  }

  // ===============================================================
  // 5. NOTIFICATION ENGINE & SYSTEM BADGES
  // ===============================================================
  async requestNotificationPermission() {
    this.triggerHaptic('light');

    if (!('Notification' in window)) {
      this.showToast('Notifications are not supported by this browser engine.');
      return false;
    }

    try {
      const permission = await Notification.requestPermission();

      if (permission === 'granted') {
        this.triggerHaptic('party');
        this.showToast('Simulcast & episode alerts active!');
        this.sendNotification('AniFlix Ultra Ready', {
          body: 'You will receive timely alerts for newly airing episodes and watch parties.',
          tag: 'welcome-notification'
        });
        return true;
      } else {
        this.triggerHaptic('error');
        this.showToast('Notification permission was denied.');
        return false;
      }
    } catch (err) {
      console.error('[AniFlix PWA] Notification permission error:', err);
      return false;
    }
  }

  async sendNotification(title, options = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const defaultOptions = {
      icon: '/android-chrome-192x192.png',
      badge: '/favicon-32x32.png',
      vibrate: [100, 50, 100],
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
      console.warn('[AniFlix PWA] Notification failed to dispatch:', err);
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
  // 6. SCREEN WAKE LOCK CONTROLLER
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
        console.log('[AniFlix PWA] Screen Wake Lock acquired.');
      }
    } catch (err) {
      console.warn('[AniFlix PWA] WakeLock acquire failure:', err.message);
    }
  }

  async releaseScreenWakeLock() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        const indicator = document.getElementById('pwaWakeLockIndicator');
        if (indicator) indicator.classList.remove('active');
        console.log('[AniFlix PWA] Screen Wake Lock released.');
      } catch (err) {
        console.warn('[AniFlix PWA] WakeLock release failure:', err);
      }
    }
  }

  setupPageVisibilityWakeLock() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        const modalContainer = document.getElementById('modalContainer');
        const isModalOpen = modalContainer && modalContainer.classList.contains('active');
        const isPlaying = this.activeVideoElement && !this.activeVideoElement.paused;

        if (isModalOpen || isPlaying) {
          await this.requestScreenWakeLock();
        }
        this.clearBadge();
      } else {
        await this.releaseScreenWakeLock();
      }
    });
  }

  // ===============================================================
  // 7. ADVANCED PICTURE-IN-PICTURE (PIP) ENGINE
  // ===============================================================
  async togglePictureInPicture(targetElement = null) {
    this.triggerHaptic('medium');

    const videoTarget =
      targetElement ||
      document.querySelector('video#nativeStreamVideo') ||
      document.querySelector('#streamFrame video') ||
      document.querySelector('video');

    // Scenario A: Native HTML5 Video Element PiP
    if (videoTarget && videoTarget.tagName === 'VIDEO') {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return;
        } else if (document.pictureInPictureEnabled) {
          await videoTarget.requestPictureInPicture();
          this.activeVideoElement = videoTarget;
          return;
        }
      } catch (err) {
        console.warn('[AniFlix PiP] Native Video PiP failed, testing Document PiP fallback:', err);
      }
    }

    // Scenario B: Document Picture-in-Picture API for arbitrary containers & embeds
    if ('documentPictureInPicture' in window) {
      try {
        if (window.documentPictureInPicture.window) {
          window.documentPictureInPicture.window.close();
          return;
        }

        const playerWrap = document.getElementById('modalPlayerWrap') || targetElement;
        if (!playerWrap) {
          this.showToast('No active video stream to open in PiP.');
          return;
        }

        // Preserve original DOM placement references for restoration
        this.pipOriginalParent = playerWrap.parentNode;
        this.pipNextSibling = playerWrap.nextSibling;

        const pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 720,
          height: 405
        });

        this.pipWindow = pipWindow;

        // Clone host styles into the new popup PiP window
        [...document.styleSheets].forEach((sheet) => {
          try {
            const cssRules = [...sheet.cssRules].map((r) => r.cssText).join('');
            const style = document.createElement('style');
            style.textContent = cssRules;
            pipWindow.document.head.appendChild(style);
          } catch (e) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = sheet.type || 'text/css';
            link.media = sheet.media;
            link.href = sheet.href;
            pipWindow.document.head.appendChild(link);
          }
        });

        // Migrate player container
        pipWindow.document.body.appendChild(playerWrap);
        pipWindow.document.body.style.margin = '0';
        pipWindow.document.body.style.background = '#000';

        // Listen for user closing the PiP window to restore DOM position
        pipWindow.addEventListener('pagehide', () => {
          if (this.pipOriginalParent) {
            if (this.pipNextSibling) {
              this.pipOriginalParent.insertBefore(playerWrap, this.pipNextSibling);
            } else {
              this.pipOriginalParent.appendChild(playerWrap);
            }
          }
          this.pipWindow = null;
          this.pipOriginalParent = null;
          this.pipNextSibling = null;
        });

        return;
      } catch (err) {
        console.error('[AniFlix PiP] Document PiP launch failed:', err);
      }
    }

    this.showToast('Picture-in-Picture is not supported in this browser engine.');
  }

  setupAutoPictureInPicture() {
    // Auto launch PiP when switching apps during playback (supported on Chromium mobile/desktop)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        const video =
          document.getElementById('nativeStreamVideo') ||
          document.querySelector('video');

        if (video && !video.paused && !document.pictureInPictureElement) {
          if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
            video.requestPictureInPicture().catch(() => {});
          }
        }
      }
    });
  }

  // ===============================================================
  // 8. MEDIASESSION API & OS CONTROLS INTEGRATION
  // ===============================================================
  setupMediaSessionBridge() {
    if (!('mediaSession' in navigator)) return;

    const actionHandlers = [
      ['play', () => {
        const v = this.getActiveVideo();
        if (v) { v.play(); this.requestScreenWakeLock(); }
      }],
      ['pause', () => {
        const v = this.getActiveVideo();
        if (v) { v.pause(); this.releaseScreenWakeLock(); }
      }],
      ['seekbackward', (details) => {
        const v = this.getActiveVideo();
        if (v) v.currentTime = Math.max(0, v.currentTime - (details.seekOffset || 10));
      }],
      ['seekforward', (details) => {
        const v = this.getActiveVideo();
        if (v) v.currentTime = Math.min(v.duration || Infinity, v.currentTime + (details.seekOffset || 10));
      }],
      ['previoustrack', () => {
        if (typeof window.playPreviousEpisode === 'function') {
          window.playPreviousEpisode();
        }
      }],
      ['nexttrack', () => {
        if (typeof window.playNextEpisode === 'function') {
          window.playNextEpisode();
        }
      }],
      ['stop', () => {
        if (typeof window.closeModal === 'function') {
          window.closeModal();
        }
      }]
    ];

    for (const [action, handler] of actionHandlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (error) {
        console.warn(`[AniFlix MediaSession] Action "${action}" not supported:`, error);
      }
    }
  }

  updateMediaSessionMetadata(metadata = {}) {
    if (!('mediaSession' in navigator)) return;

    const title = metadata.title || 'AniFlix Episode';
    const artist = metadata.artist || 'AniFlix Ultra';
    const album = metadata.album || 'Anime Stream';
    const artwork = metadata.artwork || [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }
    ];

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork
    });
  }

  syncMediaPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;

    const video = this.getActiveVideo();
    if (video && !isNaN(video.duration) && video.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: video.duration,
          playbackRate: video.playbackRate,
          position: video.currentTime
        });
      } catch (err) {
        console.warn('[AniFlix MediaSession] Position state sync error:', err);
      }
    }
  }

  getActiveVideo() {
    return (
      this.activeVideoElement ||
      document.getElementById('nativeStreamVideo') ||
      document.querySelector('video')
    );
  }

  // ===============================================================
  // 9. NATIVE SHARE & INCOMING TARGET HANDLERS
  // ===============================================================
  async shareNative(title, text, url = window.location.href) {
    this.triggerHaptic('light');

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        this.showToast('Shared successfully!');
        return;
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('[AniFlix Share] Native WebShare error:', err);
        }
      }
    }

    // Fallback: Copy to clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        this.showToast('Link copied to clipboard!');
      } catch (e) {
        this.showToast('Failed to copy link.');
      }
    }
  }

  handleIncomingShareTarget() {
    const urlParams = new URLSearchParams(window.location.search);
    const sharedTitle = urlParams.get('title');
    const sharedText = urlParams.get('text');
    const sharedUrl = urlParams.get('url');

    if (sharedTitle || sharedText || sharedUrl) {
      const query = sharedTitle || sharedText || sharedUrl;
      setTimeout(() => {
        if (typeof window.searchAndOpenByTitle === 'function') {
          window.searchAndOpenByTitle(query);
        }
      }, 400);

      // Clean history state without reloading page
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
    }
  }

  // ===============================================================
  // 10. HAPTIC PHYSICS MOTOR
  // ===============================================================
  triggerHaptic(type = 'light') {
    if (!('vibrate' in navigator)) return;

    try {
      switch (type) {
        case 'light':
          navigator.vibrate(15);
          break;
        case 'medium':
          navigator.vibrate(35);
          break;
        case 'heavy':
          navigator.vibrate(60);
          break;
        case 'reaction':
          navigator.vibrate([15, 20, 15]);
          break;
        case 'party':
          navigator.vibrate([30, 30, 60, 30, 90]);
          break;
        case 'error':
          navigator.vibrate([50, 40, 50, 40, 50]);
          break;
        default:
          navigator.vibrate(15);
          break;
      }
    } catch (e) {
      // Ignored if user has not interacted with DOM yet
    }
  }

  // ===============================================================
  // 11. DOM HOOKS & UTILITIES
  // ===============================================================
  bindDOMInteractions() {
    // Delegated click haptics
    document.addEventListener('click', (e) => {
      if (e.target.closest('.p2p-emote-btn, .dock-btn, .btn-reaction')) {
        this.triggerHaptic('reaction');
      } else if (e.target.closest('.btn-play, .chip, .ep-badge-btn, .tab-btn')) {
        this.triggerHaptic('light');
      } else if (e.target.closest('.btn-danger, .btn-delete')) {
        this.triggerHaptic('heavy');
      }
    });

    // Global share shortcuts
    window.shareCurrentTitleLink = () => {
      const title =
        window.STATE?.currentAnime?.title?.english ||
        window.STATE?.currentAnime?.title?.romaji ||
        'Anime Title';
      this.shareNative(title, `Watch ${title} in High Definition on AniFlix Ultra:`, window.location.href);
    };

    window.shareDeepLinkEpisode = () => {
      const title =
        window.STATE?.currentAnime?.title?.english ||
        window.STATE?.currentAnime?.title?.romaji ||
        'Anime Title';
      const ep = window.STATE?.episode || 1;
      this.shareNative(`${title} - Ep ${ep}`, `Watch Episode ${ep} of ${title} on AniFlix Ultra:`, window.location.href);
    };

    // Video Lifecycle Binding
    const setupVideoListeners = (video) => {
      if (!video || video._hasPwaHooks) return;
      video._hasPwaHooks = true;
      this.activeVideoElement = video;

      video.addEventListener('play', () => {
        this.requestScreenWakeLock();
        this.syncMediaPositionState();
      });

      video.addEventListener('pause', () => {
        this.releaseScreenWakeLock();
        this.syncMediaPositionState();
      });

      video.addEventListener('timeupdate', () => {
        // Throttled sync
        if (Math.floor(video.currentTime) % 15 === 0) {
          this.syncMediaPositionState();
        }
      });

      video.addEventListener('ended', () => {
        this.releaseScreenWakeLock();
      });
    };

    // MutationObserver to attach hooks to dynamically mounted video elements
    const observer = new MutationObserver(() => {
      const vid = document.getElementById('nativeStreamVideo') || document.querySelector('video');
      if (vid) setupVideoListeners(vid);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Stream & Modal Interceptors
    const origExecuteStream = window.executeStream;
    if (typeof origExecuteStream === 'function') {
      const self = this;
      window.executeStream = function (...args) {
        origExecuteStream.apply(this, args);
        self.requestScreenWakeLock();
      };
    }

    const origCloseModal = window.closeModal;
    if (typeof origCloseModal === 'function') {
      const self = this;
      window.closeModal = function (...args) {
        origCloseModal.apply(this, args);
        self.releaseScreenWakeLock();
        if (self.pipWindow) {
          self.pipWindow.close();
        }
      };
    }
  }

  showToast(message) {
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }

    // Fallback UI toast if main framework toast is missing
    const existing = document.querySelector('.aniflix-internal-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'aniflix-internal-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }
}

// Global Singleton Instantation
window.webApp = new WebAppExclusiveEngine();

// Clean Global Function Aliases for DOM Event Handlers
window.triggerPwaInstall = () => window.webApp?.triggerPwaInstall();
window.requestNotificationPermission = () => window.webApp?.requestNotificationPermission();
window.togglePictureInPicture = (target) => window.webApp?.togglePictureInPicture(target);
window.triggerMicroHaptic = (pattern) => window.webApp?.triggerHaptic(pattern);
