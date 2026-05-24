# Claude Code context

This file is read by Claude Code on every session start. It documents the architecture, patterns, and gotchas of the Project Progress Tracker so future sessions can move fast without re-discovering the same lessons.

## Tech stack

- **Vanilla HTML + CSS + JS** in a single file: `Project Progress Tracker.html` (~21k lines).
- No build step, no framework, no bundler. All state in `localStorage`.
- **Tampermonkey userscript** bridge (`rocketlane-chat-bridge/`) for cross-origin Rocketlane API calls from a `file://` or `https://github.io` page.
- Designed to run from either a `file://` URL on the user's desktop or `https://hapnes-dev.github.io/Project-Progress-Tracker/`.

## File layout inside `Project Progress Tracker.html`

| Approximate line range | Section |
|---|---|
| 1–4500 | CSS (light + dark, status pills, layout primitives, chat styles, dialogs, animations) |
| 4500–6200 | HTML body markup (toolbar, panels, dialogs, install modal) |
| 6200–6500 | State constants, storage keys, auth helpers (`getRocketlaneAuth`, `tryAutoSyncSessionKeyFromBridge`) |
| 6500–7500 | Rocketlane request layer (`rocketlaneRequestJson`, bridge routing, 401 auto-retry) |
| 7500–10000 | Owner-aware import + sync logic, body-shape builders for task/phase/project endpoints |
| 10000–12500 | Render orchestration (`render()`, `renderList`, `renderOwnerStatusOverview`, `renderDetail`) |
| 12500–14000 | `renderDetail` body — KPIs, notes, chat history, link toolbar, PANG/BAF buttons |
| 14000–15500 | Task category rendering (`.areaBox`), task expand UI, status picker, mention picker |
| 15500–17500 | Dialogs (edit project, Younium import), context menus, notifications drawer |
| 17500–end | Event wiring, sync timers, file-load handlers, install-prompt modal, init flow |

## Key conventions

### Rendering model
- One global `render()` function rebuilds owner overview + project list + detail panel.
- `render()` is wrapped in a window-scrollY-preserve harness so async re-renders don't yank the page mid-interaction.
- `renderDetail()` constructs the entire detail panel offscreen in a `root` div, then atomically swaps it into `els.detailBody` with `innerHTML = ""` + `appendChild(root)`.
- Most user actions trigger a `render()` call. Some local-only actions (task expand/collapse, category expand/collapse, scroll, owner-group collapse) skip render and just toggle a class or rebuild a small subtree.

### State persistence
- `state` is the in-memory app state; persisted to `localStorage` under `progress_tracker_state_v1` via `saveState(state)`.
- UI-only state (sort/filter/search prefs, chat scroll positions, expanded task IDs, expanded categories per project) lives in separate `localStorage` keys or in-memory Sets.
- `touchProject(id)` updates `updatedAt` AND queues a Rocketlane sync.
- `touchProjectLocal(id)` updates `updatedAt` ONLY — does not sync. Used for owner renames, category removal, task removal of unlinked tasks.

