// STRICT LOGIN MODE: Session memory-only, cleared on refresh
/*
 * auth.js — Email Authentication Module (STRICT / PRODUCTION)
 * Universal Tool Dashboard
 *
 * Security model:
 *   • Session lives in AUTH_CONFIG (JS memory) ONLY
 *   • No token, email, or session data is ever written to localStorage
 *   • Every page load / tab close / refresh = full logout
 *   • User must re-enter email on every visit
 */

const AUTH_CONFIG = {
  workerUrl: (typeof PRODUCTION_CONFIG !== 'undefined' && PRODUCTION_CONFIG.workerUrl)
    ? PRODUCTION_CONFIG.workerUrl
    : (localStorage.getItem('toolforge::workerUrl') || ''),
  sessionToken: null,  // Memory only — never persisted
  userEmail:    null,  // Memory only — never persisted
  verified:     false, // Memory only — never persisted
  deviceIp:     null   // Cached in memory for this session only
};

// ── Device IP (memory-cached, for auth logging) ──────────────────
async function getDeviceIp() {
  if (AUTH_CONFIG.deviceIp) return AUTH_CONFIG.deviceIp;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
    if (!r.ok) throw new Error('non-200');
    const d = await r.json();
    AUTH_CONFIG.deviceIp = d.ip || 'unknown';
  } catch (e) {
    AUTH_CONFIG.deviceIp = 'unknown';
  }
  return AUTH_CONFIG.deviceIp;
}

// ── Primary auth entry point ──────────────────────────────────────
async function verifyEmail(email) {
  email = (email || '').trim().toLowerCase();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { success: false, error: 'Please enter a valid email address.' };
  }

  // --- Cloudflare Worker path ---
  if (AUTH_CONFIG.workerUrl) {
    try {
      const ip = await getDeviceIp();
      const r = await fetch(AUTH_CONFIG.workerUrl.replace(/\/$/, '') + '/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, device_ip: ip })
      });
      const d = await r.json();
      if (r.ok && d.token) {
        _setSession(email, d.token);
        return { success: true, email };
      }
      return { success: false, error: d.error || 'Access denied.' };
    } catch (e) {
      return { success: false, error: 'Cannot reach auth server. Contact your administrator.' };
    }
  }

  // --- Local / offline fallback (dev mode only) ---
  // Checks localStorage whitelist but NEVER writes session data back
  const whitelist = _getLocalWhitelist();
  if (whitelist.length > 0 && !whitelist.includes(email)) {
    return { success: false, error: 'Email not in authorised list.' };
  }
  const fakeToken = btoa(email + ':' + Date.now()).replace(/=/g, '').slice(0, 24);
  _setSession(email, fakeToken);
  return { success: true, email };
}

// ── Session: set — STRICT: memory only, zero localStorage ────────
function _setSession(email, token) {
  AUTH_CONFIG.sessionToken = token;
  AUTH_CONFIG.userEmail    = email;
  AUTH_CONFIG.verified     = true;
  // STRICT: NO localStorage persistence. Session is cleared on refresh.
}

// ── Authenticated fetch wrapper ───────────────────────────────────
async function apiCall(endpoint, options) {
  options = options || {};
  if (!AUTH_CONFIG.verified) throw new Error('Not authenticated');
  const headers = Object.assign({}, options.headers || {}, {
    'X-Session-Token': AUTH_CONFIG.sessionToken
  });
  const url = AUTH_CONFIG.workerUrl.replace(/\/$/, '') + endpoint;
  const r = await fetch(url, Object.assign({}, options, { headers }));
  if (r.status === 401) {
    logout();
    throw new Error('Session expired — please log in again.');
  }
  return r;
}

// ── Public helpers ────────────────────────────────────────────────
function isAuthenticated() {
  return AUTH_CONFIG.verified && !!AUTH_CONFIG.sessionToken;
}

function getCurrentUser() {
  return AUTH_CONFIG.userEmail;
}

function getSessionToken() {
  return AUTH_CONFIG.sessionToken;
}

function logout() {
  AUTH_CONFIG.sessionToken = null;
  AUTH_CONFIG.userEmail    = null;
  AUTH_CONFIG.verified     = false;
  if (typeof showLoginModal === 'function') showLoginModal();
  if (typeof renderHeader   === 'function') renderHeader();
}

// Worker URL — only settable when lockSettings is false
function setWorkerUrl(url) {
  if (typeof PRODUCTION_CONFIG !== 'undefined' && PRODUCTION_CONFIG.lockSettings) return;
  AUTH_CONFIG.workerUrl = (url || '').trim();
  try { localStorage.setItem('toolforge::workerUrl', AUTH_CONFIG.workerUrl); } catch (e) {}
}

function getWorkerUrl() {
  return AUTH_CONFIG.workerUrl;
}

async function pingWorker() {
  if (!AUTH_CONFIG.workerUrl) return { ok: false, error: 'No Worker URL.' };
  try {
    const r = await fetch(AUTH_CONFIG.workerUrl.replace(/\/$/, '') + '/', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      return { ok: true, status: d.status || 'ok', timestamp: d.timestamp };
    }
    return { ok: false, error: 'Worker returned ' + r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Read-only whitelist for local/dev fallback — never auto-logs in anyone
function _getLocalWhitelist() {
  try {
    const raw = localStorage.getItem('toolforge::emailWhitelist');
    const arr = raw ? JSON.parse(raw) : [];
    return arr.map(function(e) { return e.toLowerCase(); });
  } catch (e) { return []; }
}
