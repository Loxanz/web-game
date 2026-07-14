/**
 * UNO Card Game — Full implementation
 * Player vs 3 AI opponents
 */

const COLORS = ['red', 'yellow', 'green', 'blue'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const WILD_VALUES = ['wild', 'wild4'];
const BOT_NAMES = ['Alex', 'Sam', 'Jordan'];

let cardIdCounter = 0;
function uid() {
  return `card-${++cardIdCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

// ===== Deck =====

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

// ===== Game State =====

let state = null;
let botSessionActive = false;
let lastRenderedTopId = null;
let cardAnimActive = 0;
let turnScheduleTimer = null;
let humanActionLock = false;
let onlineMode = false;
let mySeat = 0;

const BOT_THINK_DELAY = 1400;
const BOT_THINK_STAGGER = 180;
const BOT_ANIM_DELAY = 580;
const TURN_HANDOFF_DELAY = 320;
const HUMAN_DRAW_ANIM_DELAY = 580;
const CARD_FLIGHT_MS = 580;
const CARD_DRAW_STAGGER = 110;

let pendingForceDraws = [];

// ===== Screen Navigation =====

const SCREENS = {
  home: 'home-screen',
  setup: 'setup-screen',
  character: 'character-screen',
  online: 'online-screen',
  game: 'game-screen'
};

function showScreen(name) {
  Object.values(SCREENS).forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
  document.getElementById(SCREENS[name]).classList.add('active');
}

function goHome() {
  if (onlineMode && window.OnlineClient) {
    window.OnlineClient.leaveQuiet();
  }
  onlineMode = false;
  mySeat = 0;
  botSessionActive = false;
  lastRenderedTopId = null;
  cardAnimActive = 0;
  humanActionLock = false;
  pendingForceDraws = [];
  lastOnlineEventKey = null;
  if (turnScheduleTimer) {
    clearTimeout(turnScheduleTimer);
    turnScheduleTimer = null;
  }
  cleanupFlyingCards();
  if (state) state.botThinking = null;
  state = null;
  hideWinScreen();
  hideColorModal();
  document.getElementById('rules-modal').classList.add('hidden');
  showScreen('home');
}

function createInitialState(playerName) {
  let deck = shuffle(createDeck());

  const players = [
    { name: playerName || 'You', hand: [], isHuman: true, unoCalled: false },
    ...BOT_NAMES.map(name => ({ name, hand: [], isHuman: false, unoCalled: false }))
  ];

  players.forEach(player => {
    player.character = player.isHuman
      ? { ...CharacterSystem.getActiveCharacter() }
      : CharacterSystem.loadCharacter(player.name, { asBot: true });
  });

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
  let pendingDraw = 0;
  let phase = 'playing';
  let drawnCard = null;
  let winner = null;
  let pendingWildCard = null;

  if (topCard.value === 'skip') {
    currentPlayer = nextPlayerIndex(0, direction, 4);
  } else if (topCard.value === 'reverse') {
    direction = -1;
  } else if (topCard.value === 'draw2') {
    for (let i = 0; i < 2; i++) {
      if (deck.length === 0) reshuffleFromDiscard(deck, discardPile);
      if (deck.length > 0) players[0].hand.push(deck.pop());
    }
    currentPlayer = nextPlayerIndex(0, direction, 4);
  }

  return {
    deck,
    discardPile,
    players,
    activeColor,
    currentPlayer,
    direction,
    pendingDraw,
    phase,
    drawnCard,
    winner,
    pendingWildCard,
    selectedCardId: null,
    message: ''
  };
}

function nextPlayerIndex(current, direction, count) {
  return ((current + direction) % count + count) % count;
}

// ===== Card Logic =====

function getTopCard() {
  return state.discardPile[state.discardPile.length - 1];
}

function canPlayCard(card, activeColor, topCard) {
  if (card.color === 'wild') return true;
  if (card.color === activeColor) return true;
  if (topCard.color !== 'wild' && card.value === topCard.value) return true;
  return false;
}

function hasMatchingColor(hand, color) {
  return hand.some(c => c.color === color);
}

function getPlayableCards(hand) {
  const top = getTopCard();
  return hand.filter(c => canPlayCard(c, state.activeColor, top));
}

function hasPlayableCard(hand) {
  return getPlayableCards(hand).length > 0;
}

// ===== Turn Management =====

function getCurrentPlayer() {
  return state.players[state.currentPlayer];
}

function advanceTurn() {
  state.currentPlayer = nextPlayerIndex(state.currentPlayer, state.direction, 4);
}

function skipNextPlayer() {
  advanceTurn();
  advanceTurn();
}

// ===== Play Card =====

function playCard(playerIndex, cardId, chosenColor = null, options = {}) {
  const { autoSchedule = true } = options;
  const player = state.players[playerIndex];
  const cardIndex = player.hand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return false;

  const card = player.hand[cardIndex];
  const top = getTopCard();

  if (!canPlayCard(card, state.activeColor, top)) return false;

  player.hand.splice(cardIndex, 1);
  state.discardPile.push(card);

  if (card.color === 'wild') {
    state.activeColor = chosenColor || pickBotColor(player.hand);
  } else {
    state.activeColor = card.color;
  }

  if (player.hand.length === 1 && !player.unoCalled) {
    scheduleUnoPenalty(playerIndex);
  }

  if (player.hand.length === 0) {
    state.winner = player;
    state.phase = 'game_over';
    botSessionActive = false;
    if (state) state.botThinking = null;
    if (autoSchedule) scheduleNextTurn(0);
    return true;
  }

  resolveCardEffect(card, playerIndex, autoSchedule);
  return true;
}

function scheduleUnoPenalty(playerIndex) {
  setTimeout(() => {
    if (state.phase === 'game_over') return;
    const player = state.players[playerIndex];
    if (player.hand.length === 1 && !player.unoCalled) {
      showMessage(`${player.name} forgot UNO! Draw 2.`);
      drawCards(player, 2);
      player.unoCalled = false;
      render();
    }
  }, 800);
}

function resolveCardEffect(card, playerIndex, autoSchedule = true) {
  const playerCount = 4;

  switch (card.value) {
    case 'skip':
      showMessage(`${state.players[playerIndex].name} played Skip!`);
      advanceTurn();
      advanceTurn();
      break;

    case 'reverse':
      state.direction *= -1;
      showMessage(`Direction reversed!`);
      updateDirectionUI();
      if (playerCount === 2) {
        skipNextPlayer();
      } else {
        advanceTurn();
      }
      break;

    case 'draw2':
      showMessage(`Draw Two!`);
      advanceTurn();
      forceDraw(state.currentPlayer, 2);
      advanceTurn();
      break;

    case 'wild':
      showMessage(`Wild! Color is ${state.activeColor}.`);
      advanceTurn();
      break;

    case 'wild4':
      showMessage(`Wild Draw Four! Color is ${state.activeColor}.`);
      advanceTurn();
      forceDraw(state.currentPlayer, 4);
      advanceTurn();
      break;

    default:
      advanceTurn();
  }

  state.phase = 'playing';
  state.drawnCard = null;
  if (autoSchedule) scheduleNextTurn();
}

function scheduleNextTurn(handoffMs = TURN_HANDOFF_DELAY) {
  if (!state) return;
  if (onlineMode) {
    render();
    updateHumanControls();
    return;
  }

  if (turnScheduleTimer) {
    clearTimeout(turnScheduleTimer);
    turnScheduleTimer = null;
  }

  if (state.phase === 'game_over') {
    turnScheduleTimer = setTimeout(() => {
      turnScheduleTimer = null;
      render();
      showWinScreen();
    }, Math.max(handoffMs, 200));
    return;
  }

  turnScheduleTimer = setTimeout(async () => {
    turnScheduleTimer = null;
    render();
    await processPendingForceDraws();
    render();

    const player = getCurrentPlayer();
    if (!player.isHuman) {
      setTimeout(() => runBotTurn(), 80);
    } else {
      updateHumanControls();
    }
  }, handoffMs);
}

function forceDraw(playerIndex, count) {
  pendingForceDraws.push({ playerIndex, count });
  showMessage(`${state.players[playerIndex].name} draws ${count} cards.`);
}

function drawCards(player, count) {
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0) reshuffleDeck();
    if (state.deck.length > 0) {
      player.hand.push(state.deck.pop());
    }
  }
}

function reshuffleDeck() {
  if (state.discardPile.length <= 1) return;
  const top = state.discardPile.pop();
  state.deck = shuffle(state.discardPile);
  state.discardPile = [top];
}

function reshuffleFromDiscard(deck, discardPile) {
  if (discardPile.length <= 1) return;
  const top = discardPile.pop();
  const recycled = shuffle(discardPile);
  discardPile.length = 0;
  discardPile.push(top);
  deck.push(...recycled);
}

// ===== Draw Action =====

function handleDraw(playerIndex) {
  const player = state.players[playerIndex];

  if (state.pendingDraw > 0) {
    pendingForceDraws.push({ playerIndex, count: state.pendingDraw });
    state.pendingDraw = 0;
    advanceTurn();
    state.phase = 'playing';
    scheduleNextTurn();
    return;
  }

  if (state.deck.length === 0) reshuffleDeck();
  if (state.deck.length === 0) {
    showMessage('No cards left to draw.');
    endTurnAfterDraw();
    return;
  }

  const card = state.deck.pop();
  player.hand.push(card);
  state.drawnCard = card;

  const top = getTopCard();
  if (canPlayCard(card, state.activeColor, top)) {
    if (player.isHuman) {
      state.phase = 'drawn_playable';
      showMessage('You drew a playable card! Play it or click deck to end turn.');
      render();
      return;
    }
    playCard(playerIndex, card.id, pickBotColor(player.hand));
    render();
    return;
  }

  showMessage(`${player.name} draws a card.`);
  endTurnAfterDraw();
}

async function handleHumanDrawClick() {
  if (!state || state.currentPlayer !== 0) return;
  if (humanActionLock || (!onlineMode && (botSessionActive || cardAnimActive > 0))) return;

  if (onlineMode) {
    if (state.phase !== 'playing' && state.phase !== 'drawn_playable') return;
    humanActionLock = true;
    try {
      if (state.phase === 'playing') await animateHumanDraw();
      if (window.OnlineClient) window.OnlineClient.sendDraw();
    } finally {
      humanActionLock = false;
    }
    return;
  }

  if (state.phase === 'drawn_playable') {
    endTurnAfterDraw();
    return;
  }
  if (state.phase !== 'playing') return;

  humanActionLock = true;
  try {
    await animateHumanDraw();
    handleDraw(0);
  } finally {
    humanActionLock = false;
  }
}

function endTurnAfterDraw() {
  state.drawnCard = null;
  state.phase = 'playing';
  advanceTurn();
  scheduleNextTurn();
}

// ===== UNO =====

function callUno(playerIndex) {
  if (onlineMode && playerIndex === 0) {
    if (window.OnlineClient) window.OnlineClient.sendUno();
    const player = state?.players?.[0];
    if (player && player.hand.length <= 2) {
      player.unoCalled = true;
      showMessage('UNO!');
      document.getElementById('btn-uno').disabled = true;
    }
    return;
  }

  const player = state.players[playerIndex];
  if (player.hand.length <= 2) {
    player.unoCalled = true;
    if (player.isHuman) {
      showMessage('UNO!');
      document.getElementById('btn-uno').disabled = true;
    }
  }
}

// ===== Bot AI =====

function pickBotColor(hand) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const card of hand) {
    if (COLORS.includes(card.color)) counts[card.color]++;
  }
  return COLORS.reduce((a, b) => counts[a] >= counts[b] ? a : b);
}

function botChooseCard(hand) {
  const playable = getPlayableCards(hand);
  if (playable.length === 0) return null;

  const top = getTopCard();

  const wild4 = playable.filter(c => c.value === 'wild4');
  if (wild4.length > 0 && hand.length <= 3) return wild4[0];

  const actionCards = playable.filter(c =>
    ['skip', 'reverse', 'draw2', 'wild'].includes(c.value)
  );
  if (actionCards.length > 0 && hand.length > 2) {
    const draw2 = actionCards.find(c => c.value === 'draw2');
    if (draw2) return draw2;
    const skip = actionCards.find(c => c.value === 'skip');
    if (skip) return skip;
    return actionCards[0];
  }

  const matchingColor = playable.filter(c => c.color === state.activeColor && c.color !== 'wild');
  if (matchingColor.length > 0) {
    return matchingColor.sort((a, b) => valuePriority(b.value) - valuePriority(a.value))[0];
  }

  const wild = playable.find(c => c.value === 'wild');
  if (wild) return wild;

  return playable[0];
}

function valuePriority(value) {
  if (value === 'wild4') return 20;
  if (value === 'wild') return 15;
  if (value === 'draw2') return 12;
  if (value === 'reverse') return 10;
  if (value === 'skip') return 10;
  return parseInt(value, 10) || 0;
}

function cleanupFlyingCards() {
  if (cardAnimActive > 0) return;
  document.querySelectorAll('.flying-card').forEach(el => el.remove());
  const fxLayer = document.getElementById('fx-layer');
  if (fxLayer) fxLayer.innerHTML = '';
}

function getFxContainer() {
  return document.getElementById('fx-layer') || document.body;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextFrame(count = 2) {
  return new Promise(resolve => {
    let n = 0;
    const step = () => (++n >= count ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

function waitForTransition(el, fallbackMs = BOT_ANIM_DELAY) {
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    el.addEventListener('transitionend', e => { if (e.target === el) done(); }, { once: true });
    setTimeout(done, fallbackMs + 80);
  });
}

function getCardRotate(el) {
  if (!el) return 0;
  const v = getComputedStyle(el).getPropertyValue('--card-rotate').trim();
  return parseFloat(v) || 0;
}

/**
 * Relative player index (0 = you) → DOM opponent slot (0=left, 1=top, 2=right).
 * Adapts for 2–4 player multiplayer rooms (no bots).
 */
function opponentDomSlot(playerIndex, playerCount = state?.players?.length || 4) {
  if (playerIndex <= 0) return null;
  if (playerCount === 2) return playerIndex === 1 ? 1 : null;
  if (playerCount === 3) {
    if (playerIndex === 1) return 0;
    if (playerIndex === 2) return 2;
    return null;
  }
  const seatMap = { 1: 0, 2: 1, 3: 2 };
  return seatMap[playerIndex] ?? null;
}

function getPlayerTargetEl(playerIndex) {
  if (playerIndex === 0) {
    return document.getElementById('player-hand') || document.querySelector('.player-tray');
  }
  const slot = opponentDomSlot(playerIndex);
  return slot == null ? null : document.getElementById(`opponent-${slot}`);
}

function pulseDrawPile() {
  const pile = document.getElementById('draw-pile');
  if (!pile) return;
  pile.classList.remove('draw-pile-pulse');
  void pile.offsetWidth;
  pile.classList.add('draw-pile-pulse');
}

function getCardDimensions() {
  const style = getComputedStyle(document.documentElement);
  return {
    w: parseFloat(style.getPropertyValue('--card-w')) || 72,
    h: parseFloat(style.getPropertyValue('--card-h')) || 108
  };
}

function rectCenter(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function getAnimAnchorEl(playerIndex) {
  if (playerIndex === 0) {
    return document.getElementById('player-hand') || document.querySelector('.player-tray');
  }
  const oppEl = getPlayerTargetEl(playerIndex);
  if (!oppEl) return null;
  return oppEl.querySelector('.opponent-avatar, [data-avatar]') || oppEl;
}

async function flyCardElement(cardEl, fromRect, toRect, options = {}) {
  const {
    duration = CARD_FLIGHT_MS,
    arcHeight = 42,
    fromScale = 0.9,
    toScale = 1,
    fromRotate = -8,
    toRotate = 4,
    fadeOut = true,
    cardW: optW,
    cardH: optH
  } = options;

  const defaults = getCardDimensions();
  const cardW = optW ?? defaults.w;
  const cardH = optH ?? defaults.h;

  cardAnimActive += 1;
  const fly = cardEl;
  fly.classList.add('flying-card');

  const from = rectCenter(fromRect);
  const to = rectCenter(toRect);

  fly.style.width = `${cardW}px`;
  fly.style.height = `${cardH}px`;
  fly.style.position = 'fixed';
  fly.style.margin = '0';
  fly.style.zIndex = '201';
  fly.style.left = `${from.x - cardW / 2}px`;
  fly.style.top = `${from.y - cardH / 2}px`;
  fly.style.transform = `scale(${fromScale}) rotate(${fromRotate}deg)`;

  getFxContainer().appendChild(fly);
  await nextFrame(2);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lift = Math.min(arcHeight, Math.abs(dx) * 0.12 + 28);

  const keyframes = [
    { transform: `scale(${fromScale}) rotate(${fromRotate}deg)`, offset: 0 },
    {
      transform: `translate(${dx * 0.52}px, ${dy * 0.48 - lift}px) scale(${(fromScale + toScale) / 2 + 0.04}) rotate(${(fromRotate + toRotate) / 2}deg)`,
      offset: 0.55
    },
    { transform: `translate(${dx}px, ${dy}px) scale(${toScale}) rotate(${toRotate}deg)`, offset: 1 }
  ];

  try {
    if (typeof fly.animate === 'function') {
      const anim = fly.animate(keyframes, {
        duration,
        easing: 'cubic-bezier(0.33, 1.08, 0.42, 1)',
        fill: 'forwards'
      });
      await anim.finished.catch(() => delay(duration));
    } else {
      fly.style.transition = `transform ${duration}ms cubic-bezier(0.33, 1.08, 0.42, 1)`;
      fly.style.transform = keyframes[2].transform;
      await waitForTransition(fly, duration);
    }

    if (fadeOut) {
      if (typeof fly.animate === 'function') {
        await fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).finished.catch(() => {});
      } else {
        fly.style.opacity = '0';
        await delay(140);
      }
    }
  } finally {
    fly.remove();
    cardAnimActive -= 1;
  }
}

async function processPendingForceDraws() {
  if (!pendingForceDraws.length) return;

  const batches = pendingForceDraws.splice(0);
  for (const { playerIndex, count } of batches) {
    for (let i = 0; i < count; i++) {
      if (!state) return;
      if (state.deck.length === 0) reshuffleDeck();
      if (state.deck.length === 0) break;
      await animateDrawFromDeck(playerIndex);
      state.players[playerIndex].hand.push(state.deck.pop());
      render();
      if (i < count - 1) await delay(CARD_DRAW_STAGGER);
    }
  }
}

async function animateDrawFromDeck(playerIndex) {
  pulseDrawPile();

  const drawEl = document.querySelector('#draw-pile .card-back') || document.getElementById('draw-pile');
  const targetEl = getAnimAnchorEl(playerIndex) || getPlayerTargetEl(playerIndex);
  if (!drawEl || !targetEl) {
    await delay(HUMAN_DRAW_ANIM_DELAY);
    return;
  }

  const { w, h } = getCardDimensions();
  const flyCard = createCardBackElement();
  const miniW = playerIndex === 0 ? w : Math.round(w * 0.72);
  const miniH = playerIndex === 0 ? h : Math.round(h * 0.72);

  await flyCardElement(flyCard, drawEl.getBoundingClientRect(), targetEl.getBoundingClientRect(), {
    duration: HUMAN_DRAW_ANIM_DELAY,
    arcHeight: 48,
    fromScale: 0.82,
    toScale: 1,
    fromRotate: -6,
    toRotate: playerIndex === 0 ? 6 : -8,
    cardW: miniW,
    cardH: miniH
  });
}

async function animatePlayToDiscard(card, sourceEl) {
  const discardEl = document.getElementById('top-card') || document.getElementById('discard-pile');
  if (!discardEl) {
    await delay(CARD_FLIGHT_MS);
    return;
  }

  const handEl = document.getElementById('player-hand');
  const fromRect = sourceEl
    ? sourceEl.getBoundingClientRect()
    : (handEl || document.querySelector('.player-tray')).getBoundingClientRect();
  const toRect = discardEl.getBoundingClientRect();
  const flyCard = createCardElement(card);
  const fromRotate = getCardRotate(sourceEl);

  await flyCardElement(flyCard, fromRect, toRect, {
    duration: CARD_FLIGHT_MS,
    arcHeight: 52,
    fromScale: 1,
    toScale: 1,
    fromRotate,
    toRotate: 0
  });
}

function botThinkDelay(playerIndex) {
  return BOT_THINK_DELAY + (playerIndex * BOT_THINK_STAGGER);
}

async function animateBotPlay(playerIndex, card) {
  const anchorEl = getAnimAnchorEl(playerIndex);
  const discardEl = document.getElementById('top-card') || document.getElementById('discard-pile');
  if (!anchorEl || !discardEl) {
    await delay(BOT_ANIM_DELAY);
    return;
  }

  const flyCard = createCardElement(card);
  await flyCardElement(flyCard, anchorEl.getBoundingClientRect(), discardEl.getBoundingClientRect(), {
    duration: BOT_ANIM_DELAY,
    arcHeight: 44,
    fromScale: 0.78,
    toScale: 1,
    fromRotate: -12,
    toRotate: 2
  });
}

async function animateBotDraw(playerIndex) {
  await animateDrawFromDeck(playerIndex);
}

async function animateHumanDraw() {
  await animateDrawFromDeck(0);
}

async function runBotTurn() {
  if (!state || state.phase === 'game_over' || botSessionActive) return;

  const turnOwner = state.currentPlayer;
  const player = state.players[turnOwner];
  if (player.isHuman) return;

  botSessionActive = true;
  state.botThinking = turnOwner;
  render();

  try {
    await delay(botThinkDelay(turnOwner));

    if (!state || state.phase === 'game_over' || state.currentPlayer !== turnOwner) return;

    const bot = state.players[turnOwner];
    state.botThinking = null;
    render();

    if (bot.hand.length <= 2) callUno(turnOwner);

    const chosen = botChooseCard(bot.hand);

    if (chosen) {
      showMessage(`${bot.name} plays a card`);
      await animateBotPlay(turnOwner, chosen);

      if (!state || state.phase === 'game_over' || state.currentPlayer !== turnOwner) return;

      const color = chosen.color === 'wild' ? pickBotColor(bot.hand) : null;
      const played = playCard(turnOwner, chosen.id, color, { autoSchedule: false });

      if (!played) {
        showMessage(`${bot.name} couldn't play — passing`);
        advanceTurn();
        scheduleNextTurn();
        return;
      }

      render();
      if (state.phase === 'game_over') {
        scheduleNextTurn(400);
      } else {
        scheduleNextTurn();
      }
      return;
    }

    showMessage(`${bot.name} draws a card`);
    await animateBotDraw(turnOwner);

    if (!state || state.phase === 'game_over') return;

    if (state.deck.length === 0) reshuffleDeck();
    if (state.deck.length === 0) {
      showMessage(`${bot.name} passes`);
      advanceTurn();
      scheduleNextTurn();
      return;
    }

    const drawn = state.deck.pop();
    bot.hand.push(drawn);
    state.drawnCard = drawn;
    render();

    await delay(650);

    if (!state || state.phase === 'game_over' || state.currentPlayer !== turnOwner) {
      scheduleNextTurn();
      return;
    }

    const top = getTopCard();
    if (canPlayCard(drawn, state.activeColor, top)) {
      showMessage(`${bot.name} plays the drawn card`);
      await animateBotPlay(turnOwner, drawn);

      if (!state || state.phase === 'game_over' || state.currentPlayer !== turnOwner) return;

      state.drawnCard = null;
      const color = drawn.color === 'wild' ? pickBotColor(bot.hand) : null;
      const played = playCard(turnOwner, drawn.id, color, { autoSchedule: false });

      if (!played) {
        advanceTurn();
        scheduleNextTurn();
        return;
      }

      render();
      if (state.phase === 'game_over') {
        scheduleNextTurn(400);
      } else {
        scheduleNextTurn();
      }
      return;
    }

    state.drawnCard = null;
    showMessage(`${bot.name} passes`);
    advanceTurn();
    scheduleNextTurn();
  } finally {
    botSessionActive = false;
    if (state && state.botThinking === turnOwner) {
      state.botThinking = null;
    }
  }
}

