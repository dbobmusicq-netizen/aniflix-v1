/**
 * AniFlix Ultra - Multi-Device Synchronized P2P Watch Party Engine
 * Version 11.0 - Production-Grade WebRTC Mesh & Star Relay Controller
 * Solves: Connection lifecycle races, unhandled teardowns, signaling disconnect cascades,
 * full mesh synchronization, latency compensation, and iframe player state dispatching.
 */

class P2PWatchPartyEngine {
  constructor() {
    this.peer = null;
    this.myPeerId = null;
    this.hostPeerId = null;
    this.userName = 'User_' + Math.random().toString(36).substring(2, 6);
    this.userColor = this.generateRandomColor();

    // Peer & Mesh Topology Collections
    this.connections = new Map();     // peerId -> DataConnection
    this.audioCalls = new Map();       // peerId -> MediaConnection
    this.members = new Map();          // peerId -> MemberData
    this.latencyMap = new Map();       // peerId -> Half-RTT (ms)
    this.timeOffsets = new Map();      // peerId -> Clock Offset (ms)
    this.seenPacketIds = new Set();    // Packet Deduplication Cache

    // VoIP Stream Management
    this.localStream = null;
    this.isMicMuted = true;

    // Room Roles & Flow Control
    this.isHost = false;
    this.controlMode = 'HOST_ONLY';    // 'HOST_ONLY' | 'DEMOCRATIC'
    this.sharedQueue = [];

    // Playback Engine State Tracking
    this.lastKnownTime = 0;
    this.lastHostTime = 0;
    this.isApplyingSync = false;
    this.isLocalBuffering = false;
    this.remoteBufferingPeers = new Set();
    this.catchUpInterval = null;
    this.heartbeatInterval = null;

    // Emotes Physics & Canvas
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
  }

