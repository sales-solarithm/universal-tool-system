# ⚡ ToolForge — Universal Tool Dashboard

A modular dashboard for hosting multiple HTML tools with built-in Save/Export/Import/Auth — no backend required for local use.

---

## 📁 File Structure

```
universal-tool-system/
├── index.html              ← Main dashboard (Phase 2)
├── tool-injector.html      ← Tool wrapper generator (Phase 1)
│
├── core/
│   ├── auth.js             ← Email auth, session token management
│   ├── storage.js          ← localStorage + Cloudflare KV abstraction
│   └── dashboard.js        ← Tool registry, UI logic, postMessage bridge
│
├── assets/
│   └── styles.css          ← Shared design system (dark theme + gold)
│
├── tools/                  ← Wrapped tools go here (auto-generated)
│   └── .gitkeep
│
├── cloudflare/
│   ├── auth-worker.js      ← Cloudflare Worker (auth + KV endpoints)
│   └── wrangler.toml       ← Deployment configuration
│
└── README.md
```

---

## 🚀 Quick Start (Local — No Cloudflare Needed)

1. Save all files to a folder (e.g. `universal-tool-system/`)
2. Open `index.html` in a browser
   - Use a local server for best results: `python -m http.server 8080`
   - Or just double-click `index.html` (works for basic testing)
3. A login modal appears — enter any email (local dev mode allows all emails)
4. You'll see the tool grid with a "+ Add New Tool" card

---

## ➕ Adding a Tool

**Step 1** — Wrap your tool using `tool-injector.html`:
- Open `tool-injector.html` in browser
- Paste your raw HTML tool code
- Fill in name, icon, auth options
- Click "Generate & Download" → gets `tool-[id].html`

**Step 2** — Put the file in `/tools/`:
```
tools/tool-pdf-generator.html
```

**Step 3** — Register it in `index.html` (append before `</body>`):
```javascript
registerTool({
  id:           'pdf-generator',
  name:         'PDF Generator Pro',
  icon:         '📄',
  src:          'tools/tool-pdf-generator.html',
  requiresAuth: true,
  version:      '1.0.0',
  desc:         'Generate PDFs with image categorization'
});
```

**Step 4** — Refresh dashboard → your tool appears in the grid!

That's it. No other files need editing.

---

## 🔐 Authentication

### Local mode (no Worker URL set)
- Any email is accepted by default (dev mode)
- To restrict: open browser console and run:
  ```javascript
  localStorage.setItem('toolforge::emailWhitelist', JSON.stringify(['you@example.com']));
  ```
- Or use Settings → Local Email Whitelist

### Production mode (Cloudflare Worker)
1. Deploy the worker (see below)
2. In dashboard Settings → enter your Worker URL
3. Add allowed emails via API or Cloudflare dashboard

---

## ☁️ Cloudflare Deployment

### Deploy the Auth Worker

```bash
# Install Wrangler
npm install -g wrangler
wrangler login

# Create KV namespaces
wrangler kv:namespace create "TOOL_AUTH"
wrangler kv:namespace create "TOOL_PROJECTS"
# Copy the IDs into cloudflare/wrangler.toml

# Set your admin secret
wrangler secret put ADMIN_TOKEN

# Add allowed emails (env var approach)
# In wrangler.toml [vars]: ALLOWED_EMAILS = '["you@example.com"]'
# OR add via API after deploying

# Deploy
wrangler deploy
# Note your Worker URL: https://universal-tool-auth.YOUR-SUBDOMAIN.workers.dev
```

### Add Allowed Emails via API

```bash
curl -X POST https://YOUR-WORKER.workers.dev/admin \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: YOUR_ADMIN_TOKEN" \
  -d '{"action":"add","email":"user@company.com"}'
```

### Deploy Dashboard to Cloudflare Pages

```bash
wrangler pages deploy . --project-name universal-tool-dashboard
```

Then in dashboard Settings → enter your Worker URL → Save.

---

## 💾 Storage

| Mode | How it works | Sync |
|---|---|---|
| localStorage (default) | Saved in browser, always works | Device only |
| Cloudflare KV | Via Worker + session token | All devices |

KV is tried first; falls back to localStorage if unavailable.

---

## 🔗 PostMessage Bridge (Phase 1 ↔ Phase 2)

The dashboard communicates with wrapped tools via `postMessage`:

| Direction | Message | Purpose |
|---|---|---|
| Dashboard → Tool | `{type:'auth:token', token, email}` | Pass session token after tool loads |
| Dashboard → Tool | `{type:'project:load', projectId, data}` | Load a saved project |
| Dashboard → Tool | `{type:'project:save'}` | Request tool to save |
| Tool → Dashboard | `{type:'navigate', target:'dashboard'}` | Back button pressed |
| Tool → Dashboard | `{type:'project:saved', projectId}` | Tool confirms save |

---

## 🧪 Testing Checklist

- [ ] Open `index.html` → login modal appears
- [ ] Enter email → see tool grid with "+ Add New Tool"
- [ ] Click "+ Add New Tool" → opens `tool-injector.html`
- [ ] Wrap a tool → save to `/tools/` → register → refresh → card appears
- [ ] Open tool → fill data → Save → Refresh → Load → state restored
- [ ] Export JSON → clear localStorage → Import → state restored
- [ ] Settings → enter Worker URL → Ping → "Worker is online"
- [ ] Mobile: layout works at 320px width

---

## 🛠 Troubleshooting

**Login modal won't close:**
Check browser console for JS errors — likely a missing script file.

**Tool shows blank iframe:**
Verify the file exists at `tools/tool-[id].html`. Check for typos in `src` field of `registerTool()`.

**Save button does nothing:**
The tool may not implement `window.toolAPI`. The fallback serializer captures form inputs. Open DevTools → Console to see any errors.

**"Cannot reach auth server":**
Worker URL is wrong or worker isn't deployed. Leave blank to use local mode.

**Styles look broken:**
Make sure `assets/styles.css` exists. If opening via `file://`, some browsers block relative CSS — use a local server instead.

---

## 📄 License

MIT — free for personal and commercial use.