// ===== Human Actions =====

async function handleHumanPlay(cardId) {
  if (!state) return;
  if (humanActionLock || (!onlineMode && (botSessionActive || cardAnimActive > 0))) return;
  if (state.phase !== 'playing' && state.phase !== 'drawn_playable') return;
  if (state.currentPlayer !== 0) return;

  const player = state.players[0];
  const card = player.hand.find(c => c.id === cardId);
  if (!card) return;

  const top = getTopCard();
  if (!canPlayCard(card, state.activeColor, top)) return;

  if (card.color === 'wild') {
    state.pendingWildCard = card;
    state.phase = 'awaiting_color';
    showColorModal();
    return;
  }

  if (player.hand.length === 2 && !player.unoCalled) {
    showMessage('Call UNO before playing your last card!');
    return;
  }

  humanActionLock = true;
  const sourceEl = document.querySelector(`#player-hand .card[data-id="${cardId}"]`);
  if (sourceEl) sourceEl.classList.add('card-leaving');

  try {
    await animatePlayToDiscard(card, sourceEl);
    if (onlineMode) {
      if (window.OnlineClient) window.OnlineClient.sendPlay(cardId, null);
    } else {
      playCard(0, cardId);
      render();
    }
  } finally {
    humanActionLock = false;
  }
}

