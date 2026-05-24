# Project Progress Tracker

A single-file HTML dashboard for tracking project delivery progress, with deep integration into [Rocketlane](https://www.rocketlane.com/) for syncing project data, chat history, attachments, and notifications.

## 🌐 Try it live

**[hapnes-dev.github.io/Project-Progress-Tracker](https://hapnes-dev.github.io/Project-Progress-Tracker/)**

The hosted version always runs the latest commit on `main`. State is still stored in *your* browser's `localStorage` — nothing leaves your device. You still need to install the Tampermonkey bridge below for Rocketlane integration to work.

Prefer a local copy? Download `Project Progress Tracker.html` and open it from your desktop — it works the same way.

## Features

- **Project list with status pills, owner grouping, sorting & filtering**
- **Per-project detail view**: notes, status, due dates, custom links (Zendesk / Oneflow / Younium / HubSpot / Rocketlane), task categories with sub-tasks
- **Per-project toolbar shortcuts**: 🚀 Rocketlane, 📁 Files, 📦 Order info, ☄️ PANG (plant control), 👥 BAF (user database), Edit, Remove
- **Rocketlane sync (bidirectional where appropriate)**:
  - Pull on a **5-minute interval** when the tab is visible (resumes immediately on tab focus)
  - Push on any local data change (status, due, notes, tasks) within 2.5 seconds
  - **Click the "RL sync" chip** on any project to force a manual sync of just that one project
- **Add / remove tasks** that propagate to Rocketlane:
  - Add task in the tracker → appears in the same phase in Rocketlane
  - Remove a linked task → ⚠ confirms upstream delete before propagating
- **Chat history viewer**: live private + general chats, file attachments, inline image previews, lightbox, sortable Project Files browser, compose box with image paste + file upload
- **@-mention picker** in chat compose with project members, diacritic-insensitive search, blue mention chips (matching Rocketlane's native rendering)
- **Notifications drawer**: bell icon in the toolbar with unread badge; Rocketlane-style left-side panel with filter chips (All / Tasks I'm assigned to / Mentions / Assigned to the team); rich preview rendering with `:emoji:` decoding and mention chips
- **Fullscreen modes**: chat history, notes, task details — all toggleable via right-click or dedicated buttons, dismissible via Esc / mouse back-button / close button
- **Owner workload overview**: per-owner project counts and in-progress totals
- **Plant ID quick-link**: project titles with a numeric prefix open Pang automatically

## Architecture overview

| Component | Where it lives |
|---|---|
| App UI + Rocketlane API client | `Project Progress Tracker.html` (single file, no external dependencies beyond fonts) |
| Cross-origin / `file://` bridge | `rocketlane-chat-bridge/rocketlane-chat-bridge.user.js` (Tampermonkey userscript v1.8.1+) |
| State storage | Browser `localStorage` (per-browser, never leaves the device) |
| Rocketlane session key | Tampermonkey GM storage (never embedded in HTML) |

The bridge is required for **any** cross-origin Rocketlane API call (chat, attachments, notifications, task create/delete, etc.) because the tracker page is loaded from a `file://` or `https://github.io` URL and the browser's CORS policy blocks direct `fetch()` to `kiona.api.rocketlane.com`. The userscript runs with `GM_xmlhttpRequest` which is exempt from CORS.

## Install

### 1. Download the tracker HTML (or use the live URL)

- **Live URL** (auto-updates): https://hapnes-dev.github.io/Project-Progress-Tracker/
- **Local file**: download `Project Progress Tracker.html` from this repo to your Desktop and double-click — opens in Chrome.

### 2. Install Tampermonkey (Chrome extension)

[Tampermonkey Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).

### 3. Install the Rocketlane Chat Bridge userscript

**One-click install (recommended — auto-updates):**

👉 [**Install Rocketlane Chat Bridge**](https://raw.githubusercontent.com/hapnes-dev/tampermonkey-scripts/main/rocketlane-chat-bridge/rocketlane-chat-bridge.user.js)

Click the link above. Tampermonkey will open an install prompt — confirm **Install**. The script will auto-update whenever a new version is pushed.

The userscript is hosted in a separate repo: [Hapnes-dev/tampermonkey-scripts → rocketlane-chat-bridge](https://github.com/Hapnes-dev/tampermonkey-scripts/tree/main/rocketlane-chat-bridge).

<details>
<summary>Manual install (without auto-update)</summary>

1. Open the Tampermonkey dashboard (puzzle icon → Tampermonkey → Dashboard).
2. Click the **+** tab to create a new script.
3. Open `rocketlane-chat-bridge/rocketlane-chat-bridge.user.js` from this repo in a text editor.
4. Select all (Ctrl+A) → copy → paste into Tampermonkey → **File → Save** (Ctrl+S).

This copy doesn't auto-update — you'll need to manually paste new versions when this repo's bridge file changes.
</details>

### 4. Enable file URL access (only if running from a local file)

The userscript needs to inject `window.RocketlaneBridge` into the local HTML page:

1. Open `chrome://extensions`
2. Find **Tampermonkey** → click **Details**
3. Toggle **Allow access to file URLs** → **ON**

> **Note:** If you only use the live URL (`https://hapnes-dev.github.io/...`), you can skip this step.

### 5. Capture your Rocketlane session

1. Open [https://kiona.rocketlane.com](https://kiona.rocketlane.com) and log in once.
2. The userscript automatically captures your api-key + userId from `localStorage.__api_key` and stores them in Tampermonkey's persistent storage.
3. Refresh the tracker — chat, attachments, notifications, and write actions should now all work.

The key auto-renews — visit any Rocketlane page while logged in and the bridge re-captures within seconds.

### 6. (Optional) Tenant customization

If your Rocketlane tenant is not `kiona.rocketlane.com`, edit the userscript's `@match` directives and the `TENANT_API` constant at the top, then save.

## Day-to-day usage

- **Refresh** projects: click **Sync** in the toolbar (or just wait — auto-sync runs every 5 min).
- **Refresh one project**: click the **RL sync** chip on the project's detail panel.
- **Add Rocketlane projects**: click **+ RL Project** in the toolbar, paste the URL.
- **View chat**: select a project → scroll to "Chat history" → click Private or General tab.
- **Send a message**: type in the compose box; Enter sends, Shift+Enter for a new line. Paste an image with Ctrl+V or click the 📎 to attach a file. Type `@` to mention a teammate.
- **Expand chat fullscreen**: click the ⤢ in the chat header, or right-click the chat area.
- **Project files**: click 📁 Files in the toolbar of a selected project — sortable list with image previews and PDF lightbox.
- **Notifications**: click the 🔔 in the toolbar; left-side drawer with filter chips. Click any notification to open it in Rocketlane.
- **Add a task**: scroll to a category → click **+ Add task** → type the name. The task is created locally AND in Rocketlane in the same phase.
- **Remove a task**: click **Remove** next to the task. If linked to Rocketlane, you get an explicit ⚠ warning before propagating the delete upstream.

## Data & privacy

- All app state stays in your browser's `localStorage` (key: `progress_tracker_state_v1`).
- **No api keys or secrets are ever embedded in the HTML.** The Rocketlane session key lives only in the Tampermonkey extension's GM storage.
- No telemetry, no analytics, no external services besides Rocketlane itself.
- The "Local-only" rule:
  - **Project remove** never deletes from Rocketlane — only hides locally.
  - **Owner renames**, **category renames**, and **category removal** never sync upstream.
  - **Task removal** DOES sync upstream when the task is linked — with a loud ⚠ confirmation first.
  - All other edits (status, due date, links, notes, task add) DO push to Rocketlane.

## Security model

- The bridge userscript ships with a tight `@match` list: `https://kiona.rocketlane.com/*`, `file:///*`, and `https://hapnes-dev.github.io/Project-Progress-Tracker/*`.
- The `file:///*` match is the broadest — it would normally inject `window.RocketlaneBridge` into ANY local HTML file. To prevent this:
  - The tracker declares itself via `<meta name="rocketlane-tracker" content="hapnes-dev/Project-Progress-Tracker">`.
  - The bridge **only publishes the bridge object on `file://` URLs when that meta tag is present**.
  - Any other local HTML file you open gets no bridge access — your session key stays scoped to the tracker.
- The session key is never logged in plaintext; diagnostic logs only report presence + length.
- Untrusted Rocketlane HTML (chat messages, mention markup, notification previews) is sanitized through a strict allowlist before insertion.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chat fetch shows "Rocketlane bridge unavailable" | Install Tampermonkey + userscript (steps 2–3); enable file URL access (step 4) if running locally. |
| Bridge installed but chat / tasks empty | Visit `kiona.rocketlane.com` once while logged in so the userscript can capture the session key. |
| 401 errors in the console | Session expired — log back into Rocketlane and the bridge will auto-renew. |
| `window.RocketlaneBridge is undefined` on tracker DevTools | (a) "Allow access to file URLs" not enabled in Tampermonkey's extension settings, OR (b) you've opened the tracker in a private/incognito window without the extension enabled. |
| Files don't download | Userscript must include the AWS hosts in `@connect` — re-install the bridge from the @downloadURL above if you've edited an older copy. |
| Add task creates the task in Rocketlane but with no phase | Update bridge to v1.8.1+ AND hard-refresh the tracker. Older code sent `phase: {...}` instead of `projectPhase: {...}` and Rocketlane silently dropped the field. |

For deeper diagnostic info, check `window.__rlSyncStats.ticks` in DevTools for recent auto-sync outcomes.

## Project structure

```
project-progress-tracker/
├── Project Progress Tracker.html       # The entire app
├── index.html                          # Identical copy for GitHub Pages
├── rocketlane-chat-bridge/
│   ├── rocketlane-chat-bridge.user.js  # Tampermonkey userscript bridge
│   └── README.md                       # Bridge-specific docs
├── README.md                           # This file
└── CLAUDE.md                           # Architecture notes for Claude Code
```

## License

Private — see repo settings.
