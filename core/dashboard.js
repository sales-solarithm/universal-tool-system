// STRICT LOGIN MODE: Session memory-only, cleared on refresh
/*
 * dashboard.js — Tool Registry, UI Logic, PostMessage Bridge (STRICT / PRODUCTION)
 * Universal Tool Dashboard
 *
 * Security model:
 *   • Login modal is shown on EVERY page load — no exceptions
 *   • Email field is always blank — no pre-fill, no autocomplete
 *   • No restoreSession(), no auto-login of any kind
 *
 * ADDING A NEW TOOL:
 *   Append a registerTool() call to the bottom of index.html only.
 *   Never edit this file.
 */

// ── Global registry ───────────────────────────────────────────────
let _toolRegistry    = [];
let _activeToolId    = null;
let _activeProjectId = null;

// ── registerTool ──────────────────────────────────────────────────
function registerTool(config) {
  if (!config || !config.id || !config.name) {
    console.warn('[ToolForge] registerTool: missing required id or name', config);
    return;
  }
  const tool = {
    id:           config.id,
    name:         config.name,
    icon:         config.icon         || '🔧',
    src:          config.src          || ('tools/tool-' + config.id + '.html'),
    requiresAuth: config.requiresAuth !== undefined ? !!config.requiresAuth : true,
    version:      config.version      || '1.0',
    desc:         config.desc         || '',
    registeredAt: new Date().toISOString()
  };

  const idx = _toolRegistry.findIndex(function(t) { return t.id === tool.id; });
  if (idx >= 0) _toolRegistry[idx] = Object.assign(_toolRegistry[idx], tool);
  else _toolRegistry.push(tool);

  _persistRegistry();

  if (document.getElementById('tool-grid-view') &&
      document.getElementById('tool-grid-view').style.display !== 'none') {
    renderToolGrid();
  }
}

// ── Registry persistence (registry list only — no session data) ───
function _persistRegistry() {
  try { localStorage.setItem('toolforge::registry', JSON.stringify(_toolRegistry)); } catch(e) {}
}

function _loadRegistry() {
  try {
    const raw = localStorage.getItem('toolforge::registry');
    if (raw) _toolRegistry = JSON.parse(raw);
  } catch(e) { _toolRegistry = []; }
}

// ── openTool ──────────────────────────────────────────────────────
async function openTool(toolId) {
  const tool = _toolRegistry.find(function(t) { return t.id === toolId; });
  if (!tool) { showToast('Tool "' + toolId + '" not found.', 'error'); return; }

  if (tool.requiresAuth && !isAuthenticated()) {
    showToast('Please log in to open this tool.', 'error');
    showLoginModal();
    return;
  }

  _activeToolId    = toolId;
  _activeProjectId = null;

  document.getElementById('tool-grid-view').style.display = 'none';
  const viewer = document.getElementById('tool-viewer');
  viewer.style.display = 'flex';

  _updateViewerHeader(tool);

  const frame  = document.getElementById('tool-frame');
  frame.src    = 'about:blank';
  frame.srcdoc = '';

  try {
    const r = await fetch(tool.src, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + tool.src);
    const html = await r.text();
    frame.srcdoc = html;
  } catch (e) {
    frame.srcdoc = _errorPage(tool, e.message);
    showToast('Could not load tool: ' + e.message, 'error');
  }

  frame.onload = function() {
    if (tool.requiresAuth && isAuthenticated()) {
      setTimeout(function() {
        try {
          frame.contentWindow.postMessage({
            type:  'auth:token',
            token: getSessionToken(),
            email: getCurrentUser()
          }, '*');
        } catch(e) {}
      }, 100);
    }
  };

  showSavedProjects(toolId);
  try { history.replaceState(null, '', '#tool/' + toolId); } catch(e) {}
}

