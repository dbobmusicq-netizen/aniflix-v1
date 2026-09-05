/**
 * AniFlix Ultra - Multi-Device Synchronized P2P Watch Party Engine
 * Version 13.0 - Deep-Link URL Share & Auto-Join Controller
 * Fully backwards-compatible: Requires zero modifications to core-engine.js or streaming-ui.js.
 */

class P2PWatchPartyEngine {
  constructor() {
    this.peer = null;
    this.myPeerId = null;
    this.hostPeerId = null;
    this.userName = 'User_' + Math.random().toString(36).substring(2, 6);
    this.userColor = this.generateRandomColor();

    // Peer Mesh Collections
    this.connections = new Map();     // peerId -> DataConnection
    this.audioCalls = new Map();       // peerId -> MediaConnection
    this.members = new Map();          // peerId -> MemberData
    this.latencyMap = new Map();       // peerId -> Half-RTT (ms)
    this.timeOffsets = new Map();      // peerId -> Clock Offset (ms)
    this.seenPacketIds = new Set();

    // VoIP & Web Audio Graph
    this.localStream = null;
    this.audioCtx = null;
    this.isMicMuted = true;
    this.remoteAudioElements = new Map();

    // Room Roles & Control
    this.isHost = false;
    this.controlMode = 'HOST_ONLY';
    this.sharedQueue = [];

    // Playback Engine State Tracking
    this.lastKnownTime = 0;
    this.lastHostTime = 0;
    this.isApplyingSync = false;
    this.isLocalBuffering = false;
    this.remoteBufferingPeers = new Set();
    this.catchUpInterval = null;
    this.heartbeatInterval = null;

    // Visuals & Cursors
    this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.animFrameId = null;
    this.lastMouseBroadcast = 0;

    this.init();
  }

  init() {
    this.setupEmoteCanvas();
    this.setupCursorTracking();
    this.setupAudioUnlockTrigger();
    this.checkDeepLinkAutoJoin();
  }