  generateRandomColor() {
    const colors = ['#00f2fe', '#ff0844', '#46d369', '#ffb703', '#9d4edd', '#ff007f', '#00e5ff', '#ff3366'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  generatePacketId() {
    return `${this.myPeerId || 'anon'}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
  // 1. CONNECTION & MESH NETWORK INITIALIZATION
  // ===============================================================
  startHosting() {
    // If already active as host on an existing peer ID, reuse it
    if (this.peer && !this.peer.destroyed && this.myPeerId && this.isHost) {
      const input = document.getElementById('partyMyPeerId');
      if (input) input.value = this.myPeerId;
      return;
    }
    const roomId = 'aniflix_' + Math.random().toString(36).substring(2, 9);
    this.initPeer(roomId, true);
  }

  joinRoom(targetHostId) {
    if (!targetHostId) return;
    const cleanTarget = targetHostId.trim();

    if (cleanTarget === this.myPeerId) {
      if (typeof showToast === 'function') {
        showToast('You cannot join your own room code.');
      }
      return;
    }

    this.isHost = false;
    this.hostPeerId = cleanTarget;

    // Cleanly reuse existing Peer connection if already open
    if (this.peer && !this.peer.destroyed && this.myPeerId) {
      this.connections.forEach(conn => conn.close());
      this.connections.clear();
      this.audioCalls.forEach(call => call.close());
      this.audioCalls.clear();

      this.members.clear();
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

      if (typeof showToast === 'function') {
        showToast('Connecting to Room Host...');
      }
    } else {
      this.initPeer(null, false, cleanTarget);
    }
  }

  initPeer(preferredId, asHost, targetHostId = null) {
    if (this.peer) {
      this.peer.removeAllListeners();
      if (!this.peer.destroyed) {
        this.peer.destroy();
      }
      this.peer = null;
    }

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
      if (input) input.value = id;

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
        showToast(asHost ? 'Party Room Ready! Share code with friends.' : 'Connecting to Room Host...');
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
        if (typeof showToast === 'function') showToast('Room host not found or session closed.');
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

      // Latency calibration handshake
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

        // Host synchronizes room state immediately to the newly joined peer
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
      }, 250);

      // Bridge voice mesh if local mic is unmuted
      if (!this.isMicMuted && this.localStream) {
        const call = this.peer.call(conn.peer, this.localStream);
        this.handleVoiceCallStream(call);
      }

      if (typeof showToast === 'function') {
        showToast('Participant connected to party');
      }
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

  cleanupPeerResources(peerId) {
    this.connections.delete(peerId);
    this.members.delete(peerId);
    this.latencyMap.delete(peerId);
    this.timeOffsets.delete(peerId);
    this.remoteBufferingPeers.delete(peerId);
    this.removeCursorElement(peerId);

    const audioElem = document.getElementById(`audio_${peerId}`);
    if (audioElem) audioElem.remove();

    if (this.audioCalls.has(peerId)) {
      this.audioCalls.get(peerId).close();
      this.audioCalls.delete(peerId);
    }

    if (peerId === this.hostPeerId) {
      this.handleHostFailover();
    } else if (this.isHost) {
      this.broadcastRoster();
    }

    this.renderRoster();
    if (typeof showToast === 'function') {
      showToast('A participant left the session');
    }
  }

  handleHostFailover() {
    const remainingPeers = Array.from(this.members.keys()).sort();
    if (remainingPeers.length === 0) return;

    const nextHostId = remainingPeers[0];
    this.hostPeerId = nextHostId;

    if (this.myPeerId === nextHostId) {
      this.isHost = true;
      const me = this.members.get(this.myPeerId);
      if (me) me.isHost = true;
      if (typeof showToast === 'function') {
        showToast('Room host disconnected. You are now the host!');
      }
      this.broadcastRoster();
    } else {
      const newHost = this.members.get(nextHostId);
      if (newHost) newHost.isHost = true;
      if (typeof showToast === 'function') {
        showToast(`Host transferred to ${newHost ? newHost.name : 'peer'}`);
      }
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
    }, 5000);
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
        conn.send(data);
      }
    });
  }

  handleIncomingData(data, conn) {
    if (!data || !data.type) return;

    // Deduplication check
    if (data.packetId) {
      if (this.seenPacketIds.has(data.packetId)) return;
      this.seenPacketIds.add(data.packetId);
    }

    // Host Mesh Re-broadcast Relay
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
          showToast(`Control Mode set to: ${this.controlMode}`);
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

  broadcastMemberList() {
    this.broadcastRoster();
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
  // 4. BUFFER SYNC (SMART AUTO-PAUSE & RESUME)
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

  // ===============================================================
  // 5. AFK DRIFT CALIBRATOR & CATCH-UP SPEED ENGINE
  // ===============================================================
  checkDriftAndEvaluateCatchUp(localSeconds, hostSeconds) {
    this.lastKnownTime = localSeconds;
    this.lastHostTime = hostSeconds;

    const pill = document.getElementById('p2pCatchUpPill');
    const drift = hostSeconds - localSeconds;

    if (drift > 6 && !this.isHost) {
      if (pill) {
        pill.classList.add('visible');
        pill.innerText = `Catch Up (${Math.round(drift)}s behind) 1.5x`;
        pill.onclick = () => this.engageCatchUpSpeed();
      }
    } else if (drift <= 1.5) {
      if (pill) pill.classList.remove('visible');
    }
  }

  engageCatchUpSpeed() {
    const iframe = document.getElementById('streamFrame');
    iframe?.contentWindow?.postMessage({ type: 'SET_PLAYBACK_RATE', rate: 1.5 }, '*');
    if (typeof showToast === 'function') {
      showToast('Catch-up speed active (1.5x)');
    }

    if (this.catchUpInterval) clearInterval(this.catchUpInterval);

    this.catchUpInterval = setInterval(() => {
      if (Math.abs(this.lastKnownTime - this.lastHostTime) <= 1.2) {
        iframe?.contentWindow?.postMessage({ type: 'SET_PLAYBACK_RATE', rate: 1.0 }, '*');
        clearInterval(this.catchUpInterval);
        this.catchUpInterval = null;
        const pill = document.getElementById('p2pCatchUpPill');
        if (pill) pill.classList.remove('visible');
        if (typeof showToast === 'function') {
          showToast('Synchronized with watch party timeline');
        }
      }
    }, 1000);
  }

  // ===============================================================
  // 6. SERVERLESS VOIP VOICE CHAT (FULL-MESH WEBRTC)
  // ===============================================================
  async toggleMicrophone() {
    const micBtn = document.getElementById('p2pMicToggleBtn');

    if (this.isMicMuted) {
      try {
        if (!this.localStream) {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          });
        }
        this.localStream.getAudioTracks()[0].enabled = true;
        this.isMicMuted = false;

        this.connections.forEach((_, peerId) => {
          if (!this.audioCalls.has(peerId)) {
            const call = this.peer.call(peerId, this.localStream);
            this.handleVoiceCallStream(call);
          }
        });

        const myMember = this.members.get(this.myPeerId);
        if (myMember) myMember.isMicMuted = false;
        this.broadcastRoster();

        if (micBtn) {
          micBtn.innerHTML = '<i class="fas fa-microphone" style="color:var(--accent-emerald, #46d369);"></i> Mic On';
        }
        if (typeof showToast === 'function') {
          showToast('Voice Chat Connected');
        }
      } catch (e) {
        console.error('[WebRTC Audio Track Error]:', e);
        if (typeof showToast === 'function') {
          showToast('Microphone access denied or hardware busy');
        }
      }
    } else {
      if (this.localStream) {
        this.localStream.getAudioTracks()[0].enabled = false;
      }
      this.isMicMuted = true;

      const myMember = this.members.get(this.myPeerId);
      if (myMember) myMember.isMicMuted = true;
      this.broadcastRoster();

      if (micBtn) {
        micBtn.innerHTML = '<i class="fas fa-microphone-slash"></i> Mic Muted';
      }
      if (typeof showToast === 'function') {
        showToast('Microphone Muted');
      }
    }
    this.renderRoster();
  }

  handleIncomingVoiceCall(call) {
    if (this.localStream) {
      call.answer(this.localStream);
    } else {
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
      .then((stream) => {
        this.localStream = stream;
        if (this.isMicMuted) this.localStream.getAudioTracks()[0].enabled = false;
        call.answer(this.localStream);
      })
      .catch(() => {
        call.answer();
      });
    }
    this.handleVoiceCallStream(call);
  }

  handleVoiceCallStream(call) {
    this.audioCalls.set(call.peer, call);

    call.on('stream', (remoteStream) => {
      let audio = document.getElementById(`audio_${call.peer}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio_${call.peer}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = remoteStream;
      audio.play().catch(e => console.warn('[Audio AutoPlay Policy Intercept]:', e));
    });

    call.on('close', () => {
      const audio = document.getElementById(`audio_${call.peer}`);
      if (audio) audio.remove();
      this.audioCalls.delete(call.peer);
    });

    call.on('error', (err) => {
      console.warn('[VoIP Call Error]:', err);
      const audio = document.getElementById(`audio_${call.peer}`);
      if (audio) audio.remove();
      this.audioCalls.delete(call.peer);
    });
  }