// ── showSavedProjects ─────────────────────────────────────────────
async function showSavedProjects(toolId) {
  const drawer = document.getElementById('proj-drawer');
  const listEl = document.getElementById('proj-list');
  if (!drawer || !listEl) return;

  drawer.classList.add('open');
  listEl.innerHTML = '<div class="proj-loading">Loading…</div>';

  try {
    const projects = await storage.listProjects(toolId);
    if (projects.length === 0) {
      listEl.innerHTML = '<div class="proj-empty">No saved projects yet.<br>Click 💾 Save to create one.</div>';
      return;
    }
    listEl.innerHTML = projects.map(function(p) {
      const isActive = p.id === _activeProjectId;
      const d = new Date(p.savedAt);
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return '<div class="proj-item' + (isActive ? ' active' : '') + '" data-project-id="' + _esc(p.id) + '">'
           + '<div class="proj-name">' + _esc(p.id) + (isActive ? ' <span class="proj-active-dot">●</span>' : '') + '</div>'
           + '<div class="proj-meta">' + _esc(dateStr) + '</div>'
           + '<div class="proj-actions">'
           + '<button class="proj-btn" onclick="loadProjectIntoTool(\'' + _esc(toolId) + '\',\'' + _esc(p.id) + '\')" title="Load">↩</button>'
           + '<button class="proj-btn delete" onclick="deleteProjectFromPanel(\'' + _esc(toolId) + '\',\'' + _esc(p.id) + '\')" title="Delete">✕</button>'
           + '</div>'
           + '</div>';
    }).join('');

    listEl.querySelectorAll('.proj-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        loadProjectIntoTool(toolId, el.dataset.projectId);
      });
    });
  } catch(e) {
    listEl.innerHTML = '<div class="proj-empty" style="color:var(--danger)">Error: ' + _esc(e.message) + '</div>';
  }
}

// ── loadProjectIntoTool ───────────────────────────────────────────
async function loadProjectIntoTool(toolId, projectId) {
  const frame = document.getElementById('tool-frame');
  if (!frame) return;

  try {
    const saved = await storage.loadProject(toolId, projectId);
    if (!saved) { showToast('Project "' + projectId + '" not found.', 'error'); return; }

    _activeProjectId = projectId;

    try {
      frame.contentWindow.postMessage({
        type:      'project:load',
        projectId: projectId,
        data:      saved.state
      }, '*');
    } catch(e) {
      showToast('Could not send state to tool.', 'error');
      return;
    }

    showToast('Loaded: ' + projectId, 'success');
    showSavedProjects(toolId);
  } catch(e) {
    showToast('Load failed: ' + e.message, 'error');
  }
}

// ── deleteProjectFromPanel ────────────────────────────────────────
function deleteProjectFromPanel(toolId, projectId) {
  if (!confirm('Delete project "' + projectId + '"?')) return;
  storage.deleteProject(toolId, projectId);
  if (_activeProjectId === projectId) _activeProjectId = null;
  showSavedProjects(toolId);
  renderToolGrid();
  showToast('Deleted: ' + projectId);
}

// ── navigateBack ──────────────────────────────────────────────────
function navigateBack() {
  _activeToolId    = null;
  _activeProjectId = null;

  document.getElementById('tool-viewer').style.display    = 'none';
  document.getElementById('tool-grid-view').style.display = 'block';

  const frame = document.getElementById('tool-frame');
  if (frame) { frame.src = 'about:blank'; frame.srcdoc = ''; }

  const drawer = document.getElementById('proj-drawer');
  if (drawer) drawer.classList.remove('open');

  const nameEl = document.getElementById('viewer-tool-name');
  if (nameEl) nameEl.textContent = '';

  renderToolGrid();
  try { history.replaceState(null, '', '#'); } catch(e) {}
}

// ── renderToolGrid ────────────────────────────────────────────────
function renderToolGrid() {
  const grid = document.getElementById('tool-grid');
  if (!grid) return;

  if (_toolRegistry.length === 0) {
    grid.innerHTML = '<div class="tool-grid-empty">'
      + '<div style="font-size:48px;margin-bottom:16px;">🧰</div>'
      + '<h3>No tools registered yet</h3>'
      + '<p>Use the Tool Injector to wrap your first HTML tool, then append a <code>registerTool()</code> call to index.html.</p>'
      + '<a href="tool-injector.html" class="btn btn-primary" style="margin-top:12px;">Open Tool Injector</a>'
      + '</div>';
    return;
  }

  const cards = _toolRegistry.map(function(tool) {
    const count = storage.countProjects(tool.id);
    const countBadge = count > 0 ? '<span class="tool-badge">' + count + ' saved</span>' : '';
    return '<div class="card tool-card" role="button" tabindex="0"'
         + ' onclick="openTool(\'' + _esc(tool.id) + '\')"'
         + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \')openTool(\'' + _esc(tool.id) + '\')">'
         + countBadge
         + '<div class="tool-icon">' + _esc(tool.icon) + '</div>'
         + '<div class="tool-name">' + _esc(tool.name) + '</div>'
         + '<div class="tool-meta">' + (tool.desc ? _esc(tool.desc) : 'v' + _esc(tool.version)) + '</div>'
         + '<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:auto;">Open →</button>'
         + '</div>';
  }).join('');

  const addCard = '<a href="tool-injector.html" class="card tool-card add-new">'
    + '<div style="font-size:28px;margin-bottom:8px;">＋</div>'
    + '<div style="font-size:14px;font-weight:600;">Add New Tool</div>'
    + '<div style="font-size:12px;margin-top:4px;opacity:0.7;">Open Tool Injector</div>'
    + '</a>';

  grid.innerHTML = cards + addCard;
}