  generateRandomColor() {
    const colors = ['#00f0ff', '#ff0844', '#00ff88', '#ffb800', '#9d4edd', '#ff007f', '#38ef7d', '#f107a3'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  generatePacketId() {
    return `${this.myPeerId || 'peer'}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  getIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ];
  }

  // ===============================================================
  // DEEP LINK GENERATOR & AUTO-JOIN HANDLER
  // ===============================================================
  getShareableLink(roomId = this.myPeerId) {
    if (!roomId) return '';
    const url = new URL(window.location.href);
    url.searchParams.set('party', roomId);
    return url.toString();
  }

  checkDeepLinkAutoJoin() {
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const params = new URLSearchParams(window.location.search);
        const partyRoomId = params.get('party');
        if (partyRoomId && partyRoomId.trim()) {
          console.log('[P2P Engine] Deep-link room detected in URL:', partyRoomId);
          this.joinRoom(partyRoomId.trim());
          
          // Automatically open party chat HUD drawer for the participant
          const chatDrawer = document.getElementById('p2pChatSidebar');
          if (chatDrawer) chatDrawer.classList.add('open');

          if (typeof showToast === 'function') {
            showToast('Auto-joining Watch Party via shared link...');
          }
        }
      }, 750);
    });
  }

  // ===============================================================
  // 1. CONNECTION & MESH NETWORK INITIALIZATION
  // ===============================================================
  startHosting() {
    if (this.peer && !this.peer.destroyed && this.myPeerId && this.isHost) {
      const input = document.getElementById('partyMyPeerId');
      if (input) input.value = this.getShareableLink(this.myPeerId);
      return;
    }
    const roomId = 'aniflix_' + Math.random().toString(36).substring(2, 9);
    this.initPeer(roomId, true);
  }

  joinRoom(targetInput) {
    if (!targetInput) return;
    
    // Automatically parse clean host ID whether user pasted a full URL or raw code
    let cleanTarget = targetInput.trim();
    try {
      if (cleanTarget.startsWith('http://') || cleanTarget.startsWith('https://')) {
        const parsedUrl = new URL(cleanTarget);
        cleanTarget = parsedUrl.searchParams.get('party') || cleanTarget;
      }
    } catch (e) {}

    if (cleanTarget === this.myPeerId) {
      if (typeof showToast === 'function') showToast('You are already hosting this party.');
      return;
    }

    this.isHost = false;
    this.hostPeerId = cleanTarget;

    if (this.peer && !this.peer.destroyed && this.myPeerId) {
      this.disconnectMesh();
      this.members.set(this.myPeerId, {
        id: this.myPeerId,
        name: this.userName + ' (You)',
        color: this.userColor,
        status: 'playing',
        isMicMuted: this.isMicMuted,
        isHost: false
      });
      this.renderRoster();
      this.connectToPeer(cleanTarget);
      if (typeof showToast === 'function') showToast('Connecting to Watch Party...');
    } else {
      this.initPeer(null, false, cleanTarget);
    }
  }

  initPeer(preferredId, asHost, targetHostId = null) {
    this.disconnectPeer();

    const peerConfig = {
      config: {
        iceServers: this.getIceServers(),
        iceCandidatePoolSize: 10
      },
      debug: 1
    };

    this.peer = preferredId ? new Peer(preferredId, peerConfig) : new Peer(peerConfig);
    this.isHost = asHost;
    if (asHost) this.hostPeerId = preferredId;

    this.peer.on('open', (id) => {
      this.myPeerId = id;
      const input = document.getElementById('partyMyPeerId');
      // Injects full shareable deep-link directly into input field
      if (input) input.value = this.getShareableLink(id);

      this.members.set(this.myPeerId, {
        id: this.myPeerId,
        name: this.userName + ' (You)',
        color: this.userColor,
        status: 'playing',
        isMicMuted: this.isMicMuted,
        isHost: this.isHost
      });

      this.renderRoster();
      this.startHeartbeatMonitor();

      if (!asHost && targetHostId) {
        this.hostPeerId = targetHostId;
        this.connectToPeer(targetHostId);
      }

      if (typeof showToast === 'function') {
        showToast(asHost ? 'Party Room Created! Copy and share your link.' : 'Connected to Network.');
      }
    });

    this.peer.on('connection', (conn) => {
      this.setupConnection(conn);
    });

    this.peer.on('call', (call) => {
      this.handleIncomingVoiceCall(call);
    });

    this.peer.on('disconnected', () => {
      if (this.peer && !this.peer.destroyed) {
        this.peer.reconnect();
      }
    });

    this.peer.on('error', (err) => {
      console.warn('[P2P WebRTC Error]:', err);
      if (err.type === 'peer-unavailable') {
        if (typeof showToast === 'function') showToast('Party Host session is unavailable or ended.');
      } else if (err.type === 'unavailable-id') {
        this.startHosting();
      } else if (typeof showToast === 'function') {
        showToast('P2P Notice: ' + err.type);
      }
    });
  }

  connectToPeer(remoteId) {
    if (!this.peer || this.connections.has(remoteId) || remoteId === this.myPeerId) return;
    const conn = this.peer.connect(remoteId, { reliable: true });
    this.setupConnection(conn);
  }

  setupConnection(conn) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);

      conn.send({
        packetId: this.generatePacketId(),
        type: 'TIME_PING',
        t0: Date.now()
      });

      setTimeout(() => {
        if (!conn.open) return;
        conn.send({
          packetId: this.generatePacketId(),
          type: 'MEMBER_JOIN',
          payload: {
            id: this.myPeerId,
            name: this.userName,
            color: this.userColor,
            isHost: this.isHost,
            isMicMuted: this.isMicMuted
          }
        });

        if (this.isHost) {
          if (typeof STATE !== 'undefined' && STATE.currentAnime) {
            conn.send({
              packetId: this.generatePacketId(),
              type: 'FORCE_TITLE_SYNC',
              senderId: this.myPeerId,
              payload: {
                anime: STATE.currentAnime,
                season: STATE.season,
                episode: STATE.episode,
                activeServer: STATE.activeServer,
                currentTime: this.lastKnownTime || 0,
                controlMode: this.controlMode,
                queue: this.sharedQueue
              }
            });
          }
          this.broadcastRoster();
        }
      }, 150);

      this.bridgeVoiceToPeer(conn.peer);
      this.renderRoster();
    });

    conn.on('data', (data) => {
      this.handleIncomingData(data, conn);
    });

    conn.on('close', () => {
      this.cleanupPeerResources(conn.peer);
    });

    conn.on('error', (err) => {
      console.warn(`[P2P Connection Error - ${conn.peer}]:`, err);
      this.cleanupPeerResources(conn.peer);
    });
  }

  disconnectMesh() {
    this.connections.forEach(conn => {
      try { conn.close(); } catch(e) {}
    });
    this.connections.clear();

    this.audioCalls.forEach(call => {
      try { call.close(); } catch(e) {}
    });
    this.audioCalls.clear();

    this.remoteAudioElements.forEach(el => el.remove());
    this.remoteAudioElements.clear();
    this.members.clear();
  }

  disconnectPeer() {
    this.disconnectMesh();
    if (this.peer) {
      this.peer.removeAllListeners();
      if (!this.peer.destroyed) this.peer.destroy();
      this.peer = null;
    }
  }

  cleanupPeerResources(peerId) {
    this.connections.delete(peerId);
    this.members.delete(peerId);
    this.latencyMap.delete(peerId);
    this.timeOffsets.delete(peerId);
    this.remoteBufferingPeers.delete(peerId);
    this.removeCursorElement(peerId);

    const audioElem = this.remoteAudioElements.get(peerId);
    if (audioElem) {
      audioElem.pause();
      audioElem.srcObject = null;
      audioElem.remove();
      this.remoteAudioElements.delete(peerId);
    }

    if (this.audioCalls.has(peerId)) {
      try { this.audioCalls.get(peerId).close(); } catch(e) {}
      this.audioCalls.delete(peerId);
    }

    if (peerId === this.hostPeerId) {
      this.handleHostFailover();
    } else if (this.isHost) {
      this.broadcastRoster();
    }

    this.renderRoster();
  }

  handleHostFailover() {
    const remaining = Array.from(this.members.keys()).sort();
    if (remaining.length === 0) return;

    const nextHostId = remaining[0];
    this.hostPeerId = nextHostId;

    if (this.myPeerId === nextHostId) {
      this.isHost = true;
      const me = this.members.get(this.myPeerId);
      if (me) me.isHost = true;
      if (typeof showToast === 'function') showToast('Host left. You are now the Watch Party host!');
      this.broadcastRoster();
    } else {
      const newHost = this.members.get(nextHostId);
      if (newHost) newHost.isHost = true;
      if (typeof showToast === 'function') showToast(`Host migrated to ${newHost ? newHost.name : 'Peer'}`);
    }
  }

  startHeartbeatMonitor() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      this.connections.forEach((conn) => {
        if (conn.open) {
          conn.send({
            packetId: this.generatePacketId(),
            type: 'TIME_PING',
            t0: now
          });
        }
      });

      if (this.seenPacketIds.size > 2000) {
        this.seenPacketIds.clear();
      }
    }, 4000);
  }

  // ===============================================================
  // 2. BROADCAST & MESH RELAY PROTOCOL
  // ===============================================================
  broadcast(data, excludePeerId = null) {
    if (!data.packetId) {
      data.packetId = this.generatePacketId();
    }
    this.seenPacketIds.add(data.packetId);

    this.connections.forEach((conn, peerId) => {
      if (conn.open && peerId !== excludePeerId) {
        try {
          conn.send(data);
        } catch (e) {
          console.warn(`[Broadcast Send Error -> ${peerId}]:`, e);
        }
      }
    });
  }

  handleIncomingData(data, conn) {
    if (!data || !data.type) return;

    if (data.packetId) {
      if (this.seenPacketIds.has(data.packetId)) return;
      this.seenPacketIds.add(data.packetId);
    }

    if (this.isHost && data.senderId !== this.myPeerId) {
      this.broadcast(data, conn.peer);
    }

    switch (data.type) {
      case 'TIME_PING':
        conn.send({
          type: 'TIME_PONG',
          t0: data.t0,
          t1: Date.now()
        });
        break;

      case 'TIME_PONG': {
        const t2 = Date.now();
        const rtt = t2 - data.t0;
        const oneWayLatency = Math.max(0, Math.round(rtt / 2));
        const offset = Math.round(data.t1 - (data.t0 + oneWayLatency));
        this.latencyMap.set(conn.peer, oneWayLatency);
        this.timeOffsets.set(conn.peer, offset);
        break;
      }

      case 'MEMBER_JOIN':
        this.members.set(conn.peer, {
          ...data.payload,
          id: conn.peer,
          status: 'playing'
        });
        this.renderRoster();

        if (this.isHost) {
          this.connections.forEach((_, existingPeerId) => {
            if (existingPeerId !== conn.peer) {
              conn.send({
                packetId: this.generatePacketId(),
                type: 'PEER_DISCOVERY',
                targetPeerId: existingPeerId
              });
            }
          });
          this.broadcastRoster();
        }
        break;

      case 'PEER_DISCOVERY':
        if (!this.connections.has(data.targetPeerId) && data.targetPeerId !== this.myPeerId) {
          this.connectToPeer(data.targetPeerId);
        }
        break;

      case 'ROSTER_UPDATE':
        this.members = new Map(data.payload);
        if (this.members.has(this.myPeerId)) {
          this.members.get(this.myPeerId).name = this.userName + ' (You)';
        }
        this.renderRoster();
        break;

      case 'CHAT_MSG':
        this.renderChatMessage(data.senderName, data.text, data.color, data.senderId === this.myPeerId);
        break;

      case 'EMOTE_BURST':
        this.spawnEmoteParticles(data.emote, data.x, data.y);
        break;

      case 'FORCE_TITLE_SYNC':
        this.applyFullTitleSync(data.payload);
        break;

      case 'SYNC_PLAY':
        this.applyPlaybackAction('PLAY', data.payload);
        break;

      case 'SYNC_PAUSE':
        this.applyPlaybackAction('PAUSE', data.payload);
        break;

      case 'SYNC_SEEK':
        this.applyPlaybackAction('SEEK', data.payload);
        break;

      case 'BUFFERING':
        this.handlePeerBuffering(conn.peer, data.isBuffering);
        break;

      case 'CURSOR_MOVE':
        this.renderRemoteCursor(conn.peer, data.payload);
        break;

      case 'AUDIO_BOOST_ALERT':
        this.displayAudioBoostPrompt(data.level);
        break;

      case 'REMOTE_MODE_SWITCH':
        this.controlMode = data.mode;
        if (typeof showToast === 'function') {
          showToast(`Control Mode: ${this.controlMode}`);
        }
        this.renderRoster();
        break;

      case 'UPDATE_QUEUE':
        this.sharedQueue = data.queue || [];
        this.renderQueueUI();
        break;
    }
  }

  broadcastRoster() {
    this.broadcast({
      packetId: this.generatePacketId(),
      type: 'ROSTER_UPDATE',
      payload: Array.from(this.members.entries())
    });
  }

  // ===============================================================
  // 3. SYNCHRONIZED STREAM PLAYBACK & ENGINE CONTROLS
  // ===============================================================
  canControlPlayback() {
    return this.isHost || this.controlMode === 'DEMOCRATIC';
  }

  sendPlay(time) {
    if (!this.canControlPlayback() || this.isApplyingSync) return;
    this.broadcast({
      type: 'SYNC_PLAY',
      senderId: this.myPeerId,
      payload: { time: time, hostSentTime: Date.now() }
    });
  }

  sendPause(time) {
    if (!this.canControlPlayback() || this.isApplyingSync) return;
    this.broadcast({
      type: 'SYNC_PAUSE',
      senderId: this.myPeerId,
      payload: { time: time }
    });
  }

  sendSeek(time) {
    if (!this.canControlPlayback() || this.isApplyingSync) return;
    this.broadcast({
      type: 'SYNC_SEEK',
      senderId: this.myPeerId,
      payload: { time: time }
    });
  }

  broadcastTitleChange(anime, season, episode, server = 1) {
    if (!this.isHost) return;
    this.broadcast({
      type: 'FORCE_TITLE_SYNC',
      senderId: this.myPeerId,
      payload: {
        anime: anime,
        season: season,
        episode: episode,
        activeServer: server,
        currentTime: 0,
        controlMode: this.controlMode,
        queue: this.sharedQueue
      }
    });
  }

  async applyFullTitleSync(payload) {
    if (!payload || !payload.anime) return;
    this.isApplyingSync = true;

    if (typeof showToast === 'function') {
      showToast(`Party Host switched to: ${payload.anime.title?.english || payload.anime.title?.romaji}`);
    }

    if (typeof STATE !== 'undefined') {
      STATE.season = payload.season || 1;
      STATE.episode = payload.episode || 1;
      STATE.activeServer = payload.activeServer || 1;
    }

    if (typeof openModal === 'function') {
      await openModal(payload.anime, payload.season, payload.episode, true, true);
    }

    setTimeout(() => {
      const iframe = document.getElementById('streamFrame');
      if (iframe && payload.currentTime > 0) {
        iframe.contentWindow?.postMessage({ type: 'SEEK_TO', time: payload.currentTime }, '*');
      }
      this.isApplyingSync = false;
    }, 1800);
  }

  applyPlaybackAction(action, payload) {
    const iframe = document.getElementById('streamFrame');
    this.isApplyingSync = true;

    if (action === 'PLAY') {
      const hostId = this.getHostPeerId();
      const oneWayLatency = (hostId && this.latencyMap.has(hostId) ? this.latencyMap.get(hostId) : 50) / 1000;
      const targetTime = (payload.time || 0) + oneWayLatency;

      iframe?.contentWindow?.postMessage({ type: 'SEEK_TO', time: targetTime }, '*');
      iframe?.contentWindow?.postMessage({ type: 'PLAY' }, '*');
      this.updateMemberStatus(this.myPeerId, 'playing');
    } else if (action === 'PAUSE') {
      iframe?.contentWindow?.postMessage({ type: 'PAUSE' }, '*');
      if (payload.time !== undefined) {
        iframe?.contentWindow?.postMessage({ type: 'SEEK_TO', time: payload.time }, '*');
      }
      this.updateMemberStatus(this.myPeerId, 'paused');
    } else if (action === 'SEEK') {
      iframe?.contentWindow?.postMessage({ type: 'SEEK_TO', time: payload.time }, '*');
    }

    setTimeout(() => {
      this.isApplyingSync = false;
    }, 600);
  }

  getHostPeerId() {
    for (let [id, member] of this.members) {
      if (member.isHost) return id;
    }
    return null;
  }

  // ===============================================================
  // 4. BUFFER & DRIFT MANAGEMENT
  // ===============================================================
  notifyBufferStatus(isBuffering) {
    if (this.isLocalBuffering === isBuffering) return;
    this.isLocalBuffering = isBuffering;
    this.updateMemberStatus(this.myPeerId, isBuffering ? 'buffering' : 'playing');

    this.broadcast({
      type: 'BUFFERING',
      senderId: this.myPeerId,
      isBuffering: isBuffering
    });
  }

  handlePeerBuffering(peerId, isBuffering) {
    const banner = document.getElementById('p2pBufferNotice');
    const label = document.getElementById('p2pBufferPeerName');
    const iframe = document.getElementById('streamFrame');
    const member = this.members.get(peerId);

    if (isBuffering) {
      this.remoteBufferingPeers.add(peerId);
      this.updateMemberStatus(peerId, 'buffering');

      if (banner && label) {
        label.innerText = member ? member.name : 'A peer';
        banner.classList.add('visible');
      }
      this.isApplyingSync = true;
      iframe?.contentWindow?.postMessage({ type: 'PAUSE' }, '*');
      setTimeout(() => { this.isApplyingSync = false; }, 400);
    } else {
      this.remoteBufferingPeers.delete(peerId);
      this.updateMemberStatus(peerId, 'playing');

      if (this.remoteBufferingPeers.size === 0) {
        if (banner) banner.classList.remove('visible');
        this.isApplyingSync = true;
        iframe?.contentWindow?.postMessage({ type: 'PLAY' }, '*');
        setTimeout(() => { this.isApplyingSync = false; }, 400);
      }
    }
  }

  updateMemberStatus(id, status) {
    const member = this.members.get(id);
    if (member) {
      member.status = status;
      this.renderRoster();
    }
  }

  checkDriftAndEvaluateCatchUp(localSeconds, hostSeconds) {
    this.lastKnownTime = localSeconds;
    this.lastHostTime = hostSeconds;

    const pill = document.getElementById('p2pCatchUpPill');
    const drift = hostSeconds - localSeconds;

    if (drift > 4 && !this.isHost) {
      if (pill) {
        pill.classList.add('visible');
        pill.innerText = `Catch Up (${Math.round(drift)}s behind) 1.5x`;
        pill.onclick = () => this.engageCatchUpSpeed();
      }
    } else if (drift <= 1.2) {
      if (pill) pill.classList.remove('visible');
    }
  }

  engageCatchUpSpeed() {
    const iframe = document.getElementById('streamFrame');
    iframe?.contentWindow?.postMessage({ type: 'SET_PLAYBACK_RATE', rate: 1.5 }, '*');
    if (typeof showToast === 'function') showToast('Catch-up speed active (1.5x)');

    if (this.catchUpInterval) clearInterval(this.catchUpInterval);

    this.catchUpInterval = setInterval(() => {
      if (Math.abs(this.lastKnownTime - this.lastHostTime) <= 1.0) {
        iframe?.contentWindow?.postMessage({ type: 'SET_PLAYBACK_RATE', rate: 1.0 }, '*');
        clearInterval(this.catchUpInterval);
        this.catchUpInterval = null;
        const pill = document.getElementById('p2pCatchUpPill');
        if (pill) pill.classList.remove('visible');
        if (typeof showToast === 'function') showToast('Timeline Synchronized');
      }
    }, 800);
  }

  // ===============================================================
  // 5. BULLETPROOF WEBRTC AUDIO & VOIP ENGINE
  // ===============================================================
  setupAudioUnlockTrigger() {
    const unlockAudio = () => {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass();
        }
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      this.remoteAudioElements.forEach(audio => {
        if (audio.paused) {
          audio.play().catch(() => {});
        }
      });
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };

    window.addEventListener('click', unlockAudio, { once: false });
    window.addEventListener('keydown', unlockAudio, { once: false });
  }

  async createSilentAudioTrack() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
    }
    await this.audioCtx.resume();
    const osc = this.audioCtx.createOscillator();
    const dst = osc.connect(this.audioCtx.createMediaStreamDestination());
    osc.start();
    const track = dst.stream.getAudioTracks()[0];
    track.enabled = false;
    return track;
  }

  async getOrCreateLocalStream() {
    if (this.localStream) return this.localStream;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      this.localStream.getAudioTracks().forEach(t => t.enabled = !this.isMicMuted);
    } catch (err) {
      console.warn('[Microphone Fallback to Silent Track]:', err);
      const silentTrack = await this.createSilentAudioTrack();
      this.localStream = new MediaStream([silentTrack]);
      this.isMicMuted = true;
    }
    return this.localStream;
  }

  bridgeVoiceToPeer(peerId) {
    if (!this.peer || this.audioCalls.has(peerId) || peerId === this.myPeerId) return;

    this.getOrCreateLocalStream().then(stream => {
      const call = this.peer.call(peerId, stream);
      if (call) {
        this.handleVoiceCallStream(call);
      }
    }).catch(e => console.error('[Voice Call Bridge Error]:', e));
  }

  async toggleMicrophone() {
    const micBtn = document.getElementById('p2pMicToggleBtn');

    if (this.isMicMuted) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

        const activeTrack = stream.getAudioTracks()[0];

        if (this.localStream) {
          const oldTrack = this.localStream.getAudioTracks()[0];
          if (oldTrack) {
            this.localStream.removeTrack(oldTrack);
            oldTrack.stop();
          }
          this.localStream.addTrack(activeTrack);
        } else {
          this.localStream = stream;
        }

        activeTrack.enabled = true;
        this.isMicMuted = false;

        this.audioCalls.forEach((call) => {
          const sender = call.peerConnection?.getSenders()?.find(s => s.track && s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(activeTrack).catch(() => {});
          } else {
            call.close();
            const newCall = this.peer.call(call.peer, this.localStream);
            this.handleVoiceCallStream(newCall);
          }
        });

        this.connections.forEach((_, peerId) => {
          if (!this.audioCalls.has(peerId)) {
            this.bridgeVoiceToPeer(peerId);
          }
        });

        const me = this.members.get(this.myPeerId);
        if (me) me.isMicMuted = false;
        this.broadcastRoster();

        if (micBtn) {
          micBtn.innerHTML = '<i class="fas fa-microphone" style="color:var(--accent-emerald, #00ff88);"></i> Mic On';
          micBtn.classList.add('active');
        }
        if (typeof showToast === 'function') showToast('Voice Connected');
      } catch (e) {
        console.error('[WebRTC Mic Permission Denied]:', e);
        if (typeof showToast === 'function') showToast('Microphone access blocked or unavailable');
      }
    } else {
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach(track => { track.enabled = false; });
      }
      this.isMicMuted = true;

      const me = this.members.get(this.myPeerId);
      if (me) me.isMicMuted = true;
      this.broadcastRoster();

      if (micBtn) {
        micBtn.innerHTML = '<i class="fas fa-microphone-slash"></i> Mic Muted';
        micBtn.classList.remove('active');
      }
      if (typeof showToast === 'function') showToast('Microphone Muted');
    }
    this.renderRoster();
  }

  handleIncomingVoiceCall(call) {
    this.getOrCreateLocalStream().then(stream => {
      call.answer(stream);
      this.handleVoiceCallStream(call);
    }).catch(() => {
      call.answer();
      this.handleVoiceCallStream(call);
    });
  }

  handleVoiceCallStream(call) {
    this.audioCalls.set(call.peer, call);

    call.on('stream', (remoteStream) => {
      let audio = this.remoteAudioElements.get(call.peer);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio_${call.peer}`;
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
        this.remoteAudioElements.set(call.peer, audio);
      }
      audio.srcObject = remoteStream;
      audio.play().catch(e => {
        console.warn(`[Audio Autoplay Waiting for Click - Peer ${call.peer}]:`, e);
      });
    });

