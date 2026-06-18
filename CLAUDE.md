# Claude Code context

This file is read by Claude Code on every session start. It documents the architecture, patterns, and gotchas of the Project Progress Tracker so future sessions can move fast without re-discovering the same lessons.

## Tech stack

- **Vanilla HTML + CSS + JS** in a single file: `Project Progress Tracker.html` (~25k lines).
- No build step, no framework, no bundler. All state in `localStorage`.
- **Tampermonkey userscript** bridge (`rocketlane-chat-bridge/`) handles cross-origin API calls to FIVE platforms: Rocketlane, Zendesk, Oneflow, HubSpot, Younium. Bridge version is v1.9.13+ as of this writing (v1.9.13 made `HubSpotBridge.searchDeals` fetch ALL deal properties via `includeAllProperties`; v1.9.12 added local-dev `@match`; v1.9.11 added `YouniumBridge.getOrderEventLog` for the Younium status modal's "Last updated by" / "Created by" rows; v1.9.10 added `getOrderById` / `getInvoicesForOrder` / `getQuoteById`).
- Designed to run from either `file://` on the user's desktop or `https://hapnes-dev.github.io/Project-Progress-Tracker/`.

## File layout inside `Project Progress Tracker.html`

| Approximate line range | Section |
|---|---|
| 1–4500 | CSS (light + dark, status pills, layout primitives, chat styles, dialogs, animations, Zendesk task / fullscreen styles, Younium/Oneflow/HubSpot find buttons) |
| 4500–6300 | HTML body markup (toolbar, panels, dialogs, Edit project form including 🔎 Find buttons for Oneflow/HubSpot/Younium, install modal) |
| 6300–6800 | State constants, storage keys, auth helpers (`getRocketlaneAuth`, `tryAutoSyncSessionKeyFromBridge`) |
| 6800–8000 | Rocketlane request layer (`rocketlaneRequestJson`, bridge routing, 401 auto-retry, github.io direct-fetch optimisation) — Zendesk / Oneflow / HubSpot / Younium API client helpers + window.__zd / __of / __hs / __yn diagnostics |
| 8000–10000 | Owner-aware import + sync logic, deal-description writer (`buildProjectLinksHtml`, `rocketlaneFetchHubspotDealDescription` with tenant-fields fallback), team workload aggregation via lightV1 |
| 10000–13000 | Render orchestration (`render()`, `renderList`, `renderOwnerStatusOverview` with team groups, `renderDetail`) |
| 13000–14500 | `renderDetail` body — KPIs, notes, chat history, link toolbar, PANG/BAF buttons, Zendesk Tasks section |
| 14500–16500 | Task category rendering (`.areaBox`), task expand UI, status picker, mention picker |
| 16500–18500 | Dialogs (edit project, Younium import), context menus |
| 18500–end | Event wiring, sync timers, file-load handlers, install-prompt modal, init flow, notifications bell + drawer (Rocketlane + Zendesk unread badge, Zendesk recent-replies list, right-click fullscreen reader, incremental fetch cache) |

## Five platform bridges

Each platform has its own auth shape but uses the same architectural pattern: capture credentials on the platform's own pages (via `@match`), expose a `<Platform>Bridge` object on the tracker page (via `unsafeWindow` or isolated-world forwarder), and route API calls through `GM_xmlhttpRequest`.

| Platform | API host | Bridge object | Auth | Token storage |
|---|---|---|---|---|
| Rocketlane | `kiona.api.rocketlane.com/api/v1` | `RocketlaneBridge` | api-key (UUID from `localStorage.__api_key`) | `GM_setValue("rlApiKey")` |
| Zendesk | `iwmac.zendesk.com/api/v2` (same-origin only) | `ZendeskBridge` | Session cookie + CSRF from `<meta name="csrf-token">` | Cookie via browser; CSRF in `GM_setValue("zdCsrfToken")` |
| Oneflow | `app.oneflow.com/api` (same-origin only) | `OneflowBridge` | Session cookie + `xsrf-token` cookie (double-submit) | Cookie via browser; xsrf in `GM_setValue("ofXsrfToken")` |
| HubSpot | `app.hubspot.com/api/*` or `app-eu1.hubspot.com/api/*` (same-origin only) | `HubSpotBridge` | Session cookie + `hubspotapi-csrf` cookie + portal ID | Cookie via browser; CSRF/portal/host in `GM_setValue("hsCsrfToken"/"hsPortalId"/"hsHost")` |
| Younium | `api.younium.com` (Frontegg JWT bearer) | `YouniumBridge` | Frontegg HttpOnly refresh cookie → minted JWT | JWT cached in `GM_setValue("ynAccessToken")` with expiry timestamp |

### Tracker-side helpers (DevTools diagnostics)

| Object | Helpers |
|---|---|
| `window.__rlSyncStats` | Recent Rocketlane auto-sync outcomes |
| `window.__rlTeam` | Cached team workload aggregation |
| `window.__zd` | `api(method, path, body)`, `fetchTicket(id)`, `me()`, `csrf()` |
| `window.__of` | `api(...)`, `me()`, `search(query)`, `score(...)`, `docUrl(id)`, `csrf()` |
| `window.__hs` | `api(...)`, `me()`, `search(query)`, `score(...)`, `dealUrl(id)`, `csrf()` |
| `window.__yn` | `api(...)`, `me()`, `search(query)`, `orderUrl(id)`, `token()`, `refresh()` |

### Bridge file layout

The single userscript handles all five platforms:
- **Side A (per-host capture)**: `if (location.hostname === "...") { captureX(); return; }` — runs on each platform's pages, captures auth state into `GM_setValue`, then bails before reaching the tracker-side code.
- **Side B (bridge expose)**: assigns `target.RocketlaneBridge / ZendeskBridge / OneflowBridge / HubSpotBridge / YouniumBridge` to `unsafeWindow`.
- **Isolated-world forwarder**: when `unsafeWindow` doesn't reach the page's real `window` (browser/Tampermonkey combo quirk), the bridge injects a `<script>` shim that proxies method calls via `CustomEvent` to a userscript-side listener. Each bridge object has its own request/response event pair.

### Adding a new platform bridge

1. Add `@match` for the platform's web app + `@connect` for the API host(s).
2. Add a Side A capture block: `if (location.hostname === "...") { captureX(); return; }`.
3. Add `gmXRequest(method, path, body)` modelled on `gmZendeskRequest` (cookies) or `gmYouniumRequest` (Bearer token).
4. Expose `target.XBridge = { ... }` with `apiRequest`, `getCurrentUser`, plus any convenience methods.
5. Replicate the forwarder shim for the new bridge.
6. Bump bridge version (`@version` + `@description`).
7. Tracker side: add `xApiRequest(method, path, body)` + `xFetchCurrentUser()` + `window.__x` diagnostics that throw a clear error if the bridge isn't available.

## Key conventions

### Rendering model
- One global `render()` function rebuilds owner overview + project list + detail panel.
- `render()` is wrapped in a window-scrollY-preserve harness so async re-renders don't yank the page mid-interaction.
- `renderDetail()` constructs the entire detail panel offscreen in a `root` div, then atomically swaps it into `els.detailBody` with `innerHTML = ""` + `appendChild(root)`.
- Most user actions trigger a `render()` call. Some local-only actions (task expand/collapse, category expand/collapse, scroll, owner-group collapse) skip render and just toggle a class.

### State persistence
- `state` is the in-memory app state; persisted to `localStorage` under `progress_tracker_state_v1` via `saveState(state)`.
- UI-only state (sort/filter/search prefs, chat scroll positions, expanded task IDs, expanded categories per project, team-group collapse state, Zendesk- and Rocketlane-section collapse state) lives in separate `localStorage` keys or in-memory Sets.
- `touchProject(id)` updates `updatedAt` AND queues a Rocketlane sync.
- `touchProjectLocal(id)` updates `updatedAt` ONLY — does not sync. Used for owner renames, category removal, task removal of unlinked tasks.

### Rocketlane integration
- **Tenant API base**: `https://kiona.api.rocketlane.com/api/v1` (public `api.rocketlane.com` doesn't accept session keys).
- **github.io optimisation**: tracker has a CORS-allowed direct-fetch path to the tenant API (verified — Rocketlane's `Access-Control-Allow-Origin` allows `hapnes-dev.github.io`). Falls back to the bridge for `file://` runs.
- **Sync architecture** (poll + push):
  - **Pull**: `setInterval(rocketlaneMaybeRunLiveSync, 5 * 60 * 1000)` + immediate fire on `visibilitychange`.
  - **Push**: `touchProject(id)` → debounced `rocketlaneQueueSyncForProjectChange` → `rocketlaneMaybeRunLiveSync({force: true})`.
  - **Single-project sync**: `rocketlaneSyncLinkedProjectsNow({onlyProjectId})` — fires on project click + on the "RL sync" chip.
- **Tenant-specific custom field names** use a numeric suffix: e.g., `HubspotDealDescription_480568`. Always match by `startsWith()` of the stable prefix.
- **Custom fields without a value are OMITTED from project responses**. When fetching a field, if it isn't on `project.fields[]`, fall back to the tenant-wide `/fields` endpoint to find its ID — `rocketlaneFindDealDescriptionFieldId()` is the reference implementation.
- **S3 attachment URLs** expire after ~5 minutes (X-Amz-Expires=299). Always re-fetch via `fetchAttachment(id)` right before opening a link.

### Task notes: Description note + Private note (bidirectional)

Each task row has TWO independent notes, surfaced when the row is expanded:

| UI field | Local field | Rocketlane field | Write endpoint |
|---|---|---|---|
| **Description note** | `t.meta.rocketlaneDescription` (linked) / `t.notes` (unlinked) | task `description` | `rocketlaneUpdateTaskDescription` → `PUT /tasks/{id}` |
| **Private note** (cream box, behind "+ Add a private note") | `t.privateNote` | task `privateTaskDescription` (HTML) | `rocketlaneUpdateTaskPrivateNote` → `PUT /projects/{pid}/tasks/{tid}/mini` |

- **A "private note" is NOT a conversation/comment.** It is the task-level `privateTaskDescription` HTML field (the cream box under the description in the task drawer). The endpoint + field name were captured from the live web UI via Playwright network interception (`PUT …/tasks/{tid}/mini`, body `{ "privateTaskDescription": "<p>…</p>" }`, `api-key` auth, minimal body accepted). **Do NOT** route this through `/tasks/{id}/messages` — that's the comment stream and was the original bug (the note silently never saved). `rocketlaneCreateTaskPrivateMessage` (the `/messages` POST) still exists but is only used for subtask-creation traceability, gated behind `ROCKETLANE_SYNC_PRIVATE_NOTES=false`.
- `rocketlaneUpdateTaskPrivateNote(projectId, taskId, noteText)` needs the **project id** (derives it from the task via `rocketlaneGetTaskById` if not passed). Plain text → HTML via `rocketlanePlainTextToHtml`.
- **Read**: `rocketlanePrivateNoteFromTask(task)` checks `task.privateTaskDescription` FIRST (HTML → plain text via `rocketlaneDescriptionToPlainText`). The tasks-LIST endpoint (`GET /projects/{pid}/tasks?excludeMetaDataInFields=true`) DOES include `privateTaskDescription`, so pull-sync surfaces notes authored in Rocketlane — `commitPrivateNote`'s pull maps it into `t.privateNote` (was `t.notes`; line ~16944).
- **Clearing syncs too**: `commitPrivateNote` calls the update for empty text as well (no `next.trim()` guard), so deleting the note in the tracker PUTs `privateTaskDescription:""`. An untouched empty box never commits (the `privateNoteCurrent() === next` equality guard returns first).
- **Data-model split**: `t.privateNote` is deliberately separate from `t.notes`. For unlinked tasks the Description note still uses `t.notes`; sharing one field would collide. Read fallback `t.privateNote ?? (linked ? t.notes : "")` shows pre-migration notes until the next sync makes `t.privateNote` authoritative.

### Project status (5-state → 8-state enum, bidirectional with Rocketlane)

Local project status now uses the **same 8-state enum as Rocketlane's "Status" SELECT custom field** (fieldId varies per tenant, on Kiona it's `230410`):

| Local key | Rocketlane label | Numeric option value |
|---|---|---|
| `proposed` | Proposed | 5 |
| `in_planning` | In Planning | 6 |
| `to_be_staffed` | To be Staffed | 7 |
| `in_progress` | In progress | 2 |
| `on_hold` | On Hold | 9 |
| `blocked` | Blocked | 4 |
| `completed` | Completed | 3 |
| `cancelled` | Cancelled | 8 |

Numeric values captured via Playwright from `GET /api/v1/fields/230410` (`metaData.options[].value`). The mapping lives in `ROCKETLANE_PROJECT_STATUS_MAP`; if a new tenant re-numbers the options, regrab from that endpoint and edit the constant.

**Push** (tracker → Rocketlane):
- `openProjectStatusPicker` click handler + `els.projectForm` submit handler both call `rocketlanePushProjectStatusBestEffort(rlProjectId, localStatus)` fire-and-forget.
- Body shape verified working: `PUT /projects/{id}` with `{ fields: [{ fieldId, fieldValue: <number> }] }`. **Important**: `fieldValue` MUST be the numeric option value, not the label string — the API rejects `fieldValue: "Completed"` with `HTTP 400 Expected a numeric value`.
- The fieldId is looked up once per session via `rocketlaneFindProjectStatusFieldId()` (walks `/fields` for a PROJECT-type field named `Status`), cached in `_rocketlaneProjectStatusFieldId`.
- Failures surface as a `rocketlaneShowMessage(..., "error")` toast + `console.warn`; local change is never undone on push failure.
- Edit-dialog push fires only when `previousStatus !== status` (captured before the field overwrite) to avoid re-PUTing on every save where only links/owner/notes changed.

**Pull** (Rocketlane → tracker, every sync):
- `rocketlaneImportProjectsIntoTracker` now reads `rocketlaneProjectStatusLabel(remoteProject)` from `remoteProject.fields[]["Status"].metaFieldValue.label` on every linked project — not just on first import — and overwrites `local.status` via `rocketlaneStatusLabelToLocal(label)`.
- Falls back to the legacy task-derived heuristic (`projectStatusFromCsvTaskStatuses`) only when Rocketlane returns no recognisable label AND the project is brand-new.
- Result: the projects list always matches what the Rocketlane UI shows. The task-derived fallback only fires for greenfield tenants without a Status field.

**Migration**: `normalizeStatus()` transparently upgrades the previous 5-state enum (`open` → `proposed`, `waiting_partner` → `on_hold`, `finished` → `completed`, `closed` → `cancelled`, plus the older `active`/`done` shims) so existing localStorage data doesn't break.

### Rocketlane API field-name gotchas

The tenant and public APIs use DIFFERENT field names. The tracker must accept BOTH on read but emit the TENANT shape on write.

| Public API | Tenant API | Helper |
|---|---|---|
| `phaseId`, `phaseName` | `projectPhaseId`, `projectPhaseName` | `rocketlanePhaseId()`, `rocketlanePhaseName()` accept both |
| Task POST: `phase: {phaseId}` | Task POST: `projectPhase: {projectPhaseId}` | First body shape in `rocketlaneCreateTaskInRocketlane` is the tenant shape |
| Phases list: `/phases?projectId.eq=X` | Phases list: `/projects/{id}/phases` | `rocketlaneFetchPhasesForProject` tries the tenant endpoint first |

### lightV1 vs /projects (team workload)

For the Owner Workload Overview's per-teammate counts, use `POST /api/v1/projects/lightV1?offset=N&limit=200`. This endpoint:
- Returns `teamMembers` **inline** on each project (the regular `/projects` endpoint silently ignores `includeFields=teamMembers`).
- Paginates correctly via `offset` + `limit` (the regular `/projects` endpoint ignores `pageToken` — must use `page=N`).
- Returns 700+ projects in `data` array.

For other reads where teamMembers isn't needed, the regular `/projects?pageSize=100&page=N` works fine.

### Hubspot Deal Description writer

On project save with `rocketlaneProjectId`:
1. Try `rocketlaneFetchHubspotDealDescription(rlProjectId)`.
2. If field is on `project.fields[]` → use that fieldId.
3. Else fall back to `rocketlaneFindDealDescriptionFieldId()` which walks the tenant `/fields` endpoint for a PROJECT-type field with name `HubspotDealDescription_*` or label "Hubspot Deal Description". FieldId cached in module scope (`_rocketlaneDealDescriptionFieldId`) so we only walk `/fields` once per session.
4. PUT `/projects/<id>` with `{ fields: [{ fieldId, fieldValue: html }] }`.

The HTML format from `buildProjectLinksHtml`:
```html
<p><strong>Links:</strong></p>
<p>Oneflow: <a href="…">…</a></p>
<p>Younium: <a href="…">…</a></p>
<p>HubSpot: <a href="…">…</a></p>
```

Zendesk + Rocketlane links are intentionally excluded — Zendesk lives in the per-project Zendesk Tasks section, and a Rocketlane self-link inside Rocketlane's own field is noise.

### Chat history images (expiring signed S3 URLs)

Rocketlane serves chat attachment + inline images as AWS S3 **pre-signed URLs that expire in ~5 min** (`X-Amz-Expires=299`, host `s3.us-east-1.amazonaws.com`). Chat messages are cached in-memory per project (`getRlChatCache` → `cache.msgs[kind]`) and replayed on tab-switch AND on every detail re-render (panel rebuild), so a chat rendered from cache more than ~5 min after the fetch used to show **blank images** (S3 returns 403) until a full page refresh refetched fresh URLs.

Fix has two layers:
- **Staleness refetch (primary):** both render-from-cache paths — `loadKind` and the panel-rebuild restore block — compare `cache.fetchedAtByKind[kind]` against `SIGNED_URL_TTL_MS` (4 min) and refetch fresh signed URLs (`fetchChatComments`) when stale. Fresh caches are NOT refetched, so there's no over-fetch on rapid tab-switches.
- **Per-image error recovery (fallback):** each chat `<img>` gets an `error` handler (`onChatImgError`) that, debounced + rate-limited (8 s), refetches the conversation once and remaps every broken image by its stable **S3 object key** (the URL pathname survives re-signing — only the query string changes). A per-image retry cap of 2 prevents loops on a genuinely deleted file. This covers URLs that expire while the panel stays open (e.g. a `loading="lazy"` image scrolled into view after 5 min).

### Zendesk Tasks section (per project)

- Lives in `picWrap` right under "Chat history" (so it inherits the chat-collapse animations).
- Renders only when the project name starts with a numeric plant ID (extracted via `/^\s*(\d+)\b/`).
- Search endpoint: `GET /api/v2/search.json` (browser auto-sends Zendesk session cookie via the bridge). Runs **two** queries and merges deduped by id: `type:ticket <plantId>` AND `type:ticket "<store name>"` (the descriptive part of the project name, ≥4 chars). The name query catches tickets that reference the store but not the plant number (e.g. "Fwd: Holdbart Molde. Modbus liste Cubo" on 10228). Two queries, not one `(A OR B)` — Zendesk's parenthesized boolean returns 0 for `type:` + a quoted phrase.
- Hydrates each ticket with `lastReplyAt` by fetching `/api/v2/tickets/<id>/comments.json?include=users&sort_order=desc&per_page=20` per ticket. Concurrency capped at 8 via `mapWithConcurrency`.
- Sorts by `lastReplyAt desc` (newest reply first) — NOT by generic `updated_at` which fires on tag/status changes too.
- Inline preview shows only the newest comment + hint pill. Right-click anywhere on the card → fullscreen overlay (portal-mounted to `<body>` to escape `.chatHistoryBody { contain: layout paint style }` clipping).
- Comment body rendered via `sanitizeZendeskHtml(c.html_body)` — allowlist tags + style attributes, strips inline `color:` (would otherwise appear black on dark theme). Inline images that fail to load (deleted/cross-origin Zendesk attachments, e.g. a stale signature image) are **hidden** via an `img` onerror handler (was: replaced with a "📎 image" file-link chip) so the thread reads exactly like Zendesk — same treatment as the notification fullscreen reader. Quoted/forwarded content (`blockquote`) renders as a single subtle left-rule (no background fill); nested levels add no extra border and consecutive sibling blockquotes collapse their gap, so an Outlook forward shows as ONE quote region rather than ~5 stacked boxes. Empty quote wrappers are hidden.
- Reply submission via `PUT /api/v2/tickets/<id>.json` with `{ ticket: { comment: { body, public: true|false } } }`. Public/Internal switch uses a sliding-thumb pill (yellow when internal, accent when public).
- Timestamps: 24-hour Norwegian (Europe/Oslo) format via `Intl` API; "DD.MM HH:MM" always shown with `(i dag)` / `(i går)` / weekday context tags.

### Notifications bell (Rocketlane + Zendesk)

The 🔔 (`#btnNotifications` + `#notifBadge`) lives in the project-list header; all badge/drawer logic is in the `if (els.btnNotifications)` block.

**Badge** = Rocketlane unread groups **+** Zendesk unread tickets, recomputed by `refreshNotifBadge()` (initial load, every 2 min while visible, on `visibilitychange`). The `#btnNotifications` `title` shows the per-source split ("Rocketlane: 3, Zendesk: 0").

**Timestamp gotcha (fixed — do not regress):** Rocketlane `n.timestamp` is an ISO string, so `Number(n.timestamp)` is `NaN`. The unread reduce, the drawer's per-card unread marker, `notifFormatRelative`, and the group sorts MUST use `Date.parse(String(n.timestamp))`. The original `Number()` made the badge silently always 0 and "x ago" never render.

**Mark-seen is client-side** because `bridge.markNotificationsSeen()` currently returns **HTTP 400 INVALID_INPUTS** (bridge bug — the server last-seen never advances, so the count came back on the next poll). Both platforms keep a localStorage last-seen and count unread against `max(serverLastSeen, localLastSeen)`:

| Purpose | localStorage key |
|---|---|
| Rocketlane last-seen — advanced on bell open | `rocketlane_notif_last_seen_v1` |
| Zendesk last-seen — badge count cutoff; advanced on bell open | `zendesk_notif_last_seen_v1` |
| Zendesk ticket comment cache — keyed by ticket `updated_at`, capped at 80 (v5: latest INCOMING reply + its `isInternal` flag + a `repliedByMe` flag + my own latest reply `myReply` when I replied last) | `zendesk_ticket_cache_v5` |
| Zendesk author-name cache — by user id | `zendesk_author_cache_v1` |
| Zendesk list filters — Hide-solved/closed (default ON) + reply-state (`all`/`awaiting`/`replied`) | `zendesk_notif_hide_solved_v1`, `zendesk_notif_reply_filter_v1` |
| Rocketlane drawer list collapse state — default expanded; toggled via the "Rocketlane · notifications" header (`.notifRlHeader`, reuses `.notifZdHeader` look) | `rocketlane_notif_collapsed_v1` |

`getNotificationLastSeen()` is still read and `max()`'d in, so marking seen in the Rocketlane app (a newer server value) is also respected. The server `markNotificationsSeen()` is still attempted best-effort so it self-heals if the bridge is ever fixed.

**Zendesk** (`zendeskFetchUnreadInfo(sinceMs, opts)` → `{count, newestTs, tickets}`):
- Search `type:ticket assignee:{meId} updated>{day}`, **paged** (sort updated_at desc) until the oldest result is older than `since`, a page is short, or `opts.maxPages` is hit — that paging is what lets "Show more months" reach tickets beyond the first 100. Candidates updated since `sinceMs`, capped at `opts.maxCandidates`.
- Per candidate: reuse the cached **latest incoming reply** (`entry.latestIncoming` = newest comment **not** authored by me — **public OR an internal/private note**, with a raw `isPrivate` flag), an `entry.repliedByMe` flag (is my latest comment newer than that incoming reply?), and `entry.myReply` (my latest reply, when I replied last — rendered as the "↩ You replied" line on the card + appended in the fullscreen reader) when its `updated_at` is unchanged; otherwise fetch `/tickets/{id}/comments.json` and refresh the cache. **Only changed/new tickets hit the comments API** (verified: 14 comment calls cold, 0 on a no-change repeat). Author names **+ a `kiona` flag** (is the author's email `@kiona.com`?) are resolved via one `/users/show_many.json` for ids not already cached (author cache `zendesk_author_cache_v2` = `{name, kiona}`). Card **snippets** (incoming + "You replied") are signature-stripped via `zendeskStripSignature()` (cut at the first standalone sign-off line — "Best regards,"/"Med vennlig hilsen"/"Mvh"/… — or an RFC `--` delimiter); `fullBody`/`myReplyFull` keep the complete message for the fullscreen reader, so snippet ≠ full body is intentional.
- "Qualifies" = the latest **incoming** reply (someone else's — **public OR an internal/private note**; Zendesk delivers some partner emails as private comments, e.g. a CC'd supplier, and the assignee still wants to know) is newer than `since`. Private notes are tagged **"Internal"** (amber `.notifZdInternal` on the card, `.notifFsInternalTag` in the reader, meta "added an internal note") **only when the author's email is `@kiona.com`** — i.e. `t.isInternal = isPrivate && author-is-kiona`. Private comments from external parties (e.g. a partner/supplier whose email lands as a private comment) still notify but render as a normal "replied" with no tag. It deliberately keys on the latest incoming reply, NOT the newest comment overall, so **a case stays listed after I reply** (my reply becoming the newest comment must not drop it off). It leaves only when that incoming reply ages out of the window or a newer incoming reply replaces it.
- **Badge** calls it with `since = zendeskGetNotifLastSeen()` + applies the Hide-solved/closed filter to the count so it matches the list. **Drawer** (`notifZdRefresh`) calls it with `since = now − zdMonthsShown × ZENDESK_LIST_WINDOW_MS` (default 1 month; "Show more" bumps `zdMonthsShown` up to `ZD_MAX_MONTHS` = 6, and `openNotifDrawer` resets it to 1 on every open so it never carries over across opens/refreshes) and `{maxCandidates:300, maxPages:…}`, then renders with `newSinceMs = lastSeen` so replies newer than last-seen get a red **New** pill. Sorted by reply time desc.
- **List filters** (in `renderZdSection`, view-only — no re-fetch on toggle): a reply-state segmented control **All / Awaiting / Replied** (uses `repliedByMe`) and a **Hide solved/closed** toggle (default ON). The header count + the empty message reflect the filtered set; a **Show more** button at the bottom of the body bumps `zdMonthsShown` and calls `notifZdRefresh()`.

**Right-click fullscreen reader (+ Zendesk reply composer)** — `openCommentFullscreen({title, meta, bodyHtml, bodyText, load, reply, onSent})`: overlay reusing `.notesFullscreenOverlay` chrome at z-index 1400 (above the drawer). Wired on `contextmenu` for both `.notifZdItem` and Rocketlane notif items. **Zendesk** uses the async `load` option: it shows "Loading…", then fetches the ticket's comments and renders the real `html_body` via the module-level `zendeskSanitizeHtml()` inside a `.zendeskMsgBody` container — so it looks exactly like Zendesk (bold/lists/links/embedded images/signature), NOT the raw plain-text body with literal markdown. It renders the latest incoming reply (public or internal — internal notes get an "Internal" `.notifFsInternalTag`) + my reply (when I replied last), each under a `.notifFsCommentHead`; falls back to the plain-text `bodyText` if the fetch fails. Broken/dead images (e.g. a 404 signature attachment) are hidden via an `img` onerror handler. **Reply composer**: when the caller passes `reply = { ticketId, ticketStatus }` (the `.notifZdItem` handler does, with `t.id` / `t.status`), a composer is appended below the body — the **same `.zendeskCompose` / `.zendeskReplyKind` markup as the Zendesk Tasks fullscreen** (Public reply / Internal note sliding toggle, default Public; Ctrl/Cmd+Enter; `ZendeskBridge.postTicketReply(ticketId, body, isPublic)`); on send it re-runs `load` (refresh the conversation body) + `onSent` (`→ notifZdRefresh`, updates the "↩ You replied" line), and a **closed** ticket shows the `.zendeskComposeClosed` notice instead (Zendesk 422s on closed). **Rocketlane** notif items pass no `reply`, so theirs stays read-only and still renders `notifCommentHtmlFor(n)` / `notifCommentTextFor(n)` immediately. Esc / × / backdrop close; the drawer's own Esc (`notifEscKey`) defers while `activeCommentFullscreenContext` is set.

**Rocketlane fetch** (`fetchAllNotifGroups`): merges `filter:All` + `filter:Mentions` (Mentions is NOT a subset of All), dedupes notifications by id, sorts groups+notifications desc. A short in-memory TTL (~10s, `notifGroupsRaw`/`notifGroupsRawAt`) dedupes the badge-poll + an immediate drawer-open so it doesn't fetch twice back-to-back.

**Rocketlane drawer layout**: the source filter chips (*All / Tasks I'm assigned to / Mentions / Assigned to the team*, in-memory `notifFilter`, client-side via `renderNotifList(list, notifGroupsCache, notifFilter)`) live **inside** the collapsible Rocketlane section body (`.notifRlBody`) — `.notifRlHeader` toggles `rlBody` (chips + list together), and the chips reuse the Zendesk `.notifZdFilters`/`.notifZdFilterChip` styling. The New/Cleared tabs stay above the scroll region.

### Auto-find buttons (🔎)

Each link field in the Edit dialog has a 🔎 Find button. They use **document delegation** for the click handler:

```js
document.addEventListener("click", (e) => {
  if (e.target?.id === "btnFindOneflow") { ... }
});
```

The reason: the `els` object is built ~6000 lines later in the file, so direct `els.btnFindOneflow.addEventListener(...)` at script load fires before `els` exists. Document delegation sidesteps the timing entirely.

All three buttons share a single scoring framework — search and URL-building are still platform-specific, but normalization, scoring, decision logic, and picker UI are common code.

#### Shared scoring framework

Lives just above the Oneflow API helpers in the tracker. Key exports:

| Helper | Role |
|---|---|
| `matchNormalize(s)` | Lowercase, strip diacritics, collapse whitespace. |
| `matchExtractPlantId(s)` | Capture leading 2–6 digit prefix. |
| `matchExtractOrgNumber(s)` | 9-digit Norwegian orgnr (with or without grouping). |
| `matchExtractMoneyAmount(v)` | Parse "1 234,56" / "16377.00" / "27 902 NOK" → number. |
| `matchMoneyCloseness(a, b)` | 0..1 closeness (1.0 at exact, 0 at ≥50% diff). |
| `matchExtractEmailDomain(s)` | Pull `bar.com` from "Name <foo@bar.com>" / `foo@bar.com`. |
| `matchTokenize(s)` | Strip plant ID + punctuation, drop tokens ≤1 char, return a `Set`. |
| `matchTokenOverlap(a, b)` | `|A ∩ B| / max(|A|, |B|)`, 0..1. |
| `readRocketlaneCustomField(fields, prefix)` | Look up a custom-field value by name prefix (case-insensitive, whitespace-stripped). Returns string or array for MULTI_SELECT. **Reads the value from `fieldValue`** — the key the `/projects/<id>` payload actually uses (`value` is only a legacy fallback). Reading `value` returns `undefined` for every field and silently zeroes the whole match context — do not change this. |
| `extractRocketlaneCustomFields(project)` | Harvest EVERY HubSpot-mirror custom field (dealId, plantName, dealOwner, dealContact, dealContactEmail, dealContactPhone, dealStage, department, dealType, orderType, productTypes, certifiedPartner, plantStreetAddress, dealDescription, deliveryStatus, etc.) plus Younium order number + plant ID. |
| `extractRocketlaneForeignKeys(project)` | Shim returning `{ hubspotDealId, oneflowAgreementId, youniumOrderId }` — built from `extractRocketlaneCustomFields`. |
| `classifyLinkUrl(url)` | URL-structure classifier: returns `{ platform, recordId, recordType, url }`. Trusts URL shape, **never** trusts label text in the surrounding HTML. |
| `extractLinksFromHtml(html)` | Parse hrefs + bare URLs from HubSpot Deal Description / Delivery status message, return deduped `[{ platform, recordId, ... }]`. |
| `buildSearchTerms(platform, ctx)` | Prioritized list of `{ term, source, priority }` (foreign-key ID → plant ID → name → customer → email/phone). |
| `detectExistingLinkMismatch(platform, ctx)` | Return `{ kind: "orphan"|"wrongPlatform"|"fkMismatch", message, savedUrl }` if the currently-saved link doesn't match the project; null otherwise. |
| `buildProjectMatchContext(src)` | Form-fields OR live Rocketlane project → frozen ctx with name / plantId / partner / owner / ownerEmail / due / startDate / projectFee / customerOrgNumber / foreignKeys / **hubspotMirror** (full HubSpot-custom-field bundle) / **embeddedLinks** (parsed from HS description; each tagged with `linkKind: "order" \| "subscription"` via `parseProjectLinksFromHtml`, so a curated link is routed to its own field) / contactEmail / contactPhone / existingLinks + their classification / pre-tokenized variants. |
| `buildEnrichedProjectMatchContext()` | Async: fetches the project via `/projects/<id>` and feeds the rich payload into `buildProjectMatchContext`. Falls back to form-only on missing ID / fetch failure. |
| `scoreMatchCandidate(candidate, ctx, opts?)` | Returns `{ score, percent, signals }`. `opts.preferLinkKind` (`"order"`/`"subscription"`) makes the embedded-link signal kind-aware: an exact curated link labelled for the *other* slot scores 0 here instead of +25, so each field's Find claims its own link. |
| `decideMatchOutcome(scored, opts)` | Returns `{ kind: "auto" \| "picker" \| "none", entry?, entries?, reason }`. |
| `renderMatchPicker(statusEl, scored, onSelect, warning?)` | Renders the picker; each row's `% match` badge is color-tinted, per-signal breakdown is shown inline (not just tooltip), and an optional `warning` row at the top surfaces existing-link mismatches. |
| `debugLogMatch(label, ctx, scored, decision, warning?)` | Collapsed `console.group` with the ctx, a `console.table` of candidates, the decision rationale, the mismatch warning if any, and the parsed embedded-links list. Disable via `window.__matchDebug = false`. |

#### Point budget (caps at 100)

Calibrated from live data captured via Playwright across two real projects (plant 3299 Coop Marked, plant 4732 Spar Dampsaga). The strongest "is this the right record?" signals (FK + plant ID + org number + embedded-link evidence) can stack to 100, while the corroborating signals (name overlap / money / partner / dates / category tags) push uncertain matches into picker territory.

| Signal | Weight |
|---|---|
| Foreign-key ID match (project custom field carries the platform ID) | 35 |
| **Reverse cross-link — candidate embeds the project's HubSpot Deal ID** (e.g. an Oneflow order's `Hubspot Deal ID` custom field == the project deal) | 35 |
| Plant ID exact — native `plant_id` field | 35 |
| **Zendesk ticket cross-link** (candidate's `Churn: Zendesk Ticket ID` ∈ `ctx.zendeskTicketIds`, the Zendesk tickets embedded in the RL deal description / delivery status) | 20 |
| Plant ID at start of the record's name/title | 30 |
| Plant ID elsewhere in text (`\bID\b`, so `O-013299` ≠ plant 3299) | 18 |
| **Younium order # matches RL `Youniumordernumber` field** (Younium only) | 30 |
| **Linked from RL HubspotDealDescription / DeliveryStatusMessage** (kind-aware: a curated link labelled for the sibling slot — e.g. the "(Subscription)" link while finding the order/offer field — scores 0, not 25) | 25 |
| Org number exact match (9-digit Norwegian orgnr) | 20 |
| Name token Jaccard | 0..15 |
| Partner / company match (exact > substring > token overlap) | 0..10 |
| **Contact email exact match** (RL contact email ↔ candidate's contact emails) | 8 |
| **HubSpot deal name matches RL mirror field** (HubSpot only) | 8 |
| Money proximity (project fee vs candidate value, linear 0..50% diff) | 0..8 |
| **Contact phone match** (8-digit suffix overlap, handles country codes) | 6 |
| **HubSpot plant name matches RL mirror field** (HubSpot only) | 5 |
| Owner-email exact (project owner appears as participant/contact) | 5 |
| **Product type overlap** (RL `HubspotProducttypes` ↔ deal `product_types`) | 4 |
| Owner / contact NAME match | 0..4 |
| Date proximity vs project due OR start (≤7d → 4, ≤14d → 3, ≤30d → 2) | 0..4 |
| **HubSpot department / dealType / orderType tag match** | 3 each |
| Same email domain (e.g. both `kiona.com`) | 3 |
| "Live" status (not closed/cancelled/declined/lost/expired/etc.) | +3 |
| **Dead status** (cancelled/declined/closed/lost/void/voided/expired/rejected/overdue) | **−20** |
| **HubSpot deal stage tag match** | 2 |
| **Contact domain match** (RL contact email domain ↔ candidate) | 2 |

> **Dead-status penalty** (`MATCH_DEAD_STATUSES`): a `−20` hit (not merely the absence of the `+3` bonus) keeps cancelled/expired/lost records well below the 85% auto-fill bar even when every other signal is perfect — they can still appear in the picker for manual override, but never auto-fill.

#### Multi-term search

Instead of a single query, the find orchestrator now runs a **prioritized list of search terms** through `buildSearchTerms(platform, ctx)`:

1. Foreign-key ID (direct platform-record lookup, priority 100)
2. Younium order number (priority 90 — relevant for Younium directly, and for HubSpot since deals carry `deal_younium_quote_number`)
3. Plant ID (priority 50)
4. Stripped project name (priority 40)
5. Full project name (priority 30)
6. Customer + plant name combo (priority 25)
7. Customer alone (priority 20)
8. Contact email (priority 15) or contact email domain (priority 10)

Terms are **deduped by the normalized term string** (lowercased, whitespace-collapsed) — NOT by `priority+term` — so the same string isn't searched twice when it qualifies under two priorities; `add()` runs highest-priority first, so the first occurrence wins. Results are merged by record ID (deduplicated), with early stop once we have ≥ 12 candidates from at least 2 different sources. Each term tried gets logged via `console.log("[Platform Find] search terms tried:", ...)`.

#### Existing-link validation

Before deciding auto-fill vs picker, every find function calls `detectExistingLinkMismatch(platform, ctx)`:

- **`orphan`** — saved link couldn't be URL-parsed.
- **`wrongPlatform`** — saved URL points to a different platform than its slot (e.g. a Zendesk ticket saved in the Oneflow slot).
- **`fkMismatch`** — Rocketlane has a foreign-key custom field (e.g. `HubspotDealID_357728 = 494492985563`) but the saved URL points to a different record ID. **Same-id-shape guard**: the FK compare only runs when the saved URL's `recordId` and the RL field are the same KIND of identifier (both UUID, or both not-UUID). This prevents a correct Younium `/orders/<uuid>` link from being falsely flagged just because `YouniumOrderNumber` is an order number (`O-014603`) that can never equal a UUID — HubSpot/Oneflow IDs are numeric on both sides, so they still compare. (The Younium order-number ↔ `candidate.orderNumber` check lives in `scoreMatchCandidate`, not here.)

If a mismatch is detected, **auto-fill is suppressed** regardless of score. The picker opens with a red warning row at the top quoting the discrepancy ("Saved link record ID X ≠ Rocketlane field Y"), and the user picks a replacement manually. We never silently overwrite a saved link.

`scoreMatchCandidate` returns the raw sum AND the percentage (clamped 0–100). A perfect plant-3299 match in our test ran to ~88% (Plant ID 35 + Partner 10 + Name 9 + Money 7 + Live 3 + Date 4 + Owner-domain 3 + Plant ID exact = high), which would auto-fill. A weak match with just "name overlap + active status" lands at ~12–18% and surfaces in the picker for manual review.

#### Auto-fill rule (uniform across all three platforms)

`decideMatchOutcome`:

- Best ≥ **85%** (the clamped `percent`) AND beats #2 by ≥ **15** → auto-fill.
- The **lead is measured on the RAW uncapped `score`**, not `percent`. `percent` clamps at 100, so two strong-but-distinct candidates can both saturate to 100% and falsely look tied (lead 0), or a real gap above 100 raw gets hidden — measuring the lead on raw score keeps the "is #1 clearly better?" guard honest.
- Otherwise → picker, sorted by percent desc.

Override per call via `decideMatchOutcome(scored, { autoFillMinPercent, autoFillMinLeadPercent })`.

#### Per-platform adapters

Each platform has a `xToMatchCandidate(rawApiResult)` function returning the common Candidate shape:

```js
{
  id, platform,
  primaryText, secondaryText,
  matchableTexts:  [...],
  partyNames:      [...],
  contactNames:    [...],
  contactEmails:   [...],  // emails for owner-email / domain scoring
  orgNumbers:      [...],  // 9-digit org numbers extracted from the API
  plantId,
  status,
  date,                    // ISO string for proximity scoring
  amount,                  // number (NOK / EUR / etc.) for money proximity
  currency,                // "NOK", "EUR", … (just for the display label)
  raw,                     // original API object, used for URL building
}
```

| Platform | Adapter | URL builder | Notes |
|---|---|---|---|
| Oneflow | `oneflowToMatchCandidate` | `oneflowDocumentUrl(id)` | Harvests `agreement_value.amount` + `currency`, `parties[].orgnr`, `parties[].email`, `parties[].participants[].email/fullname`. **`extractOneflowDataFields(a)` mines the "Custom fields" (`data_fields[]`)**: Plant ID (→ native plant-id tier even when the doc name is generic), Plant Name / Your reference / Description (→ matchableTexts), Deal Partner (→ partyNames), Deal Contact e-mail / phone / Customer contact (→ contact arrays), and the cross-link IDs `hubspotDealId` + `zendeskTicketId`. **Search/list responses may omit `data_fields`** → the Find flow hydrates the top ~10 candidates via `GET /agreements/{id}` (bounded, parallel, fully defensive — a hydration failure never breaks the Find). Sets `oneflowKind: "order" \| "subscription"` via `classifyOneflowDocumentKind(name)`. PrimaryText is prefixed with 📄 Order or 📑 Subscription. |
| HubSpot | `hubspotToMatchCandidate` | `hubspotDealUrl(objectId)` (async — needs portalId from bridge) | Reads `properties.amount.value` AND `properties.amount.unit` (currency). closedate/createdate are epoch-ms strings → converted to ISO. Reads tenant custom props: `plant_id`, `plant_name`, `deal_partner`, `deal_contact`, `contact_email`, `deal_contact_tlf_nr`, `deal_organization_nr_younium` (→ orgNumbers), `deal_younium_quote_number`. **These only populate because the bridge's `searchDeals` requests `includeAllProperties:true` (v1.9.13+)** — the prior 6-property default left every custom prop empty, so deal matching ran on the deal name alone. |
| Younium (orders) | `youniumToMatchCandidate` | `youniumOrderUrl(id)` (async — needs region from bridge) | Hard-filters by exact `plant_id` (search returns false positives like `O-013299` for query `3299`). Reads `customFields[]` (`integrationHubspotHubspotDealId` → reverse cross-link, `deal_contact` → contactNames, `plant_id`/`plant_name`, invoice ref), `_account` (`organizationNumber` → orgNumbers, `name` → partyNames, domain → synthetic contact email), and `description` (→ matchableTexts + plant-id fallback). **Money reads the real Younium value objects `tcv`/`acv`/`cmrr` (`{ amount }`)** via `moneyOf`, not the non-existent `totalContractValue`/`annualContractValue`/`mrr` the builder used to look for (money scoring was dead). The search/summary shape carries none of this, so the order Find **hydrates each plant-filtered order via `getOrderById` + `GET /Accounts/{id}` before scoring** (small set, bounded, defensive fallback to the search shape). `recordType: "order"`. |
| Younium (quotes) | `youniumToQuoteMatchCandidate` | `youniumQuoteUrl(id)` (async) | Quotes use `/api/data/query/quote` (entity `"quote"`). Many quotes have **empty `plant_id`** even when matching — promoting a quote to an order is what fills it. Loose filter: accept on plant_id exact OR plant_name/accountName token overlap with project name OR plant ID literal in description/remarks. `recordType: "quote"`. Picker label prefixed with 📄 to distinguish from orders. |

The legacy `oneflowMatchScore` / `hubspotMatchScore` functions still exist as **thin shims** over the shared scorer so `window.__of.score` / `window.__hs.score` DevTools diagnostics keep working.

#### Younium status chip (project header meta row)

A clickable chip rendered in the **project detail header meta row, between the Updated and RL sync chips** (the chip element starts in the top action bar at startup so the els cache can resolve `#btnYouniumStatus`, then `renderDetail` moves it into the meta row via `appendChild` on every project select). Visually matches the sibling `.tag` chips via `.btn.youniumStatusBtn { padding: 5px 12px; font-size: 11.5px; border-radius: 999px; ... }` — selector specificity `.btn.youniumStatusBtn` (0,2,0) beats plain `.btn` (0,1,0) regardless of source order.

**Verdict labels** (icon vocabulary: ✓ good, ⏳ waiting, ⚠ action needed, ✗ terminal):

| Color | Label | When |
|---|---|---|
| 🟢 Green | `Younium: ✓ All good` | Order Invoiced AND IWMAC subscription Active |
| 🟢 Green | `Younium: ✓ Invoiced (one-time)` | Order Invoiced, no IWMAC subscription product on it (one-time sale) |
| 🟡 Yellow | `Younium: ⏳ Awaiting first invoice` | Order present, isLastVersion=true, no posted invoices yet |
| 🟡 Yellow | `Younium: ⏳ Subscription starts <YYYY-MM-DD>` | Subscription start date is in the future |
| 🟡 Yellow | `Younium: ⚠ Status uncertain` | Data incomplete or unexpected state |
| 🔴 Red | `Younium: ⚠ Activate order in Younium` | Order is Draft — needs to be activated and invoiced |
| 🔴 Red | `Younium: ⚠ Finalize order in Younium` | Order raw status 1 (Created but not finalized) + no orderNumber |
| 🔴 Red | `Younium: ⚠ Activate subscription in Younium` | IWMAC subscription order is Draft — needs activation |
| 🔴 Red | `Younium: ⚠ Finalize subscription in Younium` | IWMAC subscription Created but not finalized |
| 🔴 Red | `Younium: ⚠ Subscription <status>` | IWMAC subscription found but in some other non-Active state |
| 🔴 Red | `Younium: ✗ Cancelled` | Order has a past cancellationDate |
| 🔴 Red | `Younium: ✗ Expired` | Order's effectiveEndDate is in the past AND not auto-renewing |
| ⚪ Gray | `Younium: ⏳ Checking…` | Verdict is being fetched (modal open, refresh, or background fetch) |
| ⚪ Gray | `Younium: Missing` | No Younium link saved on the project |

The chip's **hover tooltip** is a multi-line dump: label on line 1, each problem from `verdict.problems[]` as a bullet line, "Click for details." footer.

**Click behavior:** opens `<dialog id="dlgYouniumStatus">` — a fullscreen-centered native modal. **CSS gotcha:** the dialog's styles are scoped to `dialog.dlgYouniumStatus[open]` (NOT plain `.dlgYouniumStatus`) so they only apply when the dialog is actually open; without the `[open]` qualifier our `display:flex` would override the user-agent's `dialog:not([open]) { display: none }` and leave an empty dialog stuck at the bottom of the page.

**Close paths:**
1. **Backdrop click** — explicit handler on the dialog when `ev.target === dialog`
2. **Click the `[ ✕ Close ]` span pill in the header** (`#closeYouniumHintTop`)
3. **Click the `[ ✕ Close (or click outside) ]` span pill in the footer** (`#closeYouniumHintBottom`) — *removed in some revisions; the X-in-header is the primary close affordance*
4. **Escape key** — native to `<dialog>` (some environments block it; we install an explicit document-level capture-phase keydown handler as fallback)
5. **Capture-phase click listener on document** — catches close-hint clicks regardless of what's intercepting them (closest selector matches `#closeYouniumHintTop, #closeYouniumHintBottom`)
6. **Emergency**: `closeYouniumModal()` in DevTools console

The close hints are `<span role="button">` elements — NOT `<button>` elements — because the user reported their browser's tampermonkey-bridge environment was intercepting clicks on native `<button>` elements inside the dialog, preventing them from firing handlers. Spans aren't subject to the same interception.

**Sections rendered in the modal body** (in order, `null` values get filtered out by `renderKV`):

| Section | Content |
|---|---|
| **Status summary** | Action-oriented one-liner: "All good — Order is Invoiced and Subscription is Active." / "Action needed: Subscription is in Draft state. Activate it in Younium to start invoicing." / "Cancelled — Order was cancelled on <date>." etc. Each verdict state has its own tailored copy (NOT a generic "Error:" prefix). |
| **Warnings** (only when `verdict.problems.length > 0`) | Red panel with bullet list — `computeYouniumStatus` problems + `buildYouniumExtraWarnings` (customer-name mismatch, link platform mismatch). |
| **Order / offer** | Section title carries colored badge `[INVOICED]` / `[DRAFT]` / etc. Rows: Younium link, Order ID, Order number, Order name, Order status (✓ Invoiced in green, red for Draft/Cancelled), Invoice status (hidden when order is Draft/Cancelled/Expired since invoices belong to a prior order version), Total amount, Currency, Created date, Updated date, **Created by** (from eventlog earliest event), **Last updated by** (from eventlog latest event). |
| **Subscription** | Section title carries `[ACTIVE]` / `[DRAFT (NOT ACTIVATED)]` / `[NONE]` badge. Rows: Younium link (subscription order URL), Order ID, Order number (`Draft` shown in red when no number assigned), Subscription status (color-coded), Start/End/Cancellation dates, Auto-renew/Renewed/Latest version/Term, Created/Updated dates, Created by + Last updated by from subscription order's eventlog. |
| **Other orders for this plant** | Compact one-line-per-order rows for sibling orders (filtered: drops the primary order id, the subscription order id, AND any order whose `orderNumber` matches either — catches Younium's versioning where the same `O-NNNNNN` can have multiple records). Each row: status badge, order number link to Younium, description, start/end dates. **Click-to-expand**: the row header (`.youniumRelatedHead`) toggles an inline `.youniumRelatedDetail` panel that renders the **same rows + styling as the main Order/offer section** (`renderRelatedDetail` builds the identical `renderKV` row set: Younium link, Order ID, Order number, Order name, colored Order status, Invoice status, Total amount, Currency, Created/Updated dates, Created by, Last updated by). The order-status **label + color are derived with the same logic/vocabulary as `computeYouniumStatus`** (isCancelled/isExpired/isRawDraft/isRawCreated/postedInvoices/startsInFuture → label; Invoiced=green, Cancelled/Expired/Draft/Created=red via `var(--bad)`, else `var(--warn)`; Invoice-status row hidden when the order is in a bad state). Lazy-loaded on first open and cached per render (`detail.dataset.loaded`): `youniumFetchOrderDetails(id)` then `youniumFetchInvoicesForOrder` + `youniumFetchOrderEventLog` in parallel (the event log powers Created by / Last updated by via `extractFirstEvent`/`extractLatestEvent`). Loading + error states; a fetch failure shows inline and never breaks the modal. Rendered through `renderKV` (escape-by-default) so values stay XSS-safe; the inner Younium link `stopPropagation`s so it still opens in a new tab. |

The original "Project" section + "Subscription (raw)" + "Raw Younium data" debug table were all removed — the modal now focuses on actionable Younium state only.

**Footer actions:**

- **Refresh status** — clears `youniumStatusFetchedThisSession` for the project, flips the toolbar chip to ⏳ Checking, re-runs `computeYouniumStatus()`, updates modal body + chip face.
- **Copy summary** — writes a plain-text summary to clipboard.
- **Open Younium order ↗** — direct link to saved primary order, only shown when a Younium URL is saved.
- **Open Younium subscription ↗** — direct link to the IWMAC subscription order, only shown when `verdict.subscriptionOrderIsSeparate` (the subscription was found via plant_id and is a different order than the saved primary).
- **Open Oneflow subscription ↗** — direct link to the Oneflow subscription agreement (renamed from "Open subscription" for disambiguation), only shown when `p.oneflowSubscriptionUrl` is set.

**Read-only safety:** no API writes, no project-field mutations (except cached verdict storage), no link overwrites, no subscription activation.

**Caching:** verdict is persisted on `project.youniumStatus = { color, label, orderStatus, subscriptionStatus, orderNumber, kind, problems, lastCheckedAt }` so the chip shows immediately on revisits. Background refresh runs once per project per session via `youniumStatusFetchInFlight` / `youniumStatusFetchedThisSession` Sets. During in-flight fetches the chip flips to `Younium: ⏳ Checking…` (gray) so the user knows what's happening.

**IWMAC subscription detection** — strict regex + multiple entry paths:

1. **The regex stays strict**: `/\bIWMAC\s*(?:Abonnement|Subscription)\b/i`. ONLY products literally named `IWMAC Subscription` or `IWMAC Abonnement` qualify an order as the subscription. `IWMAC Modul: Refrigeration` / `IWMAC Product: Drivers` / etc. are line items that belong to an Order/Offer, not subscription evidence. (Briefly broadened to `/\bIWMAC\b/i` in commit `97ea279` and reverted in `09a7039` — keep strict.)
2. **`findIwmacSubscriptionItem(order)`** walks every plausible array on the order payload (`bookings`, `products`, `charges`, `orderProducts`, `subscriptions`, `subscriptionProducts`, `lineItems`, `items`) and checks each entry's name fields (`productName`, `name`, `subscriptionName`, `product.name`, etc.) against the strict pattern.
3. **`youniumFindSubscriptionByPlantId(plantId)`** is the fallback: `searchOrders("", { conditions: [{ fieldName: "plant_id", value: pid, operator: 0 }, { fieldName: "isLastVersion", value: true, operator: 0 }] })`, hydrates each candidate via `getOrderById`, returns the first one whose products contain a strict-matching name.

**Three entry paths into `computeYouniumStatus()`** all reach the plant_id fallback now:

| Saved URL state | Order/Offer source | Subscription source |
|---|---|---|
| Order URL | the saved order (hydrated) | `findIwmacSubscriptionItem(savedOrder)` → fallback `youniumFindSubscriptionByPlantId(plantId)` |
| Quote URL | the saved quote (verdict `Younium: Quote`) — **unless the quote was converted to an order** (`convertedToOrderId`), then follow to that order (see below) | `youniumFindSubscriptionByPlantId(plantId)` — saved link is a Quote so it can't carry products |
| **No saved URL** | **promote the plant's most recently modified `isLastVersion=true` order** into Order/Offer (full status derivation, invoices, eventlog, synthetic `out.links.saved = .../orders/<id>`) → fallback `youniumFindSubscriptionByPlantId(plantId)` if no IWMAC product on the primary |

The no-saved-URL branch additionally sets a verdict label like `Younium: ⏳ Order found (no saved link)` or `Younium: ⚠ Activate order in Younium` depending on derived status, and pushes a `"Found order via plant_id — consider saving its Younium link on the project"` problem.

**Saved-link version resolution (Order URL path):** a saved link can point to an OUTDATED order **version** — e.g. a draft that was later activated/invoiced as a NEW version with its own order number (Younium keeps the old draft as a separate record with `isLastVersion=false`), which otherwise showed "Draft — action needed" forever. When the fetched saved order has `order.isLastVersion === false`, `youniumResolveCurrentVersion(order, project)` follows it to the CURRENT version: searches the plant_id (`isLastVersion:true`) and matches by identical `description` (+ `accountId` when the summary exposes it), then re-hydrates and derives status from that. It sets `out.supersededFrom` (the stale version) and repoints `out.links.saved` to the current order. Falls back to the stale order if nothing matches, so it never worsens the verdict. (Real case: **10111 Joker Utsira** — saved draft `2ccd4481` v0 → resolved to **O-015038** v1, Invoiced.)

**Quote → Order conversion (Quote URL path):** a Younium quote keeps `status = Quote` forever even after it's won/converted, so a saved Quote link otherwise reported "Quote — not yet converted to an Order" indefinitely. Before the Quote verdict, `computeYouniumStatus` reads the quote's `convertedToOrderId` (alias `convertedToOrderid`; `convertedOrderNumber` is the human number); if set, it rewrites `classified` to `{recordType:"order", recordId: convertedToOrderId}` and repoints `out.links.saved`, so the normal order-status derivation (+ the version resolution above) runs instead of the stale Quote verdict. Sets `out.convertedFromQuote`. (Real case: **4732 Spar Dampsaga** — saved quote `Q-010563` → followed to **O-014783**, "Order (not invoiced)".)

`plantId` is extracted from the project name via `extractPlantIdFromProjectName(name)` — pattern `^(\d{2,7})\s*[-–]\s+` (e.g. "4729 - Storcash Rudshøgda" → "4729").

**Bridge call shape gotcha**: `searchOrders(query, opts)` takes a **free-text string** as the first arg and the structured filter as `opts.conditions`. Calling `searchOrders({ fieldName: "plant_id", value: pid })` (object first arg) stringifies to `"[object Object]"` and returns 0 results — verified via Playwright. Always pass `""` as query and put the filter in `opts.conditions`. Response shape is `{ result, totalCount }` (singular `result`, not `results` or `data`).

**Subscription Draft detection** — three signals, any one triggers Draft:

- `subOrder.status === 5` (documented Younium Draft enum)
- `subOrder.status === 0` (observed in this tenant on un-activated subscriptions; not in any published enum)
- `subOrder.orderNumber` missing / null / "Draft" / starts with "draft" (Younium UI shows "Draft" when an order has no published order number, regardless of `status`)

The `subIsRawCreated` check (status === 1) is conservatively gated — it only triggers "Created (not finalized)" when ALSO combined with a draft-looking orderNumber, because status 1 can also appear on versioned ACTIVE orders.

**API fields used:**

| Source | Field(s) |
|---|---|
| `GET /api/order/{id}` | `orderNumber`, `description`, `status`, `effectiveStartDate`, `effectiveEndDate`, `cancellationDate`, `isLastVersion`, `isAutoRenewed`, `isRenewed`, `term`, `bookings[]`, plus any `products`/`charges`/`orderProducts`/etc. arrays the tenant returns |
| `POST /api/order/invoicesForHistory` `{ orderNumber }` | Array of `{ invoiceNumber, status, posted, paymentDate, dueDate, totalAmount }` — order is "Invoiced" when at least one entry has `status >= 2` OR a non-null `posted` timestamp. Invoices for Draft orders are hidden in the modal since they belong to a prior order version. |
| `POST /api/data/query/order` (via `searchOrders`) | Plant_id-filtered search for the subscription lookup + the "Other orders for this plant" list. Richer `displayFields` requested so we can render compact rows without a per-order `getOrderById`. The summary's status enum is only the lifecycle state (9 Active / 5 Draft / 1 Created); the row badge's real status (Invoiced vs Not invoiced) is refined per active row via the invoice history (next row), but **only while the modal is open** — see `youniumRelatedOrderStatusLabel`. |
| `POST /api/data/query/quote` filtered by `id` | When the saved link is a `/quotes/<uuid>` (immediate "Quote" verdict). |
| `GET /api/eventlog/order/id/{id}` (bridge v1.9.11+) | Audit timeline. Returns array of events with `timestamp` + user identity. We extract the latest event for "Last updated by" and the earliest for "Created by" via `extractLatestEvent` / `extractFirstEvent`. Field-name detection is defensive across multiple candidate keys (`userEmail`, `email`, `userDisplayName`, `userName`, `modifiedByUserDisplayName`, etc.) since we never directly inspected the JSON shape — a `currentColor` stroke also lets the spinner pick up the chip's color tint. |

**Subscription derivation:** the subscription order's lifecycle dates drive the subscription status. Order checks:

- `cancellationDate <= now` → "Cancelled"
- `effectiveEndDate <= now && !isAutoRenewed && !isRenewed` → "Inactive"
- `subOrder.status === 5` OR orderNumber looks-like-draft → "Draft (not activated)"
- `subOrder.status === 1` AND no real orderNumber → "Created (not finalized)"
- `effectiveStartDate > now` → "Order — not active yet"
- `isLastVersion && effectiveStartDate <= now` → "Active"

**Debug logging:** every check emits `[Younium status] …` lines to console — project context, parsed URL, fetched primary order, subscription order, eventlog data, verdict, color decision. The verbose subscription-order dump includes every candidate user-attribution field name so we can identify which one Younium populates on this tenant. Disable via `window.__matchDebug = false`.

#### Two-slot Oneflow (Order/offer vs Subscription agreement)

Each project has **two** Oneflow link fields, not one:

| Project field (state) | Form input ID | Find button | Status element |
|---|---|---|---|
| `oneflowUrl` | `fOneflowUrl` | `btnFindOneflow` | `oneflowFindStatus` |
| `oneflowSubscriptionUrl` | `fOneflowSubscriptionUrl` | `btnFindOneflowSubscription` | `oneflowSubscriptionFindStatus` |

A single `findOneflowDocumentForEditDialog(opts)` powers both buttons via `opts.wantKind` (`"order"` or `"subscription"`). Scoring adjustment:

- Candidate kind matches the request → +6 ("Matches requested kind")
- Candidate kind is wrong → **–25** ("Wrong document kind")

So a perfect-on-everything subscription document scored against the Order/offer slot drops by 25 percentage points — usually below the 85% auto-fill threshold and demoted in the picker, while still visible for manual override.

The state schema migration adds `p.oneflowSubscriptionUrl` (default `""`). The HubSpot Deal Description push (`buildProjectLinksHtml`) now writes BOTH Oneflow URLs back to Rocketlane as separate `Oneflow (Order): <url>` and `Oneflow (Subscription): <url>` lines. The project-info link toolbar shows separate favicon-buttons "Oneflow (Order)" and "Oneflow (Subscription)".

#### Real cross-platform values (plant 3299, captured via Playwright)

| Source | Field | Value |
|---|---|---|
| Rocketlane project 1240431 | `projectName` | `"3299 - Coop Marked Øvre Rendalen: ombygging"` |
| Rocketlane project 1240431 | `customer.companyName` | `"Coolteam AS"` |
| Rocketlane project 1240431 | `projectFee` | `31238` |
| Rocketlane project 1240431 | `projectOwner.emailId` | `thomas.kvalvag@kiona.com` |
| Oneflow agreement 14690987 | `agreement_value` | `{ amount: 16377, currency: "NOK" }` |
| Oneflow agreement 14690987 | `parties[1].name` | `"Coolteam AS"` |
| Oneflow agreement 14690987 | `parties[1].participants[0].email` | `es@coolteam.no` |
| HubSpot deal 502989505768 | `properties.amount` | `{ value: "27902.00", unit: "NOK" }` |
| HubSpot deal 502989505768 | `properties.dealname` | `"3299 - Coop Marked Øvre Rendalen - Ombygging"` |

Note the three money values differ (RL labor 31238, signed contract 16377, deal estimate 27902) — that's why money is a **supporting** 0..8 signal, not a primary one.

### CSS conventions
- Dark mode + light mode via `@media (prefers-color-scheme: light)`.
- Use `var(--surface-1/2/3)`, `var(--hairline)`, `var(--hairline-strong)`, `var(--text)`, `var(--muted)`, `var(--muted2)`, `var(--accent)`, `var(--accent-soft)`, `var(--accent-stroke)`, `var(--bad)`, `var(--bad-soft)`, `var(--good)`, `var(--good-soft)`, `var(--warn)`, `var(--warn-soft)`.
- Floating panels (drawers, popovers, lightboxes) use opaque hex colors `#0f1424` (dark) / `#ffffff` (light) — not rgba — to avoid bleed-through.
- Animation easing: `cubic-bezier(0.4, 0, 0.2, 1)` for Material standard; `cubic-bezier(0.16, 1, 0.3, 1)` for expo-out (decelerate).

### Avoid `contain: layout` on items with positioned descendants
- `contain: layout` creates a containing block for `position: fixed` descendants, so any fullscreen overlay inside a contained ancestor gets clipped. This is why Zendesk ticket cards (which live inside `.chatHistoryBody` which has `contain: layout paint style`) use a **portal pattern**: while fullscreen, the card is moved to `<body>` and restored to its original parent on exit.

### Dropdown menu z-index
- Status picker menu: `z-index: 1500` on both `.statusPicker.open` and `.statusMenu`.
- Mention picker popup: `z-index: 1500`, `position: fixed`, appended to `document.body` to escape `overflow:hidden`.
- Fullscreen overlays: `z-index: 1200`; their pinned controls: `1300`.

### Mention chip styling
- Chips use `class="rl__mention"` (and `rl__mention__self` for self-mentions) — Rocketlane's native class names.
- `::before { content: "@" }` adds the `@` glyph visually without modifying the underlying text.

## Gotchas

### Tracker HTML lives in TWO files within ONE repo — keep them in sync

The tracker repo at `C:\Users\Thomas\Desktop\project-progress-tracker` holds two identical HTML files:

1. `Project Progress Tracker.html` (the "download me" copy users grab for `file://` use)
2. `index.html` (the file GitHub Pages serves at `https://hapnes-dev.github.io/Project-Progress-Tracker/`)

**There is NO third copy.** The old standalone desktop file `C:\Users\Thomas\Desktop\Project Progress Tracker.html` was removed by the user — do not recreate or sync to it. Edit only inside this repo, and `git pull --ff-only` before starting so you build on GitHub's latest.

If you commit only one of the two repo files, the other drifts. Pattern after editing:

```powershell
cd "C:\Users\Thomas\Desktop\project-progress-tracker"
Copy-Item "Project Progress Tracker.html" "index.html" -Force
git add "Project Progress Tracker.html" index.html CLAUDE.md README.md
git commit -m "..." ; git push
```

**GitHub Pages CDN cache**: after `git push`, the deployed page can take 1–2 minutes to refresh, AND your browser caches it. After deploy, hard-refresh with **`Ctrl + Shift + R`** or **`Ctrl + F5`** to actually see the new code.

**Bridge userscript** lives in a separate repo: `Hapnes-dev/tampermonkey-scripts → rocketlane-chat-bridge/rocketlane-chat-bridge.user.js`. The local snapshot under `rocketlane-chat-bridge/` in this repo is a reference copy only — Tampermonkey's `@updateURL` pulls from the `tampermonkey-scripts` repo, so any bridge change must be committed there.


### Bridge body-shape ordering (Rocketlane)
- `rocketlaneCreateTaskInRocketlane` tries multiple body shapes. The **tenant-correct shape** (`projectPhase: {projectPhaseId}`) MUST be tried first — Rocketlane silently accepts the legacy `phase: ...` and returns 201 but creates a **phaseless task**.

### Render rebuilds break in-flight animations
- For DOM that gets rebuilt on every render (chat, categories, tasks), prefer instant state changes or one-shot CSS keyframes triggered by class markers.
- The categories grid uses **instant layout change** because attempted FLIP / View Transitions caused jitter from async re-renders.

### Chat scroll preservation across renders
- `renderDetail()` rebuilds the chat body. Auto-scroll to bottom must happen **after** `appendChild(root)`, not inside `renderMsgs()`.
- Sticky-bottom logic: if user was near the bottom (within 40px), snap to NEW bottom on re-render.
- Re-snap on every `<img>` `load` event for fresh fetches — image decode is async.

### Tampermonkey `@connect` allowlist
- The userscript can only call hosts listed in `@connect`. Current list: `kiona.api.rocketlane.com`, `iwmac.zendesk.com`, `app.oneflow.com`, `app.hubspot.com`, `app-eu1.hubspot.com`, `auth.eu.younium.com`, `auth.us.younium.com`, `api.younium.com`, plus AWS hosts for Rocketlane attachments. Adding a host requires re-saving the script.

### File:// page CORS + cross-context exposure
- ALL cross-origin API calls go through bridges via `GM_xmlhttpRequest`.
- The `file:///*` match is **gated by a meta tag** — `<meta name="rocketlane-tracker" content="hapnes-dev/Project-Progress-Tracker">`. Any other local HTML you open gets no bridge.

### Bridge cross-context publishing (forwarder fallback)
- On some Tampermonkey/browser combos, `unsafeWindow.XBridge = {...}` doesn't reach the page's real window.
- The bridge probes via a synthetic `<script>` tag whether `window.XBridge` is visible. If not, it installs a `<script>`-tag forwarder that proxies method calls via `CustomEvent`. Each bridge has its own request/response event pair.
- Synchronous getters (`apiKey`, `userId` on `RocketlaneBridge`) work through unsafeWindow but NOT through the forwarder. Tracker has both a sync read path (preferred) and an async fallback.

### Listening for clicks on dynamic elements
- For buttons inside dialogs (Edit project, etc.) that are populated AFTER the script's main run, prefer `document.addEventListener("click", e => { if (e.target.matches("#myBtn")) ... })`. Direct `getElementById("myBtn").addEventListener(...)` at script load can run before the `els` object is built and silently no-op.

### Rocketlane custom field that doesn't yet exist on a project
- A project's `fields[]` array only contains fields that have a value. Empty/never-written custom fields are OMITTED.
- To write to such a field, look up its ID via the tenant `/fields` endpoint first. Pattern: `rocketlaneFindDealDescriptionFieldId()`.

### Project-link auto-population source priority

When a project has a `rocketlaneProjectId` set and any of the link slots (`overviewUrl` / `oneflowUrl` / `oneflowSubscriptionUrl` / `youniumUrl` / `hubspotUrl`) is empty, the tracker auto-fetches link values from Rocketlane on every project view (once per session, then cached on the project).

**Source priority** (highest first):
1. **Internal Quality Control task notes** — `rocketlaneFetchInternalQCTaskNotes(rlPid)` looks for a task whose name matches `/\binternal\s+(?:quality\s+control|qc)\b/i` (covers the canonical "Internal Quality control and notes" plus user-listed variants "Internal Quality Control", "Internal QC"). Parses the task's `taskDescription` HTML.
2. **HubSpot Deal Description custom field** — `rocketlaneFetchHubspotDealDescription(rlPid)`. Fallback for any slot IQC didn't fill.
3. **HubSpot Delivery status update message custom field** — parsed from the SAME `/projects/<id>` fetch as the Deal Description (no extra API call), returned as `deliveryStatusLinks`. Lowest of the three embedded-link sources.
4. **Existing fallback search / matching** — the Find buttons (Oneflow / HubSpot / Younium) remain available for manual lookup.

**Merging behavior** (`mergeProjectLinksByPriority(iqcLinks, dealDescLinks, deliveryStatusLinks)`):
- Generalised to a ranked source list (descending priority: `iqc` > `dealDescription` > `deliveryStatus`). Per slot, the first non-empty source wins; any lower-priority source that DISAGREES is recorded in `conflicts` (`{ slot, winner, winnerUrl, source, url }`) and logged — never silently overwriting the winner.
- `sources[slot]` is `"iqc" | "dealDescription" | "deliveryStatus" | "none"`.

**Never silently overwrite manual values**: the auto-fill only writes into EMPTY fields. Saved (non-empty) links survive every refresh; the user must explicitly clear a field before auto-fill will repopulate it.

**Oneflow Order vs Subscription disambiguation** — `classifyOneflowLinkByNearbyLabel(label)` inspects the surrounding text of an Oneflow URL:
- `Abonnement` / `Subscription` / `Subscription agreement` → subscription slot
- `Order` / `Order / offer` / `Offer` / `Tilbud` / `Ordre` → order slot
- Anything else → first ambiguous Oneflow link defaults to the order slot, subsequent ambiguous ones land in the subscription slot, and a console warning lists every ambiguous case so the user can fix the label in Rocketlane.

**Domain-first classification**: URL structure is the source of truth (`classifyLinkUrl`). A link labeled "Oneflow" that actually points at Zendesk classifies as Zendesk and lands in the Zendesk slot — labels never override URL structure.

**Debug log**: every auto-fetch emits a collapsed `[ProjectLinks] auto-fetch for <project>` group with the IQC task found, Deal Description state, ambiguous Oneflow links (if any), the merged result, and the per-slot source. Disable with `window.__matchDebug = false`.

### Auto-renew-on-401 pattern (all four cookie/JWT bridges)

All four non-Rocketlane bridges retry a stale-credential failure exactly once before throwing. The mechanism differs per platform but the shape is identical: a single in-flight promise coalesces concurrent renewals, a 5s cooldown prevents stampedes, and a successful renewal triggers exactly one retry of the original call.

| Bridge | Renew mechanism | Helper |
|---|---|---|
| Zendesk | `GET /api/v2/users/me.json` with `X-Zendesk-Renew-Session: true` (documented session-refresh) | `zendeskRenewSession()` |
| Oneflow | Warmup `GET /api/positions/me` — cookie jar picks up rotated `xsrf-token`, on-site capture re-reads it within ~800ms | `oneflowRenewSession()` |
| HubSpot | Warmup `GET /api/login-verify/v1/info?portalId=…` — same idea, refreshes `hubspotapi-csrf` cookie | `hubspotRenewSession()` |
| Younium | `POST .../frontegg/.../token/refresh` with HttpOnly refresh cookie, mints a fresh JWT | `gmYouniumRefreshToken(forceRefresh)` |

Younium's refresh has TWO modes via the `forceRefresh` flag:
- **Passive** (token "expiring soon" pre-flight): honors the 30s cooldown, hands back the cached token if a recent refresh ran. Prevents stampedes.
- **Active** (401 retry path passes `forceRefresh=true`): bypasses the cooldown because the cached token was just rejected — returning it would loop.

For Oneflow/HubSpot, the warmup can't directly mint new credentials (sessions are HttpOnly + browser-managed), but it does two useful things: it forces the server to issue any pending `Set-Cookie` refreshes into the browser jar that `GM_xmlhttpRequest` uses, and it gives the on-site capture script's 60s polling loop a chance to re-read the rotated CSRF value into GM storage.

### Younium JWT lifecycle
- Frontegg refresh endpoint: `POST https://auth.<region>.younium.com/frontegg/identity/resources/auth/v1/user/token/refresh` with `{}` body. Returns `{ accessToken, expiresIn: 86400 }`.
- Bridge caches the token in `GM_setValue("ynAccessToken")` with expiry timestamp. Refreshes proactively when within 60s of expiry, OR on 401 with `forceRefresh=true` to bypass the 30s passive cooldown.

### HubSpot region split + portal scoping
- US users: `app.hubspot.com`, EU users: `app-eu1.hubspot.com`. Bridge stores the captured `location.origin` so calls reach the right region.
- Every internal API call needs `?portalId=<id>` in the query string. Bridge auto-injects it if not already present.
- CSRF header name: `X-HubSpot-CSRF-hubspotapi` (matches cookie name `hubspotapi-csrf`).

### Oneflow CSRF
- `xsrf-token` cookie is NOT HttpOnly. Capture via `document.cookie` on `app.oneflow.com` pages, attach as `X-XSRF-Token` header on all non-GET requests. The Spring/Laravel double-submit pattern.

## Common tasks and where to look

### Add a new Rocketlane field
1. Add `rocketlaneFetch<FieldName>(rlProjectId)` and `rocketlaneUpdate<FieldName>(rlProjectId, fieldId, value)` helpers near line 9000.
2. Match field by prefix on `project.fields[]`; fall back to tenant `/fields` lookup if the project hasn't been written yet.
3. Hook into `openDlgEdit` to fetch on open + the `els.projectForm` submit handler to push on save.

### Add a 🔎 Find button for a new external system
1. Build the search helper (e.g., `xSearchYThings(query)`) modelled on `oneflowSearchAgreements` / `hubspotSearchDeals` / `youniumSearchOrders`.
2. Build an **adapter** `xToMatchCandidate(rawApiResult)` returning the shared Candidate shape — see the table in **Auto-find buttons → Per-platform adapters**. Map every field you can: `primaryText`, `partyNames`, `contactNames`, `plantId`, `status`, `date`, `raw`. Missing fields just score 0.
3. Add the HTML row in the Edit dialog: clone the `oneflowLinkBlock` div structure with `id="btnFindX"` + `id="xFindStatus"`.
4. Register the elements in the `els = { ... }` block.
5. Build the orchestrator `findXForEditDialog()` modelled on `findOneflowDocumentForEditDialog`:
   - `const ctx = buildProjectMatchContext(null);`
   - call your search helper
   - `const scored = results.map(r => { const c = xToMatchCandidate(r); const s = scoreMatchCandidate(c, ctx); return { candidate: c, ...s }; }).sort((a,b) => b.percent - a.percent || b.score - a.score);`
   - `const decision = decideMatchOutcome(scored);`
   - `debugLogMatch("X", ctx, scored, decision);`
   - branch on `decision.kind === "auto"` → fill, else `renderMatchPicker(...)`
6. Wire the click via document delegation, not direct `els.btnFindX.addEventListener` (timing issue).
7. Reset the status line in the dialog-open handler so it doesn't carry stale values across projects.

Do NOT reinvent scoring — every percentage and "clear-lead" decision goes through the shared functions so all platforms behave identically.

### Add a new toolbar button next to PANG/BAF
- HTML markup: search for `id="btnOpenPang"` and clone the pattern.
- `els` registry: add to the `getElementById` block.
- Show/hide logic: in `renderDetail` near the PANG/BAF show block.
- Click handler: in the event-wiring section near `els.btnOpenPang.addEventListener`.

## Things that DON'T sync to Rocketlane

By design, these are local-only — they modify your browser's copy without touching Rocketlane:

- **Project removal** ("Remove" button) — `deleteSelected()` is explicitly local-only
- **Owner renames** (`renameOwnerGroupEverywhere`)
- Category and task UI expand/collapse state
- **Team-group collapse state** (Owner Workload Overview)
- **Zendesk Tasks section collapse state**
- Custom area labels

## Things that DO sync to Rocketlane

- Status, due date, project notes, custom links — propagate via the sync flow
- **Task add** — **+ Add task** opens `openAddTaskDialog` (task name + **Public/Private** toggle, default Public) → `addTask(projectId, area, name, {private})`. Creates the task in Rocketlane in the correct phase with the chosen visibility: `rocketlaneCreateTaskInRocketlane` takes `opts {private}` and injects `private` into every task-create body (Rocketlane persists `task.private`, read back by `rocketlaneTaskVisibility`). The flag is also set on the local task for the immediate visibility pill.
- **Category add / rename / remove** — categories ARE Rocketlane project **phases**, managed via the **"+ Add category"** button and the category header's **right-click menu** (Rename / Remove). "+ Add category" opens `openAddCategoryDialog` (name + optional preset shortcut + **Shared/Private** type + optional **description**, mirroring Rocketlane's Create-project-phase dialog) and creates the phase (`syncCreateCategoryPhase` → `rocketlaneGetOrCreatePhase` → `rocketlaneCreatePhase`, `POST /projects/{id}/phases`; stores `project.areaPhaseIds[key]`). The dialog has **Start/Due date inputs (default today, editable)**, a Shared/Private toggle, and a description, so the phase is dated to the chosen range (default today — a far-future dueDate rendered as a giant bar in `/plan`; due is clamped ≥ start). All flow via the `opts {private, description, startDate, dueDate}` arg threaded through `rocketlaneGetOrCreatePhase`/`rocketlaneCreatePhase` (`private` = Shared:false / Private:true, `phaseDescription`). The preset dropdown also has a **🧾 From order info** option: `createCategoriesFromOrderInfo(p, opts)` reads the project's order info (`rocketlaneFetchHubspotOrderInfo` → the Hubspot delivery-status field), detects which IWMAC modules the order contains (`ORDER_INFO_MODULE_MAP` regexes on `IWMAC Modul: …` → preset keys: Refrigeration / Ventilation / Energy / Wireless / Heating-VGV / Machine-Room), and creates the matching module category for each — backfilling only the missing tasks/subtasks into any that already exist (matched by normalized text). Each category gets: the generic preset **Design + Integration** tasks, PLUS a **task per order line item** with its **"- " sub-bullets as subtasks** (`parseOrderInfoModules` parses `<p>IWMAC Modul: X</p><ul><li>item</li><li>- sub</li></ul>` — sub-bullets come **two** ways, both handled: a flat dash-prefixed `<li>` sibling, OR a true nested `<ul>` inside the parent `<li>` — the parser reads each item's own text excluding any nested list, so the parent name isn't globbed with its subs). A line item matching `ORDER_INFO_PROMOTE_RULES` (currently `/\bmachinery\b/i`) is pulled OUT of its module and merged into the **Machine Room** preset category (`promotedByPreset`; a Machine Room plan entry is auto-added if that module wasn't itself in the order). **All of it — the phase AND every task AND every subtask — is created in Rocketlane** via `syncCreateCategoryWithTasks` (the old code only made the phase via `syncCreateCategoryPhase`, leaving every task/subtask local-only — they showed in the tracker but not in `/plan`): it creates the phase, then `rocketlaneCreateTaskInRocketlane` per task (parentless) and per subtask (passing the parent's freshly-created Rocketlane id so it nests), linking `meta.rocketlaneTaskId` / `parentTaskId` back onto the local tasks; runs sequentially in the background after the instant local render (a toast reports created/failed counts). The manual preset path (pick a module preset rather than "From order info") likewise creates its Design + Integration tasks upstream via the same helper. **Rename** renames the phase too (`syncRenameCategoryPhase` → `rocketlaneRenameProjectPhase`, **PUT** `/projects/{id}/phases/{phaseId}` — PATCH 400s on this tenant — so the local label and phase name stay in sync). `removeCategory` deletes the phase (`syncDeleteCategoryPhase` → `rocketlaneDeleteProjectPhase`, `DELETE /projects/{id}/phases/{phaseId}` — Rocketlane **cascades the phase's tasks**) — matched by stored id, else phase name. No-op without a `rocketlaneProjectId`; `removeCategory` requires a **double confirm** (the second is an "Are you ABSOLUTELY sure" gate) because it's destructive. (`rocketlaneCreatePhase` hits the project-scoped endpoint first — the generic `POST /phases` 500s on this tenant.)
- **Task rename / remove** — **right-click the task name** opens a context menu (`showContextMenu`): *Rename task* (`renameTask` via prompt), *Open fullscreen* (`openTaskFullscreen`), *Remove task* (`removeThisTask`, shared with the Remove button — Rocketlane-aware confirm; linked tasks propagate the upstream DELETE).
- **Task removal of LINKED tasks** — propagates the upstream DELETE (with a loud ⚠ warning)
- **Hubspot Deal Description** — auto-updated on every save with the project's external links (Oneflow / Younium / HubSpot)
- **Owner Workload pill** — syncs via the `[Tracker] Workload Sync` meta-project (one task per user; workload token in `taskDescription`)

## Things that sync to OTHER platforms

- **Zendesk reply** (from the Zendesk Tasks fullscreen view) — PUT to `/api/v2/tickets/<id>.json` with a new `comment` field. Public reply or internal note.

## Security model

- **Zero hardcoded secrets** in the HTML — the Rocketlane api-key lives ONLY in `localStorage` (`progress_tracker_rl_api_key_v1`) and the userscript's GM storage, never in the committed file. (Storing it locally is acceptable; the public HTML must stay secret-free.)
- **Every bridge-exposing origin is meta-gated** (bridge v1.9.14+): `file://`, `localhost:8102`, **and `hapnes-dev.github.io`** only publish `window.*Bridge` when the page carries `<meta name="rocketlane-tracker" content="hapnes-dev/Project-Progress-Tracker">`. github.io is a shared host, so it's gated too — not just local dev. (Capture-only platform pages like rocketlane.com are NOT gated; that's where token capture runs.)
- **Credentials are origin-scoped in the bridge** (v1.9.14+): `gmRequest`/`gmYouniumRequest` refuse to attach the Rocketlane api-key / Younium Bearer JWT unless the resolved request origin IS the platform API origin. A caller passing an absolute URL to another `@connect` host (e.g. an S3 bucket) can't carry the secret header. `YouniumBridge.refreshToken()` returns a status object, not the raw JWT.
- **Untrusted HTML** is sanitised through allowlists before any `innerHTML =` write:
  - `sanitizeHtmlForChatMessage` for Rocketlane chat
  - `sanitizeZendeskHtml` for Zendesk comments
  - `sanitizeHtmlForEditor` for general rich-text content
- **All interpolated values in `innerHTML` template strings** go through `escapeHtml()` / `escapeForHtml()` / `escHtml()`. `escHtml()` escapes `< > & " '` (quotes included → safe in `href="…"` attribute contexts, not just text).
- **`renderKV` (Younium status modal) is escape-by-default**: every value is HTML-escaped unless explicitly wrapped in the local `RAW()` marker (code-built HTML only). This replaced an unsafe `.includes("<")` heuristic that injected any attacker value containing a `<` (e.g. `order.description`) raw → stored XSS. Fail-safe: a missing `RAW()` over-escapes (cosmetic) rather than opening XSS.
- **URL sinks are scheme-guarded**: link/button `href` and window-navigation assignments fed by stored or API data (Younium links, Rocketlane attachment URLs) go through `toHttpUrl()`, which strips `javascript:`/other non-`http(s)` schemes.
- **Console logs never expose credentials** — only presence + length.
- **Internal-API diagnostic logs** use `console.debug` so they're filtered by default.
- **Trust boundary**: any script on the tracker origin is fully trusted (it can read `localStorage` + call the bridge). Therefore keep the tracker origin free of third-party/external `<script>` includes, and treat all five platforms' API response data as untrusted input to the DOM.

When adding new code that calls Rocketlane / Zendesk / Oneflow / HubSpot / Younium:
- Route through `rocketlaneRequestJson` / `zendeskApiRequest` / `oneflowApiRequest` / `hubspotApiRequest` / `youniumApiRequest`. Never call `fetch()` directly.
- Never embed secrets in source.
- If logging a request body for debugging, redact `Authorization`, `api-key`, `xsrf-token`, `X-CSRF-*`, and any field with `*key*` / `*token*` / `*secret*` in its name.

## Testing protocol (mandatory after every change)

Every code change ships through this verification flow before being declared done. Skip a step only when it doesn't apply (see exceptions at the end).

**Source of truth + workflow (READ FIRST):**
- The ONLY local working copy is the git repo at **`C:\Users\Thomas\Desktop\project-progress-tracker`**. Edit there. The old standalone desktop copy `C:\Users\Thomas\Desktop\Project Progress Tracker.html` has been **removed by the user — never read, edit, or sync it.**
- **Pull GitHub first** every session/turn before editing: `git pull --ff-only origin main`. Other sessions push here too; the GitHub `main` is authoritative — stay on top of it so you never build on a stale tree.
- The repo holds **two HTML files that must stay byte-identical**: `Project Progress Tracker.html` (download-me copy) and `index.html` (what GitHub Pages serves). After editing one, copy it onto the other before committing.
- **Testing is on the LIVE URL**, not a local file or server. The desktop file is gone, Playwright blocks `file://`, and a local `http.server` triggered a stale-service-worker redirect to the live origin. The deployed URL is the only reliable target. Trade-off: a ~30–90 s GitHub Pages deploy wait per push — so batch edits before pushing.

**Steps:**

1. **PowerShell — sync + integrity**: copy `Project Progress Tracker.html` → `index.html`, then confirm the two repo HTML files are byte-identical (`Get-FileHash`). `git status` shows only the expected files dirty.
2. **PowerShell — commit + push**: `git add` named files (never `-A`), commit, push to `origin main`.
3. **PowerShell — confirm deploy**: poll `curl.exe -s "https://hapnes-dev.github.io/Project-Progress-Tracker/index.html?cb=<n>"` for a unique marker string from your change (GitHub Pages takes ~30–90 s; the CDN + browser cache, so cache-bust the query string). Don't test until the marker appears.
4. **Playwright — exercise the changed UI on the LIVE URL**: load `https://hapnes-dev.github.io/Project-Progress-Tracker/`, then click/type/navigate the surface that changed. A change without a click-through is unverified.
5. **Playwright — console must be clean**: call `browser_console_messages` after the action. Treat any new `error` or `Uncaught` as a failure even if the UI looked fine — a 29k-line single-file app silently breaks easily.
6. **Playwright — screenshot for visual changes**: capture and inspect when the change is CSS, layout, or any visible polish.

**Playwright bridge caveat**: Tampermonkey doesn't inject into Playwright, so the notifications bell / Younium / Zendesk / Find UIs won't open on their own. Use the **mock-bridge pattern** — install `window.RocketlaneBridge` / `window.ZendeskBridge` / etc. with stubs that return realistic shapes (the bell needs `RocketlaneBridge.fetchNotificationGroups`; Zendesk needs `apiRequest` for `/search.json` + `/comments.json` + `getCurrentUser`), exercise the UI, then assert behaviour. To prove an outgoing request shape (e.g. the Zendesk search window), record calls in the stub and inspect the captured path. End-to-end bridge verification still requires the user's real Chrome.

**Exceptions** (skip noted steps with a one-line justification in chat):
- **Docs-only change** (CLAUDE.md / README.md): skip steps 4–6 (no UI surface). For step 3, the GitHub Pages `Last-Modified` won't flip because `index.html` isn't touched — instead `curl https://raw.githubusercontent.com/Hapnes-dev/Project-Progress-Tracker/main/<file>` and grep for the new content.
- **Bridge-only change** (userscript in `Hapnes-dev/tampermonkey-scripts`): skip steps 4–6 in favor of a Tampermonkey reload + manual sanity ping in the user's normal browser, since Playwright can't host the bridge.

## When working with Claude

- Prefer minimal, surgical edits. The file is large and any unrelated change is high-risk.
- For animations: less is more. `render()` rebuilds DOM. Instant toggle is the most reliable.
- The Rocketlane API has tenant-specific field IDs. Never hardcode them — always look up by name prefix. AND check both project.fields[] AND the tenant /fields endpoint, since custom fields without values are omitted from project responses.
- HubSpot's internal API is undocumented and region-split — be ready for breaking changes between UI versions. For load-bearing integrations, prefer a Private App access token + `api.hubspot.com/crm/v3/*`.
- When the user says "X doesn't work," ask for THREE specific things:
  1. `location.href` of the page they're testing on (catches local-file vs live-URL confusion)
  2. `window.RocketlaneBridge?.version` (and the relevant other bridge's version) + `typeof window.XBridge?.apiRequest`
  3. Network tab screenshot showing the actual outbound request (distinguishes "code didn't fire" from "code fired but API errored")
- For "silent skip" bugs (push appears to run but nothing changes downstream): look for `if (!fieldId)` / `if (!key)` / `if (!something)` fallthroughs that swallow the failure. Add a `console.warn` AT EVERY such fallthrough so you can see WHY it skipped.

## Recent significant changes (chronological)

- **Rocketlane import: "Only show projects owned by <picked user>" toggle** — the import picker lists `mine` = projects where the picked user is the owner **or** a team member, so projects owned by others showed too. Added a checkbox (`#rlOwnerOnly`) under the filter box that narrows the list to projects the picked user actually owns, via the canonical `rocketlaneProjectIsOwnedByUser` predicate (userId → email → normalized-name — the same logic behind the status line's "owned: N" count). Off by default; shown only in projects mode; label names the picked owner; resets when a new user is picked (`rocketlaneProjectPickerOwnerOnly`, applied in `rocketlaneRenderProjectPicker` after the text filter). Verified live: picker loaded 26 (16 owned), toggle on → exactly the 16 owned, hiding the 10 owned by others; reversible; 0 console errors.
- **Faster task→Rocketlane creation: cache phases + sample task per project** — each create did ~3 serial tenant-API GETs before the POST: `rocketlaneGetOrCreatePhase` (GET the phase list), `rocketlaneFetchTaskSampleForProject` (GET a sample task to learn the object shape + inherit assignees — run on EVERY create), then the task POST. Neither read was cached, so adding several tasks or a "From order info"/multi-subtask batch re-paid both per task. **Measured live: the sample GET (`/tasks?pageSize=1`) is ~9s on this tenant** (the filter-key detection probe was a one-off ~53s), so this dominated the delay. Added two session caches — `rocketlaneTaskSampleCache` (per project) and `rocketlanePhaseByNameCache` (per project+name, PRESENT phases only so a stale entry can never cause a duplicate phase) — plus `rocketlaneClearProjectCreateCaches(pid)` called on phase rename/delete and after a manual single-project sync. Verified: 2nd..Nth create in a project drops from ~9.4s of GETs to **0** (just the POST); `phaseWarm`/`sampleWarm` = 0ms, phase resolves to the existing phase (no spurious create), clear forces a re-fetch. No behaviour change — the sample is still read once so new tasks keep inheriting the project's assignee. **Open trade-off (not done):** the first create per project per session still pays the ~9s sample GET because it's needed for assignee-inheritance; skipping it (lazy) would speed that up but leave new tasks unassigned (all sampled projects' tasks carry an assignee) — a product decision left to the user.
- **Order-info "From order info": route aftermarket refrigeration items into the Refrigeration category** — `ORDER_INFO_MODULE_MAP` only maps `IWMAC Modul:` headers, so the `IWMAC Product: Aftermarket Services` section was dropped whole, and the only promote rule was `/machinery/`. Plant 3502's `IWMAC Aftermarket: New refrigeration position/section - price per unit — 26 pcs` therefore never created a "Refrigeration and freezing systems" category. Fix: one entry added to `ORDER_INFO_PROMOTE_RULES` (~line 27481) — `{ re: /aftermarket.*refrigeration/i, presetKey: "refrigeration_freezing" }`. The item is pulled out of the unmapped header into `promotedByPreset['refrigeration_freezing']`, and the existing promote-fallback (~27609) creates the Refrigeration category even when no `IWMAC Modul: Refrigeration` is in the order. Anchored on **"aftermarket"** so it never matches the `Per refrigeration position/section including image` item inside a real `IWMAC Modul: Refrigeration` (no "aftermarket" in that text) — mapped-module behaviour is byte-for-byte unchanged. Designed + adversarially regression-audited via a multi-agent workflow and verified across **20 real orders / 169 line items**: matches exactly the 2 aftermarket refrigeration items (3502 + 3694), 0 module items; Machinery still promotes to Machine Room (10); `Modul: Refrigeration` "position/section" items all stay in their module (12, 0 wrongly promoted). `IWMAC Product: Images / Drivers / Freight / HW` and `Modul: Basic` stay dropped (product groupings, not disciplines) — unchanged.
- **"Other orders for this plant": show the real order status, not just the lifecycle state** — the sibling-order rows in the Younium status modal showed the raw lifecycle enum (status 9 → "Active") even when the order had actually been **Invoiced**. Two shared helpers now mirror `computeYouniumStatus`'s derivation: `youniumRelatedOrderStatusLabel(orderSummary, postedInvoiceCount)` → `Invoiced / Draft / Cancelled / Created / Pending start / Not invoiced / Outdated` (Active until invoices are known), and `youniumRelatedOrderBadgeClass(label)` → green/red/yellow/gray; `youniumInvoiceIsPosted(inv)` (status 2 Sent / 3 Paid / posted flag) is the shared posted-invoice predicate (also reused in `computeYouniumStatus`). Cancelled/Draft/Created/Pending-start resolve from the **summary alone**; an otherwise-active row renders "Active" then, **only while the modal is open**, an async pass fetches that order's invoices (`getInvoicesForOrder`) and upgrades the badge to **Invoiced** or **Not invoiced**. Only the active rows are fetched; skipped entirely when the bridge lacks `getInvoicesForOrder` (keeps "Active" rather than wrongly asserting "Not invoiced"); the background status chip is unaffected (no extra fetches).
- **Task notes: drag the whole bottom edge to resize** — the native `<textarea>` resize grip is a tiny bottom-right corner that's fiddly to grab. `makeTextareaEdgeResizable(ta)` (called for the Description note + Private note in `renderDetail`) disables the native grip (`resize:none`) and inserts a full-width drag strip (`.taResizeHandle`, `cursor:ns-resize`) on the textarea's bottom edge; pointer-drag adjusts height (clamped to `min-height`). The handle is a **sibling, not a wrapper**, so the note-popout move logic (which captures `notesBox.nextSibling`) still restores order; its negative margin cancels the parent grid's row gap (8px `.taskDetails` / 4px `.taskPrivateNoteWrap`) so it hugs the edge; and the popout's `height:auto !important` overrides any inline drag-height so a resized note never breaks the popout. Verified live (90px drag → +90px; clamps to the 88px min; full-width).
- **Task-notes cards: clickable URLs** — the note body was rendered via `textContent`, so http(s) URLs stayed plain text. A small DOM linkifier (`appendNoteText`, in the Task-notes overview render) now splits the note into text nodes + `<a class="taskNoteLink">` elements — XSS-safe (no innerHTML of user content), opens in a new tab (`rel=noopener noreferrer`), trims trailing prose punctuation off the href, and `stopPropagation`s on the anchor so clicking a link doesn't also fire the row's "open task in categories" handler. Long URLs wrap via the body's existing `overflow-wrap:anywhere`.
- **Owner Workload Overview: manual refresh button** — a small refresh-icon button sits next to the heading (`#ownerStatusRefresh`, sibling of the collapse toggle since nesting buttons is invalid). Click → `rocketlaneFetchTeamWorkload()` re-pulls every teammate's project counts + workload values from Rocketlane and re-renders (the fetch already calls `renderOwnerStatusOverview` on success); the button spins (`rlSyncSpin` keyframe) + disables while in flight to guard against double-fires, then restores. The header `.ownerStatusHd` is now `display:flex` with `justify-content:flex-start` to override the base `.hd`'s `space-between` (which otherwise shoved the button to the far right). Verified live: spins+disables on click, ~20s full re-fetch, re-enables cleanly, no console errors.
- **Matching deep-dive: fix the dead custom-field reader + hydrate Younium orders + route curated links by field (lifts all 5 link Find buttons)** — a Playwright/PowerShell deep-dive across every platform found the match context was running nearly blind. All verified live on plant 10218 (rlPid 1196054):
  - **`readRocketlaneCustomField` read `f.value`, but the `/projects/<id>` payload stores it under `fieldValue`** → it returned `undefined` for EVERY custom field, silently zeroing the whole HubSpot-mirror bundle, contact info, money, AND the embedded links parsed from the Deal Description. Auto-find was effectively running on plant_id + name tokens alone. The one-key fix (prefer `fieldValue`, `value` fallback) resurrected all of it — the Younium order/offer quote jumped **60% → 85%** (now auto-fills) and the subscription order **46% → 71%**, purely from the +25 embedded-link signal that had never fired.
  - **Younium order candidate + Find hydration**: `youniumToMatchCandidate` now reads `customFields[]` (`integrationHubspotHubspotDealId`, `deal_contact`, plant id/name, invoice ref), `_account` (org number / name / domain) and `description`; money fixed to the real `tcv`/`acv`/`cmrr` `{amount}` objects (the old `totalContractValue`/`mrr` keys don't exist → money scoring was dead). `findYouniumOrderForEditDialog` hydrates each plant-filtered order via `getOrderById` + `GET /Accounts/{id}` before scoring (bounded, defensive fallback to the search shape).
  - **Kind-aware embedded links**: the Deal Description labels each link for a field ("Oneflow (Order)" vs "(Subscription)", "Younium (Order/offer)" vs "(Subscription)"). `buildProjectMatchContext` now tags every embedded link with `linkKind` (reusing `parseProjectLinksFromHtml`'s container-walk), and `scoreMatchCandidate(c, ctx, {preferLinkKind})` scores a curated link **0 instead of +25** when it was labelled for the sibling slot. The order/offer Find no longer competes with the subscription record — the quote auto-fills with a **39-pt lead** (was 14 → picker); the two Oneflow docs (both `/documents/<id>`, otherwise indistinguishable by URL) separate cleanly.
  - **Younium subscription Find** (deterministic, doesn't use the scorer) now prefers the curated "Younium (Subscription)" link when present, falling back to the plant_id + IWMAC-product heuristic.
  - **HubSpot**: the same master fix lights up its deal-id cross-link (+35), contact email/phone, deal-name mirror and the exact embedded HubSpot link (+25); full live re-verification is pending a HubSpot re-login (the session had timed out during the dive).
- **Add-category preset: reuse an existing category, never duplicate tasks** — the manual "Add category" dialog's preset/custom path (`doCreate`) used `ensureUniqueKey` (always a fresh category key) and pushed the preset's Integration/Design tasks unconditionally, so picking a preset whose category already existed produced a **duplicate category + duplicate tasks**. It now matches an existing category by **normalized label** and reuses its key, and skips any preset task whose **normalized text** is already present (top-level only). Only newly-added tasks go to `syncCreateCategoryWithTasks` (which also dedups against Rocketlane); a brand-new empty category still gets `syncCreateCategoryPhase`; an existing category with nothing to add shows a *"already exists — nothing new to add"* toast. ("From order info" already did this via its backfill.) Verified live by driving the real dialog (existing "Energy" → 1 category, tasks unchanged, no sync; new "Wireless" → created + synced).
- **Files popover: upload to General Shared Files (button + drag-and-drop) — tracker + bridge v1.9.16**
  - The Files popover gained an **⬆ Upload** header button (hidden `<input type=file multiple>`) and **drag-and-drop** anywhere on the popover (`.filesDropActive` dashed-outline state, dragenter/leave depth-tracked to avoid flicker). Uploads are sequential with progress on the button; on completion the popover reopens to re-fetch the list. The header actions are built **before** the empty-file check, so you can upload to a project with zero files (the empty message invites drag-and-drop). Feature-detected via `bridge.uploadAttachment`.
  - **Destination = General Shared Files.** Discovered (Playwright network sniff of Rocketlane's own upload) that an attachment lands in a folder only via a **2-step** flow: `POST /attachments` with the create body carrying `sourceType:"FOLDER"` + `sourceId:<folderId>`, **then** `POST /projects/{pid}/folders/{fid}/attachments/link` with body `[attachmentId]` (a raw array — object shapes 400). Create-with-`projectId`-only (the old bridge) produces an **orphan** attachment shown in no folder. Verified live: create+link → `gsfCount` increments + the file appears in the folder; create-without-link or link-without-`sourceType` → does NOT.
  - **Bridge v1.9.16**: `uploadAttachment(projectId, file, { folderId, publicVisibility })` now adds `sourceType`/`sourceId` to the create and POSTs the folder link when `folderId` is given (folder uploads default `publicVisibility:false`, matching the UI). The **tracker** resolves the General Shared Files folder per upload via `GET /projects/{id}/folders` → `isDefault && !isPrivate` (folder `2532348` on the test project) and passes `folderId`. Older bridges ignore `folderId` (orphan) → the outdated-bridge popup nudges the v1.9.16 update.
- **Outdated-bridge warning popup (tracker + bridge v1.9.15)**
  - The **bridge** now publishes its own `@version` on the page — `window.RocketlaneBridge.userscriptVersion` (+ the other bridges) and `window.IWMAC_BRIDGE_VERSION`, set from `GM_info.script.version` in **both** publish paths (direct + the `<script>`-tag shim fallback). Bumped to **v1.9.15** (canonical `Hapnes-dev/tampermonkey-scripts` + the PPT `rocketlane-chat-bridge/` snapshot, kept in sync).
  - The **tracker** runs `checkBridgeUpdate()` on load (after `rocketlane-bridge-ready` / a 5s fallback): fetches the latest `@version` from the canonical userscript on GitHub raw (`raw.githubusercontent.com` sends `ACAO:*`, so a direct `fetch` works), retries once, and caches the last-seen latest in `bridge_latest_seen_v1` so an occasional rate-limit (shared office IP) doesn't disable the check. If the installed bridge is older than latest — **or can't report its version (pre-1.9.15)** — a dismissible bottom-right card shows with an **Update bridge** link (the `@downloadURL`, which Tampermonkey intercepts). Dismissal is remembered per latest-version (`bridge_update_dismissed_v1`). `compareBridgeVersions` does a numeric dotted compare (missing/invalid installed = older). Skipped entirely when no bridge is present (the tracker surfaces "bridge not installed" elsewhere).
  - Verified live: compare logic, the CORS fetch (200 + 1.9.15), popup shown for outdated/undetectable, NOT shown for up-to-date/ahead, dismissal persistence, and the retry + cache-fallback. **Requires the user to update the bridge to v1.9.15** (which is exactly what the popup nudges).
- **Files "Download all": prompt for the destination folder every time** — `getOrPickDownloadParentDir` used to prompt once, cache the `FileSystemDirectoryHandle` in IndexedDB, then silently reuse that folder for all later downloads. It now **always** shows `showDirectoryPicker` so the user chooses the destination each run; the cached handle is used only as the picker's `startIn` hint (last-used folder, else `"downloads"`), and the new pick is saved as next time's start. Stale-handle retry (→ `"downloads"`) + `AbortError` cancel handling preserved; the per-project subfolder is now **date-stamped** (`sanitizeFolderName("<project> <YYYY-MM-DD>")`, local date) and the filename-collision logic is unchanged. Verified live (with a folder cached, the picker is still shown, starts at the cached handle, returns + saves the fresh pick).
- **Order-info: push local-only tasks (rlId null) up to Rocketlane + dedup (idempotent sync)**
  - Root cause of "tasks created in the tracker but never applied in Rocketlane": order-info tasks made by older **phase-only** code sit in local state with **`meta.rocketlaneTaskId` null** — the phase exists upstream but its tasks were never POSTed. The backfill (previous entry) only compared **local** presence, so it saw them as "present" and never synced them up. Now the reconciliation marks a task as needing sync when it's missing locally **OR** present locally with no rlId.
  - `syncCreateCategoryWithTasks` is now **idempotent**: it indexes the phase's existing Rocketlane tasks once (`rocketlaneFetchAllTasksForProject`; top-level keyed by normalized name within the phase, subtasks by `parentRlId + name`) and **links** a local task to a same-named upstream task instead of creating a duplicate. So a re-run that finds the task already upstream just repairs the local `rocketlaneTaskId` link; only genuinely-absent tasks are POSTed. Verified live: a category of rlId-null tasks gets queued (`parentExists:false`); against 2619's real "Documentation" phase, an existing task linked to its real id while a brand-new one was created (create stubbed → no writes).
- **Order-info preset: backfill missing tasks into an existing category (instead of skipping)**
  - Re-running "From order info" used to skip any module whose category already existed ("All order-info module categories already exist"), so deleting a task — or an earlier half-create that left an **empty** category — couldn't be topped up. `createCategoriesFromOrderInfo` now, per planned category, builds the desired task set and either **creates** the category (new) or **backfills only the missing tasks/subtasks** into the existing one. Matching is by **normalized text** (`trim/lowercase/[–—−]→-/collapse-spaces`) so "— 30 pcs" vs "- 30 pcs" don't double up. A missing top-level task is created fresh; a missing sub-bullet of an **existing** task nests under that task's existing Rocketlane id — `syncCreateCategoryWithTasks` gained `it.parentExists` (skip creating the parent) + `it.parentRlId`. Backfill reuses the existing phase (`rocketlaneGetOrCreatePhase`). Message reports created vs "added missing tasks to &lt;cat&gt; +N".
  - Verified live (deterministic synthetic: empty Refrigeration → +3 incl. "Per refrigeration position — 30 pcs", Machinery correctly stays promoted to Machine Room; complete Energy + Machine Room → 0 dupes) on project 2619.
- **Ctrl/Cmd+F focuses the project search box** — a global `keydown` handler (in the toolbar wiring next to the search/sort/filter listeners) calls `preventDefault` + `els.search.focus()`/`.select()` instead of the browser's native find. Guarded: bails (native find still works) when `notesFullscreenOpen` is set, the `#addCatOverlay` dialog is open, or `document.activeElement` is another `input`/`textarea`/`contenteditable` — so it never steals focus mid-edit. Verified live (focuses+selects from the list; ignored while another field is focused; Cmd+F too).
- **Order-info parser: support nested-`<ul>` sub-bullets (bug fix)**
  - Some Oneflow orders render a line item's sub-bullets as a **true nested `<ul>` inside the parent `<li>`** (`<li>item<ul><li>sub</li></ul></li>`) instead of flat dash-prefixed `<li>` siblings. `parseOrderInfoModules` used `li.textContent`, which globbed the parent **plus every nested bullet** into one task name — e.g. project 2184 created a task literally named "IWMAC Image: System image — 3 pcs**Nytt oversiktsbildeNy maskintegning og riggVGV/AC bilde**" with no subtasks.
  - The parser now reads each `<li>`'s **own text** (text nodes + inline elements, **excluding** any nested `<ul>`/`<ol>`) as the line item, and treats a nested list's `<li>`s as that item's subtasks. The original flat **"- "-prefixed sibling** format still works (both flavors handled). Verified on the live build against the real 2184 order info (3 nested subs split correctly) and the old Machinery flat-dash order (no regression) — both the parser and the full `createCategoriesFromOrderInfo` job list.
- **Reply to a Zendesk comment from the notifications drawer**
  - Right-clicking a "Zendesk · recent replies" row opened a **read-only** fullscreen reader (`openCommentFullscreen`). It now accepts an optional `o.reply = { ticketId, ticketStatus }` (+ `o.onSent`) and appends the **same compose box as the Zendesk Tasks fullscreen** — shared `.zendeskCompose` / `.zendeskReplyKind` CSS: a Public reply / Internal note sliding toggle (default Public), a textarea, **Ctrl/Cmd+Enter** to send, posting via `ZendeskBridge.postTicketReply(ticketId, body, isPublic)`. Closed tickets show the `.zendeskComposeClosed` notice (Zendesk 422s on closed). On send it re-runs `o.load` (refresh the conversation body) and `o.onSent` (`→ notifZdRefresh`, updating the "↩ You replied" line). The `.notifZdItem` right-click handler passes `reply:{ticketId:t.id, ticketStatus:t.status}`; Rocketlane notif items pass nothing, so theirs stays read-only.
  - Verified live on the deployed build with `postTicketReply` stubbed (drawer → right-click row → composer renders below the body; toggle → Internal recorded `isPublic:false`; "Sent." shown; textarea cleared) — **no real reply sent**.
- **Bug fix: order-info / preset categories now create their TASKS in Rocketlane (not just the phase)**
  - `createCategoriesFromOrderInfo` and the Add-category dialog's preset path called only `syncCreateCategoryPhase`, which creates the **phase** but no tasks — so the generic Design/Integration tasks, the order line-item tasks, AND their sub-bullets appeared in the tracker but **never in Rocketlane** (`https://kiona.rocketlane.com/projects/1260068/plan` showed the empty phase).
  - New `syncCreateCategoryWithTasks(project, areaKey, label, jobItems, opts)` creates the phase, then calls `rocketlaneCreateTaskInRocketlane` for each task (parentless) and each subtask (passing the parent's freshly-created Rocketlane id so it nests), linking `meta.rocketlaneTaskId` / `rocketlaneProjectId` / `parentTaskId` back onto the local task objects — the same proven path `addTask` / `addSubtask` use. `jobItems` = `[{ task:<localTaskObj>, subs:[<localSubObj>…] }]`. Runs **sequentially** (a subtask needs its parent's id first) in the background after the instant local render; a toast reports created/failed counts.
  - **Gotcha**: a category that already exists locally is still skipped, so an earlier half-created category (phase exists, tasks don't) must be **removed and re-added** to push its tasks. Right-click the category → Remove (deletes the empty phase), then re-run "From order info".
- **Categories ↔ Rocketlane phases: create / rename / delete now sync**
  - A tracker category maps to a Rocketlane **phase** by name (`areaPhaseIds` = areaKey→phaseId). Creating a category creates the phase via the **project-scoped** route `POST /projects/{pid}/phases` `{projectPhaseName, startDate, dueDate, private, phaseDescription}` (the generic `POST /phases` **500s** on this tenant). Renaming renames it via `PUT /projects/{pid}/phases/{phaseId}` (**PATCH 400s**). Removing deletes it via `DELETE …/{phaseId}` — which **cascades the phase's tasks** — behind a **double `confirm()`** (2nd: "Are you ABSOLUTELY sure").
  - Wrappers: `rocketlaneCreatePhase` / `rocketlaneRenameProjectPhase` / `rocketlaneDeleteProjectPhase`, and the local-state syncers `syncCreateCategoryPhase` / `syncRenameCategoryPhase` / `syncDeleteCategoryPhase`. Local-only (non-RL) projects skip the sync.
- **Add-category dialog + "From order info" preset**
  - **+ Add category** opens a custom dialog (`openAddCategoryDialog`): preset `<select>`, name, **editable Start/Due date inputs (default today)**, a **Shared/Private** toggle, and an optional **description** — mirroring Rocketlane's own Create-phase form. Dates default to the **creation date** on purpose: an early version used `dueDate = today + 1yr`, which drew a giant bar in /plan and read as "it didn't create the category". Due date is clamped ≥ start.
  - The **"🧾 From order info"** preset (`createCategoriesFromOrderInfo`) reads the project's HubSpot order-info field (`rocketlaneFetchHubspotOrderInfo` → `GET /projects/{pid}?includeAllFields=true`, field `hubspotdeliverystatus`) and creates a category per IWMAC module it contains (`ORDER_INFO_MODULE_MAP`: Refrigeration / Ventilation / Energy / Wireless / Heating·VGV / Machine Room). Each module category gets the generic **Design + Integration** tasks (from `CATEGORY_PRESETS`) **plus a task per order line item**, and each line item's indented sub-bullets become subtasks — `parseOrderInfoModules` handles **both** Oneflow flavors: a flat **dash-prefixed `<li>` sibling** AND a true **nested `<ul>` inside the `<li>`** (it reads each item's OWN text, excluding any nested list, so the parent name isn't globbed with its sub-bullets). Subtasks are linked via `meta.parentLocalTaskId`. If a category already exists, it **backfills only the missing tasks/subtasks** (matched by normalized text — dash/space/case-insensitive) instead of skipping: a missing top-level task is created fresh; a missing sub-bullet of an existing task nests under that task's existing Rocketlane id (`syncCreateCategoryWithTasks` takes `parentExists`/`parentRlId`). Reuses the existing phase.
  - **Promoted line items → another preset's category**: a line item matching `ORDER_INFO_PROMOTE_RULES` (currently `/\bmachinery\b/i` → preset `machine_room`) is pulled OUT of whatever module it's nested under and **merged into that preset's category** (`promotedByPreset`: presetKey → items) — so the "System image - Machinery" deliverable (Maskintegning / VGV-bilde) listed under Refrigeration lands in the **Machine Room** category (item stays a task, its `"- "` sub-bullets stay subtasks). Extraction happens before the module plan is built (`orderInfoPromoteRuleFor`), so Refrigeration no longer shows that item; and if the order had no `IWMAC Modul: Machine Room`, a Machine Room plan entry is appended so the category (with its generic Design/Integration tasks) is still created and the promoted items are merged in.
- **Add-task dialog: Public/Private choice**
  - **+ Add task** now opens a dialog (`openAddTaskDialog`: name + **Public/Private** toggle) instead of a bare prompt. `addTask(projectId, area, text, {private})` stores `task.private`, and `rocketlaneCreateTaskInRocketlane(…, opts)` injects `private` into every create body so the Rocketlane task is created with the chosen visibility (read back via `rocketlaneTaskVisibility`).
- **Right-click context menus on tasks and category headers**
  - Right-click a task name → **Rename task / Open fullscreen / Remove task** (the inline ⚠ Remove button still works — both call the shared `removeThisTask`). Right-click a category header → **Rename / Remove** (rename → `renameArea` + `syncRenameCategoryPhase`; remove → double-confirm + `syncDeleteCategoryPhase`). Both built on a shared `showContextMenu` bound via `contextmenu` listeners.
- **Dialogs pop out from the center** — `.addCatCard` uses an `addCatCardPop` keyframe (scale `0.78 → 1` with a `cubic-bezier(0.34,1.56,0.64,1)` overshoot, 240ms) so the dialog grows from the center instead of fading in; overlay fades via `addCatOverlayIn`.
- **Younium status: resolve to the current order version + follow converted quotes**
  - Drafts and quotes keep their status forever, so the chip showed stale verdicts (10111 showed "Draft" after the order had been invoiced; 4732 showed a stale quote after **Q-010563 → O-014783**). `computeYouniumStatus` now resolves an outdated saved order to its current version (`youniumResolveCurrentVersion`, using `isLastVersion`/`version`) and follows a converted quote to its order (`convertedToOrderId` / `convertedOrderNumber`) before judging — across all entry paths (saved Order URL, saved Quote URL, no-saved-URL plant_id search).
- **Notifications: collapsible "Rocketlane · notifications" section, filters moved inside**
  - The Rocketlane notification list got the same collapse treatment as the Zendesk section (caret + group count, `.notifRlHeader` / `.notifRlBody`, state in `rocketlane_notif_collapsed_v1` via `rocketlaneGetNotifCollapsed`/`Set…`, default expanded). The source filter chips (All / Tasks I'm assigned to / Mentions / Assigned to the team) moved **inside** that section (`notifRlFilters`, styled like the Zendesk chips) so they collapse with it.
- **Notifications: Zendesk internal notes included, "Internal" tag gated to @kiona.com**
  - `zendeskFetchUnreadInfo` now picks the latest incoming comment whether **public OR internal/private** (`lp = sorted.find(c => Number(c.author_id) !== meId)`), so a partner email that lands as a private note isn't missed (this had caused **#197516** to raise no notification). The amber **"Internal"** badge (`.notifZdInternal` / `.notifFsInternalTag`) shows **only** when the private note's author is a **@kiona.com** colleague (`f.isInternal = isPrivate && authorKiona`); private comments from external parties render as a normal reply. Kiona-ness is cached per author in `zendesk_author_cache_v2` = `{ name, kiona }` (`kiona = /@kiona\.com\s*$/i.test(email)`); ticket cache bumped to `zendesk_ticket_cache_v5`.
- **Removed the "Clear all" button** from the notifications drawer — clicking the bell already resets the count (client-side last-seen), and the list is intentionally a persistent worklist, so the button was redundant/misleading.
- **Chat image previews: recover expiring S3 signed URLs**
  - Rocketlane chat image attachments are S3 URLs signed with `X-Amz-Expires=299` (~5 min); previews used to go **blank until a page refresh** once a link expired. Now each URL is remapped by its stable S3 object key (`s3KeyOf`) on the img `error` event (`onChatImgError` → `refreshChatImageUrls(kind)`), and the cache proactively refetches when older than `SIGNED_URL_TTL_MS` (4 min) in both `loadKind` and the panel-rebuild restore path (`cache.fetchedAtByKind`, `cache.convIdByKind`). The proactive staleness refetch is the primary fix (the `error` event doesn't fire for offscreen `loading="lazy"` imgs).
- **Subtasks: single-level nesting + parent-phase sync**
  - A subtask can't have its own subtask. The `+ Add subtask` affordance is omitted on subtask rows (`isSubtask = depthByTask > 0`), and `addSubtask` hard-guards (alerts) when the parent already has `meta.parentLocalTaskId`/`parentTaskId`.
  - On create, a subtask syncs to Rocketlane **in its parent's phase** — read the parent task's `projectPhase` and pass it through; never derive a phase from the area label (that could POST a non-existent phase and 500, silently aborting the create). Falls back to the area phase only when the parent has no resolvable phase.
- **Task status → Rocketlane: dead-link resilience**
  - When a task is linked to a Rocketlane task that's been deleted/restricted, a status change used to throw 403/404 and `setTaskStatus` reverted the local status (looked like "can't change subtask status"). Now `rocketlaneIsTaskGoneError(e)` (403 ACCESS_RESTRICTED / 404) is detected: the local status is **kept**, the dead `meta.rocketlaneTaskId`/`rocketlaneProjectId` link is cleared, and a clear toast shows — instead of reverting. Healthy links sync unchanged (`rocketlaneUpdateTaskStatus` → `PUT /tasks/{id}` with `{ fields:[{fieldId,fieldValue}] }`).
- **Task-notes overview cards (top of the detail panel)**
  - The "Task notes" summary now shows each task's **name** (not just its category), so notes are traceable to their task. Subtasks get a `↳` marker + an "under &lt;parent&gt;" line. Inclusion rule unchanged: a task shows when it's not completed AND (has a note OR a non-todo/in-progress status).
- **Matcher accuracy: 6 audit gaps closed (calibrated weights kept)**
  - `detectExistingLinkMismatch`: same-id-shape guard — FK-compare only when the saved URL's recordId and the RL field are both-UUID or both-not-UUID, so a correct Younium `/orders/<uuid>` link is no longer falsely flagged vs the `O-xxxx` order-number field.
  - `decideMatchOutcome`: the "beats #2 by ≥15" lead is measured on the RAW uncapped `score`, not `percent` (which clamps at 100 and faked ties / hid real gaps).
  - `scoreMatchCandidate`: dead statuses take a **−20** penalty (was: just no +3); plant-id split into 3 tiers (native +35 / at-start +30 / anywhere +18).
  - Auto-fill link sources: HubSpot **Delivery status update message** parsed from the same project fetch as a 3rd source below Deal Description; `mergeProjectLinksByPriority` generalised to a ranked source list.
  - `buildSearchTerms`: dedup by normalized term only (was priority+term).
  - `Project` typedef: added `oneflowSubscriptionUrl`, `youniumSubscriptionUrl`, `linkSources`.
  - All verified live by unit-testing the window-exposed matcher fns (`scoreMatchCandidate`, `decideMatchOutcome`, `detectExistingLinkMismatch`, `buildSearchTerms`, `mergeProjectLinksByPriority`, `classifyLinkUrl`).
- **Workflow: repo is the single source of truth**
  - The standalone desktop copy `C:\Users\Thomas\Desktop\Project Progress Tracker.html` was removed. Edit ONLY in the repo (`C:\Users\Thomas\Desktop\project-progress-tracker`), keep `Project Progress Tracker.html` + `index.html` byte-identical, `git pull --ff-only` first, and test on the LIVE URL (see Testing protocol). This killed the 3-mirror sync that previously caused a wrong-direction `cp` to clobber edits.
- **Notifications: Zendesk recent-replies polish + reliability**
  - List window 7 d → 30 d (`ZENDESK_LIST_WINDOW_MS`); search `per_page` 50→100 + candidate cap 40→50 so a busy month isn't truncated.
  - "Zendesk · recent replies" header is a persistent collapse toggle (caret + count; `.notifZdBody` wrapper; `zendesk_notif_collapsed_v1`).
  - **Bug fix**: the bell's Zendesk mark-read + list-load were INSIDE the Rocketlane `try`, so a Rocketlane error left the Zendesk count stuck. Split into independent blocks — clicking the bell now clears + loads Zendesk even when Rocketlane fails. Verified live (RL mock throwing, Zendesk still loaded + marked read).
  - The 2-min poll (`notifTick`) now also refreshes the OPEN drawer's Zendesk list in place (`notifZdRefresh`), on top of the existing badge-count refresh.
- **Bridge v1.9.13**: `HubSpotBridge.searchDeals` now defaults to `includeAllProperties:true` (and `searchCrm` honors an `includeAllProperties` opt) so **every** deal property is returned. The matcher's `hubspotToMatchCandidate` reads tenant custom props (`plant_id`, `deal_partner`, `deal_organization_nr_younium`, `deal_contact`, `contact_email`, `deal_contact_tlf_nr`, `deal_younium_quote_number`, `plant_name`) that the prior 6-property default left empty — so HubSpot deal matching had been running on the deal name alone. Using `includeAllProperties` (vs enumerating names) avoids a 400 on any tenant-specific property that doesn't exist. **Requires the user to refresh the userscript to v1.9.13.**
- **Bridge v1.9.12**: `@match http://127.0.0.1:8102/*` + `localhost:8102`, gated behind the `rocketlane-tracker` meta tag (same opt-in as `file://`) so the bridge injects on a local dev server only for the tracker page.
- **Task notes split: "Description note" + "Private note" (bidirectional with Rocketlane)**
  - The single task-notes box was renamed **Description note**; a **+ Add a private note** link reveals a separate cream **Private note** box (mirrors Rocketlane's task-drawer affordance). New `t.privateNote` field, kept separate from `t.notes` to avoid a shared-field collision (unlinked Description note still uses `t.notes`).
  - **Private-note write was broken** — it POSTed to `/tasks/{id}/messages` (the comment stream) so it silently never saved. Captured the real call via Playwright network interception on the live task drawer: a private note is the task-level **`privateTaskDescription`** HTML field, saved via `PUT /projects/{pid}/tasks/{tid}/mini` (minimal body, `api-key` auth). Rewrote `rocketlaneUpdateTaskPrivateNote(projectId, taskId, text)` accordingly; verified end-to-end (typed in tracker → appeared on the real RL task).
  - `rocketlanePrivateNoteFromTask` now reads `privateTaskDescription` first; the tasks-list endpoint includes it, so RL-authored notes pull into the tracker. Clearing the note in the tracker also clears it in Rocketlane (empty PUT). See the "Task notes" subsection under Rocketlane integration for the full contract.
- **Project status: 5-state → 8-state enum (matches Rocketlane 1:1) with bidirectional sync**
  - Local enum now: `proposed` / `in_planning` / `to_be_staffed` / `in_progress` / `on_hold` / `blocked` / `completed` / `cancelled` (was 5 lossy keys)
  - Numeric `ROCKETLANE_PROJECT_STATUS_MAP` captured via Playwright from `/api/v1/fields/230410`
  - Push on every status change (inline picker + Edit dialog) via `PUT /projects/{id}` with numeric `fieldValue`
  - Pull `local.status` from `remoteProject.fields[]["Status"].metaFieldValue.label` on every sync (was only on first import) via `rocketlaneStatusLabelToLocal()`
  - `normalizeStatus()` transparently migrates the old 5-state values
- **Younium status modal — robust subscription detection**
  - All three entry paths (saved Order / saved Quote / no saved URL) now reach the `youniumFindSubscriptionByPlantId(plantId)` fallback
  - No-saved-URL branch promotes the plant's most-recently-modified `isLastVersion=true` order into the Order/Offer section (was: returned early, modal sat empty)
  - Strict IWMAC regex `/\bIWMAC\s*(?:Abonnement|Subscription)\b/i` preserved — `IWMAC Modul / Product` line items are NOT subscription evidence (briefly broadened in `97ea279`, reverted in `09a7039`)
  - Verified bridge call shape: `searchOrders("", { conditions: [...] })` — first arg is free-text query, second is opts; response is `{ result, totalCount }` (singular)
- **Files popover: "Download all (N)" button**
  - Uses `showDirectoryPicker` (File System Access API) on Chromium — user picks a folder once, every project attachment written into it via `FileSystemWritableFileStream`
  - Filename collisions auto-resolve as `name (1).ext`, `name (2).ext`
  - Cancel handled (`AbortError` bails without falling to legacy per-file flow)
  - Fallback to per-file `<a download>` on browsers without the API
- **Status pill / Younium modal visual polish**
  - Status pills: soft tinted bg + colored text + transparent border (was: saturated borders + colored bg, looked neon)
  - Younium modal: neutral surface + 3px colored left stripe for summary + warnings; `.youniumSubBadge` is a small pill with a 6px colored dot + neutral text (was: full-color flood with saturated border)
  - Sync button: SVG mask refresh icon spins via `rlSyncSpin` keyframe on `.syncing` class (replaces earlier `In progress | Almost` suffix + width-stepped dots experiment)
  - RL sync chip uses the same SVG mask icon as the toolbar button (was: text `↻` glyph)
- **Zendesk Tasks section** (per-project, sorted by last public reply, with inline preview + fullscreen reply)
- **Auto-find buttons** for Oneflow / HubSpot / Younium in the Edit dialog
- **Owner Workload Overview** team groups (Team kulde + Others), collapsible
- **Team workload via lightV1** (eliminates N+1 /members calls)
- **24h Norwegian timestamps** in Zendesk preview
- **Click project → instant single-project sync**
- **Drag-and-drop removed** from the project list
- **Hubspot Deal Description writer** — auto-updates the Rocketlane custom field on save with a `Links:` block; falls back to tenant /fields lookup when the field hasn't been written to the project yet
- **Bridge consolidation**: single userscript now bridges all five platforms
- **Younium status modal** — full redesign across multiple revisions:
  - Chip lives in the project header meta row (between Updated and RL sync), styled to match `.tag` chips via `.btn.youniumStatusBtn` specificity (0,2,0)
  - Action-oriented labels (`Younium: ⚠ Activate subscription in Younium`) instead of generic status names
  - IWMAC subscription detection via product-name regex + `plant_id` custom-field lookup
  - Draft detection via raw status enum (0/5) AND orderNumber heuristic (Younium UI calls an order "Draft" when no number assigned)
  - "Other orders for this plant" section using `searchOrders` with rich displayFields (no per-order hydration)
  - Audit attribution: `Created by` + `Last updated by` rows from the `/api/eventlog/order/id/{id}` endpoint (bridge v1.9.11)
  - Invoice status row hidden when order is Draft/Cancelled/Expired (those invoices belong to a prior order version)
  - Close-via-span pattern: `<span role="button">` for the X icon because some tampermonkey/browser combos intercept `<button>` clicks inside dialogs
- **RL sync chip redesign** — drop the dimmed-quiet style, use `::before { content: "↻" }` glyph that spins via `rlSyncSpin` keyframe when the `.warn` modifier is applied (during sync)
- **Bridge v1.9.11** — `getOrderEventLog(id)` calls `GET /api/eventlog/order/id/{id}` for the Younium audit timeline
