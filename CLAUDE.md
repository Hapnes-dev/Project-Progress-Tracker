# Claude Code context

This file is read by Claude Code on every session start. It documents the architecture, patterns, and gotchas of the Project Progress Tracker so future sessions can move fast without re-discovering the same lessons.

## Tech stack

- **Vanilla HTML + CSS + JS** in a single file: `Project Progress Tracker.html` (~25k lines).
- No build step, no framework, no bundler. All state in `localStorage`.
- **Tampermonkey userscript** bridge (`rocketlane-chat-bridge/`) handles cross-origin API calls to FIVE platforms: Rocketlane, Zendesk, Oneflow, HubSpot, Younium. Bridge version is v1.9.10+ as of this writing (v1.9.10 added `YouniumBridge.getOrderById` / `getInvoicesForOrder` / `getQuoteById` for the Younium status chip).
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
| 16500–18500 | Dialogs (edit project, Younium import), context menus, notifications drawer |
| 18500–end | Event wiring, sync timers, file-load handlers, install-prompt modal, init flow |

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
- UI-only state (sort/filter/search prefs, chat scroll positions, expanded task IDs, expanded categories per project, team-group collapse state, Zendesk-section collapse state) lives in separate `localStorage` keys or in-memory Sets.
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

### Zendesk Tasks section (per project)

- Lives in `picWrap` right under "Chat history" (so it inherits the chat-collapse animations).
- Renders only when the project name starts with a numeric plant ID (extracted via `/^\s*(\d+)\b/`).
- Search endpoint: `GET /api/v2/search.json?query=type:ticket+<plantId>` (browser auto-sends Zendesk session cookie via the bridge).
- Hydrates each ticket with `lastReplyAt` by fetching `/api/v2/tickets/<id>/comments.json?include=users&sort_order=desc&per_page=20` per ticket. Concurrency capped at 8 via `mapWithConcurrency`.
- Sorts by `lastReplyAt desc` (newest reply first) — NOT by generic `updated_at` which fires on tag/status changes too.
- Inline preview shows only the newest comment + hint pill. Right-click anywhere on the card → fullscreen overlay (portal-mounted to `<body>` to escape `.chatHistoryBody { contain: layout paint style }` clipping).
- Comment body rendered via `sanitizeZendeskHtml(c.html_body)` — allowlist tags + style attributes, strips inline `color:` (would otherwise appear black on dark theme).
- Reply submission via `PUT /api/v2/tickets/<id>.json` with `{ ticket: { comment: { body, public: true|false } } }`. Public/Internal switch uses a sliding-thumb pill (yellow when internal, accent when public).
- Timestamps: 24-hour Norwegian (Europe/Oslo) format via `Intl` API; "DD.MM HH:MM" always shown with `(i dag)` / `(i går)` / weekday context tags.

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
| `readRocketlaneCustomField(fields, prefix)` | Look up a custom-field value by name prefix (case-insensitive, whitespace-stripped). Returns string or array for MULTI_SELECT. |
| `extractRocketlaneCustomFields(project)` | Harvest EVERY HubSpot-mirror custom field (dealId, plantName, dealOwner, dealContact, dealContactEmail, dealContactPhone, dealStage, department, dealType, orderType, productTypes, certifiedPartner, plantStreetAddress, dealDescription, deliveryStatus, etc.) plus Younium order number + plant ID. |
| `extractRocketlaneForeignKeys(project)` | Shim returning `{ hubspotDealId, oneflowAgreementId, youniumOrderId }` — built from `extractRocketlaneCustomFields`. |
| `classifyLinkUrl(url)` | URL-structure classifier: returns `{ platform, recordId, recordType, url }`. Trusts URL shape, **never** trusts label text in the surrounding HTML. |
| `extractLinksFromHtml(html)` | Parse hrefs + bare URLs from HubSpot Deal Description / Delivery status message, return deduped `[{ platform, recordId, ... }]`. |
| `buildSearchTerms(platform, ctx)` | Prioritized list of `{ term, source, priority }` (foreign-key ID → plant ID → name → customer → email/phone). |
| `detectExistingLinkMismatch(platform, ctx)` | Return `{ kind: "orphan"|"wrongPlatform"|"fkMismatch", message, savedUrl }` if the currently-saved link doesn't match the project; null otherwise. |
| `buildProjectMatchContext(src)` | Form-fields OR live Rocketlane project → frozen ctx with name / plantId / partner / owner / ownerEmail / due / startDate / projectFee / customerOrgNumber / foreignKeys / **hubspotMirror** (full HubSpot-custom-field bundle) / **embeddedLinks** (parsed from HS description) / contactEmail / contactPhone / existingLinks + their classification / pre-tokenized variants. |
| `buildEnrichedProjectMatchContext()` | Async: fetches the project via `/projects/<id>` and feeds the rich payload into `buildProjectMatchContext`. Falls back to form-only on missing ID / fetch failure. |
| `scoreMatchCandidate(candidate, ctx)` | Returns `{ score, percent, signals }`. |
| `decideMatchOutcome(scored, opts)` | Returns `{ kind: "auto" \| "picker" \| "none", entry?, entries?, reason }`. |
| `renderMatchPicker(statusEl, scored, onSelect, warning?)` | Renders the picker; each row's `% match` badge is color-tinted, per-signal breakdown is shown inline (not just tooltip), and an optional `warning` row at the top surfaces existing-link mismatches. |
| `debugLogMatch(label, ctx, scored, decision, warning?)` | Collapsed `console.group` with the ctx, a `console.table` of candidates, the decision rationale, the mismatch warning if any, and the parsed embedded-links list. Disable via `window.__matchDebug = false`. |