    call.on('close', () => {
      const audio = this.remoteAudioElements.get(call.peer);
      if (audio) {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
        this.remoteAudioElements.delete(call.peer);
      }
      this.audioCalls.delete(call.peer);
    });

    call.on('error', (err) => {
      console.warn('[VoIP Session Closed with Error]:', err);
      const audio = this.remoteAudioElements.get(call.peer);
      if (audio) {
        audio.remove();
        this.remoteAudioElements.delete(call.peer);
      }
      this.audioCalls.delete(call.peer);
    });
  }

  // ===============================================================
  // 6. MULTIPLAYER CURSORS & LIVE EMOTES
  // ===============================================================
  setupCursorTracking() {
    window.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - this.lastMouseBroadcast > 35 && this.connections.size > 0) {
        this.lastMouseBroadcast = now;
        this.broadcast({
          type: 'CURSOR_MOVE',
          senderId: this.myPeerId,
          payload: {
            x: e.clientX / window.innerWidth,
            y: e.clientY / window.innerHeight,
            name: this.userName,
            color: this.userColor
          }
        });
      }
    });
  }

  renderRemoteCursor(peerId, data) {
    const layer = document.getElementById('p2pCursorLayer');
    if (!layer) return;

    let cursor = document.getElementById(`cursor_${peerId}`);
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = `cursor_${peerId}`;
      cursor.className = 'p2p-cursor';
      cursor.innerHTML = `
        <svg viewBox="0 0 24 24" fill="${data.color}">
          <path d="M4 0l16 12.279-6.951 1.17 4.325 8.817-3.596 1.734-4.35-8.879-5.428 5.879z"/>
        </svg>
        <span class="p2p-cursor-tag" style="background:var(--p2p-bg-glass); border-left:3px solid ${data.color};">${data.name}</span>
      `;
      layer.appendChild(cursor);
    }

    cursor.style.transform = `translate3d(${data.x * window.innerWidth}px, ${data.y * window.innerHeight}px, 0)`;
  }

  removeCursorElement(peerId) {
    document.getElementById(`cursor_${peerId}`)?.remove();
  }

  setupEmoteCanvas() {
    this.canvas = document.getElementById('p2pCanvasOverlay');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    if (!this.canvas) return;
    this.canvas.width = this.canvas.clientWidth || window.innerWidth;
    this.canvas.height = this.canvas.clientHeight || window.innerHeight;
  }

  sendEmote(emoji) {
    const originX = window.innerWidth - 75;
    const originY = window.innerHeight - 120;
    this.spawnEmoteParticles(emoji, originX, originY);

    this.broadcast({
      type: 'EMOTE_BURST',
      senderId: this.myPeerId,
      emote: emoji,
      x: originX,
      y: originY
    });
  }

  spawnEmoteParticles(emoji, x, y) {
    for (let i = 0; i < 9; i++) {
      this.particles.push({
        emoji: emoji,
        x: x + (Math.random() * 30 - 15),
        y: y,
        vx: (Math.random() - 0.5) * 6,
        vy: -(Math.random() * 5 + 6),
        alpha: 1.0,
        scale: Math.random() * 0.4 + 0.8,
        rotation: (Math.random() - 0.5) * 0.4
      });
    }
    if (!this.animFrameId) {
      this.animateEmotes();
    }
  }

  animateEmotes() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.16;
      p.alpha -= 0.015;

      this.ctx.save();
      this.ctx.globalAlpha = Math.max(p.alpha, 0);
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(p.rotation);
      this.ctx.font = `${Math.round(26 * p.scale)}px sans-serif`;
      this.ctx.textAlign = 'center';
      this.ctx.fillText(p.emoji, 0, 0);
      this.ctx.restore();

      if (p.alpha <= 0) this.particles.splice(i, 1);
    }

    if (this.particles.length > 0) {
      this.animFrameId = requestAnimationFrame(() => this.animateEmotes());
    } else {
      this.animFrameId = null;
    }
  }

  // ===============================================================
  // 7. ROSTER, QUEUE & LIVE CHAT INTERFACE
  // ===============================================================
  sendChatMessage(text) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();

    this.renderChatMessage(this.userName, cleanText, this.userColor, true);

    this.broadcast({
      type: 'CHAT_MSG',
      senderId: this.myPeerId,
      senderName: this.userName,
      color: this.userColor,
      text: cleanText
    });
  }

  renderChatMessage(sender, text, color, isMine) {
    const list = document.getElementById('p2pChatMessages');
    if (!list) return;

    const bubble = document.createElement('div');
    bubble.className = `p2p-chat-bubble ${isMine ? 'mine' : ''}`;
    bubble.innerHTML = `
      <span class="p2p-chat-sender" style="color:${color}">${sender}</span>
      <span class="p2p-chat-text"></span>
      <span class="p2p-chat-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    `;
    bubble.querySelector('.p2p-chat-text').innerText = text;
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
  }

  renderRoster() {
    const container = document.getElementById('p2pMembersList');
    const counter = document.getElementById('p2pMemberCount');
    if (!container) return;

    container.innerHTML = '';
    if (counter) counter.innerText = this.members.size;

    this.members.forEach((member) => {
      const row = document.createElement('div');
      row.className = 'p2p-member-item';
      row.innerHTML = `
        <div class="p2p-member-left">
          <span class="p2p-status-dot ${member.status || 'playing'}"></span>
          <span style="color:${member.color}; font-weight:700;">${member.name}</span>
          ${member.isHost ? '<i class="fas fa-crown" style="color:var(--accent-gold); font-size:11px; margin-left:4px;"></i>' : ''}
        </div>
        <div>
          ${member.isMicMuted ? '<i class="fas fa-microphone-slash" style="color:var(--text-muted); font-size:11px;"></i>' : '<i class="fas fa-microphone" style="color:var(--accent-emerald); font-size:11px;"></i>'}
        </div>
      `;
      container.appendChild(row);
    });
  }

  // ===============================================================
  // 8. AUDIO GAIN SYNC & SHARED WATCH QUEUE
  // ===============================================================
  broadcastAudioBoost(level) {
    this.broadcast({
      type: 'AUDIO_BOOST_ALERT',
      senderId: this.myPeerId,
      level: level
    });
  }

  displayAudioBoostPrompt(level) {
    const card = document.getElementById('p2pPromptCard');
    const label = document.getElementById('p2pPromptDesc');
    if (!card || !label) return;

    label.innerText = `The party host set audio gain boost to ${Math.round(level * 100)}%. Sync to your stream?`;
    card.classList.add('visible');

    document.getElementById('p2pAcceptBoostBtn').onclick = () => {
      if (typeof toggleAudioVolumeBooster === 'function') {
        currentAudioGainLevel = level;
        if (typeof gainNode !== 'undefined' && gainNode && typeof audioCtx !== 'undefined' && audioCtx) {
          gainNode.gain.setValueAtTime(level, audioCtx.currentTime);
        }
        const lbl = document.getElementById('audioBoosterLabel');
        if (lbl) lbl.innerText = `${Math.round(level * 100)}% Volume`;
        if (typeof showToast === 'function') showToast(`Volume Synced: ${Math.round(level * 100)}%`);
      }
      card.classList.remove('visible');
    };

    document.getElementById('p2pDeclineBoostBtn').onclick = () => {
      card.classList.remove('visible');
    };
  }

  toggleControlMode() {
    if (!this.isHost) return;
    this.controlMode = this.controlMode === 'HOST_ONLY' ? 'DEMOCRATIC' : 'HOST_ONLY';
    this.broadcast({
      type: 'REMOTE_MODE_SWITCH',
      senderId: this.myPeerId,
      mode: this.controlMode
    });
    if (typeof showToast === 'function') {
      showToast(`Control Mode: ${this.controlMode === 'HOST_ONLY' ? 'Host Only' : 'Democratic (Everyone)'}`);
    }
    this.renderRoster();
  }

  addToQueue(anime, season = 1, episode = 1) {
    const queueItem = { anime, season, episode };
    this.sharedQueue.push(queueItem);
    this.renderQueueUI();

    this.broadcast({
      type: 'UPDATE_QUEUE',
      senderId: this.myPeerId,
      queue: this.sharedQueue
    });
    if (typeof showToast === 'function') showToast('Added to Watch Party queue');
  }

  playNextInQueue() {
    if (!this.isHost || this.sharedQueue.length === 0) return;
    const nextItem = this.sharedQueue.shift();
    this.renderQueueUI();

    this.broadcast({
      type: 'UPDATE_QUEUE',
      senderId: this.myPeerId,
      queue: this.sharedQueue
    });

    if (typeof openModal === 'function') {
      openModal(nextItem.anime, nextItem.season, nextItem.episode, true);
    }
  }

  renderQueueUI() {
    const queueContainer = document.getElementById('p2pQueueList');
    if (!queueContainer) return;
    queueContainer.innerHTML = '';

    this.sharedQueue.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'p2p-queue-item';
      el.style.cssText = 'display:flex; align-items:center; justify-content:space-between; font-size:12px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.06);';
      el.innerHTML = `
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">
          ${idx + 1}. ${item.anime.title?.english || item.anime.title?.romaji} (Ep ${item.episode})
        </span>
        ${this.isHost ? `<button class="modal-pill-btn" style="padding:2px 8px; font-size:10px;" onclick="window.p2pParty.playQueueItem(${idx})">Play</button>` : ''}
      `;
      queueContainer.appendChild(el);
    });
  }

  playQueueItem(index) {
    if (!this.isHost || index < 0 || index >= this.sharedQueue.length) return;
    const item = this.sharedQueue.splice(index, 1)[0];
    this.renderQueueUI();

    this.broadcast({
      type: 'UPDATE_QUEUE',
      senderId: this.myPeerId,
      queue: this.sharedQueue
    });

    if (typeof openModal === 'function') {
      openModal(item.anime, item.season, item.episode, true);
    }
  }
}