async function handleColorChoice(color) {
  hideColorModal();
  if (!state?.pendingWildCard) return;
  if (humanActionLock || (!onlineMode && (botSessionActive || cardAnimActive > 0))) return;

  const card = state.pendingWildCard;
  state.pendingWildCard = null;

  if (state.players[0].hand.length === 2 && !state.players[0].unoCalled) {
    showMessage('Call UNO before playing your last card!');
    state.phase = 'playing';
    return;
  }

  humanActionLock = true;
  const sourceEl = document.querySelector(`#player-hand .card[data-id="${card.id}"]`);
  if (sourceEl) sourceEl.classList.add('card-leaving');

  try {
    await animatePlayToDiscard(card, sourceEl);
    if (onlineMode) {
      state.phase = 'playing';
      if (window.OnlineClient) window.OnlineClient.sendPlay(card.id, color);
    } else {
      playCard(0, card.id, color);
      render();
    }
  } finally {
    humanActionLock = false;
  }
}

function updateHumanControls() {
  if (!state) return;
  const isHumanTurn = state.currentPlayer === 0 && state.phase !== 'game_over';
  const player = state.players[0];
  const playable = isHumanTurn ? getPlayableCards(player.hand) : [];

  const btnUno = document.getElementById('btn-uno');
  const drawPile = document.getElementById('draw-pile');

  const canUseDrawPile = isHumanTurn && (state.phase === 'playing' || state.phase === 'drawn_playable');
  const mustDraw = isHumanTurn && state.phase === 'playing' && playable.length === 0;
  const canEndTurn = isHumanTurn && state.phase === 'drawn_playable';

  btnUno.disabled = !(isHumanTurn && player.hand.length <= 2 && !player.unoCalled);

  drawPile.classList.toggle('can-draw', canUseDrawPile);
  drawPile.classList.toggle('can-end-turn', canEndTurn);
  drawPile.title = canEndTurn
    ? 'Click to end your turn'
    : canUseDrawPile
      ? 'Click to draw a card'
      : 'Draw pile';

  const turnBadge = document.getElementById('turn-indicator');
  if (isHumanTurn) {
    if (canEndTurn) turnBadge.textContent = 'Play card or click deck to end turn';
    else if (mustDraw) turnBadge.textContent = 'Click deck to draw';
    else turnBadge.textContent = 'Your turn';
    turnBadge.classList.add('active');
  } else {
    const name = getCurrentPlayer()?.name || 'Player';
    turnBadge.textContent = `${name}'s turn`;
    turnBadge.classList.remove('active');
  }
}

