/**
 * UNO game engine (Node + browser). Scoped so it does not collide with game.js globals.
 */
(function (root) {
'use strict';

const COLORS = ['red', 'yellow', 'green', 'blue'];
const BOT_NAMES = ['Alex', 'Sam', 'Jordan'];

let cardIdCounter = 0;
function uid() {
  return `c${++cardIdCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: '0', id: uid() });
    for (let i = 1; i <= 9; i++) {
      deck.push({ color, value: String(i), id: uid() });
      deck.push({ color, value: String(i), id: uid() });
    }
    for (const special of ['skip', 'reverse', 'draw2']) {
      deck.push({ color, value: special, id: uid() });
      deck.push({ color, value: special, id: uid() });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild', id: uid() });
    deck.push({ color: 'wild', value: 'wild4', id: uid() });
  }
  return deck;
}

function shuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextPlayerIndex(current, direction, count) {
  return ((current + direction) % count + count) % count;
}

function hasMatchingColor(hand, color) {
  return hand.some(c => c.color === color);
}

function canPlayCard(state, card, playerIndex) {
  const top = state.discardPile[state.discardPile.length - 1];
  const activeColor = state.activeColor;
  if (card.color === 'wild') {
    if (card.value === 'wild4') {
      return !hasMatchingColor(state.players[playerIndex].hand, activeColor);
    }
    return true;
  }
  if (card.color === activeColor) return true;
  if (top.color !== 'wild' && card.value === top.value) return true;
  return false;
}

function getPlayableCards(state, hand, playerIndex) {
  return hand.filter(c => canPlayCard(state, c, playerIndex));
}

function pickBotColor(hand) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const card of hand) {
    if (COLORS.includes(card.color)) counts[card.color]++;
  }
  return COLORS.reduce((a, b) => (counts[a] >= counts[b] ? a : b));
}

function valuePriority(value) {
  if (value === 'wild4') return 20;
  if (value === 'wild') return 15;
  if (value === 'draw2') return 12;
  if (value === 'reverse' || value === 'skip') return 10;
  return parseInt(value, 10) || 0;
}

function botChooseCard(state, hand, playerIndex) {
  const playable = getPlayableCards(state, hand, playerIndex);
  if (playable.length === 0) return null;

  const wild4 = playable.filter(c => c.value === 'wild4');
  if (wild4.length > 0 && hand.length <= 3) return wild4[0];

  const actionCards = playable.filter(c =>
    ['skip', 'reverse', 'draw2', 'wild'].includes(c.value)
  );
  if (actionCards.length > 0 && hand.length > 2) {
    return actionCards.find(c => c.value === 'draw2')
      || actionCards.find(c => c.value === 'skip')
      || actionCards[0];
  }

  const matchingColor = playable.filter(c => c.color === state.activeColor && c.color !== 'wild');
  if (matchingColor.length > 0) {
    return matchingColor.sort((a, b) => valuePriority(b.value) - valuePriority(a.value))[0];
  }

  return playable.find(c => c.value === 'wild') || playable[0];
}

function reshuffleDeck(state) {
  if (state.discardPile.length <= 1) return;
  const top = state.discardPile.pop();
  state.deck = shuffle(state.discardPile);
  state.discardPile = [top];
}

function drawCards(state, player, count) {
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0) reshuffleDeck(state);
    if (state.deck.length > 0) player.hand.push(state.deck.pop());
  }
}

/**
 * Build initial game from lobby seats (humans only, 2–4 players).
 * seats: [{ name, avatar, clientId, isBot? }]
 */
function createGame(seats) {
  if (!seats || seats.length < 2 || seats.length > 4) {
    throw new Error('Need 2–4 players');
  }

  cardIdCounter = 0;
  let deck = shuffle(createDeck());
  const n = seats.length;

  const players = seats.map(s => ({
    name: s.name,
    hand: [],
    isHuman: true,
    isBot: false,
    disconnected: false,
    clientId: s.clientId || null,
    unoCalled: false,
    character: s.avatar || { color: '#4361ee' }
  }));

  for (let i = 0; i < 7; i++) {
    for (const player of players) {
      player.hand.push(deck.pop());
    }
  }

  let topCard = deck.pop();
  while (topCard.value === 'wild' || topCard.value === 'wild4') {
    deck.push(topCard);
    deck = shuffle(deck);
    topCard = deck.pop();
  }

  const discardPile = [topCard];
  let activeColor = topCard.color;
  let currentPlayer = 0;
  let direction = 1;
  let forceQueue = [];
  let message = 'Game started!';

  if (topCard.value === 'skip') {
    currentPlayer = nextPlayerIndex(0, direction, n);
    message = 'First card: Skip!';
  } else if (topCard.value === 'reverse') {
    direction = -1;
    if (n === 2) {
      currentPlayer = 0;
      message = 'First card: Reverse! (acts as Skip in 2-player)';
    } else {
      message = 'First card: Reverse!';
    }
  } else if (topCard.value === 'draw2') {
    drawCards({ deck, discardPile }, players[0], 2);
    currentPlayer = nextPlayerIndex(0, direction, n);
    message = 'First card: Draw Two!';
  }

  return {
    deck,
    discardPile,
    players,
    activeColor,
    currentPlayer,
    direction,
    phase: 'playing',
    drawnCard: null,
    winner: null,
    pendingWildCardId: null,
    forceQueue,
    message,
    seq: 0,
    lastEvent: null
  };
}

function seatCount(state) {
  return state.players.length;
}

function activeHumanCount(state) {
  return state.players.filter(p => !p.disconnected).length;
}

function advance(state) {
  const n = seatCount(state);
  let next = nextPlayerIndex(state.currentPlayer, state.direction, n);
  let guard = 0;
  while (state.players[next]?.disconnected && guard++ < n) {
    next = nextPlayerIndex(next, state.direction, n);
  }
  state.currentPlayer = next;
}

function checkSoleSurvivor(state) {
  const alive = state.players.filter(p => !p.disconnected);
  if (alive.length === 1) {
    const winnerIndex = state.players.indexOf(alive[0]);
    state.winnerIndex = winnerIndex;
    state.winner = alive[0].name;
    state.phase = 'game_over';
    state.message = `${alive[0].name} wins! (others left)`;
    return true;
  }
  return false;
}

function applyForceDraws(state) {
  while (state.forceQueue.length) {
    const { playerIndex, count } = state.forceQueue.shift();
    const player = state.players[playerIndex];
    drawCards(state, player, count);
  }
}

function resolveEffects(state, card, playerIndex) {
  const actor = state.players[playerIndex]?.name || 'Player';
  const n = seatCount(state);
  const forceEvents = [];

  switch (card.value) {
    case 'skip':
      advance(state);
      advance(state);
      state.message = `${actor} played Skip!`;
      break;
    case 'reverse':
      state.direction *= -1;
      state.message = n === 2 ? 'Reverse! (Skip in 2-player)' : 'Direction reversed!';
      if (n === 2) {
        advance(state);
        advance(state);
      } else {
        advance(state);
      }
      break;
    case 'draw2': {
      advance(state);
      const target = state.currentPlayer;
      state.forceQueue.push({ playerIndex: target, count: 2 });
      forceEvents.push({ playerIndex: target, count: 2 });
      state.message = `${state.players[target].name} draws 2 cards.`;
      advance(state);
      break;
    }
    case 'wild':
      state.message = `Wild! Color is ${state.activeColor}.`;
      advance(state);
      break;
    case 'wild4': {
      advance(state);
      const target = state.currentPlayer;
      state.forceQueue.push({ playerIndex: target, count: 4 });
      forceEvents.push({ playerIndex: target, count: 4 });
      state.message = `Wild +4! ${state.players[target].name} draws 4. Color is ${state.activeColor}.`;
      advance(state);
      break;
    }
    default:
      advance(state);
  }
  applyForceDraws(state);
  state.phase = 'playing';
  state.drawnCard = null;
  state.pendingWildCardId = null;
  return forceEvents;
}

function playCard(state, playerIndex, cardId, chosenColor = null) {
  if (state.phase === 'game_over') return { ok: false, error: 'Game over' };
  if (state.currentPlayer !== playerIndex) return { ok: false, error: 'Not your turn' };
  if (state.phase !== 'playing' && state.phase !== 'drawn_playable') {
    return { ok: false, error: 'Cannot play now' };
  }

  const player = state.players[playerIndex];
  const cardIndex = player.hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return { ok: false, error: 'Card not in hand' };

  const card = player.hand[cardIndex];
  if (!canPlayCard(state, card, playerIndex)) return { ok: false, error: 'Illegal play' };

  if (card.color === 'wild' && !chosenColor) {
    if (player.isBot) {
      chosenColor = pickBotColor(player.hand);
    } else {
      state.pendingWildCardId = cardId;
      state.phase = 'awaiting_color';
      state.message = 'Choose a color';
      state.seq++;
      return { ok: true, needsColor: true };
    }
  }

  if (player.hand.length === 2 && !player.unoCalled && !player.isBot) {
    // Allow play but flag — client should call UNO; soft penalty on next check
  }

  player.hand.splice(cardIndex, 1);
  state.discardPile.push(card);
  const playedCard = { ...card };

  if (card.color === 'wild') {
    state.activeColor = chosenColor || pickBotColor(player.hand);
  } else {
    state.activeColor = card.color;
  }

  if (player.hand.length === 1 && !player.unoCalled) {
    // Penalty applied on next play attempt cycle — mark for check
    state.unoPenaltySeat = playerIndex;
  } else {
    state.unoPenaltySeat = null;
  }

  if (player.hand.length === 0) {
    state.winnerIndex = playerIndex;
    state.winner = player.name;
    state.phase = 'game_over';
    state.message = `${player.name} wins!`;
    state.lastEvent = { kind: 'play', playerIndex, card: { ...playedCard }, win: true };
    state.seq++;
    return { ok: true, win: true, event: state.lastEvent };
  }

  const forceEvents = resolveEffects(state, playedCard, playerIndex);
  player.unoCalled = false;
  state.lastEvent = {
    kind: 'play',
    playerIndex,
    card: { ...playedCard },
    forceDraws: forceEvents
  };
  state.seq++;
  return { ok: true, event: state.lastEvent };
}

function callUno(state, playerIndex) {
  const player = state.players[playerIndex];
  if (player.hand.length <= 2) {
    player.unoCalled = true;
    state.message = `${player.name}: UNO!`;
    state.seq++;
    return { ok: true };
  }
  return { ok: false, error: 'Too many cards for UNO' };
}

function applyUnoPenaltyIfNeeded(state) {
  if (state.unoPenaltySeat == null) return;
  const idx = state.unoPenaltySeat;
  const player = state.players[idx];
  if (player.hand.length === 1 && !player.unoCalled) {
    drawCards(state, player, 2);
    state.message = `${player.name} forgot UNO! Draw 2.`;
  }
  state.unoPenaltySeat = null;
}

function drawAction(state, playerIndex) {
  if (state.phase === 'game_over') return { ok: false, error: 'Game over' };
  if (state.currentPlayer !== playerIndex) return { ok: false, error: 'Not your turn' };
  if (state.players[playerIndex]?.disconnected) return { ok: false, error: 'Disconnected' };

  if (state.phase === 'drawn_playable') {
    state.drawnCard = null;
    state.phase = 'playing';
    advance(state);
    applyForceDraws(state);
    state.message = `${state.players[playerIndex].name} ends turn`;
    state.lastEvent = { kind: 'endTurn', playerIndex };
    state.seq++;
    return { ok: true, ended: true, event: state.lastEvent };
  }

  if (state.phase !== 'playing') return { ok: false, error: 'Cannot draw now' };

  applyUnoPenaltyIfNeeded(state);

  if (state.deck.length === 0) reshuffleDeck(state);
  if (state.deck.length === 0) {
    advance(state);
    state.message = 'No cards left — pass';
    state.lastEvent = { kind: 'pass', playerIndex };
    state.seq++;
    return { ok: true, event: state.lastEvent };
  }

  const card = state.deck.pop();
  const player = state.players[playerIndex];
  player.hand.push(card);
  state.drawnCard = card;

  if (canPlayCard(state, card, playerIndex)) {
    state.phase = 'drawn_playable';
    state.message = 'Playable card drawn — play it or click deck to end turn';
    state.lastEvent = { kind: 'draw', playerIndex, count: 1, playable: true };
    state.seq++;
    return { ok: true, drawnPlayable: true, event: state.lastEvent };
  }

  state.drawnCard = null;
  state.phase = 'playing';
  advance(state);
  applyForceDraws(state);
  state.message = `${player.name} draws a card`;
  state.lastEvent = { kind: 'draw', playerIndex, count: 1, playable: false };
  state.seq++;
  return { ok: true, event: state.lastEvent };
}

function chooseColor(state, playerIndex, color) {
  if (state.phase !== 'awaiting_color') return { ok: false, error: 'Not choosing color' };
  if (state.currentPlayer !== playerIndex) return { ok: false, error: 'Not your turn' };
  if (!COLORS.includes(color)) return { ok: false, error: 'Invalid color' };
  if (!state.pendingWildCardId) return { ok: false, error: 'No wild pending' };

  const cardId = state.pendingWildCardId;
  state.pendingWildCardId = null;
  state.phase = 'playing';
  return playCard(state, playerIndex, cardId, color);
}

/** Public view for one client (hides other hands) */
function publicView(state, clientId) {
  const youIndex = state.players.findIndex(p => p.clientId === clientId && !p.disconnected);
  const fallbackYou = state.players.findIndex(p => p.clientId === clientId);
  const you = youIndex >= 0 ? youIndex : fallbackYou;
  return {
    seq: state.seq,
    playerCount: state.players.length,
    activeColor: state.activeColor,
    currentPlayer: state.currentPlayer,
    direction: state.direction,
    phase: state.phase,
    message: state.message,
    youIndex: you,
    winner: state.winner,
    winnerIndex: state.winnerIndex ?? null,
    topCard: state.discardPile[state.discardPile.length - 1],
    deckCount: state.deck.length,
    drawnCardId: state.drawnCard?.id || null,
    pendingWild: state.phase === 'awaiting_color' && state.currentPlayer === you,
    lastEvent: state.lastEvent,
    players: state.players.map((p, i) => ({
      name: p.name,
      isBot: false,
      isHuman: true,
      disconnected: !!p.disconnected,
      cardCount: p.hand.length,
      unoCalled: p.unoCalled,
      character: p.character,
      hand: i === you ? p.hand.map(c => ({ ...c })) : null
    }))
  };
}

function markDisconnected(state, clientId) {
  const p = state.players.find(pl => pl.clientId === clientId);
  if (!p) return { ok: false };
  p.disconnected = true;
  p.clientId = null;
  p.name = p.name.startsWith('(Left)') ? p.name : `(Left) ${p.name}`;

  if (checkSoleSurvivor(state)) {
    state.seq++;
    return { ok: true, win: true };
  }

  if (state.currentPlayer === state.players.indexOf(p)) {
    advance(state);
  }
  state.message = `${p.name.replace(/^\(Left\)\s*/, '')} left the game`;
  state.lastEvent = { kind: 'leave', name: p.name };
  state.seq++;
  return { ok: true };
}

function runBotTurn() {
  // Multiplayer is humans-only — no AI turns
  return { ok: false };
}

const UnoEngineAPI = {
  COLORS,
  createGame,
  playCard,
  drawAction,
  chooseColor,
  callUno,
  publicView,
  runBotTurn,
  canPlayCard,
  getPlayableCards,
  markDisconnected,
  checkSoleSurvivor,
  activeHumanCount
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = UnoEngineAPI;
}
root.UnoEngine = UnoEngineAPI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
