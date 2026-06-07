/*
 * auth-worker.js — Cloudflare Worker
 * Universal Tool Dashboard (Phase 2)
 *
 * Endpoints:
 *   GET  /              — health check
 *   POST /auth          — verify email, return session token
 *   GET  /kv/get?key=   — read from TOOL_PROJECTS KV
 *   POST /kv/set        — write to TOOL_PROJECTS KV
 *   POST /kv/delete     — delete from TOOL_PROJECTS KV
 *   GET  /admin         — list allowed emails (requires X-Admin-Token)
 *   POST /admin         — add/remove allowed email (requires X-Admin-Token)
 *
 * Required environment bindings (set in wrangler.toml or Cloudflare dashboard):
 *   TOOL_AUTH     — KV namespace for sessions + allowed emails
 *   TOOL_PROJECTS — KV namespace for project data
 *   ADMIN_TOKEN   — Secret string (wrangler secret put ADMIN_TOKEN)
 *   ALLOWED_EMAILS — Optional JSON array string (alternative to KV list)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token, X-Admin-Token',
  'Access-Control-Max-Age':       '86400'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

function err(msg, status) {
  return json({ error: msg }, status || 400);
}

// ── Token generation (simple, cryptographically random) ──────────
function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(function(b) { return b.toString(16).padStart(2,'0'); }).join('');
}

// ── Allowed-emails helpers ────────────────────────────────────────
async function getAllowedEmails(env) {
  if (env.ALLOWED_EMAILS) {
    try { return JSON.parse(env.ALLOWED_EMAILS).map(function(e) { return e.toLowerCase(); }); }
    catch(e) { return []; }
  }
  if (env.TOOL_AUTH) {
    const raw = await env.TOOL_AUTH.get('allowed_emails');
    if (raw) {
      try { return JSON.parse(raw).map(function(e) { return e.toLowerCase(); }); }
      catch(e) {}
    }
  }
  return [];
}

// ── Token validation ──────────────────────────────────────────────
async function validateToken(token, env) {
  if (!token) return false;
  if (!env.TOOL_AUTH) return true; // No auth KV: trust any token (dev mode)
  const session = await env.TOOL_AUTH.get('session:' + token);
  if (!session) return false;
  try {
    const s = JSON.parse(session);
    return s.expires > Date.now();
  } catch(e) { return false; }
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {

      // ── GET / — health check ────────────────────────────────────
      if (path === '/' && method === 'GET') {
        return json({
          service:   'toolforge-auth-worker',
          status:    'ok',
          timestamp: new Date().toISOString(),
          kv:        !!env.TOOL_AUTH && !!env.TOOL_PROJECTS
        });
      }

      // ─ POST /auth — verify email, issue token ─────────────────
      if (path === '/auth' && method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch(e) { return err('Invalid JSON body'); }

        const email     = (body.email || '').trim().toLowerCase();
        const device_ip = body.device_ip || 'unknown';

        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return err('Invalid email format');
        }

        const allowed = await getAllowedEmails(env);

        // If no allowed list configured, reject all (production safety)
        // To allow any email in dev, set ALLOWED_EMAILS='"*"' in env
        if (allowed.length === 0 && env.ALLOWED_EMAILS !== '"*"') {
          return err('No allowed emails configured. Set ALLOWED_EMAILS in worker env.', 403);
        }

        if (env.ALLOWED_EMAILS === '"*"' || allowed.includes(email)) {
          const token   = generateToken();
          const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

          if (env.TOOL_AUTH) {
            await env.TOOL_AUTH.put(
              'session:' + token,
              JSON.stringify({ email, device_ip, created: Date.now(), expires }),
              { expirationTtl: 86400 }
            );
          }

          // Log access (fire and forget)
          if (env.TOOL_AUTH) {
            env.TOOL_AUTH.put(
              'log:' + Date.now() + ':' + email,
              JSON.stringify({ email, device_ip, action: 'login', ts: new Date().toISOString() }),
              { expirationTtl: 7 * 86400 } // keep logs 7 days
            ).catch(function() {});
          }

          return json({ success: true, token, email, message: 'Authentication successful' });
        }

        return json({ error: 'Access denied: email not authorised' }, 403);
      }

      // ── GET /kv/get — read project data ─────────────────────────
      if (path === '/kv/get' && method === 'GET') {
        if (!env.TOOL_PROJECTS) return err('KV not configured', 503);

        const token = request.headers.get('X-Session-Token');
        if (!await validateToken(token, env)) return err('Unauthorised', 401);

        const key = url.searchParams.get('key');
        if (!key) return err('Missing key parameter');

        const value = await env.TOOL_PROJECTS.get(key);
        if (value === null) return json({ error: 'Key not found' }, 404);

        return json({ value });
      }

      // ── POST /kv/set — write project data ────────────────────────
      if (path === '/kv/set' && method === 'POST') {
        if (!env.TOOL_PROJECTS) return err('KV not configured', 503);

        const token = request.headers.get('X-Session-Token');
        if (!await validateToken(token, env)) return err('Unauthorised', 401);

        let body;
        try { body = await request.json(); }
        catch(e) { return err('Invalid JSON body'); }

        const { key, value } = body;
        if (!key || value === undefined) return err('Missing key or value');

        // Basic key validation: only allow toolforge:: prefix
        if (!key.startsWith('toolforge::')) return err('Invalid key prefix');

        await env.TOOL_PROJECTS.put(key, value);
        return json({ success: true });
      }

      // ── POST /kv/delete — delete project data ────────────────────
      if (path === '/kv/delete' && method === 'POST') {
        if (!env.TOOL_PROJECTS) return err('KV not configured', 503);

        const token = request.headers.get('X-Session-Token');
        if (!await validateToken(token, env)) return err('Unauthorised', 401);

        let body;
        try { body = await request.json(); }
        catch(e) { return err('Invalid JSON body'); }

        if (!body.key) return err('Missing key');
        if (!body.key.startsWith('toolforge::')) return err('Invalid key prefix');

        await env.TOOL_PROJECTS.delete(body.key);
        return json({ success: true });
      }

      // ── GET /admin — list allowed emails ─────────────────────────
      if (path === '/admin' && method === 'GET') {
        const adminToken = request.headers.get('X-Admin-Token');
        if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
          return err('Unauthorised', 401);
        }
        const emails = await getAllowedEmails(env);
        return json(emails);
      }

      // ── POST /admin — add/remove allowed email ──────────────────
      if (path === '/admin' && method === 'POST') {
        const adminToken = request.headers.get('X-Admin-Token');
        if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
          return err('Unauthorised', 401);
        }

        let body;
        try { body = await request.json(); }
        catch(e) { return err('Invalid JSON body'); }

        const { action, email } = body;
        const emailLower = (email || '').trim().toLowerCase();

        if (!emailLower || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailLower)) {
          return err('Invalid email');
        }
        if (!['add', 'remove'].includes(action)) return err('action must be "add" or "remove"');
        if (!env.TOOL_AUTH) return err('TOOL_AUTH KV not configured', 503);

        let emails = await getAllowedEmails(env);

        if (action === 'add') {
          if (!emails.includes(emailLower)) emails.push(emailLower);
        } else {
          emails = emails.filter(function(e) { return e !== emailLower; });
        }

        await env.TOOL_AUTH.put('allowed_emails', JSON.stringify(emails));
        return json({ success: true, emails, action, email: emailLower });
      }

      // ── 404 ──────────────────────────────────────────────────────
      return json({ error: 'Not found' }, 404);

    } catch(error) {
      console.error('Worker error:', error.stack || error.message);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};