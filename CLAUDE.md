# Claude Code context

This file is read by Claude Code on every session start. It documents the architecture, patterns, and gotchas of the Project Progress Tracker so future sessions can move fast without re-discovering the same lessons.

## Tech stack

- **Vanilla HTML + CSS + JS** in a single file: `Project Progress Tracker.html` (~18k lines).
- No build step, no framework, no bundler. All state in `localStorage`.
- **Tampermonkey userscript** bridge (`rocketlane-chat-bridge/`) for cross-origin Rocketlane API calls from a `file://` page.
- Designed to run from a `file://` URL on the user's desktop.

## File layout inside `Project Progress Tracker.html`

| Approximate line range | Section |
|---|---|
| 1–4000 | CSS (light + dark, status pills, layout primitives, chat styles, dialogs) |
| 4000–4500 | HTML body markup (toolbar, panels, dialogs) |
| 4500–6500 | State management, types, normalizers, status helpers |
| 6500–7500 | Rocketlane API helpers (fetch, request signing, field lookups) |
| 7500–10000 | Owner load + sync logic |
| 10000–12500 | Render orchestration (`render()`, `renderList`, `renderOwnerStatusOverview`, `renderDetail`) |
| 12500–14000 | `renderDetail` body — notes, chat history, Rocketlane integration |
| 14000–15500 | Task category rendering (`.areaBox`), task expand UI, status picker |
| 15500–17500 | Dialogs (edit project, Younium import), context menus, notifications drawer |
| 17500–end | Event wiring, sync timers, file-load handlers |

## Key conventions

### Rendering model
- One global `render()` function rebuilds owner overview + project list + detail panel.
- `renderDetail()` constructs the entire detail panel offscreen in a `root` div, then atomically swaps it into `els.detailBody` with `innerHTML = ""` + `appendChild(root)`.
- Most user actions trigger a `render()` call. Some local-only actions (task expand/collapse, category expand/collapse, scroll, owner-group collapse) skip render and just toggle a class or rebuild a small subtree.

### State persistence
- `state` is the in-memory app state; persisted to `localStorage` under `progress_tracker_state_v1` via `saveState(state)`.
- UI-only state (sort/filter/search prefs, chat scroll positions, expanded task IDs, expanded categories per project) lives in separate `localStorage` keys or in-memory Sets.
- `touchProject(id)` updates `updatedAt` AND queues a Rocketlane sync.
- `touchProjectLocal(id)` updates `updatedAt` ONLY — does not sync. Used for owner renames, task removal, category removal.

### Rocketlane integration
- API base: `https://kiona.api.rocketlane.com/api/v1`
- Auth: api-key header (UUID stored in Tampermonkey GM storage as `rlApiKey`)
- Bridge methods in `RocketlaneBridge`:
  - `listProjectConversations(projectId)`
  - `fetchChatComments(projectId, conversationId)`
  - `postChatComment(projectId, conversationId, text, opts)`
  - `uploadAttachment(projectId, file, opts)`
  - `downloadAttachmentBlob(attachmentId)` — for files that can't be opened inline (zips, ai, etc.)
  - `fetchAttachment(attachmentId)` — regenerates the presigned URL (S3 URLs expire after 5 min)
  - `fetchProjectAttachments(projectId)` — for the Files popover
  - `fetchNotificationGroups()`, `getNotificationLastSeen()`, `markNotificationsSeen()`
- Tenant-specific custom field names use a numeric suffix: e.g., `HubspotDealDescription_480568`. Always match by `startsWith()` of the stable prefix.
- S3 URLs expire after ~5 minutes (X-Amz-Expires=299). Always re-fetch via `fetchAttachment(id)` right before opening a link.

### CSS conventions
- Dark mode + light mode via `@media (prefers-color-scheme: light)`.
- Use `var(--surface-1)`, `var(--surface-2)`, `var(--surface-3)`, `var(--hairline)`, `var(--hairline-strong)`, `var(--text)`, `var(--muted)`, `var(--muted2)`, `var(--accent)`, `var(--accent-soft)`, `var(--accent-stroke)`, `var(--bad)`, `var(--bad-soft)`, `var(--good)`, `var(--good-soft)`, `var(--warn)`, `var(--warn-soft)`.
- Floating panels (drawers, popovers, lightboxes) use opaque hex colors `#0f1424` (dark) / `#ffffff` (light) — not rgba — to avoid bleed-through.
- Animation easing: `cubic-bezier(0.16, 1, 0.3, 1)` for decelerate (open/reveal), `cubic-bezier(0.4, 0, 0.6, 1)` for ease-in-out (close/symmetric).