### Rocketlane integration
- **API base**: `https://kiona.api.rocketlane.com/api/v1` (tenant API; public `api.rocketlane.com` doesn't accept session keys)
- **Auth**: api-key header. Captured by the bridge from `localStorage.__api_key` on Rocketlane pages, stored as `rlApiKey` in Tampermonkey GM storage.
- **Auto-renew**: `tryAutoSyncSessionKeyFromBridge()` pulls the bridge's key into local storage on every auth check. 401 errors trigger one automatic retry after re-pulling.
- **All write calls route through the bridge** via `window.RocketlaneBridge.apiRequest(method, path, body)`. CORS blocks direct fetch from github.io / file://.
- **Bridge methods used**:
  - `apiRequest(method, path, body)` — generic; preferred for any new endpoint
  - `listProjectConversations`, `fetchChatComments`, `postChatComment` (uses `contentHtml` opt for @mentions)
  - `uploadAttachment`, `fetchAttachment`, `downloadAttachmentBlob`, `fetchProjectAttachments`
  - `fetchProjectMembers` (for @mention picker)
  - `fetchProjectFolders` (Files popover)
  - `fetchNotificationGroups({filter, status, count, groupSize, start, exclusions})` — pass `filter=Mentions` AND `filter=All` and merge for full coverage
  - `getNotificationLastSeen`, `markNotificationsSeen`
  - Synchronous accessors: `bridge.userId`, `bridge.apiKey`, `bridge.version`
- **Sync architecture** (poll + push):
  - **Pull**: `setInterval(rocketlaneMaybeRunLiveSync, 5 * 60 * 1000)` + immediate fire on `visibilitychange` when tab becomes visible.
  - **Push**: `touchProject(id)` → debounced `rocketlaneQueueSyncForProjectChange` → `rocketlaneMaybeRunLiveSync({force: true})`.
  - **Single-project sync**: `rocketlaneSyncLinkedProjectsNow({onlyProjectId})` — used by the clickable "RL sync" chip.
  - Cooldown: 30 seconds between non-forced syncs (so periodic + focus don't double-fire).
- **Tenant-specific custom field names** use a numeric suffix: e.g., `HubspotDealDescription_480568`. Always match by `startsWith()` of the stable prefix.
- **S3 attachment URLs** expire after ~5 minutes (X-Amz-Expires=299). Always re-fetch via `fetchAttachment(id)` right before opening a link.

### Rocketlane API field-name gotchas

The Rocketlane tenant API and public API use DIFFERENT field names. The tracker must accept BOTH on read but emit the TENANT shape on write.

| Public API | Tenant API (kiona.api.rocketlane.com) | Helper |
|---|---|---|
| `phaseId`, `phaseName` | `projectPhaseId`, `projectPhaseName` | `rocketlanePhaseId()`, `rocketlanePhaseName()` accept both |
| Task POST: `phase: {phaseId}` | Task POST: `projectPhase: {projectPhaseId}` | First body shape in `rocketlaneCreateTaskInRocketlane` is the tenant shape |
| Phases list: `/phases?projectId.eq=X` | Phases list: `/projects/{id}/phases` | `rocketlaneFetchPhasesForProject` tries the tenant endpoint first |

**Verified working task-create body** (from real curl test):

```json
POST /api/v1/tasks
{
  "taskName": "...",
  "project": { "projectId": 1113681 },
  "projectPhase": { "projectPhaseId": 4496756 },
  "startDate": "2026-05-01",
  "dueDate": "2026-06-30",
  "type": "Task"
}
```

### CSS conventions
- Dark mode + light mode via `@media (prefers-color-scheme: light)`.
- Use `var(--surface-1)`, `var(--surface-2)`, `var(--surface-3)`, `var(--hairline)`, `var(--hairline-strong)`, `var(--text)`, `var(--muted)`, `var(--muted2)`, `var(--accent)`, `var(--accent-soft)`, `var(--accent-stroke)`, `var(--bad)`, `var(--bad-soft)`, `var(--good)`, `var(--good-soft)`, `var(--warn)`, `var(--warn-soft)`.
- Floating panels (drawers, popovers, lightboxes) use opaque hex colors `#0f1424` (dark) / `#ffffff` (light) — not rgba — to avoid bleed-through.
- Animation easing: `cubic-bezier(0.4, 0, 0.2, 1)` for Material standard; `cubic-bezier(0.16, 1, 0.3, 1)` for expo-out (decelerate). FLIP-style layout animations use the standard curve; per-element clip-path reveals use expo-out.

### Avoid `contain: layout` on items with positioned descendants
- `contain: layout` creates a stacking context. If you put it on `.task`, the status picker dropdown can no longer paint over neighboring task rows. Use it sparingly and never on elements that contain absolute-positioned menus.

### Dropdown menu z-index
- Status picker menu: `z-index: 1500` on both `.statusPicker.open` and `.statusMenu`.
- Mention picker popup: `z-index: 1500`, `position: fixed`, appended to `document.body` to escape `overflow:hidden` of the compose box.

### Mention chip styling
- Chips use `class="rl__mention"` (and `rl__mention__self` for self-mentions) — Rocketlane's native class names.
- The tracker overrides Rocketlane's lavender/blue colors with its own dark-theme palette via CSS scoped to those class names.
- `::before { content: "@" }` adds the `@` glyph visually without modifying the underlying text (Rocketlane stores the bare name).

## Gotchas

### Bridge body-shape ordering
- `rocketlaneCreateTaskInRocketlane` tries multiple body shapes. The **tenant-correct shape** (`projectPhase: {projectPhaseId}`) MUST be tried first — Rocketlane silently accepts the legacy `phase: ...` shape and returns 201 but creates a **phaseless task**. The loop then thinks it succeeded and never tries the correct shape.
- When the project has assignees, an assignee-aware prefix is prepended. That prefix MUST also use the tenant shape first; previously it used the legacy shape which caused all assigneed projects to create phaseless tasks.

### Render rebuilds break in-flight animations
- Any animation that takes >1 frame can be interrupted by `render()`. For DOM that gets rebuilt on every render (chat, categories, tasks), prefer instant state changes or use one-shot CSS keyframes triggered by class markers on the new DOM.
- The categories grid uses **instant layout change** (no transition) because attempted FLIP / View Transitions / scaleY animations all caused jitter from async re-renders fired by the sync layer.

### Chat scroll preservation across renders
- `renderDetail()` rebuilds the chat body element. Auto-scroll to bottom must happen **after** `appendChild(root)` runs, not inside `renderMsgs()` (where chatBody is still detached and `scrollTop` is a no-op).
- Sticky-bottom logic: if the user was near the bottom (within 40px) at the previous render, snap to the NEW bottom (handles "auto-sync arrived a new message, scroll down").
- Re-snap on every `<img>` `load` event for fresh fetches — image decode is async and grows `scrollHeight` AFTER the initial snap.

### Mouse back-button as close gesture
- For fullscreen overlays (chat, notes, task), listen for `mousedown` with capture phase AND `auxclick` AND `popstate` — different browsers route the side-button differently.
- Push `history.pushState({...sentinel...})` when opening, `history.back()` when closing via user action. Skip the `history.back()` if the close was already triggered by a `popstate`.

### Tampermonkey `@connect` allowlist
- The userscript can only call hosts listed in `@connect`. For file downloads via S3, this MUST include `s3.us-east-1.amazonaws.com`, `s3.amazonaws.com`, and `amazonaws.com`. Adding a new host requires re-saving the script, and Tampermonkey may prompt the user to approve.

### File:// page CORS + cross-context exposure
- `fetch()` from a `file://` page is blocked from cross-origin requests. ALL Rocketlane API calls go through `RocketlaneBridge` which proxies via `GM_xmlhttpRequest`.
- The bridge publishes `window.RocketlaneBridge` via `unsafeWindow` so the page can call it directly. To prevent ANY local HTML from inheriting bridge access:
  - The tracker declares `<meta name="rocketlane-tracker" content="hapnes-dev/Project-Progress-Tracker">`.
  - The bridge only publishes on `file://` URLs when that meta tag is present.
  - HTTPS targets are narrowly scoped by `@match` so no marker check needed there.

### Bridge cross-context publishing (forwarder fallback)
- On some Tampermonkey/browser combos, the userscript's `unsafeWindow.RocketlaneBridge = {...}` assignment doesn't propagate to the page's real window.
- The bridge probes via a synthetic `<script>` tag whether `window.RocketlaneBridge` is visible to the page. If not, it installs a `<script>`-tag forwarder that proxies method calls back via `CustomEvent`.
- Synchronous getters (`apiKey`, `userId`) work through unsafeWindow but NOT through the forwarder. The tracker has both a sync read path (preferred) and an async `getApiKey()` fallback.

### Notification rich preview
- The notifications drawer renders three preview sources in priority order: `meta.message.content` (chat), `meta.note` (automation), `meta.description` (task update).
- Emoji shortcodes (`<span class="emoji">:blush:</span>`) are decoded to Unicode chars via a 160-entry map before sanitization.
- The verb text is generated per `systemRuleIdentifier` (e.g., `CHANGE_PROJECT_STATUS` → `"changed project Status from X to Y"`) with embedded inline HTML for from/to labels, week ranges, etc.

## Common tasks and where to look

### Add a new Rocketlane field
1. Add `rocketlaneFetch<FieldName>(rlProjectId)` and `rocketlaneUpdate<FieldName>(rlProjectId, fieldId, value)` helpers near line 7000.
2. Match field by prefix in `rocketlaneFindProjectNotesField` / similar pattern.
3. Hook into `openDlgEdit` to fetch on open + `els.projectForm` submit handler to push on save.

### Add a new notification type label
- `notifVerbHtmlFor(n)` in the notifications section — extend the `switch (rule)` with the new `systemRuleIdentifier`. Return controlled HTML (inline `<em>`/`<strong>`) with `escapeHtml()` on every variable.

### Change chat compose behavior
- The compose box is built around line 14800; `sendMessage()` handles upload + post; the @mention picker is at line 14900+; paste / drop handlers near the compose textarea.

### Add a new toolbar button next to PANG/BAF
- HTML markup: search for `id="btnOpenPang"` and clone the pattern.
- `els` registry: add to the `getElementById` block.
- Show/hide logic: in `renderDetail` near the PANG/BAF show block — gate on whatever condition the new button needs.
- Click handler: in the event-wiring section near `els.btnOpenPang.addEventListener`.

### Tweak the Files popover
- `els.btnOpenRocketlaneFiles.addEventListener("click", ...)` around line 19500.

## Things that DON'T sync to Rocketlane

By design, these are local-only — they modify your browser's copy without touching Rocketlane:

- **Project removal** ("Remove" button) — `deleteSelected()` is explicitly local-only; never calls a Rocketlane delete endpoint
- **Owner renames** (`renameOwnerGroupEverywhere`)
- **Category removal** (`removeCategory`)
- **Category rename** (`renameArea`)
- Category and task UI expand/collapse state
- Owner workload pill (`state.ownerLoads`)
- Custom area labels

## Things that DO sync to Rocketlane

- Status, due date, project notes, custom links — all propagate via the sync flow
- **Task add** — creates the task in Rocketlane in the correct phase
- **Task removal of LINKED tasks** — propagates the upstream DELETE (with a loud ⚠ warning confirm)
- Task description updates (when ROCKETLANE_SYNC_PRIVATE_NOTES is enabled — disabled by default)

## Security model

- **Zero hardcoded secrets** in the HTML — credentials live only in Tampermonkey GM storage.
- **`file:///*` is gated** by a meta-tag marker so the bridge only publishes on the legitimate tracker.
- **Untrusted Rocketlane HTML** is sanitized through `sanitizeHtmlForChatMessage` before any `innerHTML =` write.
- **All interpolated values in `innerHTML` template strings** go through `escapeHtml()` / `escapeForHtml()`.
- **Console logs never expose credentials** — only presence + length. Avoid logging userId either (low-sensitivity but appears in shared screenshots).
- **Internal-API diagnostic logs** (`rl-chat-discover` etc.) use `console.debug` so they're filtered by default.

When adding new code that calls Rocketlane:
- Route through `rocketlaneRequestJson` (which uses the bridge if available, falls back to fetch otherwise)
- Never embed an api-key in source — read via `getRocketlaneAuth()` which pulls from the bridge → localStorage chain
- If logging a request body for debugging, redact `api-key`, `Authorization`, and any field with `*key*` / `*token*` / `*secret*` in its name

## When working with Claude

- Prefer minimal, surgical edits. The file is large and any unrelated change is high-risk.
- Test changes in the browser using Playwright when available — Tampermonkey isn't injectable into Playwright, so use the **mock-bridge-with-call-log** pattern: install `window.RocketlaneBridge` with a recording stub, exercise the UI, then verify the captured `apiRequest` calls match what the real bridge would emit. End-to-end verification still requires curl against Rocketlane.
- For animations: less is more. Multiple attempts at animating category expand/collapse have all caused glitches because `render()` rebuilds DOM. Instant toggle is the most reliable.
- The Rocketlane API has tenant-specific field IDs. Never hardcode them — always look up by name prefix.
- When debugging "task created but doesn't appear in Rocketlane Plan view," CHECK THE PHASE — Rocketlane silently drops the wrong-field-name `phase` parameter and creates a phaseless task. The verification fix: `curl /api/v1/tasks/{id}` and check `projectPhase` is set.
- When the user says "X doesn't work," ask for THREE specific things:
  1. `location.href` of the page they're testing on (to catch local-file-vs-live-URL confusion)
  2. `window.RocketlaneBridge?.version` + `typeof window.RocketlaneBridge?.apiRequest` (to confirm bridge is loaded)
  3. Network tab screenshot showing the actual outbound request (to distinguish "code didn't fire" from "code fired but API errored")