// ===== Rendering =====

// ===== Classic UNO Card Rendering =====

const UNO_COLORS = { red: '#e8181e', blue: '#006bb6', green: '#35a846', yellow: '#f8d021' };

function cardFaceClass(card) {
  return card.color === 'wild' ? 'black' : card.color;
}

function isNum(v) { return /^[0-9]$/.test(v); }

function svgSkip() {
  return `<svg class="uno-icon icon-shadow" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="15" fill="#ffffff" stroke="#000" stroke-width="2"/>
    <line x1="11" y1="29" x2="29" y2="11" stroke="#000000" stroke-width="3.5" stroke-linecap="round"/>
  </svg>`;
}

function svgReverse() {
  return `<svg class="uno-icon icon-shadow" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M28 10 C18 10 14 16 14 20 C14 24 18 30 28 30" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
    <polygon points="24,6 32,10 24,14" fill="#ffffff" stroke="#000" stroke-width="0.5"/>
    <path d="M12 30 C22 30 26 24 26 20 C26 16 22 10 12 10" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
    <polygon points="16,34 8,30 16,26" fill="#ffffff" stroke="#000" stroke-width="0.5"/>
  </svg>`;
}

function cornerHTML(card) {
  const v = card.value;
  if (isNum(v)) return `<span class="uno-num">${v}</span>`;
  if (v === 'skip') return svgSkip();
  if (v === 'reverse') return svgReverse();
  if (v === 'draw2') return `<span class="uno-action-text">+2</span>`;
  if (v === 'wild') return `<span class="wild-dot"></span>`;
  if (v === 'wild4') return `<span class="uno-action-text">+4</span>`;
  return '';
}

