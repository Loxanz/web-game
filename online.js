/**
 * Online multiplayer client — connects to same-origin WebSocket server
 */

(function () {
  let ws = null;
  let connected = false;
  let clientId = null;
  let inLobby = false;
  let lastLobby = null;
  let reconnectTimer = null;
  let intentionalClose = false;

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
    // Optional remote server after deploy, e.g.:
    // window.UNO_WS_URL = 'wss://your-app.up.railway.app';
    if (typeof window.UNO_WS_URL === 'string' && window.UNO_WS_URL.trim()) {
      return window.UNO_WS_URL.trim().replace(/\/$/, '');
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Same host as page (works with npm start on :3000)
    // If opened via Live Server (:5500), fall back to localhost:3000
    const isLiveServer = location.port === '5500' || location.port === '5501';
    if (isStaticHost()) {
      return null;
    }
    const host = isLiveServer ? `${location.hostname}:3000` : location.host;
    return `${proto}//${host}`;
  }

  function staticHostHint() {
    return 'This site is static-only (Vercel can’t host WebSockets). Deploy the Node server (npm start) to Railway/Render, then set window.UNO_WS_URL in config.js to your wss://… URL. Or play locally: npm start → http://localhost:3000';
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
    if (isStaticHost() && !window.UNO_WS_URL) {
      setStatus(staticHostHint(), true);
    } else {
      setStatus('');
    }
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

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    setStatus('Not connected to server. Run: npm start', true);
    return false;
  }

  function ensureConnected() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      const url = wsUrl();
      if (!url) {
        setStatus(staticHostHint(), true);
        reject(new Error('no-server'));
        return;
      }

      intentionalClose = false;
      setStatus('Connecting…');

      try {
        ws = new WebSocket(url);
      } catch (err) {
        setStatus(staticHostHint(), true);
        reject(err);
        return;
      }

      const timeout = setTimeout(() => {
        setStatus('Connection timed out. Run npm start and open http://localhost:3000', true);
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
        if (isStaticHost() && !window.UNO_WS_URL) {
          setStatus(staticHostHint(), true);
        } else if (isStaticHost()) {
          setStatus('Could not reach game server. Check window.UNO_WS_URL in config.js (use wss://…).', true);
        } else {
          setStatus('Connection failed. Run npm start and open http://localhost:3000', true);
        }
      };

      ws.onclose = () => {
        connected = false;
        clearTimeout(timeout);
        if (!intentionalClose) {
          if (isStaticHost() && !window.UNO_WS_URL) {
            setStatus(staticHostHint(), true);
          } else if (isStaticHost()) {
            setStatus('Disconnected — game server unreachable. Check UNO_WS_URL / that the server is running.', true);
          } else {
            setStatus('Disconnected from server', true);
          }
        }
        ws = null;
      };
    });
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
        // Win screen already shown via last state; after delay lobby updates
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

  async function createRoom() {
    try {
      await ensureConnected();
    } catch {
      return;
    }
    const name = (el.name()?.value || 'Player').trim().slice(0, 12) || 'Player';
    if (window.CharacterSystem) {
      CharacterSystem.syncPlayerName(name);
      CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
    }
    send({
      type: 'create',
      name,
      avatar: window.CharacterSystem ? CharacterSystem.getActiveCharacter() : { color: '#4361ee' }
    });
  }

  async function joinRoom() {
    const code = (el.joinCode()?.value || '').toUpperCase().trim();
    if (!code || code.length < 4) {
      setStatus('Enter a 4-character room code', true);
      return;
    }
    try {
      await ensureConnected();
    } catch {
      return;
    }
    const name = (el.name()?.value || 'Player').trim().slice(0, 12) || 'Player';
    if (window.CharacterSystem) {
      CharacterSystem.syncPlayerName(name);
      CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
    }
    send({
      type: 'join',
      code,
      name,
      avatar: window.CharacterSystem ? CharacterSystem.getActiveCharacter() : { color: '#35a846' }
    });
  }

  function startGame() {
    send({ type: 'start' });
  }

  function leaveQuiet() {
    intentionalClose = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'leave' })); } catch (_) { /* */ }
      try { ws.close(); } catch (_) { /* */ }
    }
    ws = null;
    connected = false;
    inLobby = false;
    lastLobby = null;
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

  // Wire lobby buttons
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
