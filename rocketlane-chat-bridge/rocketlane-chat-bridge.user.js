// ==UserScript==
// @name         Rocketlane Chat Bridge
// @namespace    https://kiona.rocketlane.com/
// @version      1.7.0
// @description  Bridges Rocketlane chat API to the local Project Progress Tracker, bypassing CORS.
// @author       Thomas
// @homepageURL  https://github.com/Hapnes-dev/Project-Progress-Tracker
// @supportURL   https://github.com/Hapnes-dev/Project-Progress-Tracker/issues
// @updateURL    https://raw.githubusercontent.com/hapnes-dev/tampermonkey-scripts/main/rocketlane-chat-bridge/rocketlane-chat-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/hapnes-dev/tampermonkey-scripts/main/rocketlane-chat-bridge/rocketlane-chat-bridge.user.js
// @match        https://kiona.rocketlane.com/*
// @match        file:///*
// @match        https://hapnes-dev.github.io/Project-Progress-Tracker/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      kiona.api.rocketlane.com
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
  // Side B — On a file:// page (the tracker): expose window.RocketlaneBridge.
  // ──────────────────────────────────────────────────────────────────────────
  const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  // Don't double-install if the script ran on a frame or got injected twice.
  if (target.RocketlaneBridge) return;

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
   * @param {{publicVisibility?: boolean}} [opts]
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
      const publicVisibility = !!(opts && opts.publicVisibility !== false);
      const requestPayload = {
        attachment: {
          name: fileName,
          publicVisibility: publicVisibility,
          projectId: Number(projectId),
        },
      };
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
          try {
            const j = JSON.parse(res.responseText || "{}");
            const att = j?.attachment ?? j?.data?.attachment ?? j;
            if (!att?.attachmentId) {
              reject(new Error("Upload succeeded but no attachmentId in response"));
              return;
            }
            resolve(att);
          } catch (e) {
            reject(new Error("Could not parse upload response: " + e.message));
          }
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

  // Notify the tracker page in case it's listening
  try {
    target.dispatchEvent(new CustomEvent("rocketlane-bridge-ready"));
  } catch (_) {}
})();