function centerHTML(card) {
  const v = card.value;
  if (isNum(v)) return `<span class="uno-num">${v}</span>`;
  if (v === 'skip') return svgSkip();
  if (v === 'reverse') return svgReverse();
  if (v === 'draw2') return `<div class="draw2-stack"><div class="dc"></div><div class="dc"></div></div>`;
  if (v === 'wild') {
    return `<div class="wild-center">
      <div class="wild-swoosh"></div>
      <div class="wild-word">
        <span class="w-w">W</span><span class="w-i">I</span><span class="w-l">L</span><span class="w-d">D</span>
      </div>
    </div>`;
  }
  if (v === 'wild4') {
    return `<div class="wild4-stack"><div class="w4"></div><div class="w4"></div><div class="w4"></div><div class="w4"></div></div>`;
  }
  return '';
}

const FACE_COLORS = {
  red: '#e8181e',
  yellow: '#f8d021',
  green: '#35a846',
  blue: '#006bb6',
  black: '#111111'
};

function createCardElement(card, options = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  const face = cardFaceClass(card);

  el.innerHTML = `
    <div class="card-face ${face}">
      <div class="card-oval"></div>
      <div class="corner corner-tl">${cornerHTML(card)}</div>
      <div class="corner corner-br">${cornerHTML(card)}</div>
      <div class="card-center">${centerHTML(card)}</div>
    </div>`;

  const faceEl = el.querySelector('.card-face');
  if (faceEl) faceEl.style.backgroundColor = FACE_COLORS[face] || FACE_COLORS.black;

  if (options.playable) el.classList.add('playable');
  if (options.notPlayable) el.classList.add('not-playable');
  if (options.justDrawn) el.classList.add('just-drawn');
  if (options.clickable) el.addEventListener('click', () => { void handleHumanPlay(card.id); });
  return el;
}

