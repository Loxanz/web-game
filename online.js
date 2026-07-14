/**
 * Online multiplayer — WebSocket (local npm start) or PeerJS P2P (Vercel / static hosts)
 */

(function () {
  let ws = null;
  let connected = false;
  let clientId = null;
  let inLobby = false;
  let lastLobby = null;
  let intentionalClose = false;
  let transport = null; // 'ws' | 'p2p'

  // P2P (PeerJS) — host runs UnoEngine, guests sync over data channel
  let peer = null;
  let isHost = false;
  let roomCode = null;
  let hostConn = null;
  /** @type {Map<string, import('peerjs').DataConnection>} */
  let guestConns = new Map();
  let p2pPlayers = [];
  let p2pGame = null;
  let p2pStatus = 'idle';

  const el = {
    menu: () => document.getElementById('online-menu'),
    lobby: () => document.getElementById('online-lobby'),
    status: () => document.getElementById('online-status'),
    lobbyHint: () => document.getElementById('lobby-hint'),
    lobbyCode: () => document.getElementById('lobby-code'),
    lobbyPlayers: () => document.getElementById('lobby-players'),
    btnStart: () => document.getElementById('btn-online-start'),
    name: () => document.getElementById('online-player-name'),
    joinCode: () => document.getElementById('online-join-code')
  };

  function isStaticHost() {
    const h = location.hostname;
    return (
      h.endsWith('github.io')
      || h.endsWith('vercel.app')
      || h.endsWith('netlify.app')
      || h.endsWith('pages.dev')
    );
  }

  function wsUrl() {
    if (typeof window.UNO_WS_URL === 'string' && window.UNO_WS_URL.trim()) {
      return window.UNO_WS_URL.trim().replace(/\/$/, '');
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const isLiveServer = location.port === '5500' || location.port === '5501';
    if (isStaticHost()) return null;
    const host = isLiveServer ? `${location.hostname}:3000` : location.host;
    return `${proto}//${host}`;
  }

  function useP2P() {
    return !wsUrl();
  }

  function engine() {
    return window.UnoEngine;
  }

  function setStatus(text, isError = false) {
    const s = el.status();
    if (!s) return;
    s.textContent = text || '';
    s.classList.toggle('error', !!isError);
  }

  function setLobbyHint(text) {
    const h = el.lobbyHint();
    if (h) h.textContent = text || '';
  }

  function showMenu() {
    el.menu()?.classList.remove('hidden');
    el.lobby()?.classList.add('hidden');
    inLobby = false;
    const nameInput = el.name();
    if (nameInput && window.CharacterSystem) {
      nameInput.value = CharacterSystem.getPlayerName();
    }
    setStatus(useP2P()
      ? 'Ready — create or join a room (works on this site)'
      : '');
  }

  function showLobby() {
    el.menu()?.classList.add('hidden');
    el.lobby()?.classList.remove('hidden');
    inLobby = true;
  }

  function renderLobby(data) {
    lastLobby = data;
    showLobby();
    const codeEl = el.lobbyCode();
    if (codeEl) codeEl.textContent = data.code;

    const list = el.lobbyPlayers();
    if (list) {
      list.innerHTML = '';
      data.players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'lobby-player-row';
        const avatar = document.createElement('div');
        avatar.className = 'character-avatar avatar-sm';
        if (window.CharacterSystem) {
          CharacterSystem.mountCharacter(avatar, p.avatar || { color: '#4361ee' }, 36, p.name);
        }
        const name = document.createElement('span');
        name.className = 'lobby-player-name';
        name.textContent = p.name + (p.isHost ? ' (Host)' : '');
        row.appendChild(avatar);
        row.appendChild(name);
        list.appendChild(row);
      });
    }

    const startBtn = el.btnStart();
    if (startBtn) {
      startBtn.classList.toggle('hidden', !data.youAreHost);
      startBtn.disabled = data.players.length < 2;
    }

    if (data.youAreHost) {
      setLobbyHint(data.players.length < 2
        ? 'Waiting for at least 1 more player…'
        : `Ready to start with ${data.players.length} players (humans only).`);
    } else {
      setLobbyHint('Waiting for host to start…');
    }
  }

  function handleServer(msg) {
    switch (msg.type) {
      case 'welcome':
        clientId = msg.id;
        break;

      case 'lobby':
        renderLobby(msg);
        setStatus('');
        break;

      case 'gameStart':
      case 'state':
        if (msg.view && window.OnlineGame) {
          OnlineGame.applyView(msg.view, msg.event || null);
        }
        break;

      case 'gameOver':
        if (window.OnlineGame?.showMessage && msg.winner) {
          OnlineGame.showMessage(`${msg.winner} wins!`);
        }
        break;

      case 'error':
        setStatus(msg.message || 'Error', true);
        if (window.OnlineGame?.showMessage) OnlineGame.showMessage(msg.message);
        break;

      case 'left':
        showMenu();
        break;

      default:
        break;
    }

    if (msg.view) lastStateView = msg.view;
  }

  let lastStateView = null;

  // ===== WebSocket path (npm start / custom UNO_WS_URL) =====

  function sendWs(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    setStatus('Not connected to server. Run: npm start', true);
    return false;
  }

  function ensureWsConnected() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      const url = wsUrl();
      if (!url) {
        reject(new Error('no-server'));
        return;
      }

      intentionalClose = false;
      transport = 'ws';
      setStatus('Connecting…');

      try {
        ws = new WebSocket(url);
      } catch (err) {
        setStatus('Connection failed', true);
        reject(err);
        return;
      }

      const timeout = setTimeout(() => {
        setStatus('Connection timed out', true);
        try { ws.close(); } catch (_) { /* */ }
        reject(new Error('timeout'));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        connected = true;
        setStatus('Connected');
        resolve();
      };

      ws.onmessage = ev => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        handleServer(msg);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        setStatus('Connection failed', true);
      };

      ws.onclose = () => {
        connected = false;
        clearTimeout(timeout);
        if (!intentionalClose) setStatus('Disconnected from server', true);
        ws = null;
      };
    });
  }

  // ===== PeerJS P2P path (Vercel / GitHub Pages) =====

  function makeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function peerIdForCode(code) {
    return `uno${String(code).toLowerCase()}`;
  }

  function destroyPeer() {
    guestConns.forEach(c => {
      try { c.close(); } catch (_) { /* */ }
    });
    guestConns.clear();
    if (hostConn) {
      try { hostConn.close(); } catch (_) { /* */ }
      hostConn = null;
    }
    if (peer) {
      try { peer.destroy(); } catch (_) { /* */ }
      peer = null;
    }
    p2pPlayers = [];
    p2pGame = null;
    p2pStatus = 'idle';
    isHost = false;
    roomCode = null;
  }

  function sendToConn(conn, msg) {
    if (conn && conn.open) {
      conn.send(msg);
      return true;
    }
    return false;
  }

  function broadcastP2P(msg, exceptId = null) {
    guestConns.forEach((conn, id) => {
      if (id === exceptId) return;
      sendToConn(conn, msg);
    });
  }

  function lobbyPayloadFor(forId) {
    return {
      type: 'lobby',
      code: roomCode,
      hostId: p2pPlayers[0]?.id,
      youAreHost: forId === p2pPlayers[0]?.id,
      status: p2pStatus,
      players: p2pPlayers.map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isHost: p.id === p2pPlayers[0]?.id
      }))
    };
  }

  function pushLobbyAll() {
    const hostLobby = lobbyPayloadFor(clientId);
    renderLobby(hostLobby);
    p2pPlayers.forEach(p => {
      if (p.id === clientId) return;
      const conn = guestConns.get(p.id);
      sendToConn(conn, lobbyPayloadFor(p.id));
    });
  }

  function afterP2PAction(result) {
    if (!result?.ok || !p2pGame) return;
    const eng = engine();
    p2pPlayers.forEach(p => {
      const view = eng.publicView(p2pGame, p.id);
      const msg = {
        type: 'state',
        event: result.event || null,
        view
      };
      if (p.id === clientId) {
        handleServer(msg);
      } else {
        sendToConn(guestConns.get(p.id), msg);
      }
    });

    if (p2pGame.phase === 'game_over') {
      const winner = p2pGame.winner;
      const winnerIndex = p2pGame.winnerIndex;
      const over = { type: 'gameOver', winner, winnerIndex };
      handleServer(over);
      broadcastP2P(over);
      p2pStatus = 'lobby';
      p2pGame = null;
      setTimeout(() => pushLobbyAll(), 800);
    }
  }

  function replyTo(playerId, msg) {
    if (playerId === clientId) {
      handleServer(msg);
      return;
    }
    sendToConn(guestConns.get(playerId), msg);
  }

  function hostHandleGuestMessage(fromId, msg) {
    const eng = engine();
    if (!eng) return;

    switch (msg.type) {
      case 'join': {
        if (p2pStatus !== 'lobby') {
          replyTo(fromId, { type: 'error', message: 'Game already started' });
          return;
        }
        if (p2pPlayers.length >= 4) {
          replyTo(fromId, { type: 'error', message: 'Room is full' });
          return;
        }
        if (p2pPlayers.some(p => p.id === fromId)) return;
        const name = String(msg.name || 'Player').trim().slice(0, 12) || 'Player';
        const avatar = msg.avatar || { color: '#35a846' };
        p2pPlayers.push({ id: fromId, name, avatar });
        replyTo(fromId, { type: 'welcome', id: fromId });
        pushLobbyAll();
        break;
      }

      case 'play': {
        if (!p2pGame || p2pStatus !== 'playing') return;
        const seat = p2pGame.players.findIndex(p => p.clientId === fromId);
        if (seat < 0) return;
        const result = eng.playCard(p2pGame, seat, msg.cardId, msg.color || null);
        if (!result.ok) {
          replyTo(fromId, { type: 'error', message: result.error || 'Illegal play' });
          return;
        }
        if (result.needsColor) {
          p2pPlayers.forEach(p => {
            const view = eng.publicView(p2pGame, p.id);
            replyTo(p.id, { type: 'state', event: { kind: 'chooseColor' }, view });
          });
          return;
        }
        afterP2PAction(result);
        break;
      }

      case 'draw': {
        if (!p2pGame || p2pStatus !== 'playing') return;
        const seat = p2pGame.players.findIndex(p => p.clientId === fromId);
        if (seat < 0) return;
        const result = eng.drawAction(p2pGame, seat);
        if (!result.ok) {
          replyTo(fromId, { type: 'error', message: result.error || 'Cannot draw' });
          return;
        }
        afterP2PAction(result);
        break;
      }

      case 'color': {
        if (!p2pGame) return;
        const seat = p2pGame.players.findIndex(p => p.clientId === fromId);
        if (seat < 0) return;
        const result = eng.chooseColor(p2pGame, seat, msg.color);
        if (!result.ok) {
          replyTo(fromId, { type: 'error', message: result.error || 'Invalid color' });
          return;
        }
        afterP2PAction(result);
        break;
      }

      case 'uno': {
        if (!p2pGame) return;
        const seat = p2pGame.players.findIndex(p => p.clientId === fromId);
        if (seat < 0) return;
        const result = eng.callUno(p2pGame, seat);
        if (result.ok) afterP2PAction({ ok: true, event: { kind: 'uno' } });
        break;
      }

      case 'leave': {
        removeP2PPlayer(fromId);
        break;
      }

      default:
        break;
    }
  }

  function removeP2PPlayer(id) {
    const eng = engine();
    const idx = p2pPlayers.findIndex(p => p.id === id);
    if (idx === -1) return;
    const leaving = p2pPlayers[idx];
    guestConns.get(id)?.close();
    guestConns.delete(id);

    if (p2pStatus === 'playing' && p2pGame && eng) {
      const result = eng.markDisconnected(p2pGame, id);
      p2pPlayers.splice(idx, 1);
      if (p2pPlayers.length === 0) {
        destroyPeer();
        showMenu();
        return;
      }
      if (result?.win || p2pGame.phase === 'game_over') {
        afterP2PAction({ ok: true, win: true, event: p2pGame.lastEvent });
        return;
      }
      afterP2PAction({ ok: true, event: { kind: 'playerLeft', name: leaving.name } });
      return;
    }

    p2pPlayers.splice(idx, 1);
    if (p2pPlayers.length === 0) {
      destroyPeer();
      showMenu();
      return;
    }
    pushLobbyAll();
  }

  function wireGuestConn(conn) {
    conn.on('data', data => {
      if (!data || typeof data !== 'object') return;
      hostHandleGuestMessage(conn.peer, data);
    });
    conn.on('close', () => {
      if (isHost) removeP2PPlayer(conn.peer);
    });
    conn.on('error', () => {
      if (isHost) removeP2PPlayer(conn.peer);
    });
  }

  function createPeer(id) {
    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') {
        reject(new Error('PeerJS missing'));
        return;
      }
      const opts = { debug: 0 };
      const p = id ? new Peer(id, opts) : new Peer(opts);
      const failTimer = setTimeout(() => {
        try { p.destroy(); } catch (_) { /* */ }
        reject(new Error('PeerJS timeout'));
      }, 12000);

      p.on('open', openId => {
        clearTimeout(failTimer);
        resolve({ peer: p, id: openId });
      });
      p.on('error', err => {
        clearTimeout(failTimer);
        reject(err);
      });
    });
  }

  async function p2pCreateRoom() {
    if (!engine()) {
      setStatus('Game engine failed to load. Redeploy and hard-refresh.', true);
      return;
    }
    if (typeof Peer === 'undefined') {
      setStatus('PeerJS failed to load. Check your network / ad blocker.', true);
      return;
    }

    intentionalClose = false;
    transport = 'p2p';
    setStatus('Creating room…');
    destroyPeer();

    let code = makeCode();
    let created = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      code = makeCode();
      try {
        created = await createPeer(peerIdForCode(code));
        break;
      } catch {
        created = null;
      }
    }
    if (!created) {
      setStatus('Could not create room. Try again.', true);
      return;
    }

    peer = created.peer;
    clientId = created.id;
    isHost = true;
    roomCode = code;
    p2pStatus = 'lobby';
    connected = true;

    const name = (el.name()?.value || 'Player').trim().slice(0, 12) || 'Player';
    if (window.CharacterSystem) {
      CharacterSystem.syncPlayerName(name);
      CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
    }
    const avatar = window.CharacterSystem
      ? CharacterSystem.getActiveCharacter()
      : { color: '#4361ee' };

    p2pPlayers = [{ id: clientId, name, avatar }];

    peer.on('connection', conn => {
      guestConns.set(conn.peer, conn);
      wireGuestConn(conn);
    });

    peer.on('disconnected', () => {
      if (!intentionalClose) setStatus('Connection lost — refreshing…', true);
    });
    peer.on('close', () => {
      if (!intentionalClose) {
        connected = false;
        setStatus('Room closed', true);
      }
    });

    setStatus('');
    pushLobbyAll();
  }

  async function p2pJoinRoom() {
    if (!engine()) {
      setStatus('Game engine failed to load. Redeploy and hard-refresh.', true);
      return;
    }
    if (typeof Peer === 'undefined') {
      setStatus('PeerJS failed to load. Check your network / ad blocker.', true);
      return;
    }

    const code = (el.joinCode()?.value || '').toUpperCase().trim();
    if (!code || code.length < 4) {
      setStatus('Enter a 4-character room code', true);
      return;
    }

    intentionalClose = false;
    transport = 'p2p';
    setStatus('Joining room…');
    destroyPeer();

    let created;
    try {
      created = await createPeer();
    } catch {
      setStatus('Could not connect. Try again.', true);
      return;
    }

    peer = created.peer;
    clientId = created.id;
    isHost = false;
    roomCode = code;
    connected = true;

    const name = (el.name()?.value || 'Player').trim().slice(0, 12) || 'Player';
    if (window.CharacterSystem) {
      CharacterSystem.syncPlayerName(name);
      CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
    }
    const avatar = window.CharacterSystem
      ? CharacterSystem.getActiveCharacter()
      : { color: '#35a846' };

    const remoteId = peerIdForCode(code);
    const conn = peer.connect(remoteId, { reliable: true });
    hostConn = conn;

    const openTimeout = setTimeout(() => {
      setStatus('Room not found or host offline', true);
      try { conn.close(); } catch (_) { /* */ }
    }, 10000);

    conn.on('open', () => {
      clearTimeout(openTimeout);
      setStatus('');
      conn.send({ type: 'join', name, avatar });
    });

    conn.on('data', data => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'welcome') clientId = data.id || clientId;
      handleServer(data);
    });

    conn.on('close', () => {
      if (!intentionalClose) {
        setStatus('Disconnected from host', true);
        connected = false;
        showMenu();
      }
    });

    conn.on('error', () => {
      clearTimeout(openTimeout);
      setStatus('Could not join room', true);
    });
  }

  function p2pStartGame() {
    if (!isHost || p2pStatus !== 'lobby') return;
    const eng = engine();
    if (!eng) return;
    if (p2pPlayers.length < 2) {
      setStatus('Need at least 2 players', true);
      return;
    }

    const seats = p2pPlayers.map(p => ({
      name: p.name,
      avatar: p.avatar,
      clientId: p.id,
      isBot: false
    }));

    try {
      p2pGame = eng.createGame(seats);
    } catch (err) {
      setStatus(err.message || 'Could not start', true);
      return;
    }

    p2pStatus = 'playing';
    p2pPlayers.forEach(p => {
      const view = eng.publicView(p2pGame, p.id);
      const msg = { type: 'gameStart', view };
      if (p.id === clientId) handleServer(msg);
      else sendToConn(guestConns.get(p.id), msg);
    });
  }

  function send(msg) {
    if (transport === 'p2p') {
      if (isHost) {
        // Host applies own actions through the same handler
        hostHandleGuestMessage(clientId, msg);
        return true;
      }
      if (hostConn && hostConn.open) {
        hostConn.send(msg);
        return true;
      }
      setStatus('Not connected to host', true);
      return false;
    }
    return sendWs(msg);
  }

  async function createRoom() {
    if (useP2P()) {
      await p2pCreateRoom();
      return;
    }
    try {
      await ensureWsConnected();
    } catch {
      return;
    }
    const name = (el.name()?.value || 'Player').trim().slice(0, 12) || 'Player';
    if (window.CharacterSystem) {
      CharacterSystem.syncPlayerName(name);
      CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
    }
    sendWs({
      type: 'create',
      name,
      avatar: window.CharacterSystem ? CharacterSystem.getActiveCharacter() : { color: '#4361ee' }
    });
  }

  async function joinRoom() {
    if (useP2P()) {
      await p2pJoinRoom();
      return;
    }
    const code = (el.joinCode()?.value || '').toUpperCase().trim();
    if (!code || code.length < 4) {
      setStatus('Enter a 4-character room code', true);
      return;
    }
    try {
      await ensureWsConnected();
    } catch {
      return;
    }
    const name = (el.name()?.value || 'Player').trim().slice(0, 12) || 'Player';
    if (window.CharacterSystem) {
      CharacterSystem.syncPlayerName(name);
      CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
    }
    sendWs({
      type: 'join',
      code,
      name,
      avatar: window.CharacterSystem ? CharacterSystem.getActiveCharacter() : { color: '#35a846' }
    });
  }

  function startGame() {
    if (transport === 'p2p') {
      p2pStartGame();
      return;
    }
    sendWs({ type: 'start' });
  }

  function leaveQuiet() {
    intentionalClose = true;
    if (transport === 'p2p') {
      if (!isHost && hostConn?.open) {
        try { hostConn.send({ type: 'leave' }); } catch (_) { /* */ }
      }
      destroyPeer();
      connected = false;
      inLobby = false;
      lastLobby = null;
      transport = null;
      if (window.OnlineGame) OnlineGame.setOffline();
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'leave' })); } catch (_) { /* */ }
      try { ws.close(); } catch (_) { /* */ }
    }
    ws = null;
    connected = false;
    inLobby = false;
    lastLobby = null;
    transport = null;
    if (window.OnlineGame) OnlineGame.setOffline();
  }

  function leave() {
    leaveQuiet();
    showMenu();
    setStatus('');
    if (window.OnlineGame) OnlineGame.goHome();
  }

  function returnToLobby() {
    if (window.OnlineGame) OnlineGame.hideWinScreen();
    if (lastLobby) {
      renderLobby(lastLobby);
    } else {
      showMenu();
    }
    window.OnlineGame?.showScreen('online');
    if (window.OnlineGame) OnlineGame.setOffline();
    setLobbyHint('Back in lobby — host can start another game.');
  }

  document.getElementById('btn-online-create')?.addEventListener('click', () => { void createRoom(); });
  document.getElementById('btn-online-join')?.addEventListener('click', () => { void joinRoom(); });
  document.getElementById('btn-online-start')?.addEventListener('click', startGame);
  document.getElementById('btn-online-leave')?.addEventListener('click', leave);

  document.getElementById('online-join-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  document.getElementById('online-join-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') void joinRoom();
  });

  document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
    const code = el.lobbyCode()?.textContent;
    if (!code || code === '----') return;
    try {
      await navigator.clipboard.writeText(code);
      setLobbyHint('Code copied!');
    } catch {
      setLobbyHint(`Code: ${code}`);
    }
  });

  window.OnlineClient = {
    showMenu,
    leaveQuiet,
    leave,
    returnToLobby,
    sendPlay(cardId, color) {
      send({ type: 'play', cardId, color: color || undefined });
    },
    sendDraw() {
      send({ type: 'draw' });
    },
    sendColor(color) {
      send({ type: 'color', color });
    },
    sendUno() {
      send({ type: 'uno' });
    },
    isActive() {
      return connected && !!window.OnlineGame?.isOnline();
    }
  };
})();