  // ===============================================================
  // 7. MULTIPLAYER VIRTUAL CURSORS
  // ===============================================================
  setupCursorTracking() {
    window.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - this.lastMouseBroadcast > 40 && this.connections.size > 0) {
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
      cursor.style.cssText = 'position:fixed; top:0; left:0; pointer-events:none; z-index:99999; will-change:transform; transition:transform 0.08s linear;';
      cursor.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="${data.color}" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5));">
          <path d="M4 0l16 12.279-6.951 1.17 4.325 8.817-3.596 1.734-4.35-8.879-5.428 5.879z"/>
        </svg>
        <span class="p2p-cursor-tag" style="background:${data.color}; color:#000; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; margin-left:8px; vertical-align:top; white-space:nowrap; box-shadow:0 2px 4px rgba(0,0,0,0.4);">${data.name}</span>
      `;
      layer.appendChild(cursor);
    }

    cursor.style.transform = `translate3d(${data.x * window.innerWidth}px, ${data.y * window.innerHeight}px, 0)`;
  }

  removeCursorElement(peerId) {
    document.getElementById(`cursor_${peerId}`)?.remove();
  }

  // ===============================================================
  // 8. CANVAS EMOTE PHYSICS ENGINE
  // ===============================================================
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
    const originX = window.innerWidth - 70;
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
        x: x + (Math.random() * 40 - 20),
        y: y,
        vx: (Math.random() - 0.5) * 6,
        vy: -(Math.random() * 5 + 6),
        alpha: 1.0,
        scale: Math.random() * 0.5 + 0.8,
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
      p.vy += 0.15;
      p.alpha -= 0.015;

      this.ctx.save();
      this.ctx.globalAlpha = Math.max(p.alpha, 0);
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(p.rotation);
      this.ctx.font = `${Math.round(28 * p.scale)}px sans-serif`;
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
  // 9. LIVE CHAT & ROSTER UI
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
          ${member.isHost ? '<i class="fas fa-crown" style="color:var(--accent-gold, #ffb703); font-size:10px; margin-left:4px;"></i>' : ''}
        </div>
        <div>
          ${member.isMicMuted ? '<i class="fas fa-microphone-slash" style="color:var(--text-muted, #71717a); font-size:11px;"></i>' : '<i class="fas fa-microphone" style="color:var(--accent-emerald, #46d369); font-size:11px;"></i>'}
        </div>
      `;
      container.appendChild(row);
    });
  }

  // ===============================================================
  // 10. SYNCED AUDIO BOOSTER
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

    label.innerText = `The party host activated an audio gain boost (${Math.round(level * 100)}%). Apply to your session?`;
    card.classList.add('visible');

    document.getElementById('p2pAcceptBoostBtn').onclick = () => {
      if (typeof toggleAudioVolumeBooster === 'function') {
        currentAudioGainLevel = level;
        if (typeof gainNode !== 'undefined' && gainNode && typeof audioCtx !== 'undefined' && audioCtx) {
          gainNode.gain.setValueAtTime(level, audioCtx.currentTime);
        }
        const lbl = document.getElementById('audioBoosterLabel');
        if (lbl) lbl.innerText = `${Math.round(level * 100)}% Volume`;
        if (typeof showToast === 'function') {
          showToast(`Synced Volume: ${Math.round(level * 100)}%`);
        }
      }
      card.classList.remove('visible');
    };

    document.getElementById('p2pDeclineBoostBtn').onclick = () => {
      card.classList.remove('visible');
    };
  }

  // ===============================================================
  // 11. PASS THE REMOTE & SHARED QUEUE
  // ===============================================================
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
    if (typeof showToast === 'function') {
      showToast('Added title to Watch Party queue');
    }
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
      el.style.cssText = 'display:flex; align-items:center; justify-content:space-between; font-size:12px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);';
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
// 12. GLOBAL WINDOW HOOKS FOR HTML ONCLICK BUTTONS
// ===============================================================
function openWatchPartyModal(skipUrlSync = false) {
  const modal = document.getElementById('watchPartyModal');
  const overlay = document.getElementById('watchPartyOverlay');
  if (!modal || !overlay) return;

  modal.style.display = 'flex';
  overlay.classList.add('active');
  document.documentElement.style.overflowY = 'hidden';

  // Initialize hosting session only if peer is not already connected
  if (window.p2pParty && !window.p2pParty.myPeerId) {
    window.p2pParty.startHosting();
  } else {
    const input = document.getElementById('partyMyPeerId');
    if (input && window.p2pParty.myPeerId) {
      input.value = window.p2pParty.myPeerId;
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
  if (input?.value && input.value !== 'Generating...' && !input.value.includes('Click Host')) {
    navigator.clipboard.writeText(input.value);
    if (typeof showToast === 'function') {
      showToast('Room Code copied to clipboard!');
    }
  } else {
    if (window.p2pParty) {
      window.p2pParty.startHosting();
    }
  }
}
window.copyWatchPartyCode = copyWatchPartyCode;

function joinWatchPartyRoom() {
  const input = document.getElementById('partyJoinInput');
  const hostId = input?.value?.trim();
  if (!hostId) {
    if (typeof showToast === 'function') {
      showToast('Please enter a valid host room code.');
    }
    return;
  }
  if (window.p2pParty) {
    window.p2pParty.joinRoom(hostId);
    closeWatchPartyModal();
  }
}
window.joinWatchPartyRoom = joinWatchPartyRoom;

// ===============================================================
// 13. IFRAME POSTMESSAGE EVENT LISTENER
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