function createCardBackElement() {
  const el = document.createElement('div');
  el.className = 'card card-back';
  el.innerHTML = `<div class="card-face"><span class="uno-logo-small">UNO</span></div>`;
  return el;
}

function render() {
  if (!state) return;
  if (cardAnimActive === 0 && !botSessionActive) cleanupFlyingCards();

  const top = getTopCard();
  const human = state.players[0];
  const isHumanTurn = state.currentPlayer === 0 && state.phase !== 'game_over' && state.phase !== 'awaiting_color';
  const playable = isHumanTurn ? getPlayableCards(human.hand) : [];
  const playableIds = new Set(playable.map(c => c.id));

  // Top card
  const topCardEl = document.getElementById('top-card');
  const newTop = createCardElement(top);

  const topChanged = top.id !== lastRenderedTopId;
  if (topChanged) {
    newTop.classList.add('play-animation', 'discard-flash');
    lastRenderedTopId = top.id;
    setTimeout(() => newTop.classList.remove('discard-flash'), 450);
  }

  topCardEl.replaceWith(newTop);
  newTop.id = 'top-card';

  // Color badge
  const colorBadge = document.getElementById('current-color-badge');
  colorBadge.textContent = state.activeColor;
  colorBadge.className = `color-badge ${state.activeColor}`;

  // Opponents (2–4 seats; hide unused DOM slots in multiplayer)
  for (let i = 0; i < 3; i++) {
    const oppEl = document.getElementById(`opponent-${i}`);
    if (oppEl) oppEl.classList.add('hidden');
  }

  const playerCount = state.players.length;
  for (let rel = 1; rel < playerCount; rel++) {
    const player = state.players[rel];
    if (!player || player.disconnected) continue;

    const slot = opponentDomSlot(rel, playerCount);
    if (slot == null) continue;

    const oppEl = document.getElementById(`opponent-${slot}`);
    if (!oppEl) continue;
    oppEl.classList.remove('hidden');

    oppEl.querySelector('.opponent-name').textContent = player.name;
    oppEl.querySelector('.card-count').textContent = `${player.hand.length} card${player.hand.length !== 1 ? 's' : ''}`;
    oppEl.classList.toggle('active-turn', state.currentPlayer === rel);
    oppEl.classList.toggle('thinking', state.botThinking === rel);

    const avatarEl = oppEl.querySelector('[data-avatar]');
    if (avatarEl && player.character) {
      CharacterSystem.mountCharacter(avatarEl, player.character, 48, player.name);
    }

    const cardsContainer = oppEl.querySelector('.opponent-cards');
    cardsContainer.innerHTML = '';
    const showCount = Math.min(player.hand.length, 7);
    for (let j = 0; j < showCount; j++) {
      const mini = document.createElement('div');
      mini.className = 'mini-card';
      cardsContainer.appendChild(mini);
    }
    if (player.hand.length > 7) {
      const more = document.createElement('span');
      more.style.cssText = 'font-size:0.7rem;color:var(--text-muted);margin-left:4px';
      more.textContent = `+${player.hand.length - 7}`;
      cardsContainer.appendChild(more);
    }
  }

  // Player hand
  document.getElementById('player-display-name').textContent = human.name;
  document.getElementById('player-card-count').textContent =
    `${human.hand.length} card${human.hand.length !== 1 ? 's' : ''}`;

  const playerAvatar = document.getElementById('player-avatar');
  if (playerAvatar && human.character) {
    CharacterSystem.mountCharacter(playerAvatar, human.character, 48, human.name);
  }

  const playerTray = document.querySelector('.player-tray');
  if (playerTray) {
    playerTray.classList.toggle('player-active', isHumanTurn);
  }

  const handEl = document.getElementById('player-hand');
  handEl.innerHTML = '';

  const sortedHand = [...human.hand].sort((a, b) => {
    const colorOrder = [...COLORS, 'wild'];
    const ci = colorOrder.indexOf(a.color) - colorOrder.indexOf(b.color);
    if (ci !== 0) return ci;
    return valuePriority(b.value) - valuePriority(a.value);
  });

  const handCount = sortedHand.length;
  const overlapPx = handCount <= 1 ? 0 : Math.max(14, Math.min(22, Math.floor(115 / handCount)));
  const fanDeg = handCount <= 5 ? 2.8 : handCount <= 8 ? 2.4 : 2.0;
  handEl.style.setProperty('--card-overlap', `-${overlapPx}px`);

  for (let i = 0; i < sortedHand.length; i++) {
    const card = sortedHand[i];
    const canClick = isHumanTurn && (state.phase === 'playing' || state.phase === 'drawn_playable');
    const el = createCardElement(card, {
      playable: playableIds.has(card.id),
      notPlayable: canClick && !playableIds.has(card.id),
      justDrawn: state.drawnCard && state.drawnCard.id === card.id,
      clickable: canClick && playableIds.has(card.id)
    });

    const mid = (sortedHand.length - 1) / 2;
    const rotate = (i - mid) * fanDeg;
    el.style.setProperty('--card-rotate', `${rotate.toFixed(1)}deg`);
    el.style.setProperty('--card-z', String(i + 1));

    handEl.appendChild(el);
  }

  updateHumanControls();
  updateDirectionUI();
}