// ── Header ────────────────────────────────────────────────────────
function _updateViewerHeader(tool) {
  const nameEl = document.getElementById('viewer-tool-name');
  if (nameEl) nameEl.textContent = tool.icon + ' ' + tool.name;
}

function renderHeader() {
  const userSection = document.getElementById('header-user-section');
  const userEl      = document.getElementById('header-user');
  const loginBtn    = document.getElementById('header-login-btn');
  const logoutBtn   = document.getElementById('header-logout-btn');

  if (isAuthenticated()) {
    if (userEl)      userEl.textContent          = getCurrentUser();
    if (userSection) userSection.style.display   = 'flex';
    if (loginBtn)    loginBtn.style.display       = 'none';
    if (logoutBtn)   logoutBtn.style.display      = 'inline-flex';
  } else {
    if (userSection) userSection.style.display   = 'none';
    if (loginBtn)    loginBtn.style.display       = 'inline-flex';
    if (logoutBtn)   logoutBtn.style.display      = 'none';
  }
}

// ── Login modal — STRICT: always blank email field ────────────────
function showLoginModal() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  const emailInput = document.getElementById('auth-email-input');
  if (emailInput) {
    emailInput.value = '';               // STRICT: Never auto-fill
    emailInput.removeAttribute('value'); // Remove any baked-in value attribute
    emailInput.focus();
  }

  const errEl = document.getElementById('auth-error');
  if (errEl) errEl.textContent = '';
}

function hideLoginModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.style.display = 'none';
}

async function handleLogin() {
  const emailInput = document.getElementById('auth-email-input');
  const email  = (emailInput ? emailInput.value : '').trim();
  const errEl  = document.getElementById('auth-error');
  const btn    = document.getElementById('auth-submit-btn');

  if (errEl) errEl.textContent = '';
  if (btn)   { btn.disabled = true; btn.textContent = 'Verifying…'; }

  const result = await verifyEmail(email);

  if (btn) { btn.disabled = false; btn.textContent = 'Verify Access'; }

  if (result.success) {
    hideLoginModal();
    renderHeader();
    renderToolGrid();
    showToast('Welcome, ' + getCurrentUser() + '!', 'success');
    handleHashNavigation();
  } else {
    if (errEl) errEl.textContent = result.error || 'Access denied.';
  }
}

// ── Settings modal ────────────────────────────────────────────────
function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  const workerInput = document.getElementById('settings-worker-url');
  if (workerInput) workerInput.value = AUTH_CONFIG.workerUrl;

  const kvCheck = document.getElementById('settings-use-kv');
  if (kvCheck) kvCheck.checked = STORAGE_CONFIG.useKV;

  const themeSelect = document.getElementById('settings-theme');
  if (themeSelect) themeSelect.value = document.documentElement.getAttribute('data-theme') || 'dark';

  const pingStatus = document.getElementById('ping-status');
  if (pingStatus) pingStatus.textContent = '';

  const sessionEl = document.getElementById('settings-session-info');
  if (sessionEl) {
    sessionEl.textContent = isAuthenticated()
      ? 'Logged in as: ' + getCurrentUser() + ' (session clears on page refresh)'
      : 'Not logged in.';
  }

  const logoutBtn = document.getElementById('settings-logout-btn');
  if (logoutBtn) logoutBtn.style.display = isAuthenticated() ? 'inline-flex' : 'none';
}

function hideSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.style.display = 'none';
}

