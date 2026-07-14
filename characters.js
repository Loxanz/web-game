/**
 * Simple avatar system (initial + color) — localStorage per player name
 */

const AVATAR_COLORS = [
  '#4361ee', '#e8181e', '#35a846', '#f8d021',
  '#7c3aed', '#ec4899', '#006bb6', '#64748b'
];

const BOT_AVATARS = {
  Alex:   { color: '#4361ee' },
  Sam:    { color: '#35a846' },
  Jordan: { color: '#e8181e' }
};

const DEFAULT_AVATAR = { color: '#4361ee' };

let activeAvatar = { ...DEFAULT_AVATAR };

function charStorageKey(name) {
  return `uno-char-${(name || 'guest').trim().toLowerCase().replace(/\s+/g, '-')}`;
}

function getPlayerNameInputs() {
  return [
    document.getElementById('player-name'),
    document.getElementById('customize-player-name')
  ].filter(Boolean);
}

function getPlayerName() {
  for (const input of getPlayerNameInputs()) {
    const v = input.value.trim();
    if (v) return v;
  }
  try {
    return localStorage.getItem('uno-player-name') || 'You';
  } catch (_) {
    return 'You';
  }
}

function syncPlayerName(name) {
  getPlayerNameInputs().forEach(input => { input.value = name; });
  try {
    localStorage.setItem('uno-player-name', name);
  } catch (_) { /* ignore */ }
}

function shadeColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function normalizeAvatar(data) {
  if (!data || typeof data !== 'object') return { ...DEFAULT_AVATAR };
  if (data.color) return { color: data.color };
  if (data.shirt) return { color: data.shirt };
  return { ...DEFAULT_AVATAR };
}

function loadCharacter(name, options = {}) {
  const { asBot = false } = options;
  if (asBot && BOT_AVATARS[name]) return { ...BOT_AVATARS[name] };
  try {
    const raw = localStorage.getItem(charStorageKey(name));
    if (raw) return normalizeAvatar(JSON.parse(raw));
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_AVATAR };
}

function saveCharacter(name, config) {
  try {
    localStorage.setItem(charStorageKey(name), JSON.stringify(normalizeAvatar(config)));
  } catch (_) { /* ignore */ }
}

function getInitial(name) {
  const trimmed = (name || '?').trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

function buildAvatarHTML(config, displayName) {
  const c = normalizeAvatar(config);
  const initial = getInitial(displayName);
  const dark = shadeColor(c.color, -30);
  return `<span class="avatar-badge" style="--avatar-bg:${c.color};--avatar-bg-dark:${dark}">${initial}</span>`;
}

function mountCharacter(el, config, size, displayName = '?') {
  if (!el) return;
  el.classList.add('character-avatar', 'avatar-only');
  el.innerHTML = buildAvatarHTML(config, displayName);
  if (size) {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
  }
  el.setAttribute('aria-label', `${displayName} avatar`);
}

function getActiveCharacter() {
  return { ...activeAvatar };
}

function setActiveCharacter(config, saveName = null) {
  activeAvatar = normalizeAvatar(config);
  if (saveName) saveCharacter(saveName, activeAvatar);
  return activeAvatar;
}

let charCustomizationReady = false;

function buildSwatchRow(container, key, colors) {
  if (!container || container.dataset.built) return;
  container.dataset.built = '1';
  container.dataset.charOption = key;
  colors.forEach(color => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'char-swatch';
    btn.dataset.value = color;
    btn.style.backgroundColor = color;
    btn.setAttribute('aria-label', `Avatar color ${color}`);
    container.appendChild(btn);
  });
}

function initCharacterCustomization() {
  const preview = document.getElementById('char-preview');
  if (!preview) return;

  buildSwatchRow(document.getElementById('char-color-row'), 'color', AVATAR_COLORS);

  const savedName = getPlayerName();
  syncPlayerName(savedName);

  function refreshFromName() {
    const name = getPlayerName();
    activeAvatar = loadCharacter(name);
    mountCharacter(preview, activeAvatar, 120, name);
    syncPickerUI();
  }

  function syncPickerUI() {
    document.querySelectorAll('[data-char-option]').forEach(row => {
      const key = row.dataset.charOption;
      row.querySelectorAll('[data-value]').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.value === activeAvatar[key]);
      });
    });
  }

  function onChange() {
    const name = getPlayerName();
    saveCharacter(name, activeAvatar);
    syncPlayerName(name);
    mountCharacter(preview, activeAvatar, 120, name);
    syncPickerUI();
  }

  if (!charCustomizationReady) {
    document.querySelectorAll('[data-char-option]').forEach(row => {
      row.addEventListener('click', e => {
        const btn = e.target.closest('[data-value]');
        if (!btn) return;
        activeAvatar.color = btn.dataset.value;
        onChange();
      });
    });

    getPlayerNameInputs().forEach(input => {
      input.addEventListener('input', () => {
        syncPlayerName(input.value.trim() || 'You');
        refreshFromName();
      });
    });

    document.getElementById('btn-random-char')?.addEventListener('click', () => {
      activeAvatar = {
        color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]
      };
      onChange();
    });

    charCustomizationReady = true;
  }

  refreshFromName();
}

window.CharacterSystem = {
  loadCharacter,
  saveCharacter,
  mountCharacter,
  getActiveCharacter,
  setActiveCharacter,
  initCharacterCustomization,
  getPlayerName,
  syncPlayerName,
  BOT_AVATARS,
  AVATAR_COLORS
};