function updateDirectionUI() {
  const el = document.getElementById('direction-indicator');
  el.classList.toggle('reversed', state.direction === -1);
}

// ===== UI Helpers =====

let messageTimeout = null;

function showMessage(text) {
  const toast = document.getElementById('message-toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  toast.classList.add('visible');

  clearTimeout(messageTimeout);
  messageTimeout = setTimeout(() => {
    toast.classList.remove('visible');
    toast.classList.add('hidden');
  }, 2200);
}

function showColorModal() {
  document.getElementById('color-modal').classList.remove('hidden');
}

function hideColorModal() {
  document.getElementById('color-modal').classList.add('hidden');
}

function showWinScreen() {
  const winScreen = document.getElementById('win-screen');
  const isHumanWinner = state.winner.isHuman;

  document.getElementById('win-title').textContent = isHumanWinner ? 'You Win!' : `${state.winner.name} Wins!`;
  document.getElementById('win-message').textContent = isHumanWinner
    ? 'Congratulations! You emptied your hand first.'
    : 'Better luck next time!';

  const scoresEl = document.getElementById('final-scores');
  scoresEl.innerHTML = '';
  for (const player of state.players) {
    const row = document.createElement('div');
    row.className = 'score-row score-row-with-char' + (player === state.winner ? ' winner' : '');
    const pts = player.hand.reduce((sum, c) => sum + cardPoints(c), 0);
    const avatar = document.createElement('div');
    avatar.className = 'character-avatar avatar-sm';
    if (player.character) CharacterSystem.mountCharacter(avatar, player.character, 32, player.name);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name;
    const ptsSpan = document.createElement('span');
    ptsSpan.textContent = player === state.winner ? 'WINNER' : `${pts} pts left`;
    row.appendChild(avatar);
    row.appendChild(nameSpan);
    row.appendChild(ptsSpan);
    scoresEl.appendChild(row);
  }

  winScreen.classList.remove('hidden');
}

function hideWinScreen() {
  document.getElementById('win-screen').classList.add('hidden');
}

function startGame() {
  const name = CharacterSystem.getPlayerName();
  CharacterSystem.syncPlayerName(name);
  CharacterSystem.setActiveCharacter(CharacterSystem.loadCharacter(name));
  CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());

  cardIdCounter = 0;
  botSessionActive = false;
  lastRenderedTopId = null;
  cardAnimActive = 0;
  humanActionLock = false;
  pendingForceDraws = [];
  if (turnScheduleTimer) {
    clearTimeout(turnScheduleTimer);
    turnScheduleTimer = null;
  }
  cleanupFlyingCards();
  state = createInitialState(name);

  showScreen('game');
  hideWinScreen();

  const top = getTopCard();
  if (top.value === 'skip') showMessage('First card: Skip!');
  else if (top.value === 'reverse') showMessage('First card: Reverse!');
  else if (top.value === 'draw2') showMessage('First card: Draw Two!');
  else showMessage('Game started!');

  render();
  scheduleNextTurn();
}

function cardPoints(card) {
  if (card.value === 'wild' || card.value === 'wild4') return 50;
  if (['skip', 'reverse', 'draw2'].includes(card.value)) return 20;
  return parseInt(card.value, 10) || 0;
}

// ===== Event Listeners =====

document.getElementById('btn-play-computer').addEventListener('click', () => {
  CharacterSystem.syncPlayerName(CharacterSystem.getPlayerName());
  showScreen('setup');
});

document.getElementById('btn-customize-character').addEventListener('click', () => {
  showScreen('character');
  CharacterSystem.initCharacterCustomization();
});

document.getElementById('btn-back-character')?.addEventListener('click', () => {
  const name = CharacterSystem.getPlayerName();
  CharacterSystem.saveCharacter(name, CharacterSystem.getActiveCharacter());
  CharacterSystem.syncPlayerName(name);
  goHome();
});

document.getElementById('btn-play-online').addEventListener('click', () => {
  showScreen('online');
  if (window.OnlineClient) window.OnlineClient.showMenu();
});

document.getElementById('btn-back-setup').addEventListener('click', goHome);
document.getElementById('btn-back-online').addEventListener('click', () => {
  if (window.OnlineClient) window.OnlineClient.leaveQuiet();
  goHome();
});
document.getElementById('btn-home-from-win').addEventListener('click', goHome);

document.getElementById('btn-start').addEventListener('click', startGame);

document.getElementById('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') startGame();
});