### Avoid `contain: layout` on items with positioned descendants
- `contain: layout` creates a stacking context. If you put it on `.task`, the status picker dropdown can no longer paint over neighboring task rows. Use it sparingly and never on elements that contain absolute-positioned menus.

### Dropdown menu z-index
- Status picker menu: `z-index: 1500` on both `.statusPicker.open` and `.statusMenu` to ensure they float above sibling rows.

## Gotchas

### Render rebuilds break in-flight animations
- Any animation that takes >1 frame can be interrupted by `render()`. For DOM that gets rebuilt on every render (chat, categories, tasks), prefer instant state changes or use one-shot CSS keyframes triggered by class markers on the new DOM.

### Chat scroll preservation across renders
- `renderDetail()` rebuilds the chat body element. Auto-scroll to bottom must happen **after** `appendChild(root)` runs, not inside `renderMsgs()` (where chatBody is still detached and `scrollTop` is a no-op).
- Cache per-tab scroll position in `getRlChatCache(projectId).scrollByKind` and restore in the post-swap block.
- Auto-scroll to bottom only on fresh fetch (`justLoaded` class). Cache replays should restore the user's previous position.

### Mouse back-button as close gesture
- For fullscreen overlays (chat, notes, task), listen for `mousedown` with capture phase AND `auxclick` AND `popstate` — different browsers route the side-button differently.
- Push `history.pushState({...sentinel...})` when opening, `history.back()` when closing via user action. Skip the `history.back()` if the close was already triggered by a `popstate`.

### Tampermonkey `@connect` allowlist
- The userscript can only call hosts listed in `@connect`. For file downloads via S3, this MUST include `s3.us-east-1.amazonaws.com`, `s3.amazonaws.com`, and `amazonaws.com`. Adding a new host requires re-saving the script, and Tampermonkey may prompt the user to approve.

### File:// page CORS
- `fetch()` from a `file://` page is blocked from cross-origin requests. ALL Rocketlane API calls go through `RocketlaneBridge` which proxies via `GM_xmlhttpRequest`.

## Common tasks and where to look

### Add a new Rocketlane field
1. Add `rocketlaneFetch<FieldName>(rlProjectId)` and `rocketlaneUpdate<FieldName>(rlProjectId, fieldId, value)` helpers near line 6000.
2. Match field by prefix in `rocketlaneFindProjectNotesField` / similar pattern.
3. Hook into `openDlgEdit` to fetch on open + `els.projectForm` submit handler to push on save.

### Add a new notification type label
- `notifVerbFor(n)` in the notifications drawer — extend `verbMap` with the new `systemRuleIdentifier`.

### Change chat compose behavior
- The compose box is built around line 13300; `sendMessage()` handles upload + post; paste / drop handlers are nearby.

### Tweak the Files popover
- `els.btnOpenRocketlaneFiles.addEventListener("click", ...)` around line 16140.

## Things that DON'T sync to Rocketlane

By design, these are local-only — they modify your browser's copy without touching Rocketlane:

- Owner renames (`renameOwnerGroupEverywhere`)
- Task removal (`removeTask`)
- Category removal (`removeCategory`)
- Category and task UI expand/collapse state
- Owner workload pill (`state.ownerLoads`)
- Custom area labels

All other edits (status, due date, links, notes, etc.) DO push to Rocketlane via the sync logic.

## When working with Claude

- Prefer minimal, surgical edits. The file is large and any unrelated change is high-risk.
- Test changes in the browser using the Claude-in-Chrome extension when available (the user has it set up with file URL access).
- For animations: less is more. Multiple attempts at animating category expand/collapse have all caused glitches because `render()` rebuilds DOM. Instant toggle is the most reliable.
- The Rocketlane API has tenant-specific field IDs. Never hardcode them — always look up by name prefix.
