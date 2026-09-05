/**
 * AnimeDrift - Enterprise Progressive Web App Capabilities & Native Bridge
 * File: webapp.js
 * Version: 6.0.0 Production Engine
 * 
 * Features Included:
 * 1. Background P2P Message Notification System:
 *    - Automatically shows push notification in OS/phone status bar when a chat message arrives and tab/screen is in the background.
 *    - Plays subtle notification ringtone audio chime + distinct haptic vibration.
 *    - Clicking the notification re-focuses the window and expands the party chat drawer.
 * 2. Smart Install Engine (Android, Desktop & Apple Safari iOS sheet):
 *    - Floating install notification card with cooldown heuristics.
 *    - Safari "Add to Home Screen" step-by-step visual drawer.
 * 3. Document & Video Picture-in-Picture (PiP):
 *    - True HTML5 Video PiP & W3C Document PiP support with safe DOM restoration.
 * 4. Lock-Screen Media Controls (MediaSession API):
 *    - Native lock screen notification controls (Play, Pause, Seek, Next/Prev episode).
 * 5. Screen Wake Lock Lifecycle:
 *    - Keeps mobile display active during streaming; auto-releases on sleep or tab switch.
 * 6. Micro-Haptic Vibration Physics Engine.
 * 7. Storage Persistence & Device Storage Quota Analyzer.
 * 8. Network-Aware Offline Recovery (Auto-reconnects on Wi-Fi/Cellular restore).
 */

class WebAppExclusiveEngine {
  constructor() {
    this.version = '6.0.0';
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
    this.audioNotificationChime = null;
    this.networkState = {
      online: navigator.onLine,
      effectiveType: navigator.connection?.effectiveType || '4g'
    };

    this.init();
  }

