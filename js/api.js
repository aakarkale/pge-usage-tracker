/* ============================================================================
 * api.js — Auth + data access, spoken directly to Supabase over REST.
 *
 * No SDK and no build step: GoTrue for auth, PostgREST for data, both plain
 * fetch. That keeps the app a static site you can open from a file, and keeps
 * the dependency count at zero like the rest of the codebase.
 *
 * The session (access + refresh token) lives in localStorage. Access tokens are
 * short-lived, so every request refreshes proactively when the token is close
 * to expiry and retries once on a 401.
 *
 * Every table is guarded by row-level security server-side; the filters here
 * are for correctness and payload size, never for access control.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var SESSION_KEY = "wattwise.session.v1";
  var cfg = (App.config && App.config.supabase) || {};
  var BASE = cfg.url || "";
  var KEY = cfg.publishableKey || "";

  var session = null;      // { access_token, refresh_token, expires_at, user }
  var refreshing = null;   // in-flight refresh, so parallel calls share one

  function configured() { return !!(BASE && KEY); }

  /* ---- session persistence --------------------------------------------- */

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) { session = null; }
    return session;
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }
  function currentUser() { return session && session.user ? session.user : null; }
  function signedIn() { return !!(session && session.access_token); }

  function storeAuthResponse(d) {
    if (!d || !d.access_token) return null;
    var s = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      // expires_in is seconds; keep an absolute ms deadline.
      expires_at: Date.now() + ((d.expires_in || 3600) * 1000),
      user: d.user || null
    };
    saveSession(s);
    return s;
  }

  /* ---- low-level fetch --------------------------------------------------- */

  function friendlyNetworkError(e) {
    var msg = (e && e.message) || "";
    if (/failed to fetch|networkerror|load failed|abort|timeout/i.test(msg) || e instanceof TypeError) {
      return "Can't reach the server — check your connection and try again.";
    }
    return msg || "Something went wrong.";
  }

  /* Only a server-side rejection means the stored credential is actually dead.
     A network failure, the abort timeout, 429 or 5xx all leave the refresh
     token perfectly valid — wiping it there logs people out for a blip. */
  function isAuthRejection(e) {
    return !!(e && (e.status === 400 || e.status === 401 || e.status === 403));
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = { apikey: KEY };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];
    if (opts.auth !== false) {
      headers.Authorization = "Bearer " + ((session && session.access_token) || KEY);
    }
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, opts.timeout || 20000);
    return fetch(BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal
    }).then(function (r) {
      return r.text().then(function (text) {
        clearTimeout(to);
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
        if (!r.ok) {
          var err = new Error(
            (data && (data.msg || data.message || data.error_description || data.error)) ||
            ("Request failed (" + r.status + ")")
          );
          err.status = r.status;
          err.code = data && (data.error_code || data.code);
          throw err;
        }
        return data;
      });
    }).catch(function (e) {
      clearTimeout(to);
      if (e && e.status) throw e;
      throw new Error(friendlyNetworkError(e));
    });
  }

  /* ---- token refresh ----------------------------------------------------- */

  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.reject(new Error("Not signed in."));
    if (refreshing) return refreshing;
    refreshing = request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", auth: false,
      headers: { Authorization: "Bearer " + KEY },
      body: { refresh_token: session.refresh_token }
    }).then(function (d) {
      refreshing = null;
      var s = storeAuthResponse(d);
      if (!s) throw new Error("Could not refresh the session.");
      return s;
    }).catch(function (e) {
      refreshing = null;
      if (isAuthRejection(e)) saveSession(null);   // genuinely dead — sign in again
      throw e;                                     // transient — keep the token
    });
    return refreshing;
  }

  /* Any authenticated call goes through here: refresh early, retry once on 401. */
  function authed(path, opts) {
    if (!signedIn()) return Promise.reject(new Error("Not signed in."));
    var soon = session.expires_at && (session.expires_at - Date.now() < 60000);
    var start = soon ? refreshSession() : Promise.resolve();
    return start.then(function () {
      return request(path, opts);
    }).catch(function (e) {
      if (e && e.status === 401 && session && session.refresh_token) {
        return refreshSession().then(function () { return request(path, opts); });
      }
      throw e;
    });
  }

  /* ---- auth -------------------------------------------------------------- */

  function signUp(email, password, displayName) {
    var redirect = (App.config && App.config.redirectTo) ||
      (location.origin && location.origin !== "null" ? location.origin + location.pathname : null);
    var body = { email: email, password: password, data: { display_name: displayName || "" } };
    var q = redirect ? "?redirect_to=" + encodeURIComponent(redirect) : "";
    return request("/auth/v1/signup" + q, { method: "POST", auth: false, body: body })
      .then(function (d) {
        // With email confirmation enabled the response carries a user but no
        // token; the caller shows a "check your inbox" state instead.
        var s = storeAuthResponse(d);
        return { session: s, needsConfirmation: !s, user: d && (d.user || d) };
      });
  }

  function signIn(email, password) {
    return request("/auth/v1/token?grant_type=password", {
      method: "POST", auth: false, body: { email: email, password: password }
    }).then(function (d) {
      var s = storeAuthResponse(d);
      if (!s) throw new Error("Sign-in failed.");
      return s;
    });
  }

  function signOut() {
    var had = signedIn();
    // Clear locally FIRST: on a shared machine, sign-out must be immediate and
    // must not depend on the network being reachable.
    var token = session && session.access_token;
    saveSession(null);
    if (!had) return Promise.resolve();
    return request("/auth/v1/logout", {
      method: "POST", auth: false, timeout: 5000,
      headers: { Authorization: "Bearer " + token }
    }).catch(function () { /* best effort — already signed out locally */ });
  }

  /* Confirm the stored session still works, and refresh the cached user. */
  function restore() {
    if (!configured() || !loadSession()) return Promise.resolve(null);
    return authed("/auth/v1/user", {}).then(function (u) {
      if (u && u.id) { session.user = u; saveSession(session); }
      return session;
    }).catch(function (e) {
      // Opening the app offline must not sign you out.
      if (isAuthRejection(e)) { saveSession(null); return null; }
      return session;
    });
  }

  function resetPassword(email) {
    var redirect = (App.config && App.config.redirectTo) ||
      (location.origin && location.origin !== "null" ? location.origin + location.pathname : null);
    return request("/auth/v1/recover", {
      method: "POST", auth: false,
      body: redirect ? { email: email, redirect_to: redirect } : { email: email }
    });
  }

  /* ---- data (PostgREST) -------------------------------------------------- */

  function qs(params) {
    var parts = [];
    for (var k in params) {
      if (params[k] !== undefined && params[k] !== null) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  function uid() {
    var u = currentUser();
    return u && u.id;
  }

  /* -- profile -- */
  function getProfile() {
    return authed("/rest/v1/profiles" + qs({ select: "*", id: "eq." + uid(), limit: 1 }), {})
      .then(function (rows) { return (rows && rows[0]) || null; });
  }

  function upsertProfile(patch) {
    var row = {};
    for (var k in patch) row[k] = patch[k];
    row.id = uid();
    row.updated_at = new Date().toISOString();
    return authed("/rest/v1/profiles" + qs({ on_conflict: "id" }), {
      method: "POST", body: row,
      headers: { Prefer: "resolution=merge-duplicates,return=representation" }
    }).then(function (rows) { return (rows && rows[0]) || null; });
  }

  /* -- uploads -- */
  function listUploads() {
    return authed("/rest/v1/uploads" + qs({
      select: "id,file_name,fuel,unit,granularity,period_start,period_end,row_count,total_usage,total_cost,billing_start,billing_end,created_at",
      user_id: "eq." + uid(), order: "created_at.desc"
    }), {});
  }

  function getUpload(id) {
    return authed("/rest/v1/uploads" + qs({ select: "*", id: "eq." + id, limit: 1 }), {})
      .then(function (rows) { return (rows && rows[0]) || null; });
  }

  function createUpload(row) {
    row.user_id = uid();
    return authed("/rest/v1/uploads", {
      method: "POST", body: row, headers: { Prefer: "return=representation" }
    }).then(function (rows) { return (rows && rows[0]) || null; });
  }

  function updateUpload(id, patch) {
    return authed("/rest/v1/uploads" + qs({ id: "eq." + id }), {
      method: "PATCH", body: patch, headers: { Prefer: "return=representation" }
    }).then(function (rows) { return (rows && rows[0]) || null; });
  }

  function deleteUpload(id) {
    return authed("/rest/v1/uploads" + qs({ id: "eq." + id }), { method: "DELETE" });
  }

  /* -- annotations -- */
  function listAnnotations(uploadId) {
    return authed("/rest/v1/annotations" + qs({
      select: "date_key,away,cause", upload_id: "eq." + uploadId
    }), {});
  }

  function saveAnnotation(uploadId, dateKey, patch) {
    var row = {
      user_id: uid(), upload_id: uploadId, date_key: dateKey,
      away: !!patch.away, cause: patch.cause || null,
      updated_at: new Date().toISOString()
    };
    return authed("/rest/v1/annotations" + qs({ on_conflict: "upload_id,date_key" }), {
      method: "POST", body: row,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" }
    });
  }

  /* -- answers -- */
  function listAnswers() {
    return authed("/rest/v1/answers" + qs({
      select: "fuel,question_id,value", user_id: "eq." + uid()
    }), {});
  }

  function saveAnswer(fuel, questionId, value) {
    var row = {
      user_id: uid(), fuel: fuel, question_id: questionId,
      value: value === undefined ? null : value,
      updated_at: new Date().toISOString()
    };
    return authed("/rest/v1/answers" + qs({ on_conflict: "user_id,fuel,question_id" }), {
      method: "POST", body: row,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" }
    });
  }

  App.api = {
    configured: configured,
    loadSession: loadSession,
    signedIn: signedIn,
    currentUser: currentUser,
    restore: restore,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    resetPassword: resetPassword,
    getProfile: getProfile,
    upsertProfile: upsertProfile,
    listUploads: listUploads,
    getUpload: getUpload,
    createUpload: createUpload,
    updateUpload: updateUpload,
    deleteUpload: deleteUpload,
    listAnnotations: listAnnotations,
    saveAnnotation: saveAnnotation,
    listAnswers: listAnswers,
    saveAnswer: saveAnswer
  };
})(window.App = window.App || {});