// Global Singleton Instance
window.p2pParty = new P2PWatchPartyEngine();

// ===============================================================
// 9. UI EVENT INTEGRATIONS & WINDOW HOOKS
// ===============================================================
function openWatchPartyModal(skipUrlSync = false) {
  const modal = document.getElementById('watchPartyModal');
  const overlay = document.getElementById('watchPartyOverlay');
  if (!modal || !overlay) return;

  modal.style.display = 'flex';
  overlay.classList.add('active');
  document.documentElement.style.overflowY = 'hidden';

  if (window.p2pParty && !window.p2pParty.myPeerId) {
    window.p2pParty.startHosting();
  } else {
    const input = document.getElementById('partyMyPeerId');
    if (input && window.p2pParty.myPeerId) {
      input.value = window.p2pParty.getShareableLink(window.p2pParty.myPeerId);
    }
  }

  if (!skipUrlSync && typeof Router !== 'undefined') {
    Router.set({ modal: 'watchparty' }, true);
  }
}
window.openWatchPartyModal = openWatchPartyModal;

function closeWatchPartyModal(skipUrlSync = false) {
  const modal = document.getElementById('watchPartyModal');
  const overlay = document.getElementById('watchPartyOverlay');
  if (modal && overlay) {
    modal.style.display = 'none';
    overlay.classList.remove('active');
    document.documentElement.style.overflowY = 'scroll';
    if (!skipUrlSync && typeof Router !== 'undefined') {
      Router.set({ modal: null });
    }
  }
}
window.closeWatchPartyModal = closeWatchPartyModal;

