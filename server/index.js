/**
 * UNO Online — Express + WebSocket server (authoritative rooms)
 * Run: npm install && npm start
 * Open: http://localhost:3000
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const engine = require('./game-engine');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

const app = express();
app.use(express.static(ROOT));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<WebSocket, { id: string, roomCode: string|null }>} */
const clients = new Map();

let clientSeq = 0;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastRoom(room, msg, exceptId = null) {
  for (const p of room.players) {
    if (!p.ws || p.id === exceptId) continue;
    send(p.ws, msg);
  }
}

function lobbySnapshot(room, forClientId) {
  return {
    type: 'lobby',
    code: room.code,
    hostId: room.hostId,
    youAreHost: room.hostId === forClientId,
    status: room.status,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.id === room.hostId
    }))
  };
}

function broadcastLobby(room) {
  for (const p of room.players) {
    if (p.ws) send(p.ws, lobbySnapshot(room, p.id));
  }
}

function broadcastGame(room, event = null) {
  if (!room.game) return;
  for (const p of room.players) {
    if (!p.ws) continue;
    const view = engine.publicView(room.game, p.id);
    send(p.ws, { type: 'state', event, view });
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runBotLoop(room) {
  if (!room.game || room.status !== 'playing' || room.botBusy) return;
  room.botBusy = true;
  try {
    while (room.game && room.status === 'playing' && room.game.phase !== 'game_over') {
      const cur = room.game.players[room.game.currentPlayer];
      if (!cur || !cur.isBot) break;

      await delay(900 + Math.random() * 500);
      if (!room.game || room.status !== 'playing') break;

      const still = room.game.players[room.game.currentPlayer];
      if (!still || !still.isBot) break;

      engine.runBotTurn(room.game);
      broadcastGame(room, { kind: 'bot' });

      if (room.game.phase === 'game_over') {
        const winner = room.game.winner;
        const winnerIndex = room.game.winnerIndex;
        broadcastRoom(room, {
          type: 'gameOver',
          winner,
          winnerIndex
        });
        room.status = 'lobby';
        room.game = null;
        setTimeout(() => broadcastLobby(room), 800);
        break;
      }
      await delay(350);
    }
  } finally {
    room.botBusy = false;
  }
}

function startGame(room) {
  if (room.status === 'playing') return { error: 'Game already in progress' };
  if (room.players.length < 2) {
    return { error: 'Need at least 2 players to start' };
  }

  const seats = room.players.map(p => ({
    name: p.name,
    avatar: p.avatar,
    clientId: p.id,
    isBot: false
  }));

  room.game = engine.createGame(seats);
  room.status = 'playing';
  room.botBusy = false;

  for (const p of room.players) {
    if (!p.ws) continue;
    const view = engine.publicView(room.game, p.id);
    send(p.ws, { type: 'gameStart', view });
  }

  setTimeout(() => runBotLoop(room), 400);
  return { ok: true };
}

function findPlayer(room, clientId) {
  return room.players.find(p => p.id === clientId);
}

function leaveRoom(ws) {
  const meta = clients.get(ws);
  if (!meta?.roomCode) return;
  const room = rooms.get(meta.roomCode);
  meta.roomCode = null;
  if (!room) return;

  const idx = room.players.findIndex(p => p.id === meta.id);
  if (idx === -1) return;

  const leaving = room.players[idx];

  if (room.status === 'playing' && room.game) {
    // Convert leaver to bot mid-game
    const gp = room.game.players.find(p => p.clientId === meta.id);
    if (gp) {
      gp.isBot = true;
      gp.isHuman = false;
      gp.clientId = null;
      gp.name = gp.name.startsWith('(AI)') ? gp.name : `(AI) ${gp.name}`;
    }
    room.players.splice(idx, 1);
    leaving.ws = null;

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    if (room.hostId === meta.id) {
      room.hostId = room.players[0].id;
    }

    broadcastLobby(room);
    broadcastGame(room, { kind: 'playerLeft', name: leaving.name });
    setTimeout(() => runBotLoop(room), 200);
    return;
  }

  room.players.splice(idx, 1);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === meta.id) {
    room.hostId = room.players[0].id;
  }
  broadcastLobby(room);
}

function seatIndexForClient(room, clientId) {
  if (!room.game) return -1;
  return room.game.players.findIndex(p => p.clientId === clientId);
}

function afterAction(room, result) {
  if (!result?.ok) return;
  broadcastGame(room, { kind: 'action' });

  if (room.game.phase === 'game_over') {
    const winner = room.game.winner;
    const winnerIndex = room.game.winnerIndex;
    broadcastRoom(room, {
      type: 'gameOver',
      winner,
      winnerIndex
    });
    room.status = 'lobby';
    room.game = null;
    setTimeout(() => broadcastLobby(room), 800);
    return;
  }

  setTimeout(() => runBotLoop(room), 200);
}

wss.on('connection', ws => {
  const id = `p${++clientSeq}`;
  clients.set(ws, { id, roomCode: null });
  send(ws, { type: 'welcome', id });

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: 'error', message: 'Invalid message' });
    }

    const meta = clients.get(ws);
    if (!meta) return;

    try {
      handleMessage(ws, meta, msg);
    } catch (err) {
      console.error(err);
      send(ws, { type: 'error', message: 'Server error' });
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

function handleMessage(ws, meta, msg) {
  switch (msg.type) {
    case 'create': {
      if (meta.roomCode) leaveRoom(ws);
      const code = makeCode();
      const name = String(msg.name || 'Player').trim().slice(0, 12) || 'Player';
      const avatar = msg.avatar || { color: '#4361ee' };
      const room = {
        code,
        hostId: meta.id,
        status: 'lobby',
        players: [{ id: meta.id, name, avatar, ws }],
        game: null,
        botBusy: false
      };
      rooms.set(code, room);
      meta.roomCode = code;
      send(ws, lobbySnapshot(room, meta.id));
      break;
    }

    case 'join': {
      if (meta.roomCode) leaveRoom(ws);
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.status !== 'lobby') return send(ws, { type: 'error', message: 'Game already started' });
      if (room.players.length >= 4) return send(ws, { type: 'error', message: 'Room is full' });
      if (room.players.some(p => p.id === meta.id)) return;

      const name = String(msg.name || 'Player').trim().slice(0, 12) || 'Player';
      const avatar = msg.avatar || { color: '#35a846' };
      room.players.push({ id: meta.id, name, avatar, ws });
      meta.roomCode = code;
      broadcastLobby(room);
      break;
    }

    case 'start': {
      const room = rooms.get(meta.roomCode);
      if (!room) return send(ws, { type: 'error', message: 'Not in a room' });
      if (room.hostId !== meta.id) return send(ws, { type: 'error', message: 'Only host can start' });
      const res = startGame(room);
      if (res?.error) send(ws, { type: 'error', message: res.error });
      break;
    }

    case 'leave': {
      leaveRoom(ws);
      send(ws, { type: 'left' });
      break;
    }

    case 'play': {
      const room = rooms.get(meta.roomCode);
      if (!room?.game || room.status !== 'playing') {
        return send(ws, { type: 'error', message: 'No active game' });
      }
      const seat = seatIndexForClient(room, meta.id);
      if (seat < 0) return send(ws, { type: 'error', message: 'Not in this game' });
      const result = engine.playCard(room.game, seat, msg.cardId, msg.color || null);
      if (!result.ok) return send(ws, { type: 'error', message: result.error || 'Illegal play' });
      if (result.needsColor) {
        broadcastGame(room, { kind: 'chooseColor' });
        return;
      }
      afterAction(room, result);
      break;
    }

    case 'draw': {
      const room = rooms.get(meta.roomCode);
      if (!room?.game || room.status !== 'playing') {
        return send(ws, { type: 'error', message: 'No active game' });
      }
      const seat = seatIndexForClient(room, meta.id);
      if (seat < 0) return send(ws, { type: 'error', message: 'Not in this game' });
      const result = engine.drawAction(room.game, seat);
      if (!result.ok) return send(ws, { type: 'error', message: result.error || 'Cannot draw' });
      afterAction(room, result);
      break;
    }

    case 'color': {
      const room = rooms.get(meta.roomCode);
      if (!room?.game) return send(ws, { type: 'error', message: 'No active game' });
      const seat = seatIndexForClient(room, meta.id);
      if (seat < 0) return;
      const result = engine.chooseColor(room.game, seat, msg.color);
      if (!result.ok) return send(ws, { type: 'error', message: result.error || 'Invalid color' });
      afterAction(room, result);
      break;
    }

    case 'uno': {
      const room = rooms.get(meta.roomCode);
      if (!room?.game) return;
      const seat = seatIndexForClient(room, meta.id);
      if (seat < 0) return;
      const result = engine.callUno(room.game, seat);
      if (result.ok) broadcastGame(room, { kind: 'uno' });
      break;
    }

    default:
      send(ws, { type: 'error', message: 'Unknown message type' });
  }
}

server.listen(PORT, () => {
  console.log(`UNO Online running at http://localhost:${PORT}`);
  console.log('Open that URL in your browser (not Live Server) for multiplayer.');
});