// Settings save — PRODUCTION: theme change only (lockSettings = true)
function saveSettings() {
  // PRODUCTION: Lock settings — only allow theme change
  if (typeof PRODUCTION_CONFIG !== 'undefined' && PRODUCTION_CONFIG.lockSettings) {
    const themeSelect = document.getElementById('settings-theme');
    if (themeSelect) {
      const theme = themeSelect.value;
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem('toolforge::theme', theme); } catch(e) {}
    }
    hideSettingsModal();
    showToast('Theme updated.', 'success');
    return;
  }
  
  if (typeof PRODUCTION_CONFIG !== 'undefined' && PRODUCTION_CONFIG.lockSettings) {
    const themeSelect = document.getElementById('settings-theme');
    if (themeSelect) {
      const theme = themeSelect.value;
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem('toolforge::theme', theme); } catch(e) {}
    }
    hideSettingsModal();
    showToast('Theme updated.', 'success');
    return;
  }

  // Dev / non-locked fallback
  const workerInput = document.getElementById('settings-worker-url');
  const kvCheck     = document.getElementById('settings-use-kv');
  const themeSelect = document.getElementById('settings-theme');
  if (workerInput) setWorkerUrl(workerInput.value.trim());
  if (kvCheck)     _setUseKV(kvCheck.checked);
  if (themeSelect) {
    const theme = themeSelect.value;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('toolforge::theme', theme); } catch(e) {}
  }
  hideSettingsModal();
  showToast('Settings saved.', 'success');
}

// ── PostMessage bridge ────────────────────────────────────────────
function initMessageBridge() {
  window.addEventListener('message', function(event) {
    const d = event.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'navigate' && d.target === 'dashboard') { navigateBack(); return; }
    if (d === 'navigate:dashboard') { navigateBack(); return; }

    if (d.type === 'tool:ready') {
      const btn = document.getElementById('tb-save-btn');
      if (btn) btn.disabled = false;
      return;
    }

    if (d.type === 'project:saved') {
      if (_activeToolId) showSavedProjects(_activeToolId);
      renderToolGrid();
      if (d.projectId) showToast('Saved: ' + d.projectId, 'success');
      return;
    }

    if (d.type === 'auth:request') {
      if (isAuthenticated()) {
        const frame = document.getElementById('tool-frame');
        if (frame) {
          try {
            frame.contentWindow.postMessage({
              type:  'auth:token',
              token: getSessionToken(),
              email: getCurrentUser()
            }, '*');
          } catch(e) {}
        }
      }
      return;
    }
  });
}

// ── URL hash deep linking ─────────────────────────────────────────
function handleHashNavigation() {
  const hash = window.location.hash;
  if (!hash) return;

  const toolMatch = hash.match(/^#tool\/(.+)$/);
  if (toolMatch) {
    setTimeout(function() { openTool(decodeURIComponent(toolMatch[1])); }, 100);
    return;
  }

  const projMatch = hash.match(/^#project\/([^/]+)\/(.+)$/);
  if (projMatch) {
    const toolId    = decodeURIComponent(projMatch[1]);
    const projectId = decodeURIComponent(projMatch[2]);
    setTimeout(async function() {
      await openTool(toolId);
      setTimeout(function() { loadProjectIntoTool(toolId, projectId); }, 500);
    }, 100);
  }
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  const icon = document.createElement('span');
  icon.style.fontWeight = '700';
  icon.textContent = { success: '✓', error: '✕', warning: '⚠' }[type] || 'ℹ';
  t.appendChild(icon);
  t.appendChild(document.createTextNode(' ' + msg));
  container.appendChild(t);
  setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
}

// ── Helpers ───────────────────────────────────────────────────────
function _esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _errorPage(tool, msg) {
  return '<!DOCTYPE html><html><body style="font-family:system-ui;background:#1a1a1a;color:#e0e0e0;'
    + 'display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;">'
    + '<div style="font-size:48px;">' + tool.icon + '</div>'
    + '<h2>' + tool.name + '</h2>'
    + '<p style="color:#888;">Failed to load tool:</p>'
    + '<code style="background:#222;padding:8px 16px;border-radius:6px;color:#ef5350;">' + msg + '</code>'
    + '</body></html>';
}

// ── DOMContentLoaded — STRICT: always show login modal ────────────
document.addEventListener('DOMContentLoaded', function() {
  // Restore theme (the only thing persisted from previous sessions)
  try {
    const savedTheme = localStorage.getItem('toolforge::theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
  } catch(e) {}

  // Load tool registry (list of registered tools, not session data)
  _loadRegistry();

  // Init postMessage bridge
  initMessageBridge();

  // Render UI
  renderHeader();
  renderToolGrid();

  // STRICT: Always show login modal. No auto-login. No restoreSession().
  // isAuthenticated() will always be false here because auth.js no longer
  // restores session from localStorage.
  showLoginModal();

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      hideLoginModal();
      hideSettingsModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b' && _activeToolId) {
      e.preventDefault();
      navigateBack();
    }
  });
});