function copyWatchPartyCode() {
  const input = document.getElementById('partyMyPeerId');
  const shareableUrl = window.p2pParty ? window.p2pParty.getShareableLink() : '';

  if (shareableUrl && !shareableUrl.includes('Click Host')) {
    if (input) input.value = shareableUrl;
    navigator.clipboard.writeText(shareableUrl);
    if (typeof showToast === 'function') {
      showToast('Watch Party Link copied to clipboard!');
    }
  } else {
    if (window.p2pParty) window.p2pParty.startHosting();
  }
}
window.copyWatchPartyCode = copyWatchPartyCode;

function joinWatchPartyRoom() {
  const input = document.getElementById('partyJoinInput');
  const rawInput = input?.value?.trim();
  if (!rawInput) {
    if (typeof showToast === 'function') showToast('Please paste a room code or link.');
    return;
  }
  if (window.p2pParty) {
    window.p2pParty.joinRoom(rawInput);
    closeWatchPartyModal();
  }
}
window.joinWatchPartyRoom = joinWatchPartyRoom;

// ===============================================================
// 10. IFRAME POSTMESSAGE PLAYER SYNC
// ===============================================================
window.addEventListener('message', ({ data }) => {
  if (data && data.type === 'PLAYER_EVENT') {
    const ev = data.data;
    if (ev && typeof ev.currentTime === 'number') {
      window.p2pParty.lastKnownTime = ev.currentTime;

      if (ev.state === 'playing') {
        window.p2pParty.notifyBufferStatus(false);
        window.p2pParty.sendPlay(ev.currentTime);
      } else if (ev.state === 'paused') {
        window.p2pParty.sendPause(ev.currentTime);
      } else if (ev.state === 'buffering') {
        window.p2pParty.notifyBufferStatus(true);
      }
    }
  }
});
