# Project Progress Tracker

A single-file HTML dashboard for tracking project delivery progress, with deep integration into [Rocketlane](https://www.rocketlane.com/) for syncing project data, chat history, attachments, and notifications.

## 🌐 Try it live

**[hapnes-dev.github.io/Project-Progress-Tracker](https://hapnes-dev.github.io/Project-Progress-Tracker/)**

The hosted version always runs the latest commit on `main`. State is still stored in *your* browser's `localStorage` — nothing leaves your device. You still need to install the Tampermonkey bridge below for Rocketlane integration to work.

Prefer a local copy? Download `Project Progress Tracker.html` and open it from your desktop — it works the same way.

## Features

- **Project list with status pills, owner grouping, sorting & filtering**
- **Per-project detail view**: notes, status, due dates, custom links (Zendesk / Oneflow / Younium / HubSpot / Rocketlane), task categories with sub-tasks
- **Rocketlane sync**: pulls projects, tasks, owners, statuses, and the Hubspot Deal Description field; bidirectional for project links
- **Chat history viewer**: live private + general chats, file attachments, inline image previews, lightbox, sortable Project Files browser, compose box with image paste + file upload
- **Notifications drawer**: bell icon in the toolbar with unread badge; Rocketlane-style left-side panel with filter chips (All / Tasks I'm assigned to / Mentions / Assigned to the team)
- **Fullscreen modes**: chat history, notes, task details — all toggleable via right-click or dedicated buttons, dismissible via Esc / mouse back-button / close button
- **Owner workload overview**: per-owner project counts and in-progress totals
- **Plant ID quick-link**: project titles with a numeric prefix open Pang automatically

## Architecture overview

| Component | Where it lives |
|---|---|
| App UI + Rocketlane API client | `Project Progress Tracker.html` (single file, no external dependencies beyond fonts) |
| Cross-origin / `file://` bridge | `rocketlane-chat-bridge/rocketlane-chat-bridge.user.js` (Tampermonkey userscript) |
| State storage | Browser `localStorage` (per-browser, never leaves the device) |

The bridge is required for any cross-origin Rocketlane API call (chat, attachments, notifications) because the tracker page is loaded from a `file://` URL and the browser's CORS policy blocks direct `fetch()` to `kiona.api.rocketlane.com`. The userscript runs with `GM_xmlhttpRequest` which is exempt from CORS.

## Install

### 1. Download the tracker HTML

Save `Project Progress Tracker.html` from this repo anywhere on your computer (typically `Desktop/`). Double-click it — it should open in Chrome.

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

### 4. Enable file URL access

The userscript needs to inject `window.RocketlaneBridge` into the local HTML page:

1. Open `chrome://extensions`
2. Find **Tampermonkey** → click **Details**
3. Toggle **Allow access to file URLs** → **ON**

### 5. Capture your Rocketlane session

1. Open [https://kiona.rocketlane.com](https://kiona.rocketlane.com) and log in once.
2. The userscript automatically captures your API key + userId from `localStorage.__api_key` and stores them in Tampermonkey's persistent storage.
3. Refresh `Project Progress Tracker.html` — chat, attachments, and notifications should now work.

### 6. (Optional) Tenant customization

If your Rocketlane tenant is not `kiona.rocketlane.com`, edit the userscript's `@match` directives and the `TENANT_API` constant at the top, then save.

## Day-to-day usage

- **Refresh** projects: click **Sync** in the toolbar.
- **Add Rocketlane projects**: click **+ RL Project** in the toolbar, paste the URL.
- **View chat**: select a project → scroll to "Chat history" → click Private or General tab.
- **Send a message**: type in the compose box; Enter sends, Shift+Enter for a new line. Paste an image with Ctrl+V or click the 📎 to attach a file.
- **Expand chat fullscreen**: click the ⤢ in the chat header, or right-click the chat area.
- **Project files**: click 📁 Files in the toolbar of a selected project — sortable list with image previews and PDF lightbox.
- **Notifications**: click the 🔔 in the toolbar; left-side drawer with filter chips. Click any notification to open it in Rocketlane.

## Data & privacy

- All state stays in your browser's `localStorage` (key: `progress_tracker_state_v1`).
- The Rocketlane API key is held only by the Tampermonkey extension (not embedded in the HTML).
- No telemetry, no analytics, no external services besides Rocketlane itself.
- The "Local-only" rule: owner renames, task removal, and category removal never sync back to Rocketlane — they only modify your local copy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chat fetch shows "Rocketlane bridge unavailable" | Install Tampermonkey + userscript (steps 2–3), enable file URL access (step 4). |
| Bridge installed but chat empty | Visit `kiona.rocketlane.com` once while logged in so the userscript can capture the session key. |
| 401 errors in the console | Session expired — log back into Rocketlane and refresh the tracker. |
| `RocketlaneBridge is undefined` on tracker DevTools | "Allow access to file URLs" not enabled in Tampermonkey's extension settings. |
| Files don't download | Userscript must include the AWS hosts in `@connect` — see the script header. |

## Project structure

```
project-progress-tracker/
├── Project Progress Tracker.html       # The entire app
├── rocketlane-chat-bridge/
│   └── rocketlane-chat-bridge.user.js  # Tampermonkey userscript bridge
├── README.md                           # This file
└── CLAUDE.md                           # Architecture notes for Claude Code
```

## License

Private — see repo settings.