#### Point budget (caps at 100)

Calibrated from live data captured via Playwright across two real projects (plant 3299 Coop Marked, plant 4732 Spar Dampsaga). The strongest "is this the right record?" signals (FK + plant ID + org number + embedded-link evidence) can stack to 100, while the corroborating signals (name overlap / money / partner / dates / category tags) push uncertain matches into picker territory.

| Signal | Weight |
|---|---|
| Foreign-key ID match (project custom field carries the platform ID) | 35 |
| Plant ID exact (native field or leading digits) | 35 |
| Plant ID elsewhere in text (mutually exclusive with the above) | 18 |
| **Younium order # matches RL `Youniumordernumber` field** (Younium only) | 30 |
| **Linked from RL HubspotDealDescription / DeliveryStatusMessage** | 25 |
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
| "Live" status (not closed/cancelled/declined/lost/expired/etc.) | 0..3 |
| **HubSpot deal stage tag match** | 2 |
| **Contact domain match** (RL contact email domain ↔ candidate) | 2 |

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

Results are merged by record ID (deduplicated), with early stop once we have ≥ 12 candidates from at least 2 different sources. Each term tried gets logged via `console.log("[Platform Find] search terms tried:", ...)`.

#### Existing-link validation

Before deciding auto-fill vs picker, every find function calls `detectExistingLinkMismatch(platform, ctx)`:

- **`orphan`** — saved link couldn't be URL-parsed.
- **`wrongPlatform`** — saved URL points to a different platform than its slot (e.g. a Zendesk ticket saved in the Oneflow slot).
- **`fkMismatch`** — Rocketlane has a foreign-key custom field (e.g. `HubspotDealID_357728 = 494492985563`) but the saved URL points to a different record ID.

If a mismatch is detected, **auto-fill is suppressed** regardless of score. The picker opens with a red warning row at the top quoting the discrepancy ("Saved link record ID X ≠ Rocketlane field Y"), and the user picks a replacement manually. We never silently overwrite a saved link.

`scoreMatchCandidate` returns the raw sum AND the percentage (clamped 0–100). A perfect plant-3299 match in our test ran to ~88% (Plant ID 35 + Partner 10 + Name 9 + Money 7 + Live 3 + Date 4 + Owner-domain 3 + Plant ID exact = high), which would auto-fill. A weak match with just "name overlap + active status" lands at ~12–18% and surfaces in the picker for manual review.

#### Auto-fill rule (uniform across all three platforms)

`decideMatchOutcome`:

- Best ≥ **85%** AND beats #2 by ≥ **15 percentage points** → auto-fill.
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
| Oneflow | `oneflowToMatchCandidate` | `oneflowDocumentUrl(id)` | Harvests `agreement_value.amount` + `currency`, `parties[].orgnr`, `parties[].email`, `parties[].participants[].email/fullname`. Sets `oneflowKind: "order" \| "subscription"` via `classifyOneflowDocumentKind(name)` — names containing "Abonnementsavtale" or "Subscription agreement" classify as subscription. PrimaryText is prefixed with 📄 Order or 📑 Subscription. |
| HubSpot | `hubspotToMatchCandidate` | `hubspotDealUrl(objectId)` (async — needs portalId from bridge) | Reads `properties.amount.value` AND `properties.amount.unit` (currency). closedate/createdate are epoch-ms strings → converted to ISO. |
| Younium (orders) | `youniumToMatchCandidate` | `youniumOrderUrl(id)` (async — needs region from bridge) | Hard-filters by exact `plant_id` (search returns false positives like `O-013299` for query `3299`). Money picks `totalContractValue` > `annualContractValue` > `mrr`. `recordType: "order"`. |
| Younium (quotes) | `youniumToQuoteMatchCandidate` | `youniumQuoteUrl(id)` (async) | Quotes use `/api/data/query/quote` (entity `"quote"`). Many quotes have **empty `plant_id`** even when matching — promoting a quote to an order is what fills it. Loose filter: accept on plant_id exact OR plant_name/accountName token overlap with project name OR plant ID literal in description/remarks. `recordType: "quote"`. Picker label prefixed with 📄 to distinguish from orders. |

