# Project Progress Tracker

A single-file HTML dashboard for tracking project delivery progress, with deep integration into [Rocketlane](https://www.rocketlane.com/), [Zendesk](https://www.zendesk.com/), [Oneflow](https://oneflow.com/), [HubSpot](https://www.hubspot.com/), and [Younium](https://younium.com/) — all routed through a single Tampermonkey bridge that re-uses each platform's existing browser session.

## 🌐 Try it live

**[hapnes-dev.github.io/Project-Progress-Tracker](https://hapnes-dev.github.io/Project-Progress-Tracker/)**

The hosted version always runs the latest commit on `main`. State is stored in *your* browser's `localStorage` — nothing leaves your device. You still need to install the Tampermonkey bridge below for cross-origin API calls to work.

Prefer a local copy? Download `Project Progress Tracker.html` and open it from your desktop — it works the same way.

## Features

### Project management
- **Project list with status pills**, team-group workload sections (Team kulde + Others), sorting & filtering, plant ID quick-link to PANG.
- **Per-project detail view**: notes, status, due dates, custom links (Oneflow / Younium / HubSpot), task categories with **one-level sub-tasks** (a subtask can't have its own subtask; created subtasks sync to Rocketlane in the parent's phase), expandable task notes & descriptions, in-progress / blocked / waiting-on-partner / need-assistance status.
- **Per-project toolbar shortcuts**: 🚀 Rocketlane, 📁 Files, 📦 Order info, ☄️ PANG (plant control), 👥 BAF (user database), Edit, Remove.
- **📁 Files popover** has a **⬇ Download all (N)** button — picks a destination folder once via the File System Access API (`showDirectoryPicker`) and writes every project attachment straight into it. Filename collisions auto-resolve as `name (1).ext`, `name (2).ext`. Falls back to per-file `<a download>` on browsers without the API.

### Project status (8-state, bidirectional with Rocketlane)
- Local status enum matches **Rocketlane's project Status field 1:1**: `Proposed` · `In Planning` · `To be Staffed` · `In progress` · `On Hold` · `Blocked` · `Completed` · `Cancelled`.
- **Push** (instant): change the status pill or save the Edit dialog → `PUT /projects/<id>` with the numeric option value (e.g. 3 = `Completed`). No more manually re-clicking the status on Rocketlane's settings page.
- **Pull** (every sync, not just on first import): each Rocketlane sync now overwrites `local.status` from `remoteProject.fields[]["Status"].metaFieldValue.label`. Rocketlane stays the source of truth — change the status on either side and the other catches up.
- Existing tracker installs with old `open` / `in_progress` / `waiting_partner` / `finished` / `closed` statuses migrate transparently on next load via `normalizeStatus()`.

### Owner Workload Overview (collapsible)
- **Team groups**: Team kulde lists a fixed roster (configured at `OWNER_TEAM_GROUPS`); everyone else falls into Others.
- **Collapsible sections** (whole overview + each team) with per-localStorage state.
- **Live counts from Rocketlane**: total active projects + "In progress" specifically per teammate, fetched from `/projects/lightV1` (which returns `teamMembers` inline so we don't have to fan out to /members).
- **Cross-user workload sharing**: each agent's Low / Normal / High / Need Work / On Hold selection is stored in a hidden `[Tracker] Workload Sync` Rocketlane meta-project (one task per user, plain-text token in `taskDescription`). Pull on every 5-min sync; push on every picker change.

### Rocketlane integration
- **Sync (bidirectional)**: 5-min pull when tab is visible (resumes on focus), push-on-change within 2.5s, manual single-project sync via the "RL sync" chip.
- **Click any project → instant single-project sync** of just that one (no fan-out).
- **Tasks**: add / remove with upstream propagation (delete is gated by ⚠ confirm). **Task status** changes push to Rocketlane; if a task's Rocketlane counterpart was deleted or made access-restricted, the tracker keeps your local status and clears the dead link instead of reverting.
- **Chat history viewer** for project conversations: Private + General tabs, file attachments, inline image previews, lightbox, @-mention picker (diacritic-insensitive), notifications drawer with filter chips and rich previews.
- **Hubspot Deal Description writer**: when you save a project, the Rocketlane custom field "Hubspot Deal Description" is updated with a plain `Links:` block listing the project's Oneflow / Younium / HubSpot URLs. Field is discovered via the tenant `/fields` endpoint when it doesn't yet exist on the project.

### Task notes & private notes (synced to Rocketlane)

Expand any task to edit two independent notes that mirror Rocketlane's task drawer:

- **Description note** — the task's main description. For Rocketlane-linked tasks it reads/writes the Rocketlane task description; for local-only tasks it's stored in the tracker.
- **Private note** — hidden behind a **+ Add a private note** link (matching Rocketlane's own affordance); click it to reveal a cream editor. For linked tasks this syncs to Rocketlane's task-level **`privateTaskDescription`** field — the same private note shown in the task drawer — via `PUT /projects/<projectId>/tasks/<taskId>/mini`. **Clearing** the note in the tracker also clears it in Rocketlane, and notes authored **in** Rocketlane pull back into the tracker on every sync.

Stored locally as `t.privateNote`, kept separate from the description so the two never collide. Saved on Enter or click-away.

A **Task notes overview** at the top of the project detail surfaces every task that needs attention — any task that isn't completed and either has a note or a non-"To do"/"In progress" status — as a card showing the category, **task name**, status, and note. Subtasks are marked with a `↳` and their parent ("under &lt;parent&gt;"). Click a card to jump to that task in its category.

### Zendesk Tasks (per project)
- **Section** under "Chat history" in the project detail panel, sorted by **last public reply** (not generic `updated_at`).
- Each row shows status pill + subject + "Last reply 25.05 14:17 (i dag)" (24-h Oslo timezone, Norwegian locale).
- **Inline preview** shows the newest comment + a "Right-click to open fullscreen — read full thread & reply" hint.
- **Right-click anywhere on a ticket card** → fullscreen overlay (portal-mounted to `<body>` to escape `contain: layout` clipping). Full conversation rendered from sanitized `html_body` (signatures, inline images, attachments), with a Public reply / Internal note toggle and Ctrl+Enter shortcut.
- **Auto session renewal** on 401 via the documented `X-Zendesk-Renew-Session: true` header — and the same auto-retry pattern is now in place for Oneflow, HubSpot, and Younium too.

### Notifications bell (Rocketlane + Zendesk)

The 🔔 in the project-list toolbar shows a combined **unread count** and opens a left-side drawer.

- **Unread badge** = unread Rocketlane notifications (chat, mentions, status changes) **plus** Zendesk tickets assigned to you with a new public reply. Hover the bell for a per-source breakdown. Refreshes every 2 min while the tab is visible, and on focus.
- **Clicking the bell resets the count and it stays cleared.** Rocketlane's server-side "mark seen" API currently rejects the call, so the tracker keeps its own per-source last-seen timestamps (`rocketlane_notif_last_seen_v1`, `zendesk_notif_last_seen_v1`) and counts unread against `max(serverLastSeen, localLastSeen)` — the count clears reliably on click, and genuinely-new items re-raise it.
- **Zendesk "recent replies" list** at the top of the drawer (collapsible): your assigned tickets that have an **incoming reply** (from someone other than you). A case **stays listed even after you reply** — it's a worklist of conversations to keep an eye on, not just unanswered ones. Defaults to the **last month**, newest on top, with **filter chips** — *All / Awaiting / Replied* (by whether you've answered) and a *Hide solved/closed* toggle (on by default) — plus a **"Show more"** button that loads one more month per click (up to 6). Replies arriving since your last click are flagged **New**; the list **persists across opens** (opening only resets the count, it never empties the list). Left-click a row to open the ticket in Zendesk; **right-click to read the full reply in a centered fullscreen popup**.
- **Rocketlane notifications** below: actor, action, chat-message preview, and a relative time ("8m ago"). Left-click opens it in Rocketlane; **right-click reads the full message fullscreen** (Esc / × / backdrop closes).
- **Incremental fetch cache — only changed/new data loads.** Each Zendesk ticket's latest incoming reply is cached keyed by the ticket's `updated_at` (`zendesk_ticket_cache_v3`, capped, localStorage). A repeat fetch still runs the one cheap search to learn what changed, but only tickets whose `updated_at` actually changed re-hit the comments API — verified live: 14 comment calls on a cold fetch, **0** on the next when nothing changed. Author names are cached by id (`zendesk_author_cache_v1`); Rocketlane group fetches are de-duped for ~10s so the badge poll and a drawer-open don't double-fetch.

### Auto-find buttons (🔎)
The Edit project dialog has a **🔎 Find** button next to the Oneflow / HubSpot / Younium link fields. Each one extracts the plant ID prefix from the project name and searches the corresponding system:

| Field | Endpoint | Match strategy |
|---|---|---|
| Oneflow | `GET /api/agreements/?q=<plantId>` | Plant-ID prefix +50, name token overlap +0..30, partner in parties +20. Threshold ≥60 + clear-lead. |
| HubSpot | `POST /api/crm-search/search` (objectTypeId `0-3`) | Plant ID anywhere in `dealname` +50, token overlap +0..30, partner in name +20. Same threshold logic. |
| Younium | `POST /api/data/query/order` | Native `plant_id` field — exact string match. 1 match → auto-fill; 2+ → picker (newest first). |

High-confidence matches fill the URL automatically; multiple candidates show an inline picker.

### Younium status chip (per project)

A status chip in the project header meta row (between the **Updated** and **RL sync** chips) showing the verdict for the project's Younium order + subscription state. Styled identically to the sibling chips — pill shape, 11.5px font, color tint per verdict (green / yellow / red / gray).

| Color / label | When |
|---|---|
| 🟢 `Younium: ✓ All good` | Order Invoiced AND IWMAC subscription Active |
| 🟢 `Younium: ✓ Invoiced (one-time)` | Order Invoiced, no IWMAC subscription product |
| ⏳ `Younium: ⏳ Awaiting first invoice` | Order present, no posted invoices yet |
| ⏳ `Younium: ⏳ Subscription starts <date>` | Subscription start date is in the future |
| ⚠ `Younium: ⚠ Activate order in Younium` | Order is Draft — needs activation |
| ⚠ `Younium: ⚠ Activate subscription in Younium` | IWMAC subscription is Draft — needs activation |
| ⚠ `Younium: ⚠ Status uncertain` | Data incomplete |
| ✗ `Younium: ✗ Cancelled` / `✗ Expired` | Terminal — can't recover |
| ⏳ `Younium: ⏳ Checking…` | Verdict is being fetched |

**Clicking the chip** opens a fullscreen modal with:
- **Status summary** — action-oriented one-liner (e.g. "Action needed: Subscription is in Draft state. Activate it in Younium to start invoicing.")
- **Warnings panel** — only when problems exist
- **Order / offer** section — Younium link, IDs, name, status (color-coded ✓), invoice status, dates, Created by / Last updated by
- **Subscription** section — found via plant_id lookup, shows IWMAC product status + dates + Created by / Last updated by
- **Other orders for this plant** section — compact rows for sibling orders (Younium versions orders, so a single plant can have multiple records)

**Subscription detection**: a Younium order is treated as an IWMAC subscription when (a) any product on the order has a name matching the strict pattern `/\bIWMAC\s*(?:Abonnement|Subscription)\b/i` — i.e. literally `IWMAC Subscription` or `IWMAC Abonnement`, NOT `IWMAC Modul / Product` (those are Order/Offer line items, not subscription evidence) — OR (b) we find such an order via the `plant_id` custom field. **All three entry paths now run the plant_id fallback**: when the saved URL points to an Order, a Quote, OR is empty entirely. For projects with no saved Younium link, the plant's most-recently-modified `isLastVersion=true` order is automatically promoted into the Order/Offer section so the modal is never blank.

**Audit attribution** (bridge v1.9.11+): `Created by` and `Last updated by` rows come from the Younium event log endpoint (`GET /api/eventlog/order/id/{id}`). First/latest events sorted by timestamp.

**Read-only**: the modal never writes to Younium. No invoicing, no activation, no link overwrites.

### Per-platform bridges (Tampermonkey userscript v1.9.11+)

All four cookie/JWT bridges share the same auto-retry contract: on 401, the bridge fires one credential-refresh call (Zendesk's renew-session header, Oneflow's `/positions/me` warmup, HubSpot's `/login-verify/v1/info` warmup, or Younium's Frontegg token mint) and retries the original request exactly once before giving up. You shouldn't see "session expired" errors as long as you have the relevant tab open or — for Younium — a valid Frontegg refresh cookie.



| Platform | Auth model | Capture |
|---|---|---|
| Rocketlane | api-key in `localStorage.__api_key` | UUID + userId from the parsed array, stored in `GM_setValue("rlApiKey")`. |
| Zendesk | HttpOnly session cookie + CSRF in meta tag | `<meta name="csrf-token">` value re-captured every 60s when an `iwmac.zendesk.com` tab is open. |
| Oneflow | HttpOnly session cookie + `xsrf-token` cookie (Spring-style double-submit) | Cookie value via `document.cookie`, refreshed every 60s. |
| HubSpot | HttpOnly session cookie + `hubspotapi-csrf` cookie + portal ID | Portal ID extracted from URL path, CSRF from cookie, hublet host (US vs EU) from `location.origin`. |
| Younium | Frontegg HttpOnly refresh cookie → JWT bearer | Bridge calls `/frontegg/.../token/refresh` on demand and caches the 24h-lived access token. Region (eu/us) captured from page hostname. |

All bridges route through `GM_xmlhttpRequest`, which is exempt from CORS — no tokens are stored in the tracker HTML.

## Architecture overview

| Component | Where it lives |
|---|---|
| App UI + API clients | `Project Progress Tracker.html` (single file, no build) |
| Cross-origin bridge | `rocketlane-chat-bridge/rocketlane-chat-bridge.user.js` (Tampermonkey userscript v1.9.11+) |
| State storage | Browser `localStorage` (per-browser, never leaves the device) |
| Per-platform secrets | Tampermonkey GM storage (never embedded in HTML) |

The bridge is required for **any** cross-origin API call from `github.io` or `file://`. The tracker on `github.io` has a CORS-allowed direct-fetch path to Rocketlane's tenant API as an optimisation, but for Zendesk / Oneflow / HubSpot / Younium the bridge is the only option (their CORS policies only allow same-origin).

## Install

### 1. Download the tracker HTML (or use the live URL)

- **Live URL** (auto-updates): https://hapnes-dev.github.io/Project-Progress-Tracker/
- **Local file**: download `Project Progress Tracker.html` from this repo and open it from your Desktop.

### 2. Install Tampermonkey (Chrome extension)

[Tampermonkey Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).

### 3. Install the Rocketlane Chat Bridge userscript (covers all five integrations)

**One-click install (recommended — auto-updates):**

👉 [**Install Rocketlane Chat Bridge**](https://raw.githubusercontent.com/hapnes-dev/tampermonkey-scripts/main/rocketlane-chat-bridge/rocketlane-chat-bridge.user.js)

Despite the name, this single userscript also bridges Zendesk, Oneflow, HubSpot, and Younium. Tampermonkey will open an install prompt — confirm **Install**. The script auto-updates on every push.

The userscript is hosted in a separate repo: [Hapnes-dev/tampermonkey-scripts → rocketlane-chat-bridge](https://github.com/Hapnes-dev/tampermonkey-scripts/tree/main/rocketlane-chat-bridge).

### 4. Enable file URL access (only for local file mode)

`chrome://extensions` → Tampermonkey → Details → **Allow access to file URLs**.

Skip this if you only use the live GitHub Pages URL.

### 5. Visit each platform once while logged in

Each bridge captures auth state from the user's existing session — you don't paste any keys. Just visit these once after installing the userscript:

| Visit | Why |
|---|---|
| `https://kiona.rocketlane.com` | Capture api-key from `localStorage.__api_key`. |
| `https://iwmac.zendesk.com` | Capture CSRF token from `<meta name="csrf-token">`. |
| `https://app.oneflow.com` | Capture `xsrf-token` cookie value. |
| `https://app-eu1.hubspot.com` (or `app.hubspot.com` for US) | Capture portal ID + CSRF cookie + hublet host. |
| `https://eu.younium.com` (or `us.younium.com`) | Record region; bridge mints JWTs from there. |

Refresh the tracker — all five integrations should now work.

The Rocketlane key auto-renews; Zendesk & Oneflow re-capture their CSRF every 60s while their tabs are open; HubSpot does the same for CSRF + portal; Younium mints fresh JWTs on demand and caches them for 24h.

## Day-to-day usage

- **Refresh** projects: click **Sync** in the toolbar (or wait — auto-sync runs every 5 min).
- **Refresh one project**: click anywhere on the project card → instant background sync.
- **Add Rocketlane projects**: **+ RL Project** in the toolbar, paste the URL.
- **View chat**: select a project → "Chat history" → Private or General tab.
- **Send a chat message**: type in the compose box; Enter sends, Shift+Enter for newline. Paste an image with Ctrl+V or click 📎. Type `@` to mention.
- **Expand chat fullscreen**: click ⤢ in the chat header or right-click the chat area.
- **Project files**: 📁 Files in the toolbar.
- **Notifications**: 🔔 in the toolbar — a combined Rocketlane + Zendesk unread count. Click to open the drawer (resets the count but keeps the list); right-click any comment/reply to read it fullscreen.
- **Add a task**: scroll to a category → **+ Add task**. Created locally AND in Rocketlane in the same phase.
- **Remove a task**: **Remove** next to the task. If linked, ⚠ confirms upstream delete.

### Zendesk Tasks (per project)
- Section appears in projects whose name starts with a numeric plant ID.
- **Click a ticket** → inline preview of the latest comment.
- **Right-click anywhere on the ticket card** → fullscreen with full thread + reply compose.
- Public reply / Internal note toggle; **Ctrl+Enter** sends.

### Owner Workload Overview
- Click any teammate's pill to set their workload (syncs to other tracker users via the meta-project).
- Click a section header chevron to collapse / expand.

### Edit project dialog — auto-find external links
- **🔎 Find** next to each link field searches the corresponding system and auto-fills the URL (or shows a picker if multiple candidates).
- On **Save**, the project's Rocketlane "Hubspot Deal Description" field is updated with a `Links:` block listing the populated Oneflow / Younium / HubSpot URLs.

## Data & privacy

- All app state stays in your browser's `localStorage` (key: `progress_tracker_state_v1`).
- **No api keys or secrets are embedded in the HTML.** Tokens / cookies / CSRF values live only in Tampermonkey's GM storage and the browser's cookie jar.
- No telemetry, no analytics, no external services besides the integrated platforms themselves.
- The "Local-only" rule:
  - **Project remove** never deletes from Rocketlane — only hides locally.
  - **Owner renames** and **category renames / removal** never sync upstream.
  - **Task removal** DOES sync upstream when the task is linked — with a loud ⚠ confirm first.
  - All other edits (status, due date, links, notes, task add) DO push to Rocketlane.

## Security model

- **Bridge `@match` allowlist**: `kiona.rocketlane.com`, `iwmac.zendesk.com`, `app.oneflow.com`, `app.hubspot.com`, `app-eu1.hubspot.com`, `eu.younium.com`, `us.younium.com`, `app.younium.com`, `file:///*`, `https://hapnes-dev.github.io/Project-Progress-Tracker/*`.
- The broad `file:///*` match is **gated by a meta tag** — the bridge only publishes its API to `file://` pages that include `<meta name="rocketlane-tracker" content="hapnes-dev/Project-Progress-Tracker">`. Any other local HTML you open gets nothing.
- Tokens / cookies are never logged in plaintext; diagnostic logs only report presence + length.
- Untrusted HTML (Rocketlane chat, Zendesk comments, mention markup, notification previews) is sanitised through strict allowlists before insertion into the DOM.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `RocketlaneBridge` undefined | Install Tampermonkey + userscript; for local file: enable "Allow access to file URLs" in Tampermonkey's extension settings. |
| Bridge installed but data empty | Visit each platform's page once while logged in (see Install step 5). |
| 401 errors in console | Bridge tries to auto-renew on the very next attempt. If you still see 401, the underlying session is dead — log back into the relevant platform tab and retry. |
| Younium calls fail with "session expired" | Visit `eu.younium.com` once; the Frontegg refresh cookie is needed for JWT minting. |
| HubSpot Find returns "CSRF token not captured" | Visit any `app-eu1.hubspot.com` page once. |
| Zendesk Tasks shows "bridge unavailable" | Update bridge to v1.9.0+ and visit `iwmac.zendesk.com` once. |
| Save doesn't fill "Hubspot Deal Description" | Update tracker to commit `2c08956`+ (tenant-fields fallback for projects where the field hasn't been written yet). |
| Add task creates phaseless task | Update bridge to v1.8.1+ AND hard-refresh — older code sent `phase: {...}` instead of `projectPhase: {...}`. |

For deeper diagnostics in DevTools:
- `window.__rlSyncStats.ticks` — recent auto-sync outcomes
- `window.__zd.csrf()` — Zendesk CSRF capture status
- `window.__of.csrf()` — Oneflow CSRF capture status
- `window.__hs.csrf()` — HubSpot CSRF + portal capture status
- `window.__yn.token()` — Younium JWT cache status

## Project structure

```
project-progress-tracker/
├── Project Progress Tracker.html       # The entire app
├── index.html                          # Identical copy for GitHub Pages
├── rocketlane-chat-bridge/
│   ├── rocketlane-chat-bridge.user.js  # Local snapshot of the bridge (canonical copy lives in Hapnes-dev/tampermonkey-scripts)
│   └── README.md                       # Bridge-specific docs
├── README.md                           # This file
└── CLAUDE.md                           # Architecture notes for Claude Code
```

## License

Private — see repo settings.
