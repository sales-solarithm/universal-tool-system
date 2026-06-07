/*
 * storage.js — Project Storage Abstraction
 * Universal Tool Dashboard (Phase 2)
 *
 * Hierarchy:
 *   1. Cloudflare KV (via Worker) — if STORAGE_CONFIG.useKV && workerUrl && token
 *   2. localStorage                — always available as fallback
 *
 * Key format:
 *   toolforge::{toolId}::proj::{projectId}   — project data
 *   toolforge::{toolId}::index               — project list for a tool
 */

const STORAGE_CONFIG = {
  useKV: (function() {
    try { return JSON.parse(localStorage.getItem('toolforge::useKV') || 'true'); } catch(e) { return true; }
  })()
};

function _setUseKV(val) {
  STORAGE_CONFIG.useKV = !!val;
  try { localStorage.setItem('toolforge::useKV', JSON.stringify(STORAGE_CONFIG.useKV)); } catch(e) {}
}

const storage = {

  _key: function(toolId, projectId) {
    return 'toolforge::' + toolId + '::proj::' + projectId;
  },

  _indexKey: function(toolId) {
    return 'toolforge::' + toolId + '::index';
  },

  // ── Save a project ────────────────────────────────────────────
  saveProject: async function(toolId, projectId, data) {
    const payload = JSON.stringify({
      toolId:    toolId,
      projectId: projectId,
      savedAt:   new Date().toISOString(),
      state:     data,
      meta: { schemaVersion: 1 }
    });

    // Try KV first
    if (STORAGE_CONFIG.useKV && AUTH_CONFIG.workerUrl && AUTH_CONFIG.sessionToken) {
      try {
        const r = await apiCall('/kv/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: this._key(toolId, projectId), value: payload })
        });
        if (r.ok) {
          this._updateLocalIndex(toolId, projectId);
          return { success: true, source: 'kv' };
        }
      } catch (e) { /* fall through */ }
    }

    // localStorage fallback
    try {
      localStorage.setItem(this._key(toolId, projectId), payload);
      this._updateLocalIndex(toolId, projectId);
      return { success: true, source: 'localStorage' };
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        return { success: false, error: 'Storage full. Delete old projects to free space.' };
      }
      return { success: false, error: e.message };
    }
  },

  // ── Load a project ────────────────────────────────────────────
  loadProject: async function(toolId, projectId) {
    // Try KV first
    if (STORAGE_CONFIG.useKV && AUTH_CONFIG.workerUrl && AUTH_CONFIG.sessionToken) {
      try {
        const r = await apiCall('/kv/get?key=' + encodeURIComponent(this._key(toolId, projectId)));
        if (r.ok) {
          const d = await r.json();
          if (d.value) {
            const parsed = JSON.parse(d.value);
            return { state: parsed.state, savedAt: parsed.savedAt, source: 'kv' };
          }
        }
      } catch (e) { /* fall through */ }
    }

    // localStorage fallback
    try {
      const raw = localStorage.getItem(this._key(toolId, projectId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return { state: parsed.state, savedAt: parsed.savedAt, source: 'localStorage' };
    } catch (e) {
      return null;
    }
  },

  // ── List projects for a tool ──────────────────────────────────
  listProjects: async function(toolId) {
    let index = this._readLocalIndex(toolId);
    // Sort newest first
    index.sort(function(a, b) { return new Date(b.savedAt) - new Date(a.savedAt); });
    return index;
  },

  // ── Delete a project ──────────────────────────────────────────
  deleteProject: function(toolId, projectId) {
    localStorage.removeItem(this._key(toolId, projectId));
    const idx = this._readLocalIndex(toolId).filter(function(p) {
      return p.id !== projectId;
    });
    try { localStorage.setItem(this._indexKey(toolId), JSON.stringify(idx)); } catch(e) {}

    // Best-effort KV delete (fire and forget)
    if (STORAGE_CONFIG.useKV && AUTH_CONFIG.workerUrl && AUTH_CONFIG.sessionToken) {
      apiCall('/kv/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: this._key(toolId, projectId) })
      }).catch(function() {});
    }
  },

  // ── Count saved projects (sync, from local index) ─────────────
  countProjects: function(toolId) {
    return this._readLocalIndex(toolId).length;
  },

  // ── Private: read localStorage index ─────────────────────────
  _readLocalIndex: function(toolId) {
    try {
      const raw = localStorage.getItem(this._indexKey(toolId));
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  },

  // ── Private: update localStorage index after save ─────────────
  _updateLocalIndex: function(toolId, projectId) {
    const idx = this._readLocalIndex(toolId);
    const existing = idx.findIndex(function(p) { return p.id === projectId; });
    const entry = { id: projectId, savedAt: new Date().toISOString() };
    if (existing >= 0) idx[existing] = entry;
    else idx.push(entry);
    try { localStorage.setItem(this._indexKey(toolId), JSON.stringify(idx)); } catch(e) {}
  }
};