The legacy `oneflowMatchScore` / `hubspotMatchScore` functions still exist as **thin shims** over the shared scorer so `window.__of.score` / `window.__hs.score` DevTools diagnostics keep working.

#### Younium status chip (project header)

A read-only chip rendered between the "Updated" tag and the "RL sync" tag in the project detail header. Computes a Younium order + subscription verdict from the project's saved Younium link.

**Color rules:**

| Color | When |
|---|---|
| 🟢 Green — "Younium: OK" | Order has posted invoices AND subscription is Active (within term, not cancelled). |
| 🟡 Yellow — "Younium: Pending" / "Not invoiced" / "Uncertain" | Order is in good shape but invoices haven't been posted yet OR subscription start date is in the future OR data is incomplete. |
| 🔴 Red — "Younium: Quote" / "Draft" / "Cancelled" / "Expired" / "Bad link" / "Not found" | Saved URL is a Quote (not promoted), Order is draft, Order was cancelled, end date in past, or link can't be parsed. |
| ⚪ Gray — "Younium: Missing" / "Younium: …" | No Younium link saved on the project. |

**Click behavior:** opens a popover with the verdict breakdown — Order/offer status, Subscription status, Order number, "Open in Younium" link, last-checked timestamp, and an "Issues" bullet list when problems were detected. Outside-click dismisses.

**Caching:** verdict is persisted on `project.youniumStatus = { color, label, orderStatus, subscriptionStatus, orderNumber, kind, problems, lastCheckedAt }` so the chip shows immediately on revisits. Background refresh runs once per project per session via the `youniumStatusFetchInFlight` / `youniumStatusFetchedThisSession` Sets (same pattern as the auto-link-fetch).

**API fields used:**

| Source | Field(s) |
|---|---|
| `GET /api/order/{id}` | `orderNumber`, `status`, `effectiveStartDate`, `effectiveEndDate`, `cancellationDate`, `isLastVersion`, `isAutoRenewed`, `isRenewed`, `term`, `bookings[]` |
| `POST /api/order/invoicesForHistory` `{ orderNumber }` | Array of `{ invoiceNumber, status, posted, paymentDate, dueDate, totalAmount }` — order is "Invoiced" when at least one entry has `status >= 2` OR a non-null `posted` timestamp |
| `POST /api/data/query/quote` filtered by `id` | When the saved link is a `/quotes/<uuid>` (immediate "Quote" verdict — never Active) |

**Subscription derivation:** Younium's order `bookings[]` array is empty on most orders we've sampled, so subscription state is derived from the order's lifecycle dates:

- `cancellationDate <= now` → Cancelled
- `effectiveEndDate <= now && !isAutoRenewed && !isRenewed` → Inactive
- `effectiveStartDate > now` → "Order — not active yet"
- `isLastVersion && effectiveStartDate <= now` → Active

**Debug logging:** every check emits `[Younium status] …` lines to console — project context, parsed URL, fetched order, fetched invoices, verdict, and color decision. Disable via `window.__matchDebug = false`.

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

### Tracker HTML lives in THREE places — sync all three on every change

When editing the tracker, the working copy is `C:\Users\Thomas\Desktop\Project Progress Tracker.html` but the live deploy needs both:

1. `C:\Users\Thomas\Desktop\project-progress-tracker\Project Progress Tracker.html` (download copy in the repo)
2. `C:\Users\Thomas\Desktop\project-progress-tracker\index.html` (the file GitHub Pages serves at `https://hapnes-dev.github.io/Project-Progress-Tracker/`)

If you commit only CLAUDE.md / README.md, the live site stays on the previous code. Pattern after editing:

```bash
cp "C:/Users/Thomas/Desktop/Project Progress Tracker.html" \
   "C:/Users/Thomas/Desktop/project-progress-tracker/Project Progress Tracker.html"
cp "C:/Users/Thomas/Desktop/Project Progress Tracker.html" \
   "C:/Users/Thomas/Desktop/project-progress-tracker/index.html"
cd "C:/Users/Thomas/Desktop/project-progress-tracker"
git add "Project Progress Tracker.html" index.html CLAUDE.md README.md
git commit -m "..." && git push
```

