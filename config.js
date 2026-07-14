/**
 * Online multiplayer WebSocket URL.
 *
 * Vercel / GitHub Pages are static-only — they cannot run the game server.
 * Deploy server/ with `npm start` on Railway, Render, or Fly.io, then set:
 *
 *   window.UNO_WS_URL = 'wss://YOUR-APP.up.railway.app';
 *
 * Leave empty for local play via: npm start → http://localhost:3000
 */
window.UNO_WS_URL = window.UNO_WS_URL || '';
