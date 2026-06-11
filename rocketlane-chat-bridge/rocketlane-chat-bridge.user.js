// ==UserScript==
// @name         Rocketlane Chat Bridge
// @namespace    https://kiona.rocketlane.com/
// @version      1.9.16
// @description  Bridges Rocketlane + Zendesk + Oneflow + HubSpot + Younium APIs to the local Project Progress Tracker, bypassing CORS. (v1.9.16: uploadAttachment(projectId, file, { folderId }) can upload into a project folder — e.g. General Shared Files — via create(sourceType:FOLDER) + the folder link step.)
// @author       Thomas
// @homepageURL  https://github.com/Hapnes-dev/Project-Progress-Tracker
// @supportURL   https://github.com/Hapnes-dev/Project-Progress-Tracker/issues
// @updateURL    https://raw.githubusercontent.com/hapnes-dev/tampermonkey-scripts/main/rocketlane-chat-bridge/rocketlane-chat-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/hapnes-dev/tampermonkey-scripts/main/rocketlane-chat-bridge/rocketlane-chat-bridge.user.js
// @match        https://kiona.rocketlane.com/*
// @match        https://iwmac.zendesk.com/*
// @match        https://app.oneflow.com/*
// @match        https://app.hubspot.com/*
// @match        https://app-eu1.hubspot.com/*
// @match        https://eu.younium.com/*
// @match        https://us.younium.com/*
// @match        https://app.younium.com/*
// @match        file:///*
// @match        http://127.0.0.1:8102/*
// @match        http://localhost:8102/*
// @match        https://hapnes-dev.github.io/Project-Progress-Tracker/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      kiona.api.rocketlane.com
// @connect      iwmac.zendesk.com
// @connect      app.oneflow.com
// @connect      app.hubspot.com
// @connect      app-eu1.hubspot.com
// @connect      auth.eu.younium.com
// @connect      auth.us.younium.com
// @connect      api.younium.com
// @connect      s3.us-east-1.amazonaws.com
// @connect      s3.amazonaws.com
// @connect      amazonaws.com
// @connect      assets.rocketlane.com
// @connect      d1vtr0p8bkmfca.cloudfront.net
// @run-at       document-start
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  "use strict";

  const TENANT_API = "https://kiona.api.rocketlane.com/api/v1";
  // Zendesk lives at the subdomain root; the API is mounted at /api/v2
  // and authenticates via the user's session cookie (set when they're
  // logged into iwmac.zendesk.com in a normal browser tab). We don't
  // capture or store any token — GM_xmlhttpRequest automatically
  // includes cookies for the request URL's origin, so the same session
  // the user already has is reused for tracker calls.
  const ZENDESK_HOST = "https://iwmac.zendesk.com";
  const ZENDESK_API  = ZENDESK_HOST + "/api/v2";
  // Oneflow uses session cookies (HttpOnly) for auth and a NON-HttpOnly
  // `xsrf-token` cookie for CSRF on non-GET requests (Spring/Laravel
  // double-submit pattern). The userscript on app.oneflow.com pages
  // reads the cookie value into GM storage; the bridge attaches it as
  // X-XSRF-Token automatically on writes.
  const ONEFLOW_HOST = "https://app.oneflow.com";
  const ONEFLOW_API  = ONEFLOW_HOST + "/api";
  // HubSpot has two regional hublets — US (app.hubspot.com) and EU
  // (app-eu1.hubspot.com). The captured host below tracks which one the
  // user is logged into so the bridge calls the right region.
  // Every API call requires portalId in the query string + csrf header
  // from the `hubspotapi-csrf` cookie. CSRF + portal are captured on
  // hubspot pages and stored in GM storage.

  // Younium uses Frontegg auth — no token is stored anywhere readable
  // by JS. Instead, the bridge mints a fresh access token on demand by
  // POSTing to /frontegg/.../token/refresh with the HttpOnly refresh
  // cookie. The minted access token is a 24h JWT that we cache in GM
  // storage with an expiry timestamp. On API calls, we use it as a
  // Bearer token against api.younium.com.
  const YOUNIUM_API = "https://api.younium.com";

  // ──────────────────────────────────────────────────────────────────────────
  // Side A — On Rocketlane: capture the api-key from localStorage.
  // ──────────────────────────────────────────────────────────────────────────
  if (location.hostname.endsWith("kiona.rocketlane.com")) {
    function captureNow() {
      try {
        const raw = window.localStorage.getItem("__api_key");
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return false;
        const uuid = parsed.find(
          (v) =>
            typeof v === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
        );
        // The userId is the first integer in the array (used when posting comments).
        const userId = parsed.find((v) => typeof v === "number" && v > 0 && Number.isInteger(v));
        if (uuid) {
          GM_setValue("rlApiKey", uuid);
          GM_setValue("rlApiKeyCapturedAt", Date.now());
          if (userId) GM_setValue("rlUserId", userId);
          return true;
        }
      } catch (_) {}
      return false;
    }

    // Initial wait until localStorage has the key (after login), then capture.
    let attempts = 0;
    const tick = setInterval(() => {
      attempts += 1;
      if (captureNow() || attempts > 60) clearInterval(tick);
    }, 1000);

    // Refresh every 5 minutes in case the api-key rotates while the tab is open.
    setInterval(captureNow, 5 * 60 * 1000);
    return; // don't run the bridge side
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Side A2 — On Zendesk: capture the CSRF token from the meta tag.
  // The session cookie is sent automatically by the browser, but state-
  // changing requests (POST/PUT/PATCH/DELETE) also require the CSRF token
  // in the X-CSRF-Token header. We grab it from the meta tag and store it
  // in GM storage so the bridge can attach it on the tracker side.
  // ──────────────────────────────────────────────────────────────────────────
  if (location.hostname.endsWith("iwmac.zendesk.com")) {
    function captureZendeskCsrf() {
      try {
        const meta = document.querySelector('meta[name="csrf-token"]');
        const token = meta && meta.getAttribute("content");
        if (token && token !== GM_getValue("zdCsrfToken", "")) {
          GM_setValue("zdCsrfToken", token);
          GM_setValue("zdCsrfCapturedAt", Date.now());
          return true;
        }
      } catch (_) {}
      return false;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", captureZendeskCsrf);
    } else {
      captureZendeskCsrf();
    }
    // Refresh every minute — the token can rotate when Zendesk renews
    // the session. Cheap to read a meta tag.
    setInterval(captureZendeskCsrf, 60 * 1000);
    return; // don't run the bridge side here either
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Side A3 — On Oneflow: capture the xsrf-token cookie value.
  // The session cookie is HttpOnly (browser handles it) but Oneflow uses
  // the double-submit-cookie CSRF pattern: a NON-HttpOnly `xsrf-token`
  // cookie whose value must be echoed as the `X-XSRF-Token` header on
  // POST/PUT/PATCH/DELETE. We read the value via document.cookie and
  // stash it for the bridge to attach.
  // ──────────────────────────────────────────────────────────────────────────
  if (location.hostname === "app.oneflow.com") {
    function captureOneflowXsrf() {
      try {
        const raw = document.cookie || "";
        const entry = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith("xsrf-token="));
        if (!entry) return false;
        const value = decodeURIComponent(entry.slice("xsrf-token=".length));
        if (value && value !== GM_getValue("ofXsrfToken", "")) {
          GM_setValue("ofXsrfToken", value);
          GM_setValue("ofXsrfCapturedAt", Date.now());
          return true;
        }
      } catch (_) {}
      return false;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", captureOneflowXsrf);
    } else {
      captureOneflowXsrf();
    }
    // Refresh every 60s — Oneflow rotates the token periodically and
    // we want the bridge to have a fresh value when writes happen.
    setInterval(captureOneflowXsrf, 60 * 1000);
    return; // don't run the bridge side here
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Side A4 — On HubSpot: capture the hublet host + portal ID + CSRF token.
  // HubSpot has TWO regional hublets (app.hubspot.com / app-eu1.hubspot.com)
  // and every internal API call needs:
  //   • The right hublet host (so requests reach the user's region)
  //   • portalId query param (extracted from the URL — most paths embed it)
  //   • hubspotapi-csrf cookie value, echoed as X-HubSpot-CSRF-hubspotapi
  // The session cookie is HttpOnly so the browser handles it.
  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // Side A5 — On Younium: remember the hublet region (eu / us).
  // Younium's API host is api.younium.com (global) but the AUTH host is
  // region-specific (auth.eu.younium.com vs auth.us.younium.com). We
  // capture which region the user is in so the bridge can call the
  // right refresh endpoint.
  // No token is captured here — the bridge mints one on demand from
  // the HttpOnly refresh cookie when it needs to call api.younium.com.
  // ──────────────────────────────────────────────────────────────────────────
  if (/(?:^|\.)younium\.com$/i.test(location.hostname)) {
    try {
      // eu.younium.com → "eu", us.younium.com → "us", app.younium.com → unknown
      const m = location.hostname.match(/^(eu|us)\.younium\.com$/i);
      if (m) {
        const region = m[1].toLowerCase();
        if (region !== GM_getValue("ynRegion", "")) {
          GM_setValue("ynRegion", region);
          GM_setValue("ynRegionCapturedAt", Date.now());
        }
      }
    } catch (_) {}
    return; // don't run the bridge side here
  }

  if (location.hostname === "app.hubspot.com" || location.hostname === "app-eu1.hubspot.com") {
    function captureHubSpotState() {
      try {
        // Hublet host (us vs eu) is just the page's origin.
        const host = location.origin; // e.g. "https://app-eu1.hubspot.com"
        if (host !== GM_getValue("hsHost", "")) GM_setValue("hsHost", host);

        // Portal ID: scrape any /<digits>/ segment from the URL path.
        // Examples: /global-home/8805657, /contacts/8805657/objects/0-1/...
        const portalMatch = location.pathname.match(/\/(\d{6,10})(?:\/|$)/);
        if (portalMatch) {
          const portalId = portalMatch[1];
          if (portalId !== GM_getValue("hsPortalId", "")) GM_setValue("hsPortalId", portalId);
        }

        // CSRF cookie — NOT HttpOnly, readable via document.cookie.
        const raw = document.cookie || "";
        const entry = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith("hubspotapi-csrf="));
        if (entry) {
          const value = decodeURIComponent(entry.slice("hubspotapi-csrf=".length));
          if (value && value !== GM_getValue("hsCsrfToken", "")) {
            GM_setValue("hsCsrfToken", value);
            GM_setValue("hsCsrfCapturedAt", Date.now());
          }
        }
      } catch (_) {}
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", captureHubSpotState);
    } else {
      captureHubSpotState();
    }
    setInterval(captureHubSpotState, 60 * 1000);
    return; // don't run the bridge side here
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Side B — On a file:// page (the tracker): expose window.RocketlaneBridge.
  // ──────────────────────────────────────────────────────────────────────────

  // Startup beacon — visible in the page console so users can confirm the
  // script actually loaded. If you don't see this log when the tracker
  // page opens, Tampermonkey isn't injecting the script (URL @match miss,
  // toggle off, etc.) and no amount of bridge code will help.
  try {
    console.log("[Rocketlane Chat Bridge] loaded on", location.href, "@ ", new Date().toISOString());
  } catch (_) {}

  // Pick the page's real window — unsafeWindow when Tampermonkey is
  // running the script in an isolated world (the normal case with
  // @grant unsafeWindow), or plain window when it isn't.
  const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  // SECURITY: gate the bridge expose to specifically the tracker page.
  //
  // The @match list above includes `file:///*` so the bridge works when
  // the user runs the tracker as a local file. Without this in-page
  // check, ANY local HTML file would receive `window.RocketlaneBridge`
  // and could call `apiRequest(...)` against the user's Rocketlane
  // tenant using the captured api-key.
  //
  // We require the page to declare itself as the tracker via a
  // dedicated meta tag — anything else gets nothing.
  //
  // Every bridge-EXPOSING origin must opt in via the tracker meta tag —
  // including GitHub Pages. github.io is a SHARED host (any page under the
  // account could be served from it), and file:// / localhost are broad
  // origins that could host arbitrary pages. Requiring the marker means
  // only the real tracker document (which ships the meta tag) ever gets
  // the privileged bridge. The capture-only platform pages (rocketlane.com,
  // zendesk.com, …) are NOT in this set, so token capture is unaffected.
  const isTrackerHostOrigin =
    location.protocol === "file:" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "localhost" ||
    location.hostname === "hapnes-dev.github.io";
  if (isTrackerHostOrigin) {
    const marker = document.querySelector(
      'meta[name="rocketlane-tracker"][content="hapnes-dev/Project-Progress-Tracker"]'
    );
    if (!marker) {
      // Not the tracker — silently bail. Doesn't break anything for
      // the user; they just won't see RocketlaneBridge on this page.
      return;
    }
  }

  // Don't double-install if the script ran on a frame or got injected twice.
  if (target.RocketlaneBridge) return;

  /**
   * Generic CORS-bypassing HTTP call to the Rocketlane tenant API.
   * Used by both the named helpers (gmFetch / gmPost) below AND exposed
   * directly on the bridge as `apiRequest(method, path, body)` so the
   * tracker can call any endpoint without us needing to add a wrapper
   * for each one. The tracker prefers this over its own fetch() because
   * tenant endpoints don't whitelist github.io / file:// origins.
   *
   * @param {string} method    "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
   * @param {string} path      Either an absolute URL or a path; if a path,
   *                           it's resolved against the tenant base.
   * @param {object} [body]    Parsed-JSON body for POST/PUT/PATCH.
   * @returns {Promise<any>}   Parsed JSON response (null if empty body).
   */
  function gmRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const apiKey = GM_getValue("rlApiKey", "");
      if (!apiKey) {
        reject(new Error("No Rocketlane api-key captured yet. Open https://kiona.rocketlane.com once while logged in."));
        return;
      }
      const url = /^https?:/i.test(path) ? path : (TENANT_API + path);
      // SECURITY: only attach the secret api-key when the request really
      // targets the Rocketlane API origin. If a caller passes an absolute
      // URL to another @connect host (e.g. an S3 bucket), refuse — else
      // the api-key would be exfiltrated to that host. Relative paths
      // always resolve to TENANT_API, so legitimate calls are unaffected.
      let reqOrigin = "";
      try { reqOrigin = new URL(url).origin; } catch (_) {}
      if (reqOrigin !== "https://kiona.api.rocketlane.com") {
        reject(new Error("Refusing to send Rocketlane api-key to non-Rocketlane origin: " + (reqOrigin || url)));
        return;
      }
      const headers = { "api-key": apiKey, accept: "application/json" };
      const init = { method, url, headers, timeout: 20000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("HTTP " + res.status + ": " + (res.responseText || "").slice(0, 300)));
            return;
          }
          if (!res.responseText) { resolve(null); return; }
          try { resolve(JSON.parse(res.responseText)); }
          catch { resolve(null); } // some endpoints return non-JSON success
        },
        onerror: () => reject(new Error("Network error reaching Rocketlane API")),
        ontimeout: () => reject(new Error("Rocketlane API timed out")),
      };
      if (body !== undefined && body !== null) {
        headers["content-type"] = "application/json";
        init.data = typeof body === "string" ? body : JSON.stringify(body);
      }
      GM_xmlhttpRequest(init);
    });
  }

  /**
   * Single-shot Zendesk API call. Does NOT auto-retry on 401; the
   * caller (gmZendeskRequest) handles the retry policy so we can layer
   * a renew-session warm-up before the second attempt.
   *
   * @param {string} method
   * @param {string} url      Fully-resolved URL.
   * @param {object|string|null} [body]
   * @param {Record<string,string>} [extraHeaders]
   * @returns {Promise<{status:number, json:any, text:string}>}
   */
  function gmZendeskSendRaw(method, url, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ accept: "application/json" }, extraHeaders || {});
      const init = {
        method,
        url,
        headers,
        timeout: 20000,
        // anonymous: false → include cookies for the target origin.
        anonymous: false,
        onload: (res) => {
          const status = res.status;
          const text = res.responseText || "";
          let json = null;
          if (text) { try { json = JSON.parse(text); } catch { /* non-JSON */ } }
          resolve({ status, json, text });
        },
        onerror: () => reject(new Error("Network error reaching Zendesk API")),
        ontimeout: () => reject(new Error("Zendesk API timed out")),
      };
      if (body !== undefined && body !== null) {
        headers["content-type"] = "application/json";
        init.data = typeof body === "string" ? body : JSON.stringify(body);
      }
      GM_xmlhttpRequest(init);
    });
  }

  // Coalesce concurrent renew attempts so a burst of N failed API calls
  // doesn't trigger N parallel /users/me.json renews.
  /** @type {Promise<boolean> | null} */
  let zendeskRenewInFlight = null;
  let zendeskLastRenewAttempt = 0;
  const ZENDESK_RENEW_COOLDOWN_MS = 5000; // don't renew more than once per 5s

  /**
   * Force-refresh the Zendesk session cookie by hitting /users/me.json
   * with the documented X-Zendesk-Renew-Session: true header. Zendesk
   * responds with refreshed session/CSRF cookies if the underlying
   * authentication is still valid (e.g. SAML session still active even
   * though the cookie expired). Resolves with `true` if renew worked,
   * `false` otherwise.
   */
  function zendeskRenewSession() {
    if (zendeskRenewInFlight) return zendeskRenewInFlight;
    const now = Date.now();
    if (now - zendeskLastRenewAttempt < ZENDESK_RENEW_COOLDOWN_MS) {
      // Recent renew failed; don't hammer.
      return Promise.resolve(false);
    }
    zendeskLastRenewAttempt = now;
    zendeskRenewInFlight = (async () => {
      try {
        const res = await gmZendeskSendRaw(
          "GET",
          ZENDESK_API + "/users/me.json",
          null,
          { "X-Zendesk-Renew-Session": "true" },
        );
        return res.status >= 200 && res.status < 300;
      } catch (_) {
        return false;
      } finally {
        // Allow another renew attempt later (after cooldown).
        setTimeout(() => { zendeskRenewInFlight = null; }, 0);
      }
    })();
    return zendeskRenewInFlight;
  }

  /**
   * Generic CORS-bypassing HTTP call to the Zendesk API with automatic
   * session renewal on 401. Uses the SAME session cookie the user
   * already has from being logged in at https://iwmac.zendesk.com.
   * No tokens captured, no storage.
   *
   * Retry policy:
   *  1. First attempt — plain request, cookies attached.
   *  2. If response is 401 (and this isn't already a retry), fire a
   *     renew-session warm-up request, then retry the original call
   *     once with `X-Zendesk-Renew-Session: true` on the actual call
   *     as well. This handles SAML / SSO sessions where the underlying
   *     identity is valid but the session cookie expired.
   *  3. If still 401 after retry, surface a clear "open Zendesk while
   *     logged in" error message.
   *
   *   await ZendeskBridge.apiRequest("GET", "/tickets/196389.json");
   *   await ZendeskBridge.apiRequest("PUT", "/tickets/196389.json", { ticket: { status: "solved" } });
   *
   * @param {string} method
   * @param {string} path   Relative to /api/v2, OR an absolute URL.
   * @param {object} [body] JSON body for non-GET requests.
   * @returns {Promise<any>}
   */
  async function gmZendeskRequest(method, path, body) {
    const url = /^https?:/i.test(path) ? path : (ZENDESK_API + path);
    // For state-changing requests, Zendesk requires the CSRF token. We
    // get it from GM storage where the Zendesk-side capture wrote it.
    // GET requests don't need CSRF — only the session cookie.
    const upper = String(method ?? "GET").toUpperCase();
    const extraHeaders = {};
    if (upper !== "GET" && upper !== "HEAD") {
      const csrf = GM_getValue("zdCsrfToken", "");
      if (csrf) {
        extraHeaders["X-CSRF-Token"] = csrf;
      } else {
        throw new Error(
          "Zendesk CSRF token not captured yet. Open https://iwmac.zendesk.com once while logged in (any page), then retry."
        );
      }
    }
    // First attempt
    let res = await gmZendeskSendRaw(method, url, body, extraHeaders);
    if (res.status === 401) {
      // Try to renew; this hits /users/me.json with renew-session header.
      const renewed = await zendeskRenewSession();
      if (renewed) {
        // Retry the original call with renew-session header for good
        // measure (Zendesk sometimes ignores fresh cookies on the very
        // next call without the explicit header). CSRF token is included
        // again — if the renew rotated it, the next non-GET will fail
        // and the user re-loads the Zendesk tab once.
        res = await gmZendeskSendRaw(method, url, body, {
          ...extraHeaders,
          "X-Zendesk-Renew-Session": "true",
        });
      }
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "HTTP " + res.status +
        ": Zendesk session expired or missing. Open https://iwmac.zendesk.com once while logged in to refresh, then try again.",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error("HTTP " + res.status + ": " + (res.text || "").slice(0, 300));
    }
    return res.json; // may be null for empty bodies
  }

  /**
   * Single-shot Oneflow call. Lets the caller decide retry policy.
   * Resolves with the raw {status, text, json} envelope (does NOT throw
   * on 4xx) so gmOneflowRequest can branch on status.
   */
  function gmOneflowSendRaw(method, url, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ accept: "application/json" }, extraHeaders || {});
      const init = {
        method: String(method ?? "GET").toUpperCase(),
        url,
        headers,
        timeout: 20000,
        anonymous: false,
        onload: (res) => {
          const status = res.status;
          const text = res.responseText || "";
          let json = null;
          if (text) { try { json = JSON.parse(text); } catch { /* non-JSON */ } }
          resolve({ status, json, text });
        },
        onerror: () => reject(new Error("Network error reaching Oneflow API")),
        ontimeout: () => reject(new Error("Oneflow API timed out")),
      };
      if (body !== undefined && body !== null) {
        headers["content-type"] = "application/json";
        init.data = typeof body === "string" ? body : JSON.stringify(body);
      }
      GM_xmlhttpRequest(init);
    });
  }

  // Coalesce concurrent renew attempts so a burst of N failed Oneflow
  // calls doesn't fan out N parallel warmups.
  /** @type {Promise<boolean> | null} */
  let oneflowRenewInFlight = null;
  let oneflowLastRenewAttempt = 0;
  const ONEFLOW_RENEW_COOLDOWN_MS = 5000;

  /**
   * Try to nudge Oneflow into refreshing the session + CSRF cookies.
   * Oneflow doesn't expose a dedicated renew header (unlike Zendesk),
   * but its SPA pings /positions/me on most page loads, and that
   * response sets a fresh xsrf-token cookie when the current one is
   * about to rotate. The browser cookie jar (which GM_xmlhttpRequest
   * uses) picks the new value up automatically.
   *
   * If the user has an app.oneflow.com tab open in the same browser,
   * the on-site capture script picks the rotated cookie up within 60s
   * and writes it back to GM storage. We wait briefly for that as a
   * best-effort, but if no Oneflow tab is open we still gain the cookie
   * refresh inside this script's GM_xmlhttpRequest cookie jar.
   *
   * Resolves with `true` if the warmup returned 2xx (session is alive),
   * `false` otherwise.
   */
  function oneflowRenewSession() {
    if (oneflowRenewInFlight) return oneflowRenewInFlight;
    const now = Date.now();
    if (now - oneflowLastRenewAttempt < ONEFLOW_RENEW_COOLDOWN_MS) {
      // Recent attempt; don't hammer Oneflow.
      return Promise.resolve(false);
    }
    oneflowLastRenewAttempt = now;
    oneflowRenewInFlight = (async () => {
      try {
        const res = await gmOneflowSendRaw("GET", ONEFLOW_API + "/positions/me", null, null);
        const ok = res.status >= 200 && res.status < 300;
        if (ok) {
          // Give the on-site capture script a brief chance to re-read
          // the rotated xsrf-token cookie. 800ms is plenty for the
          // captureOneflowXsrf interval (which runs every 60s but also
          // synchronously on cookie-read).
          await new Promise((r) => setTimeout(r, 800));
        }
        return ok;
      } catch (_) {
        return false;
      } finally {
        setTimeout(() => { oneflowRenewInFlight = null; }, 0);
      }
    })();
    return oneflowRenewInFlight;
  }

  /**
   * Generic CORS-bypassing HTTP call to the Oneflow API with automatic
   * session renewal on 401.
   *
   * Auth mechanics:
   *   • Session cookie (HttpOnly) — browser auto-attaches via GM_xmlhttpRequest.
   *   • For non-GET methods, X-XSRF-Token header is required. We pull the
   *     value from GM storage (set by the Oneflow-side capture above).
   *
   * Retry policy:
   *   1. First attempt — plain request with whatever CSRF we have cached.
   *   2. On 401, fire a warmup GET to /positions/me; if it succeeds,
   *      re-read xsrf-token from GM storage (it may have rotated) and
   *      retry the original call once.
   *   3. If still 401/403, surface a clear "open Oneflow while logged in"
   *      error.
   *
   *   await OneflowBridge.apiRequest("GET", "/positions/me");
   *   await OneflowBridge.apiRequest("GET", "/collections/?limit=10");
   *
   * @param {string} method
   * @param {string} path   Relative to /api, OR an absolute URL.
   * @param {object} [body] JSON body for non-GET requests.
   */
  async function gmOneflowRequest(method, path, body) {
    const url = /^https?:/i.test(path) ? path : (ONEFLOW_API + path);
    const upper = String(method ?? "GET").toUpperCase();
    const buildHeaders = () => {
      const headers = {};
      if (upper !== "GET" && upper !== "HEAD") {
        const xsrf = GM_getValue("ofXsrfToken", "");
        if (xsrf) {
          // Oneflow accepts both X-XSRF-Token (Spring-style) and xsrf-token
          // header names. X-XSRF-Token is the more common convention.
          headers["X-XSRF-Token"] = xsrf;
        }
      }
      return headers;
    };

    // First attempt
    let res = await gmOneflowSendRaw(upper, url, body, buildHeaders());
    if (res.status === 401 || res.status === 403) {
      const renewed = await oneflowRenewSession();
      if (renewed) {
        // Re-read CSRF in case the on-site capture script just rotated it.
        res = await gmOneflowSendRaw(upper, url, body, buildHeaders());
      }
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "HTTP " + res.status +
        ": Oneflow session expired or missing. Open https://app.oneflow.com once while logged in, then try again.",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error("HTTP " + res.status + ": " + (res.text || "").slice(0, 300));
    }
    return res.json;
  }

  /**
   * Single-shot HubSpot call. Lets the caller decide retry policy.
   * Resolves with the raw {status, text, json} envelope (does NOT throw
   * on 4xx) so gmHubSpotRequest can branch on status.
   */
  function gmHubSpotSendRaw(method, url, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ accept: "application/json" }, extraHeaders || {});
      const init = {
        method: String(method ?? "GET").toUpperCase(),
        url,
        headers,
        timeout: 20000,
        anonymous: false,
        onload: (res) => {
          const status = res.status;
          const text = res.responseText || "";
          let json = null;
          if (text) { try { json = JSON.parse(text); } catch { /* non-JSON */ } }
          resolve({ status, json, text });
        },
        onerror: () => reject(new Error("Network error reaching HubSpot API")),
        ontimeout: () => reject(new Error("HubSpot API timed out")),
      };
      if (body !== undefined && body !== null) {
        headers["content-type"] = "application/json";
        init.data = typeof body === "string" ? body : JSON.stringify(body);
      }
      GM_xmlhttpRequest(init);
    });
  }

  // Coalesce concurrent HubSpot renew attempts.
  /** @type {Promise<boolean> | null} */
  let hubspotRenewInFlight = null;
  let hubspotLastRenewAttempt = 0;
  const HUBSPOT_RENEW_COOLDOWN_MS = 5000;

  /**
   * Try to refresh the HubSpot session + CSRF cookie by pinging the
   * lightweight login-information endpoint. The response sets fresh
   * Set-Cookie headers if the underlying session is still valid (e.g.
   * SSO-backed session). The on-site capture script then picks the
   * rotated hubspotapi-csrf cookie up within 60s and writes it back to
   * GM storage; we wait briefly to give it a chance.
   *
   * Resolves with `true` if the warmup returned 2xx (session is alive),
   * `false` otherwise.
   */
  function hubspotRenewSession() {
    if (hubspotRenewInFlight) return hubspotRenewInFlight;
    const now = Date.now();
    if (now - hubspotLastRenewAttempt < HUBSPOT_RENEW_COOLDOWN_MS) {
      return Promise.resolve(false);
    }
    hubspotLastRenewAttempt = now;
    hubspotRenewInFlight = (async () => {
      try {
        const host = GM_getValue("hsHost", "");
        const portalId = GM_getValue("hsPortalId", "");
        if (!host || !portalId) return false;
        // login-information is cheap, always available, and doesn't
        // require CSRF (it's a GET). HubSpot's SPA hits it on every page
        // load, so it's a safe warmup target.
        const url = host + "/api/login-verify/v1/info?portalId=" + encodeURIComponent(portalId);
        const res = await gmHubSpotSendRaw("GET", url, null, null);
        const ok = res.status >= 200 && res.status < 300;
        if (ok) {
          // Give the on-site capture a moment to re-read rotated CSRF.
          await new Promise((r) => setTimeout(r, 800));
        }
        return ok;
      } catch (_) {
        return false;
      } finally {
        setTimeout(() => { hubspotRenewInFlight = null; }, 0);
      }
    })();
    return hubspotRenewInFlight;
  }

  /**
   * Generic CORS-bypassing HTTP call to the HubSpot internal API with
   * automatic session renewal on 401.
   *
   * Auth mechanics:
   *   • Session cookie (HttpOnly) — browser auto-attaches via GM_xmlhttpRequest.
   *   • Per-call CSRF: X-HubSpot-CSRF-hubspotapi header echoes the
   *     `hubspotapi-csrf` cookie value.
   *   • Every call needs portalId in the query string. The bridge auto-
   *     injects it if not already present.
   *
   * Retry policy:
   *   1. First attempt with cached host/portalId/csrf.
   *   2. On 401/403, fire a warmup GET to /api/login-verify/v1/info; if
   *      it succeeds, re-read CSRF from GM storage (may have rotated)
   *      and retry once.
   *   3. If still 401/403, surface a clear error pointing at the right
   *      regional hublet.
   *
   *   await HubSpotBridge.apiRequest("GET", "/properties/v4/groups/0-1/properties");
   *
   * @param {string} method
   * @param {string} path   Relative to /api, OR an absolute URL.
   * @param {object} [body] JSON body for non-GET requests.
   */
  async function gmHubSpotRequest(method, path, body) {
    const host = GM_getValue("hsHost", "");
    const portalId = GM_getValue("hsPortalId", "");
    if (!host || !portalId) {
      throw new Error(
        "HubSpot state not captured yet. Open https://app.hubspot.com (or app-eu1.hubspot.com) once while logged in, then retry.",
      );
    }
    // Build the full URL. Inject portalId as query param if missing.
    let url;
    if (/^https?:/i.test(path)) {
      url = path;
    } else {
      const prefix = path.startsWith("/api") ? "" : "/api";
      url = host + prefix + path;
    }
    if (!/[?&]portalId=/i.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "portalId=" + encodeURIComponent(portalId);
    }

    const upper = String(method ?? "GET").toUpperCase();
    const buildHeaders = () => {
      const headers = {};
      if (upper !== "GET" && upper !== "HEAD") {
        const csrf = GM_getValue("hsCsrfToken", "");
        if (csrf) headers["X-HubSpot-CSRF-hubspotapi"] = csrf;
      }
      return headers;
    };

    // First attempt
    let res = await gmHubSpotSendRaw(upper, url, body, buildHeaders());
    if (res.status === 401 || res.status === 403) {
      const renewed = await hubspotRenewSession();
      if (renewed) {
        res = await gmHubSpotSendRaw(upper, url, body, buildHeaders());
      }
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "HTTP " + res.status +
        ": HubSpot session expired or missing. Open https://app" +
        (host.includes("eu1") ? "-eu1" : "") +
        ".hubspot.com once while logged in, then try again.",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error("HTTP " + res.status + ": " + (res.text || "").slice(0, 300));
    }
    return res.json;
  }

  /**
   * Mint a fresh Younium access token by calling the Frontegg refresh
   * endpoint with the HttpOnly refresh cookie. Returns the access token
   * string and caches it (+ expiry) in GM storage.
   *
   * Cooldown: passive refreshes (token "expiring soon" pre-flight check)
   * skip if a recent refresh happened, to avoid stampeding the API.
   * Active refreshes (forceRefresh=true after a 401) ALWAYS run — the
   * cached token was just rejected, so handing it back would loop.
   */
  let ynRefreshInFlight = null;
  let ynLastRefreshAttempt = 0;
  function gmYouniumRefreshToken(forceRefresh) {
    if (ynRefreshInFlight) return ynRefreshInFlight;
    const now = Date.now();
    if (!forceRefresh && now - ynLastRefreshAttempt < 30 * 1000) {
      // Recent passive refresh — reuse the cached token rather than
      // hammering Frontegg. (forceRefresh callers from 401 retry skip
      // this branch so a stale cache can't trap us in a loop.)
      const cached = GM_getValue("ynAccessToken", "");
      if (cached) return Promise.resolve(cached);
    }
    ynLastRefreshAttempt = now;
    const region = GM_getValue("ynRegion", "eu"); // default to EU
    const authHost = "https://auth." + region + ".younium.com";
    ynRefreshInFlight = new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: authHost + "/frontegg/identity/resources/auth/v1/user/token/refresh",
        headers: { "content-type": "application/json", accept: "application/json" },
        data: "{}",
        timeout: 20000,
        anonymous: false,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(
              "HTTP " + res.status +
              ": Younium session expired or missing. Open https://" + region +
              ".younium.com once while logged in, then try again.",
            ));
            return;
          }
          try {
            const j = JSON.parse(res.responseText || "{}");
            const token = String(j?.accessToken ?? "").trim();
            if (!token) {
              reject(new Error("Younium refresh returned no accessToken."));
              return;
            }
            // Cache + record expiry. expiresIn is in seconds.
            const ttlMs = Math.max(60_000, Number(j.expiresIn || 0) * 1000);
            const expiresAt = Date.now() + ttlMs;
            GM_setValue("ynAccessToken", token);
            GM_setValue("ynAccessTokenExpiresAt", expiresAt);
            GM_setValue("ynAccessTokenCapturedAt", Date.now());
            resolve(token);
          } catch (e) {
            reject(new Error("Younium refresh parse failed: " + (e?.message ?? e)));
          }
        },
        onerror: () => reject(new Error("Network error reaching Younium auth")),
        ontimeout: () => reject(new Error("Younium auth timed out")),
      });
    }).finally(() => {
      // Allow another refresh attempt later
      setTimeout(() => { ynRefreshInFlight = null; }, 0);
    });
    return ynRefreshInFlight;
  }

  /**
   * Generic CORS-bypassing HTTP call to the Younium API.
   *
   * Auth: ensures a fresh access token (refreshes if absent or within
   * 60s of expiry), then sends `Authorization: Bearer <token>` against
   * api.younium.com. On 401, refreshes once and retries.
   *
   *   await YouniumBridge.apiRequest("GET", "/api/user/profile");
   *
   * @param {string} method
   * @param {string} path   Relative to https://api.younium.com, OR absolute.
   * @param {object} [body] JSON body for non-GET requests.
   */
  async function gmYouniumRequest(method, path, body) {
    const url = /^https?:/i.test(path) ? path : (YOUNIUM_API + (path.startsWith("/") ? path : "/" + path));
    // SECURITY: never attach the Bearer JWT to a non-Younium origin. A
    // caller-supplied absolute URL to another @connect host must not
    // receive the token. Relative paths always resolve to api.younium.com.
    let __ynOrigin = "";
    try { __ynOrigin = new URL(url).origin; } catch (_) {}
    if (__ynOrigin !== "https://api.younium.com") {
      throw new Error("Refusing to send Younium token to non-Younium origin: " + (__ynOrigin || url));
    }

    // Use cached token if it's not about to expire; otherwise refresh.
    let token = GM_getValue("ynAccessToken", "");
    const expiresAt = Number(GM_getValue("ynAccessTokenExpiresAt", 0));
    const expiringSoon = !expiresAt || (Date.now() > expiresAt - 60_000);
    if (!token || expiringSoon) {
      token = await gmYouniumRefreshToken();
    }

    const send = (t) => new Promise((resolve, reject) => {
      // `X-Younium-Origin: frontend` is required by some endpoints
      // (notably /api/data/query/order). Cheap to send on every call;
      // adding it unconditionally avoids per-endpoint header juggling.
      const headers = {
        accept: "application/json",
        Authorization: "Bearer " + t,
        "X-Younium-Origin": "frontend",
      };
      const init = {
        method: String(method ?? "GET").toUpperCase(),
        url,
        headers,
        timeout: 20000,
        anonymous: false,
        onload: (res) => resolve({ status: res.status, text: res.responseText || "" }),
        onerror: () => reject(new Error("Network error reaching Younium API")),
        ontimeout: () => reject(new Error("Younium API timed out")),
      };
      if (body !== undefined && body !== null) {
        headers["content-type"] = "application/json";
        init.data = typeof body === "string" ? body : JSON.stringify(body);
      }
      GM_xmlhttpRequest(init);
    });

    let res = await send(token);
    if (res.status === 401) {
      // Token rejected — force a fresh refresh (bypassing the 30s
      // cooldown) and retry once. The cooldown is meant to prevent
      // stampedes on passive expiry-soon refreshes; a 401 means the
      // cached token is actually dead, so we must mint a new one.
      try {
        token = await gmYouniumRefreshToken(true);
        res = await send(token);
      } catch (_) {/* fall through to error below */}
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "HTTP " + res.status +
        ": Younium session expired. Open https://" + GM_getValue("ynRegion", "eu") +
        ".younium.com once while logged in to refresh, then try again.",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error("HTTP " + res.status + ": " + (res.text || "").slice(0, 300));
    }
    if (!res.text) return null;
    try { return JSON.parse(res.text); } catch { return null; }
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      const apiKey = GM_getValue("rlApiKey", "");
      if (!apiKey) {
        reject(
          new Error(
            "No Rocketlane api-key captured yet. Open https://kiona.rocketlane.com once while logged in.",
          ),
        );
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        headers: { "api-key": apiKey, accept: "application/json" },
        timeout: 20000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("HTTP " + res.status + ": " + (res.responseText || "").slice(0, 200)));
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(new Error("Invalid JSON from Rocketlane: " + e.message));
          }
        },
        onerror: () => reject(new Error("Network error reaching Rocketlane API")),
        ontimeout: () => reject(new Error("Rocketlane API timed out")),
      });
    });
  }

  function gmPost(url, jsonBody) {
    return new Promise((resolve, reject) => {
      const apiKey = GM_getValue("rlApiKey", "");
      if (!apiKey) {
        reject(new Error("No Rocketlane api-key captured yet. Open https://kiona.rocketlane.com once while logged in."));
        return;
      }
      GM_xmlhttpRequest({
        method: "POST",
        url: url,
        headers: {
          "api-key": apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        data: JSON.stringify(jsonBody),
        timeout: 20000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("HTTP " + res.status + ": " + (res.responseText || "").slice(0, 200)));
            return;
          }
          try {
            resolve(res.responseText ? JSON.parse(res.responseText) : null);
          } catch (e) {
            // Some POST endpoints return non-JSON on success; treat as OK.
            resolve(null);
          }
        },
        onerror: () => reject(new Error("Network error reaching Rocketlane API")),
        ontimeout: () => reject(new Error("Rocketlane API timed out")),
      });
    });
  }

  /**
   * Upload a file to Rocketlane as an attachment.
   * Format discovered by sniffing the Rocketlane web UI's own request:
   *   POST https://kiona.api.rocketlane.com/api/v1/attachments
   *   Content-Type: multipart/form-data
   *   Parts:
   *     - "file": <File>
   *     - "request": application/json blob with shape
   *         { "attachment": { "name", "publicVisibility", "projectId" } }
   * Response: 201 Created with body { "attachment": { ...full attachment incl. attachmentId... } }
   *
   * @param {number|string} projectId
   * @param {File|Blob} file — must have .name and .type (or `fileName`/`fileType`)
   * @param {{publicVisibility?: boolean, folderId?: number|string}} [opts]
   *        folderId → upload into that project folder (e.g. General Shared Files):
   *        creates with sourceType:"FOLDER"/sourceId, then POSTs the folder link.
   * @returns {Promise<any>} the `attachment` object from the response
   */
  function gmUploadAttachment(projectId, file, opts) {
    return new Promise((resolve, reject) => {
      const apiKey = GM_getValue("rlApiKey", "");
      if (!apiKey) {
        reject(new Error("No Rocketlane api-key captured yet. Open https://kiona.rocketlane.com once while logged in."));
        return;
      }
      const fileName = (file && (file.name || file.fileName)) || "upload.bin";
      // Optional folder target (e.g. General Shared Files). When given, the
      // create request carries sourceType/sourceId so Rocketlane homes the
      // attachment in that folder, and we POST .../attachments/link afterwards
      // (mirrors Rocketlane's own 2-step "upload to folder" flow). Folder
      // uploads default publicVisibility=false to match the UI's request.
      const folderId = opts && opts.folderId != null ? Number(opts.folderId) : null;
      const publicVisibility = opts && typeof opts.publicVisibility === "boolean"
        ? opts.publicVisibility
        : folderId == null;
      const attachmentReq = {
        name: fileName,
        publicVisibility: publicVisibility,
        projectId: Number(projectId),
      };
      if (folderId != null) { attachmentReq.sourceType = "FOLDER"; attachmentReq.sourceId = folderId; }
      const requestPayload = { attachment: attachmentReq };
      const fd = new FormData();
      fd.append("file", file, fileName);
      fd.append("request", new Blob([JSON.stringify(requestPayload)], { type: "application/json" }));

      GM_xmlhttpRequest({
        method: "POST",
        url: TENANT_API + "/attachments",
        // NOTE: do NOT set Content-Type ourselves — the browser/Tampermonkey
        // will set `multipart/form-data; boundary=...` automatically.
        headers: { "api-key": apiKey, accept: "application/json" },
        data: fd,
        timeout: 60000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("Upload failed HTTP " + res.status + ": " + (res.responseText || "").slice(0, 200)));
            return;
          }
          let att;
          try {
            const j = JSON.parse(res.responseText || "{}");
            att = j?.attachment ?? j?.data?.attachment ?? j;
            if (!att?.attachmentId) {
              reject(new Error("Upload succeeded but no attachmentId in response"));
              return;
            }
          } catch (e) {
            reject(new Error("Could not parse upload response: " + e.message));
            return;
          }
          // No folder target → done (legacy behavior). Otherwise link the new
          // attachment into the folder so it actually shows there (create alone
          // leaves it an orphan — Rocketlane needs the explicit link step).
          if (folderId == null) { resolve(att); return; }
          GM_xmlhttpRequest({
            method: "POST",
            url: TENANT_API + "/projects/" + encodeURIComponent(projectId) + "/folders/" + encodeURIComponent(folderId) + "/attachments/link",
            headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
            data: JSON.stringify([att.attachmentId]),
            timeout: 30000,
            onload: (lres) => {
              if (lres.status < 200 || lres.status >= 300) {
                reject(new Error("Folder link failed HTTP " + lres.status + ": " + (lres.responseText || "").slice(0, 200)));
                return;
              }
              resolve(att);
            },
            onerror: () => reject(new Error("Network error during folder link")),
            ontimeout: () => reject(new Error("Folder link timed out")),
          });
        },
        onerror: () => reject(new Error("Network error during attachment upload")),
        ontimeout: () => reject(new Error("Attachment upload timed out")),
      });
    });
  }

  function plainTextToHtml(text) {
    // Escape HTML, then wrap paragraphs by double-newline and <br> by single-newline.
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return String(text)
      .split(/\n{2,}/)
      .map((para) => "<p>" + esc(para).replace(/\n/g, "<br>") + "</p>")
      .join("");
  }

  target.RocketlaneBridge = {
    isAvailable: true,
    version: "1.0.0-tampermonkey",

    // Synchronous accessors — the tracker reads these at chat-panel
    // render time to avoid the async race where mentions get composed
    // before getApiKey() resolves. GM_getValue is itself synchronous so
    // there's no I/O penalty.
    get userId() { return GM_getValue("rlUserId", null); },
    get apiKey() { return GM_getValue("rlApiKey", "") || null; },

    /**
     * Generic Rocketlane API call routed through GM_xmlhttpRequest so it
     * bypasses CORS. The tracker uses this for ANY tenant-API endpoint
     * (task create, phase list, task delete, project update, …) because
     * its own fetch() can't reach kiona.api.rocketlane.com from
     * github.io / file:// origins.
     *
     *   await bridge.apiRequest("POST", "/tasks", { taskName: "x", … });
     *   await bridge.apiRequest("GET",  "/projects/123/phases");
     *   await bridge.apiRequest("DELETE", "/tasks/456");
     *
     * @param {string} method
     * @param {string} path   Path relative to /api/v1, or full URL.
     * @param {object} [body] JSON body for non-GET requests.
     */
    async apiRequest(method, path, body) {
      return await gmRequest(method, path, body);
    },

    async getStatus() {
      const hasKey = !!GM_getValue("rlApiKey", "");
      const capturedAt = GM_getValue("rlApiKeyCapturedAt", null);
      return { hasKey, capturedAt };
    },

    /**
     * Return the captured Rocketlane api-key so the tracker page can save it
     * locally (e.g. for non-bridge API calls). Only callable from pages where
     * the userscript injected the bridge — i.e. local file:// pages, which is
     * the same origin scope as the tracker.
     */
    async getApiKey() {
      const apiKey = GM_getValue("rlApiKey", "");
      const capturedAt = GM_getValue("rlApiKeyCapturedAt", null);
      const userId = GM_getValue("rlUserId", null);
      return apiKey ? { apiKey, capturedAt, userId } : null;
    },

    async listProjectConversations(projectId) {
      const data = await gmFetch(
        TENANT_API +
          "/projects/" +
          encodeURIComponent(projectId) +
          "/project-conversations?pageSize=20",
      );
      // Rocketlane sometimes returns numeric-keyed objects; normalize to array.
      return Array.isArray(data)
        ? data
        : Object.values(data || {}).filter((v) => v && typeof v === "object");
    },

    async uploadAttachment(projectId, file, opts) {
      return await gmUploadAttachment(projectId, file, opts);
    },

    /**
     * List all attachments uploaded to a project (across chat, tasks, spaces).
     * Response is an array where each entry has { attachment, source, link }.
     * Returns a normalized array of attachment objects with an extra
     * `_source` field describing where it came from.
     */
    /**
     * Fetch a single attachment by id. Rocketlane regenerates the
     * presigned downloadUrl on this endpoint, so it's the right call
     * to make right before opening/downloading a file.
     *
     * Tries several known endpoint shapes — Rocketlane has used different
     * paths over time and we don't have a public spec to anchor on.
     */
    async fetchAttachment(attachmentId) {
      const candidates = [
        TENANT_API + "/attachments/" + encodeURIComponent(attachmentId),
        TENANT_API + "/attachments/" + encodeURIComponent(attachmentId) + "/download",
        TENANT_API + "/attachments/" + encodeURIComponent(attachmentId) + "/url",
      ];
      let lastErr = null;
      for (const url of candidates) {
        try {
          const data = await gmFetch(url);
          // Different endpoints return different shapes — normalize.
          const att = data?.attachment ?? data?.data?.attachment ?? data;
          if (att && (att.downloadUrl || att.location || att.url)) {
            // Normalize a `url` field into `downloadUrl` for downstream code
            if (!att.downloadUrl && att.url) att.downloadUrl = att.url;
            return att;
          }
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("No attachment endpoint returned a usable URL");
    },

    /**
     * Download an attachment as a Blob via GM_xmlhttpRequest, so the tracker
     * can save it locally even though the file lives on S3 (which doesn't
     * send Content-Disposition headers that would let a plain <a download>
     * trigger a save from a cross-origin link).
     *
     * Always fetches a fresh presigned URL first (per-attachment endpoint).
     * Returns { blob, fileName, mimeType }.
     */
    async downloadAttachmentBlob(attachmentId) {
      const apiKey = GM_getValue("rlApiKey", "");
      if (!apiKey) throw new Error("No Rocketlane api-key captured yet.");
      // 1) Get a freshly-signed download URL via the per-attachment endpoint.
      const att = await this.fetchAttachment(attachmentId);
      const url = String(att?.downloadUrl ?? att?.location ?? "").trim();
      if (!url) throw new Error("Attachment has no downloadUrl/location.");
      const fileName = String(att?.name ?? "download.bin");
      const mimeType = String(att?.mimeType ?? att?.contentType ?? "application/octet-stream");
      // 2) Stream the bytes through GM_xmlhttpRequest so CORS doesn't bite.
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "blob",
          timeout: 120000,
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error("Download failed HTTP " + res.status));
              return;
            }
            resolve({ blob: res.response, fileName, mimeType });
          },
          onerror: () => reject(new Error("Network error while downloading attachment")),
          ontimeout: () => reject(new Error("Attachment download timed out")),
        });
      });
    },

    /**
     * Fetch the user's notification groups. The response is an array of
     *   { key, task, notifications: [...] }
     * where each notification has timestamp, systemRuleIdentifier, meta, etc.
     *
     * Earlier versions called the endpoint with no params, which made the
     * server return a default subset that quietly excluded chat-mention
     * events. Capture from Rocketlane's own UI shows the call passes
     * status/count/groupSize/filter/exclusions explicitly — we now do too.
     *
     * @param {object} [opts]
     * @param {"All"|"AssignedToMe"|"Mentions"|"Team"} [opts.filter="All"]
     * @param {"New"|"Read"} [opts.status="New"]
     * @param {number} [opts.count=20]      Max groups to return
     * @param {number} [opts.groupSize=8]   Max notifications per group
     * @param {number} [opts.start]         Cursor (epoch micros) for pagination
     * @param {string} [opts.exclusions=""] CSV of rule IDs to exclude
     */
    async fetchNotificationGroups(opts) {
      const o = opts || {};
      const params = new URLSearchParams();
      params.set("status",     String(o.status     ?? "New"));
      params.set("count",      String(o.count      ?? 20));
      params.set("groupSize",  String(o.groupSize  ?? 8));
      params.set("filter",     String(o.filter     ?? "All"));
      params.set("exclusions", String(o.exclusions ?? ""));
      if (o.start != null) params.set("start", String(o.start));
      const data = await gmFetch(TENANT_API + "/notifications/groups?" + params.toString());
      return Array.isArray(data) ? data : Object.values(data || {});
    },

    /** Returns { lastSeenAt: ISO string } — the "everything before this is read" cursor. */
    async getNotificationLastSeen() {
      return await gmFetch(TENANT_API + "/notifications/last-seen-at");
    },

    /** Mark all notifications as read by pushing the cursor forward to now. */
    async markNotificationsSeen() {
      const apiKey = GM_getValue("rlApiKey", "");
      if (!apiKey) throw new Error("No Rocketlane api-key captured yet.");
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: TENANT_API + "/notifications/last-seen-at",
          headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
          data: "{}",
          timeout: 15000,
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error("HTTP " + res.status + ": " + (res.responseText || "").slice(0, 200)));
              return;
            }
            try { resolve(res.responseText ? JSON.parse(res.responseText) : null); }
            catch { resolve(null); }
          },
          onerror: () => reject(new Error("Network error marking notifications seen")),
          ontimeout: () => reject(new Error("Marking notifications seen timed out")),
        });
      });
    },

    /**
     * Fetch the project's "Shared Files" / "Private Files" folders.
     * Returns a flat array of attachment objects with an extra
     * `_folder` field (folder name) and `_isPrivate` flag.
     * Complements fetchProjectAttachments() which only covers
     * task/conversation attachments — folder files live elsewhere.
     */
    async fetchProjectFolders(projectId) {
      const data = await gmFetch(
        TENANT_API + "/projects/" + encodeURIComponent(projectId) + "/folders"
      );
      const folders = Array.isArray(data?.value) ? data.value
        : Array.isArray(data) ? data
        : [];
      const out = [];
      for (const f of folders) {
        const folderName = String(f?.folderName ?? "Files").trim();
        const isPrivate = !!f?.isPrivate;
        const atts = Array.isArray(f?.attachments) ? f.attachments : [];
        for (const a of atts) {
          out.push({
            ...a,
            _folder: folderName,
            _isPrivate: isPrivate,
            _source: folderName,
            _link: null,
          });
        }
      }
      return out;
    },

    /**
     * Fetch the list of users + teams that are members of a Rocketlane
     * project. Used by the chat compose box's @-mention picker so only
     * actual project members appear in the dropdown.
     * Returns the response shape:
     *   { userList: [...], teamList: [...], members: [...], ... }
     */
    async fetchProjectMembers(projectId) {
      return await gmFetch(
        TENANT_API + "/projects/" + encodeURIComponent(projectId) + "/members"
      );
    },

    async fetchProjectAttachments(projectId) {
      const data = await gmFetch(
        TENANT_API + "/attachments/project/" + encodeURIComponent(projectId)
      );
      const list = Array.isArray(data) ? data : Object.values(data || {}).filter((v) => v && typeof v === "object");
      // Normalize: flatten { attachment, source, link } into a plain object
      return list
        .filter((entry) => entry && entry.attachment)
        .map((entry) => ({
          ...entry.attachment,
          _source: entry.source ?? null,
          _link: entry.link ?? null,
        }));
    },

    async postChatComment(projectId, conversationId, plainText, opts) {
      const text = String(plainText || "").trim();
      const linkedAtt = (opts && Array.isArray(opts.linkedAttachments)) ? opts.linkedAttachments : [];
      // Callers can pass pre-rendered HTML (used by @-mention support so
      // the <span class="mention">...</span> markup isn't escaped). If
      // provided, it's used verbatim and overrides the plainText path.
      const contentHtml = opts && typeof opts.contentHtml === "string" ? opts.contentHtml : null;
      if (!text && !linkedAtt.length && !contentHtml) throw new Error("Empty message (no text and no attachments)");
      const isPrivate = !!(opts && opts.private);
      const userId = GM_getValue("rlUserId", 0);
      if (!userId) {
        throw new Error("No userId captured yet. Visit kiona.rocketlane.com once while logged in.");
      }
      const commentMeta = {};
      if (linkedAtt.length) {
        // Each entry should be the full attachment object from uploadAttachment().
        // Rocketlane uses `linkedAttachments` to link uploaded files to a comment.
        commentMeta.linkedAttachments = linkedAtt;
      }
      const finalContent = contentHtml != null
        ? contentHtml
        : (text ? plainTextToHtml(text) : "");
      // Extract Rocketlane native @mention markers so we can attach a
      // mentions.userMentions array. The server appears to read both the
      // HTML and the explicit array, but in-app notifications rely on
      // this array being present.
      const userMentions = [];
      try {
        const re = /<a[^>]*\bclass="[^"]*rl__mention[^"]*"[^>]*>/g;
        let m;
        while ((m = re.exec(finalContent)) !== null) {
          const tag = m[0];
          const objId = (tag.match(/data-rocketlane-mention-object-id="(\d+)"/) || [])[1];
          const uuid = (tag.match(/data-rocketlane-mention-identifier="([^"]+)"/) || [])[1];
          if (objId && uuid) {
            userMentions.push({
              mentionedObjectId: Number(objId),
              mentionedObjectType: "USER",
              mentionUuid: uuid,
              projectId: Number(projectId),
              sourceUserId: Number(userId),
            });
          }
        }
      } catch (_) {}
      const body = {
        comment: {
          messageType: "USER_MESSAGE",
          content: finalContent,
          private: isPrivate,
          commentMeta,
          user: { userId: Number(userId), userType: "NATIVE" },
        },
      };
      if (userMentions.length) {
        body.comment.mentions = { userMentions, taskMentions: [], documentMentions: [], spaceTabMentions: [], teamMentions: [] };
      }
      const url = TENANT_API +
        "/projects/" + encodeURIComponent(projectId) +
        "/project-conversations/" + encodeURIComponent(conversationId) +
        "/comments";
      return await gmPost(url, body);
    },

    async fetchChatComments(projectId, conversationId) {
      const data = await gmFetch(
        TENANT_API +
          "/projects/" +
          encodeURIComponent(projectId) +
          "/project-conversations/" +
          encodeURIComponent(conversationId) +
          "/conversations",
      );
      return Array.isArray(data && data.comments) ? data.comments : [];
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // ZendeskBridge — separate object, separate API surface. Lives next to
  // RocketlaneBridge so existing tracker code doesn't see breaking changes.
  //
  // No token storage: GM_xmlhttpRequest re-uses the user's existing
  // iwmac.zendesk.com session cookie. If the user is logged out, calls
  // fail with HTTP 401 and the bridge surfaces a clear error message.
  // ──────────────────────────────────────────────────────────────────────────
  target.ZendeskBridge = {
    isAvailable: true,
    version: "1.0.0-tampermonkey",
    /**
     * Generic CORS-bypassing Zendesk API call.
     * @param {string} method
     * @param {string} path   Relative to /api/v2, or an absolute URL.
     * @param {object} [body] JSON body for non-GET requests.
     */
    async apiRequest(method, path, body) {
      return await gmZendeskRequest(method, path, body);
    },
    /**
     * Convenience: fetch one ticket by ID. Returns the parsed ticket
     * object, or null on 404.
     * @param {number|string} ticketId
     */
    async getTicket(ticketId) {
      const id = String(ticketId ?? "").trim();
      if (!id) throw new Error("getTicket requires a ticketId");
      try {
        const json = await gmZendeskRequest("GET", "/tickets/" + encodeURIComponent(id) + ".json");
        return json?.ticket ?? null;
      } catch (e) {
        if (String(e?.message ?? "").includes("HTTP 404")) return null;
        throw e;
      }
    },
    /**
     * Convenience: return the currently-logged-in Zendesk user.
     * Useful for the tracker to confirm session is valid before
     * showing Zendesk-dependent UI.
     */
    async getCurrentUser() {
      const json = await gmZendeskRequest("GET", "/users/me.json");
      return json?.user ?? null;
    },
    /**
     * Get all comments for a ticket with author user data sideloaded.
     * Returns { comments: [...], users: [...] } so the tracker can show
     * author names without an extra round-trip per comment.
     */
    async getTicketComments(ticketId) {
      const id = String(ticketId ?? "").trim();
      if (!id) throw new Error("getTicketComments requires a ticketId");
      return await gmZendeskRequest(
        "GET",
        "/tickets/" + encodeURIComponent(id) + "/comments.json?include=users&sort_order=asc",
      );
    },
    /**
     * Post a reply to a ticket. `body` is plain text. `isPublic=true`
     * → customer-visible; false → internal note (agents only).
     * Requires CSRF token captured from an iwmac.zendesk.com session.
     * Returns the updated ticket object.
     */
    async postTicketReply(ticketId, body, isPublic) {
      const id = String(ticketId ?? "").trim();
      if (!id) throw new Error("postTicketReply requires a ticketId");
      const trimmed = String(body ?? "").trim();
      if (!trimmed) throw new Error("Reply body cannot be empty");
      const json = await gmZendeskRequest(
        "PUT",
        "/tickets/" + encodeURIComponent(id) + ".json",
        { ticket: { comment: { body: trimmed, public: !!isPublic } } },
      );
      return json?.ticket ?? null;
    },
    /** Diagnostic: returns whether a CSRF token has been captured + age. */
    async getCsrfStatus() {
      const token = GM_getValue("zdCsrfToken", "");
      const capturedAt = GM_getValue("zdCsrfCapturedAt", 0);
      return {
        hasToken: !!token,
        capturedAt: capturedAt || null,
        ageMs: capturedAt ? (Date.now() - capturedAt) : null,
      };
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // OneflowBridge — parallel to RocketlaneBridge / ZendeskBridge.
  // Session-cookie auth + xsrf-token CSRF; no API key captured here, just
  // routes calls through GM_xmlhttpRequest so the user's existing Oneflow
  // session works from the tracker's github.io / file:// origin.
  // ──────────────────────────────────────────────────────────────────────────
  target.OneflowBridge = {
    isAvailable: true,
    version: "1.0.0-tampermonkey",
    /**
     * Generic CORS-bypassing Oneflow API call.
     * @param {string} method
     * @param {string} path   Relative to /api, or an absolute URL.
     * @param {object} [body] JSON body for non-GET requests.
     */
    async apiRequest(method, path, body) {
      return await gmOneflowRequest(method, path, body);
    },
    /**
     * Currently logged-in Oneflow user — useful for confirming session
     * is valid before showing Oneflow-dependent UI in the tracker.
     */
    async getCurrentUser() {
      return await gmOneflowRequest("GET", "/positions/me");
    },
    /** Diagnostic: whether an xsrf-token was captured + how old it is. */
    async getCsrfStatus() {
      const token = GM_getValue("ofXsrfToken", "");
      const capturedAt = GM_getValue("ofXsrfCapturedAt", 0);
      return {
        hasToken: !!token,
        capturedAt: capturedAt || null,
        ageMs: capturedAt ? (Date.now() - capturedAt) : null,
      };
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // HubSpotBridge — session-cookie + per-call CSRF. Portal ID + hublet
  // host are captured separately because HubSpot has US and EU regions
  // and every API call needs them in the URL.
  // ──────────────────────────────────────────────────────────────────────────
  target.HubSpotBridge = {
    isAvailable: true,
    version: "1.0.0-tampermonkey",
    /**
     * Generic CORS-bypassing HubSpot API call.
     * @param {string} method
     * @param {string} path   Relative to /api, or an absolute URL.
     * @param {object} [body] JSON body for non-GET requests.
     */
    async apiRequest(method, path, body) {
      return await gmHubSpotRequest(method, path, body);
    },
    /**
     * Currently logged-in HubSpot user context. The Login UI's
     * /api/login-requirements endpoint works without portal scope so
     * we use it here as a session-validity probe.
     */
    async getCurrentUser() {
      const portalId = GM_getValue("hsPortalId", "");
      const host = GM_getValue("hsHost", "");
      if (!host || !portalId) {
        throw new Error("HubSpot state not captured. Open a HubSpot page once.");
      }
      // The login-requirements endpoint takes user/portal in the path.
      // We don't know the userId from outside, so fall back to a generic
      // hub-user-info call that the web app uses on bootstrap.
      return await gmHubSpotRequest("GET", "/login-verify/hub-user-info?early=true");
    },
    /**
     * Search HubSpot CRM for objects of a given type.
     *
     * objectTypeId conventions: "0-1" = Contacts, "0-2" = Companies,
     * "0-3" = Deals, "0-5" = Tickets.
     *
     *   await HubSpotBridge.searchCrm("0-3", "3299", { properties: ["dealname"] });
     *
     * @param {string} objectTypeId
     * @param {string} query
     * @param {{ count?: number, offset?: number, properties?: string[] }} [opts]
     */
    async searchCrm(objectTypeId, query, opts) {
      const count = opts?.count ?? 10;
      const offset = opts?.offset ?? 0;
      const props = opts?.properties || [];
      return await gmHubSpotRequest("POST", "/crm-search/search", {
        objectTypeId,
        query: String(query ?? ""),
        count,
        offset,
        requestOptions: {
          properties: props,
          // When the caller asks for it, return EVERY property on the
          // object instead of just the listed ones. Used by searchDeals
          // so matching can read plant_id / deal_partner / org-nr /
          // contact / Younium-quote without enumerating (and risking a
          // 400 on) every tenant-specific property name.
          includeAllProperties: opts?.includeAllProperties === true,
        },
      });
    },
    /**
     * Convenience: search deals by free text. Returns the standard
     * { results, total, hasMore, offset } shape.
     *
     * Defaults to includeAllProperties:true so EVERY deal property comes
     * back — the tracker's matcher reads tenant-specific custom props
     * (plant_id, deal_partner, deal_organization_nr_younium,
     * deal_contact / contact_email / deal_contact_tlf_nr,
     * deal_younium_quote_number, plant_name, …) and enumerating them
     * risks a 400 on any name that doesn't exist. Pass
     * { includeAllProperties: false } to opt back into the minimal list.
     */
    async searchDeals(query, opts) {
      return await this.searchCrm("0-3", query, {
        count: opts?.count ?? 10,
        includeAllProperties: opts?.includeAllProperties ?? true,
        properties: opts?.properties ?? [
          "dealname", "dealstage", "amount", "closedate",
          "hs_lastmodifieddate", "pipeline",
        ],
      });
    },
    /** Diagnostic: state-capture status. */
    async getCsrfStatus() {
      const token = GM_getValue("hsCsrfToken", "");
      const capturedAt = GM_getValue("hsCsrfCapturedAt", 0);
      return {
        hasToken: !!token,
        host: GM_getValue("hsHost", "") || null,
        portalId: GM_getValue("hsPortalId", "") || null,
        capturedAt: capturedAt || null,
        ageMs: capturedAt ? (Date.now() - capturedAt) : null,
      };
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // YouniumBridge — Frontegg JWT auth. Bridge mints fresh access
  // tokens via /frontegg/.../token/refresh using the HttpOnly refresh
  // cookie (no token stored on the page side; bridge holds the
  // 24h-lived access token in GM storage with an expiry timestamp).
  // ──────────────────────────────────────────────────────────────────────────
  target.YouniumBridge = {
    isAvailable: true,
    version: "1.0.0-tampermonkey",
    /**
     * Generic CORS-bypassing Younium API call.
     * @param {string} method
     * @param {string} path   Relative to https://api.younium.com, or absolute.
     * @param {object} [body] JSON body for non-GET requests.
     */
    async apiRequest(method, path, body) {
      return await gmYouniumRequest(method, path, body);
    },
    /**
     * Force a token refresh (on-demand). Returns only a STATUS object —
     * never the raw JWT — so page-world code can't harvest a bearer token
     * valid against api.younium.com. Internal callers (gmYouniumRequest)
     * use gmYouniumRefreshToken() directly and are unaffected.
     */
    async refreshToken() {
      await gmYouniumRefreshToken();
      const expiresAt = Number(GM_getValue("ynAccessTokenExpiresAt", 0)) || null;
      return { refreshed: true, expiresAt };
    },
    /** Currently logged-in Younium user — proof session is valid. */
    async getCurrentUser() {
      return await gmYouniumRequest("GET", "/api/user/profile");
    },
    /**
     * Search Younium orders by free text. Mirrors the body shape the
     * Younium UI sends (verified via Playwright):
     *
     *   POST /api/data/query/order
     *   { entity, filter, pageNumber, pageSize, sortField, sortDirection,
     *     displayFields, conditions, conditionLogic }
     *
     * Response: { totalCount, result: [...] } with flat fields incl.
     * plant_id (native field — exact-match friendly), plant_name,
     * orderNumber, accountname, status, effectiveStartDate, id.
     */
    async searchOrders(query, opts) {
      const body = {
        entity: "order",
        filter: String(query ?? ""),
        pageNumber: 0,
        pageSize: opts?.pageSize ?? 20,
        sortField: opts?.sortField ?? "effectiveStartDate",
        sortDirection: opts?.sortDirection ?? "desc",
        displayFields: opts?.displayFields ?? [
          "orderNumber", "plant_id", "plant_name",
          "accountname", "status", "orderType",
          "effectiveStartDate", "id",
        ],
        conditions: opts?.conditions ?? [
          { fieldName: "isLastVersion", value: true, operator: 0 },
        ],
        conditionLogic: opts?.conditionLogic ?? "",
      };
      return await gmYouniumRequest("POST", "/api/data/query/order", body);
    },
    /**
     * Free-text search Younium quotes. Mirrors searchOrders but hits
     * /api/data/query/quote with entity: "quote". Verified via
     * Playwright — the response carries flat fields including
     * plant_id (often empty for unfinished quotes), plant_name,
     * accountName, description, number ("Draft" until published, then
     * "Q-NNNNNN"), status (numeric), currencyCode, ownerUserDisplayName,
     * remarks, and the UUID `id` used in the /quotes/<id> URL.
     *
     * The user spec showed a plant 11102 quote that searchOrders
     * missed entirely because it was a quote not promoted to an order.
     */
    async searchQuotes(query, opts) {
      const body = {
        entity: "quote",
        filter: String(query ?? ""),
        pageNumber: 0,
        pageSize: opts?.pageSize ?? 20,
        sortField: opts?.sortField ?? "number",
        sortDirection: opts?.sortDirection ?? "desc",
        // Pull every field useful for matching — same set the Younium
        // UI itself requests, plus a few extras (orderType analog).
        displayFields: opts?.displayFields ?? [
          "number", "accountName", "description", "status",
          "currencyCode", "remarks", "ownerUserDisplayName",
          "plant_name", "plant_id",
          "accountid", "changeOrderid", "convertedToOrderid", "id",
          "ownerid", "currencyid",
        ],
        conditions: opts?.conditions ?? [],
        conditionLogic: opts?.conditionLogic ?? "",
      };
      return await gmYouniumRequest("POST", "/api/data/query/quote", body);
    },
    /**
     * Fetch a single order's full payload by UUID.
     *   GET https://api.younium.com/api/order/{id}
     * Used by the Younium status chip to inspect lifecycle dates,
     * cancellation, bookings, and the order's enum status field.
     */
    async getOrderById(id) {
      const safe = encodeURIComponent(String(id || "").trim());
      if (!safe) throw new Error("getOrderById: id is required");
      return await gmYouniumRequest("GET", "/api/order/" + safe, null);
    },
    /**
     * Fetch invoice history for an order by its public order number
     * (e.g. "O-011102"). The Younium UI uses this exact endpoint when
     * rendering the "Invoices" panel on the order detail page.
     *   POST /api/order/invoicesForHistory  { orderNumber }
     * Each invoice entry has `status` (3 = posted/paid in our samples),
     * `invoiceNumber`, `posted`, `paymentDate`, `dueDate`, `totalAmount`.
     */
    async getInvoicesForOrder(orderNumber) {
      const n = String(orderNumber || "").trim();
      if (!n) return [];
      const result = await gmYouniumRequest(
        "POST", "/api/order/invoicesForHistory", { orderNumber: n },
      );
      return Array.isArray(result) ? result : (result?.result ?? []);
    },
    /**
     * Fetch a single quote's row from /api/data/query/quote filtered
     * by id. Younium doesn't expose a GET /api/quote/{id} endpoint
     * (verified — the orders detail endpoint pattern doesn't apply to
     * quotes), so we use the query-filter shape with conditions.
     */
    async getQuoteById(id) {
      const safe = String(id || "").trim();
      if (!safe) return null;
      const body = {
        entity: "quote",
        filter: "",
        pageNumber: 0,
        pageSize: 1,
        sortField: "number",
        sortDirection: "desc",
        displayFields: [
          "number", "accountName", "description", "status", "currencyCode",
          "remarks", "ownerUserDisplayName", "plant_name", "plant_id",
          "accountid", "changeOrderid", "convertedToOrderid", "id",
        ],
        conditions: [{ fieldName: "id", value: safe, operator: 0 }],
        conditionLogic: "",
      };
      const j = await gmYouniumRequest("POST", "/api/data/query/quote", body);
      return j?.result?.[0] || null;
    },
    /**
     * Fetch the audit/timeline event log for an order. Verified via
     * Chrome devtools-MCP: Younium's UI calls
     *   GET https://api.younium.com/api/eventlog/order/id/{id}
     * when the user clicks the clock-icon "Order timeline" button.
     *
     * Response: array of event entries (or { result: [...] } depending
     * on tenant). Each entry typically has timestamp + user email /
     * display name + a description of what changed. We return the
     * raw array so the caller can extract the latest event.
     */
    async getOrderEventLog(id) {
      const safe = encodeURIComponent(String(id || "").trim());
      if (!safe) throw new Error("getOrderEventLog: id is required");
      const result = await gmYouniumRequest(
        "GET", "/api/eventlog/order/id/" + safe, null,
      );
      return Array.isArray(result) ? result : (result?.result ?? []);
    },
    /** Diagnostic: token cache status + region. */
    async getTokenStatus() {
      const token = GM_getValue("ynAccessToken", "");
      const expiresAt = GM_getValue("ynAccessTokenExpiresAt", 0);
      const capturedAt = GM_getValue("ynAccessTokenCapturedAt", 0);
      return {
        hasToken: !!token,
        region: GM_getValue("ynRegion", "") || null,
        capturedAt: capturedAt || null,
        expiresAt: expiresAt || null,
        msUntilExpiry: expiresAt ? (expiresAt - Date.now()) : null,
      };
    },
  };

  // Notify the tracker page in case it's listening
  try {
    target.dispatchEvent(new CustomEvent("rocketlane-bridge-ready"));
    target.dispatchEvent(new CustomEvent("zendesk-bridge-ready"));
    target.dispatchEvent(new CustomEvent("oneflow-bridge-ready"));
    target.dispatchEvent(new CustomEvent("hubspot-bridge-ready"));
    target.dispatchEvent(new CustomEvent("younium-bridge-ready"));
  } catch (_) {}

  // Expose this userscript's own @version on the page window so the tracker can
  // warn when an OUTDATED bridge is installed. The tracker reads
  // RocketlaneBridge.userscriptVersion (or window.IWMAC_BRIDGE_VERSION). This
  // covers the direct-publish path; the <script>-tag shim fallback below
  // re-publishes it for isolated-world browser/Tampermonkey combos.
  try {
    const __bridgeUserscriptVersion =
      (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || null;
    if (__bridgeUserscriptVersion) {
      try { target.IWMAC_BRIDGE_VERSION = __bridgeUserscriptVersion; } catch (_) {}
      for (const __bn of ["RocketlaneBridge", "ZendeskBridge", "OneflowBridge", "HubSpotBridge", "YouniumBridge"]) {
        try { if (target[__bn]) target[__bn].userscriptVersion = __bridgeUserscriptVersion; } catch (_) {}
      }
    }
  } catch (_) {}

  // Verify the assignment actually landed on the page's real window
  // (not the userscript's isolated world). If it didn't — which can
  // happen on some Tampermonkey/browser combos where the unsafeWindow
  // reference returns the sandbox window — fall back to an injected
  // <script> tag that runs in the page world and forwards calls back to
  // the userscript via window-level events.
  function bridgeIsVisibleOnPage() {
    try {
      // Probe the page world with a synthetic script that reports back.
      const probeKey = "__rlBridgeProbe_" + Date.now();
      const s = document.createElement("script");
      s.textContent =
        "window['" + probeKey + "'] = typeof window.RocketlaneBridge !== 'undefined';";
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      const ok = !!(typeof unsafeWindow !== "undefined" ? unsafeWindow : window)[probeKey];
      return ok;
    } catch (_) { return false; }
  }

  // Schedule the visibility check after a microtask so the assignment
  // has been committed first.
  Promise.resolve().then(() => {
    if (bridgeIsVisibleOnPage()) {
      try { console.log("[Rocketlane Chat Bridge] published on page window ✓"); } catch (_) {}
      return;
    }
    try { console.warn("[Rocketlane Chat Bridge] not visible on page window — installing <script>-tag forwarder"); } catch (_) {}
    // Inject a tiny shim into the page world that:
    //   1. Defines window.RocketlaneBridge with the same surface
    //   2. For each async method, dispatches a CustomEvent to a
    //      userscript-side listener, which performs the actual work
    //      and dispatches back the result.
    const reqEvt  = "rocketlaneBridgeReq";
    const respEvt = "rocketlaneBridgeResp";
    const shim = document.createElement("script");
    const methodList = Object.keys(target.RocketlaneBridge).filter((k) =>
      typeof target.RocketlaneBridge[k] === "function",
    );
    const props = {
      version: target.RocketlaneBridge.version,
      userscriptVersion: target.RocketlaneBridge.userscriptVersion || null,
      isAvailable: true,
    };
    shim.textContent = `
      (function () {
        if (window.RocketlaneBridge) return;
        const methods = ${JSON.stringify(methodList)};
        const props   = ${JSON.stringify(props)};
        const reqEvt  = ${JSON.stringify(reqEvt)};
        const respEvt = ${JSON.stringify(respEvt)};
        const pending = new Map();
        let seq = 0;
        window.addEventListener(respEvt, (e) => {
          const d = e.detail || {};
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error));
          else p.resolve(d.value);
        });
        const bridge = { ...props };
        for (const m of methods) {
          bridge[m] = function (...args) {
            return new Promise((resolve, reject) => {
              const id = ++seq;
              pending.set(id, { resolve, reject });
              window.dispatchEvent(new CustomEvent(reqEvt, { detail: { id, method: m, args } }));
            });
          };
        }
        window.RocketlaneBridge = bridge;
        if (props.userscriptVersion) {
          try { window.IWMAC_BRIDGE_VERSION = props.userscriptVersion; } catch (_) {}
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(shim);
    shim.remove();

    // Userscript-side listener — runs the actual GM_xmlhttpRequest etc.
    target.addEventListener(reqEvt, async (e) => {
      const { id, method, args } = e.detail || {};
      try {
        const fn = target.RocketlaneBridge[method];
        const value = typeof fn === "function" ? await fn.apply(target.RocketlaneBridge, args || []) : null;
        target.dispatchEvent(new CustomEvent(respEvt, { detail: { id, value } }));
      } catch (err) {
        target.dispatchEvent(new CustomEvent(respEvt, { detail: { id, error: String(err?.message ?? err) } }));
      }
    });

    // Parallel forwarder for ZendeskBridge — same isolated-world fallback.
    const zReqEvt  = "zendeskBridgeReq";
    const zRespEvt = "zendeskBridgeResp";
    const zShim = document.createElement("script");
    const zMethodList = Object.keys(target.ZendeskBridge || {}).filter(
      (k) => typeof target.ZendeskBridge[k] === "function",
    );
    const zProps = {
      version: target.ZendeskBridge?.version,
      isAvailable: !!target.ZendeskBridge?.isAvailable,
    };
    zShim.textContent = `
      (function () {
        if (window.ZendeskBridge) return;
        const methods = ${JSON.stringify(zMethodList)};
        const props   = ${JSON.stringify(zProps)};
        const reqEvt  = ${JSON.stringify(zReqEvt)};
        const respEvt = ${JSON.stringify(zRespEvt)};
        const pending = new Map();
        let seq = 0;
        window.addEventListener(respEvt, (e) => {
          const d = e.detail || {};
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error));
          else p.resolve(d.value);
        });
        const bridge = { ...props };
        for (const m of methods) {
          bridge[m] = function (...args) {
            return new Promise((resolve, reject) => {
              const id = ++seq;
              pending.set(id, { resolve, reject });
              window.dispatchEvent(new CustomEvent(reqEvt, { detail: { id, method: m, args } }));
            });
          };
        }
        window.ZendeskBridge = bridge;
      })();
    `;
    (document.head || document.documentElement).appendChild(zShim);
    zShim.remove();

    target.addEventListener(zReqEvt, async (e) => {
      const { id, method, args } = e.detail || {};
      try {
        const fn = target.ZendeskBridge[method];
        const value = typeof fn === "function" ? await fn.apply(target.ZendeskBridge, args || []) : null;
        target.dispatchEvent(new CustomEvent(zRespEvt, { detail: { id, value } }));
      } catch (err) {
        target.dispatchEvent(new CustomEvent(zRespEvt, { detail: { id, error: String(err?.message ?? err) } }));
      }
    });

    // Parallel forwarder for OneflowBridge — same isolated-world fallback.
    const oReqEvt  = "oneflowBridgeReq";
    const oRespEvt = "oneflowBridgeResp";
    const oShim = document.createElement("script");
    const oMethodList = Object.keys(target.OneflowBridge || {}).filter(
      (k) => typeof target.OneflowBridge[k] === "function",
    );
    const oProps = {
      version: target.OneflowBridge?.version,
      isAvailable: !!target.OneflowBridge?.isAvailable,
    };
    oShim.textContent = `
      (function () {
        if (window.OneflowBridge) return;
        const methods = ${JSON.stringify(oMethodList)};
        const props   = ${JSON.stringify(oProps)};
        const reqEvt  = ${JSON.stringify(oReqEvt)};
        const respEvt = ${JSON.stringify(oRespEvt)};
        const pending = new Map();
        let seq = 0;
        window.addEventListener(respEvt, (e) => {
          const d = e.detail || {};
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error));
          else p.resolve(d.value);
        });
        const bridge = { ...props };
        for (const m of methods) {
          bridge[m] = function (...args) {
            return new Promise((resolve, reject) => {
              const id = ++seq;
              pending.set(id, { resolve, reject });
              window.dispatchEvent(new CustomEvent(reqEvt, { detail: { id, method: m, args } }));
            });
          };
        }
        window.OneflowBridge = bridge;
      })();
    `;
    (document.head || document.documentElement).appendChild(oShim);
    oShim.remove();

    target.addEventListener(oReqEvt, async (e) => {
      const { id, method, args } = e.detail || {};
      try {
        const fn = target.OneflowBridge[method];
        const value = typeof fn === "function" ? await fn.apply(target.OneflowBridge, args || []) : null;
        target.dispatchEvent(new CustomEvent(oRespEvt, { detail: { id, value } }));
      } catch (err) {
        target.dispatchEvent(new CustomEvent(oRespEvt, { detail: { id, error: String(err?.message ?? err) } }));
      }
    });

    // Parallel forwarder for HubSpotBridge — same isolated-world fallback.
    const hReqEvt  = "hubspotBridgeReq";
    const hRespEvt = "hubspotBridgeResp";
    const hShim = document.createElement("script");
    const hMethodList = Object.keys(target.HubSpotBridge || {}).filter(
      (k) => typeof target.HubSpotBridge[k] === "function",
    );
    const hProps = {
      version: target.HubSpotBridge?.version,
      isAvailable: !!target.HubSpotBridge?.isAvailable,
    };
    hShim.textContent = `
      (function () {
        if (window.HubSpotBridge) return;
        const methods = ${JSON.stringify(hMethodList)};
        const props   = ${JSON.stringify(hProps)};
        const reqEvt  = ${JSON.stringify(hReqEvt)};
        const respEvt = ${JSON.stringify(hRespEvt)};
        const pending = new Map();
        let seq = 0;
        window.addEventListener(respEvt, (e) => {
          const d = e.detail || {};
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error));
          else p.resolve(d.value);
        });
        const bridge = { ...props };
        for (const m of methods) {
          bridge[m] = function (...args) {
            return new Promise((resolve, reject) => {
              const id = ++seq;
              pending.set(id, { resolve, reject });
              window.dispatchEvent(new CustomEvent(reqEvt, { detail: { id, method: m, args } }));
            });
          };
        }
        window.HubSpotBridge = bridge;
      })();
    `;
    (document.head || document.documentElement).appendChild(hShim);
    hShim.remove();

    target.addEventListener(hReqEvt, async (e) => {
      const { id, method, args } = e.detail || {};
      try {
        const fn = target.HubSpotBridge[method];
        const value = typeof fn === "function" ? await fn.apply(target.HubSpotBridge, args || []) : null;
        target.dispatchEvent(new CustomEvent(hRespEvt, { detail: { id, value } }));
      } catch (err) {
        target.dispatchEvent(new CustomEvent(hRespEvt, { detail: { id, error: String(err?.message ?? err) } }));
      }
    });

    // Parallel forwarder for YouniumBridge.
    const yReqEvt  = "youniumBridgeReq";
    const yRespEvt = "youniumBridgeResp";
    const yShim = document.createElement("script");
    const yMethodList = Object.keys(target.YouniumBridge || {}).filter(
      (k) => typeof target.YouniumBridge[k] === "function",
    );
    const yProps = {
      version: target.YouniumBridge?.version,
      isAvailable: !!target.YouniumBridge?.isAvailable,
    };
    yShim.textContent = `
      (function () {
        if (window.YouniumBridge) return;
        const methods = ${JSON.stringify(yMethodList)};
        const props   = ${JSON.stringify(yProps)};
        const reqEvt  = ${JSON.stringify(yReqEvt)};
        const respEvt = ${JSON.stringify(yRespEvt)};
        const pending = new Map();
        let seq = 0;
        window.addEventListener(respEvt, (e) => {
          const d = e.detail || {};
          const p = pending.get(d.id);
          if (!p) return;
          pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error));
          else p.resolve(d.value);
        });
        const bridge = { ...props };
        for (const m of methods) {
          bridge[m] = function (...args) {
            return new Promise((resolve, reject) => {
              const id = ++seq;
              pending.set(id, { resolve, reject });
              window.dispatchEvent(new CustomEvent(reqEvt, { detail: { id, method: m, args } }));
            });
          };
        }
        window.YouniumBridge = bridge;
      })();
    `;
    (document.head || document.documentElement).appendChild(yShim);
    yShim.remove();

    target.addEventListener(yReqEvt, async (e) => {
      const { id, method, args } = e.detail || {};
      try {
        const fn = target.YouniumBridge[method];
        const value = typeof fn === "function" ? await fn.apply(target.YouniumBridge, args || []) : null;
        target.dispatchEvent(new CustomEvent(yRespEvt, { detail: { id, value } }));
      } catch (err) {
        target.dispatchEvent(new CustomEvent(yRespEvt, { detail: { id, error: String(err?.message ?? err) } }));
      }
    });
  });
})();