Same pattern for the bridge — `rocketlane-chat-bridge.user.js` lives in **two** repos (the working dir at `Desktop\rocketlane-chat-bridge\` and the clone at `Desktop\tampermonkey-scripts-clone\rocketlane-chat-bridge\`); only the clone is what `@updateURL` pulls from, so the userscript MUST be copied to the clone before `git push`.


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
- **Category removal** (`removeCategory`) and **category rename** (`renameArea`)
- Category and task UI expand/collapse state
- **Team-group collapse state** (Owner Workload Overview)
- **Zendesk Tasks section collapse state**
- Custom area labels

## Things that DO sync to Rocketlane

- Status, due date, project notes, custom links — propagate via the sync flow
- **Task add** — creates the task in Rocketlane in the correct phase
- **Task removal of LINKED tasks** — propagates the upstream DELETE (with a loud ⚠ warning)
- **Hubspot Deal Description** — auto-updated on every save with the project's external links (Oneflow / Younium / HubSpot)
- **Owner Workload pill** — syncs via the `[Tracker] Workload Sync` meta-project (one task per user; workload token in `taskDescription`)

## Things that sync to OTHER platforms

- **Zendesk reply** (from the Zendesk Tasks fullscreen view) — PUT to `/api/v2/tickets/<id>.json` with a new `comment` field. Public reply or internal note.

## Security model

- **Zero hardcoded secrets** in the HTML — credentials live only in Tampermonkey GM storage and the browser's cookie jar.
- **`file:///*` is gated** by a meta-tag marker so the bridges only publish on the legitimate tracker.
- **Untrusted HTML** is sanitised through allowlists before any `innerHTML =` write:
  - `sanitizeHtmlForChatMessage` for Rocketlane chat
  - `sanitizeZendeskHtml` for Zendesk comments
  - `sanitizeHtmlForEditor` for general rich-text content
- **All interpolated values in `innerHTML` template strings** go through `escapeHtml()` / `escapeForHtml()`.
- **Console logs never expose credentials** — only presence + length.
- **Internal-API diagnostic logs** use `console.debug` so they're filtered by default.

When adding new code that calls Rocketlane / Zendesk / Oneflow / HubSpot / Younium:
- Route through `rocketlaneRequestJson` / `zendeskApiRequest` / `oneflowApiRequest` / `hubspotApiRequest` / `youniumApiRequest`. Never call `fetch()` directly.
- Never embed secrets in source.
- If logging a request body for debugging, redact `Authorization`, `api-key`, `xsrf-token`, `X-CSRF-*`, and any field with `*key*` / `*token*` / `*secret*` in its name.

## When working with Claude

- Prefer minimal, surgical edits. The file is large and any unrelated change is high-risk.
- Test changes in the browser using Playwright when available — Tampermonkey isn't injectable into Playwright, so use the **mock-bridge-with-call-log** pattern: install `window.XBridge` with a recording stub, exercise the UI, then verify captured `apiRequest` calls match what the real bridge would emit. End-to-end verification still requires curl or a separate Playwright tab on the platform itself.
- For animations: less is more. `render()` rebuilds DOM. Instant toggle is the most reliable.
- The Rocketlane API has tenant-specific field IDs. Never hardcode them — always look up by name prefix. AND check both project.fields[] AND the tenant /fields endpoint, since custom fields without values are omitted from project responses.
- HubSpot's internal API is undocumented and region-split — be ready for breaking changes between UI versions. For load-bearing integrations, prefer a Private App access token + `api.hubspot.com/crm/v3/*`.
- When the user says "X doesn't work," ask for THREE specific things:
  1. `location.href` of the page they're testing on (catches local-file vs live-URL confusion)
  2. `window.RocketlaneBridge?.version` (and the relevant other bridge's version) + `typeof window.XBridge?.apiRequest`
  3. Network tab screenshot showing the actual outbound request (distinguishes "code didn't fire" from "code fired but API errored")
- For "silent skip" bugs (push appears to run but nothing changes downstream): look for `if (!fieldId)` / `if (!key)` / `if (!something)` fallthroughs that swallow the failure. Add a `console.warn` AT EVERY such fallthrough so you can see WHY it skipped.

## Recent significant changes (chronological)

- **Zendesk Tasks section** (per-project, sorted by last public reply, with inline preview + fullscreen reply)
- **Auto-find buttons** for Oneflow / HubSpot / Younium in the Edit dialog
- **Owner Workload Overview** team groups (Team kulde + Others), collapsible
- **Team workload via lightV1** (eliminates N+1 /members calls)
- **24h Norwegian timestamps** in Zendesk preview
- **Click project → instant single-project sync**
- **Drag-and-drop removed** from the project list
- **Hubspot Deal Description writer** — auto-updates the Rocketlane custom field on save with a `Links:` block; falls back to tenant /fields lookup when the field hasn't been written to the project yet
- **Bridge consolidation**: single userscript now bridges all five platforms