  async init() {
    this.applyStandaloneStyling();
    this.setupInstallPromptHandlers();
    await this.initServiceWorkerBridge();
    this.initStoragePersistence();
    this.setupNetworkMonitors();
    this.setupPageVisibilityWakeLock();
    this.setupAutoPictureInPicture();
    this.setupMediaSessionBridge();
    this.setupP2PIncomingMessageNotificationBridge();
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
    } else {
      document.documentElement.classList.remove('pwa-standalone');
      document.body.classList.remove('pwa-standalone');
    }
  }

  setupInstallPromptHandlers() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.updateInstallButtonsVisibility(true);
      this.evaluateInstallRecommendation();
    });

    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.isStandalone = true;
      this.applyStandaloneStyling();
      this.dismissInstallBanner();
      this.showToast('AnimeDrift installed successfully!');
      this.triggerHaptic('party');
      localStorage.setItem('animedrift_pwa_installed', 'true');
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
      this.showToast('AnimeDrift is already installed and running natively.');
      return;
    }

    if (this.isIOS) {
      this.displayIOSInstallGuide();
      return;
    }

    if (this.deferredPrompt) {
      try {
        this.deferredPrompt.prompt();
        const choiceResult = await this.deferredPrompt.userChoice;

        if (choiceResult.outcome === 'accepted') {
          this.showToast('Installing AnimeDrift...');
          this.dismissInstallBanner();
        } else {
          this.showToast('Installation deferred.');
          localStorage.setItem('animedrift_pwa_dismissed', Date.now().toString());
        }
      } catch (err) {
        console.error('[PWA Install Error]:', err);
      } finally {
        this.deferredPrompt = null;
      }
      return;
    }

    this.showToast('Tap Install or Add to Home Screen in your browser settings.');
  }

  evaluateInstallRecommendation() {
    if (this.isStandalone) return;

    const lastDismissed = localStorage.getItem('animedrift_pwa_dismissed');
    const hasInstalled = localStorage.getItem('animedrift_pwa_installed');
    if (hasInstalled === 'true') return;

    const cooldownMs = 2 * 24 * 60 * 60 * 1000;
    if (lastDismissed && Date.now() - parseInt(lastDismissed, 10) < cooldownMs) {
      return;
    }

    setTimeout(() => {
      this.renderInstallRecommendationBanner();
    }, 3500);
  }

  renderInstallRecommendationBanner() {
    if (document.getElementById('animedriftInstallBanner') || this.isStandalone) return;

    const banner = document.createElement('aside');
    banner.id = 'animedriftInstallBanner';
    banner.className = 'aniflix-install-card';
    banner.innerHTML = `
      <div class="aniflix-install-content">
        <div class="aniflix-install-icon">
          <img src="/android-chrome-192x192.png" alt="AnimeDrift Logo" onerror="this.src='/favicon-32x32.png'" />
        </div>
        <div class="aniflix-install-meta">
          <strong class="aniflix-install-title">Install AnimeDrift App</strong>
          <span class="aniflix-install-desc">Install for offline playback, instant P2P watch party alerts, and background audio.</span>
        </div>
      </div>
      <div class="aniflix-install-actions">
        <button id="animedriftInstallAction" class="btn-primary-compact" type="button">Install</button>
        <button id="animedriftDismissAction" class="btn-ghost-compact" type="button" aria-label="Dismiss">✕</button>
      </div>
    `;

    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('visible'));

    document.getElementById('animedriftInstallAction')?.addEventListener('click', () => {
      this.triggerPwaInstall();
    });

    document.getElementById('animedriftDismissAction')?.addEventListener('click', () => {
      this.dismissInstallBanner();
      localStorage.setItem('animedrift_pwa_dismissed', Date.now().toString());
    });
  }

  dismissInstallBanner() {
    const banner = document.getElementById('animedriftInstallBanner');
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
          <h3>Install AnimeDrift on iOS</h3>
          <button class="ios-close-btn" id="closeIosInstallGuide">✕</button>
        </div>
        <p class="ios-sheet-subtitle">Follow these quick steps in Apple Safari:</p>
        <ol class="ios-steps-list">
          <li>Tap the <strong>Share</strong> icon at the bottom of Safari.</li>
          <li>Scroll down and select <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong> in the top right corner.</li>
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
  // 2. P2P INCOMING MESSAGE PHONE NOTIFICATION BRIDGE
  // ===============================================================
  setupP2PIncomingMessageNotificationBridge() {
    // Intercept native chat render message from window.p2pParty or DOM dispatch
    const originalRenderChat = window.p2pParty?.renderChatMessage;
    if (typeof originalRenderChat === 'function') {
      const self = this;
      window.p2pParty.renderChatMessage = function (sender, text, color, isMine) {
        originalRenderChat.apply(this, [sender, text, color, isMine]);
        
        // Trigger OS notification only if message is from a peer and window is unfocused/backgrounded
        if (!isMine && (document.hidden || !document.hasFocus())) {
          self.notifyIncomingP2PMessage(sender, text);
        }
      };
    }

    // Window message listener fallback for iframe or worker dispatches
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'P2P_MESSAGE_RECEIVED') {
        const { sender, text, isMine } = event.data;
        if (!isMine && (document.hidden || !document.hasFocus())) {
          this.notifyIncomingP2PMessage(sender, text);
        }
      }
    });
  }

  notifyIncomingP2PMessage(senderName, messageText) {
    this.triggerHaptic('reaction');
    this.playNotificationChime();
    this.incrementBadge();

    const title = `Watch Party: ${senderName}`;
    const body = messageText.length > 70 ? messageText.substring(0, 67) + '...' : messageText;

    this.sendNotification(title, {
      body: body,
      tag: 'p2p-chat-message',
      renotify: true,
      data: {
        url: window.location.href,
        action: 'open_party_chat'
      }
    });
  }

  playNotificationChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5

      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
  }

  // ===============================================================
  // 3. STORAGE PERSISTENCE & ESTIMATOR
  // ===============================================================
  async initStoragePersistence() {
    if (navigator.storage && navigator.storage.persist) {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        await navigator.storage.persist();
      }
    }
  }

  async getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { quota, usage } = await navigator.storage.estimate();
        return {
          usageMB: (usage / (1024 * 1024)).toFixed(1),
          quotaMB: (quota / (1024 * 1024)).toFixed(1),
          percentUsed: ((usage / quota) * 100).toFixed(1)
        };
      } catch (err) {}
    }
    return null;
  }

  // ===============================================================
  // 4. SERVICE WORKER & MESSAGE ROUTER
  // ===============================================================
  async initServiceWorkerBridge() {
    if (!('serviceWorker' in navigator)) return;

    try {
      this.swRegistration = await navigator.serviceWorker.ready;

      navigator.serviceWorker.addEventListener('message', (event) => {
        this.handleServiceWorkerMessage(event.data);
      });
    } catch (err) {
      console.warn('[PWA] Service Worker bridge error:', err);
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

      case 'OPEN_P2P_CHAT': {
        const chatSidebar = document.getElementById('p2pChatSidebar');
        if (chatSidebar) chatSidebar.classList.add('open');
        break;
      }

      default:
        break;
    }
  }

  // ===============================================================
  // 5. NOTIFICATION API & PHONE STATUS BAR DISPATCH
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
        this.showToast('Notifications enabled!');
        this.sendNotification('AnimeDrift Connected', {
          body: 'You will receive alerts for party messages and new episodes.',
          tag: 'welcome-notification'
        });
        return true;
      } else {
        this.triggerHaptic('error');
        this.showToast('Notification permission was denied.');
        return false;
      }
    } catch (err) {
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
          if (defaultOptions.data?.action === 'open_party_chat') {
            const chatSidebar = document.getElementById('p2pChatSidebar');
            if (chatSidebar) chatSidebar.classList.add('open');
          }
          notif.close();
        };
      }
    } catch (err) {
      console.warn('[PWA Notification Error]:', err);
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
  // 6. SCREEN WAKE LOCK
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
    } catch (err) {}
  }

  async releaseScreenWakeLock() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
        const indicator = document.getElementById('pwaWakeLockIndicator');
        if (indicator) indicator.classList.remove('active');
      } catch (err) {}
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
  // 7. PICTURE-IN-PICTURE (PIP) ENGINE
  // ===============================================================
  async togglePictureInPicture(targetElement = null) {
    this.triggerHaptic('medium');

    const videoTarget =
      targetElement ||
      document.querySelector('video#nativeStreamVideo') ||
      document.querySelector('#streamFrame video') ||
      document.querySelector('video');

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
      } catch (err) {}
    }

    if ('documentPictureInPicture' in window) {
      try {
        if (window.documentPictureInPicture.window) {
          window.documentPictureInPicture.window.close();
          return;
        }

        const playerWrap = document.getElementById('modalPlayerWrap') || targetElement;
        if (!playerWrap) {
          this.showToast('No active stream to open in PiP.');
          return;
        }

        this.pipOriginalParent = playerWrap.parentNode;
        this.pipNextSibling = playerWrap.nextSibling;

        const pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 720,
          height: 405
        });

        this.pipWindow = pipWindow;

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
            link.href = sheet.href;
            pipWindow.document.head.appendChild(link);
          }
        });

        pipWindow.document.body.appendChild(playerWrap);
        pipWindow.document.body.style.margin = '0';
        pipWindow.document.body.style.background = '#000';

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
      } catch (err) {}
    }

    this.showToast('Picture-in-Picture not supported in this browser.');
  }

  setupAutoPictureInPicture() {
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
  // 8. MEDIASESSION API & OS LOCKSCREEN CONTROLS
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
        if (typeof window.playPreviousEpisode === 'function') window.playPreviousEpisode();
      }],
      ['nexttrack', () => {
        if (typeof window.playNextEpisode === 'function') window.playNextEpisode();
      }],
      ['stop', () => {
        if (typeof window.closeModal === 'function') window.closeModal();
      }]
    ];

    for (const [action, handler] of actionHandlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (error) {}
    }
  }

  updateMediaSessionMetadata(metadata = {}) {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: metadata.title || 'AnimeDrift Episode',
      artist: metadata.artist || 'AnimeDrift',
      album: metadata.album || 'Watch Party',
      artwork: metadata.artwork || [
        { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
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
      } catch (err) {}
    }

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

      window.history.replaceState({}, '', window.location.pathname);
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
    } catch (e) {}
  }

  // ===============================================================
  // 11. DOM HOOKS & UTILITIES
  // ===============================================================
  setupNetworkMonitors() {
    window.addEventListener('online', () => {
      document.body.classList.remove('pwa-offline');
      this.showToast('Network restored.');
      this.triggerHaptic('light');
    });

    window.addEventListener('offline', () => {
      document.body.classList.add('pwa-offline');
      this.showToast('Offline Mode active.');
      this.triggerHaptic('error');
    });
  }

  bindDOMInteractions() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('.p2p-emote-btn, .dock-btn, .btn-reaction')) {
        this.triggerHaptic('reaction');
      } else if (e.target.closest('.btn-play, .chip, .ep-badge-btn, .tab-btn')) {
        this.triggerHaptic('light');
      }
    });

    window.shareCurrentTitleLink = () => {
      const title = window.STATE?.currentAnime?.title?.english || window.STATE?.currentAnime?.title?.romaji || 'Anime';
      this.shareNative(title, `Watch ${title} on AnimeDrift:`, window.location.href);
    };

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
        if (self.pipWindow) self.pipWindow.close();
      };
    }
  }

  showToast(message) {
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }

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

// Global Singleton Initialization
window.webApp = new WebAppExclusiveEngine();

// Window Function Bindings
window.triggerPwaInstall = () => window.webApp?.triggerPwaInstall();
window.requestNotificationPermission = () => window.webApp?.requestNotificationPermission();
window.togglePictureInPicture = (target) => window.webApp?.togglePictureInPicture(target);
window.triggerMicroHaptic = (pattern) => window.webApp?.triggerHaptic(pattern);