document.getElementById('btn-new-game').addEventListener('click', () => {
  if (onlineMode && window.OnlineClient) {
    window.OnlineClient.leaveQuiet();
  }
  goHome();
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  hideWinScreen();
  if (onlineMode) {
    if (window.OnlineClient) window.OnlineClient.returnToLobby();
    return;
  }
  startGame();
});

document.getElementById('draw-pile').addEventListener('click', () => {
  handleHumanDrawClick();
});

document.getElementById('btn-uno').addEventListener('click', () => {
  callUno(0);
});

document.querySelectorAll('.color-option').forEach(btn => {
  btn.addEventListener('click', () => { void handleColorChoice(btn.dataset.color); });
});

document.getElementById('btn-rules').addEventListener('click', () => {
  document.getElementById('rules-modal').classList.remove('hidden');
});

document.getElementById('btn-close-rules').addEventListener('click', () => {
  document.getElementById('rules-modal').classList.add('hidden');
});

document.getElementById('rules-modal').addEventListener('click', e => {
  if (e.target.id === 'rules-modal') {
    document.getElementById('rules-modal').classList.add('hidden');
  }
});

document.getElementById('color-modal').addEventListener('click', e => {
  if (e.target.id === 'color-modal' && state) {
    hideColorModal();
    state.phase = 'playing';
    state.pendingWildCard = null;
  }
});

// ===== Online multiplayer bridge =====

let lastOnlineEventKey = null;
let onlineViewChain = Promise.resolve();

function applyOnlineView(view, event = null) {
  onlineViewChain = onlineViewChain
    .then(() => applyOnlineViewAsync(view, event))
    .catch(err => console.error('Online view apply failed', err));
}

async function applyOnlineViewAsync(view, event = null) {
  onlineMode = true;
  const n = view.playerCount || view.players?.length || 4;
  const you = view.youIndex >= 0 ? view.youIndex : 0;
  mySeat = you;

  botSessionActive = false;
  if (turnScheduleTimer) {
    clearTimeout(turnScheduleTimer);
    turnScheduleTimer = null;
  }

  const last = view.lastEvent || event;
  const eventKey = last && view.seq != null
    ? `${view.seq}:${last.kind}:${last.playerIndex}`
    : null;

  const canAnimate = !!(
    last
    && eventKey
    && eventKey !== lastOnlineEventKey
    && state
    && document.getElementById('game-screen')?.classList.contains('active')
  );

  // Same flights as vs-computer for remote players (and forced draws)
  if (canAnimate) {
    const rel = ((last.playerIndex - you) % n + n) % n;
    if (last.playerIndex !== you) {
      if (last.kind === 'play' && last.card) {
        const name = view.players[last.playerIndex]?.name || 'Opponent';
        showMessage(`${name} plays a card`);
        await animateBotPlay(rel, last.card);
      } else if (last.kind === 'draw') {
        const name = view.players[last.playerIndex]?.name || 'Opponent';
        showMessage(`${name} draws a card`);
        await animateBotDraw(rel);
      }
    }

    if (last.forceDraws?.length) {
      for (const fd of last.forceDraws) {
        const fdRel = ((fd.playerIndex - you) % n + n) % n;
        for (let i = 0; i < (fd.count || 0); i++) {
          await animateDrawFromDeck(fdRel);
          if (i < fd.count - 1) await delay(CARD_DRAW_STAGGER);
        }
      }
    }
  }
  if (eventKey) lastOnlineEventKey = eventKey;

  humanActionLock = false;

  const players = [];
  for (let i = 0; i < n; i++) {
    const src = view.players[(you + i) % n];
    const isMe = i === 0;
    players.push({
      name: src.name,
      hand: isMe
        ? (src.hand || []).map(c => ({ ...c }))
        : Array.from({ length: src.cardCount }, (_, j) => ({
            id: `hid-${i}-${j}-${src.cardCount}`,
            color: 'wild',
            value: 'wild'
          })),
      isHuman: isMe,
      isBot: false,
      disconnected: !!src.disconnected,
      unoCalled: !!src.unoCalled,
      character: src.character || { color: '#4361ee' }
    });
  }

  const relativeCurrent = ((view.currentPlayer - you) % n + n) % n;
  let winner = null;
  if (view.phase === 'game_over' && view.winnerIndex != null) {
    winner = players[((view.winnerIndex - you) % n + n) % n];
  }

  const drawn = view.drawnCardId
    ? players[0].hand.find(c => c.id === view.drawnCardId) || null
    : null;

  state = {
    deck: Array(Math.max(0, view.deckCount || 0)).fill({ id: 'deck' }),
    discardPile: [view.topCard],
    players,
    activeColor: view.activeColor,
    currentPlayer: relativeCurrent,
    direction: view.direction,
    pendingDraw: 0,
    phase: view.phase,
    drawnCard: drawn,
    winner,
    pendingWildCard: state?.pendingWildCard || null,
    botThinking: null,
    selectedCardId: null,
    message: view.message || '',
    onlineSeq: view.seq
  };

  if (view.topCard?.id) lastRenderedTopId = view.topCard.id;

  showScreen('game');
  render();

  if (view.message) showMessage(view.message);

  if (view.pendingWild && view.phase === 'awaiting_color') {
    const wild = players[0].hand.find(c => c.color === 'wild');
    if (wild) {
      state.pendingWildCard = wild;
      showColorModal();
    }
  }

  if (view.phase === 'game_over' && winner) {
    showWinScreen();
  } else {
    hideWinScreen();
  }
}

window.OnlineGame = {
  applyView: applyOnlineView,
  isOnline: () => onlineMode,
  setOffline() {
    onlineMode = false;
    mySeat = 0;
    lastOnlineEventKey = null;
  },
  showScreen,
  goHome,
  hideWinScreen,
  showMessage,
  getPlayerName: () => CharacterSystem.getPlayerName(),
  getAvatar: () => CharacterSystem.getActiveCharacter()
};
