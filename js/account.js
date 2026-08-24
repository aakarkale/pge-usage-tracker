/* ============================================================================
 * account.js — Accounts, onboarding, and the saved-uploads library.
 *
 * The onboarding flow is deliberately short — four steps, each asking only for
 * something the analysis actually uses:
 *
 *   1. Account   — sign up, sign in, or explore without an account.
 *   2. Your home — ZIP (asked ONCE, here) plus the handful of facts that
 *                  sharpen the recommendations.
 *   3. Upload    — the CSV.
 *   4. Billing   — the cycle dates for that file (confirmed on EVERY upload,
 *                  since a new export usually covers a new period).
 *
 * Guest mode is a first-class path: everything works without an account, backed
 * by localStorage, and signing up later keeps the app behaving identically.
 * App.store hides which of the two is in play from the rest of the app.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var api = App.api;

  /* ---- state ------------------------------------------------------------ */

  var Acct = {
    mode: "guest",        // "guest" | "user"
    profile: null,        // server profile row (or the local stand-in)
    uploads: [],          // saved upload summaries
    currentUploadId: null,
    step: null,
    busy: false,
    pendingFiles: null,   // files captured during onboarding step 3
    error: ""
  };

  var LOCAL_PROFILE_KEY = "wattwise.localProfile.v1";
  var LOCAL_UPLOADS_KEY = "wattwise.localUploads.v1";

  function el(id) { return document.getElementById(id); }
  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---- local (guest) persistence ---------------------------------------- */

  function localGet(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function localSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ---- store: one interface, two backends ------------------------------- */

  var store = {
    isUser: function () { return Acct.mode === "user"; },

    getProfile: function () {
      if (store.isUser()) return api.getProfile();
      return Promise.resolve(localGet(LOCAL_PROFILE_KEY, null));
    },

    saveProfile: function (patch) {
      if (store.isUser()) {
        return api.upsertProfile(patch).then(function (p) { Acct.profile = p; return p; });
      }
      var cur = localGet(LOCAL_PROFILE_KEY, {}) || {};
      for (var k in patch) cur[k] = patch[k];
      localSet(LOCAL_PROFILE_KEY, cur);
      Acct.profile = cur;
      return Promise.resolve(cur);
    },

    listUploads: function () {
      if (store.isUser()) return api.listUploads();
      return Promise.resolve(localGet(LOCAL_UPLOADS_KEY, []) || []);
    },

    getUpload: function (id) {
      if (store.isUser()) return api.getUpload(id);
      var all = localGet(LOCAL_UPLOADS_KEY, []) || [];
      for (var i = 0; i < all.length; i++) if (all[i].id === id) return Promise.resolve(all[i]);
      return Promise.resolve(null);
    },

    createUpload: function (row) {
      if (store.isUser()) return api.createUpload(row);
      var all = localGet(LOCAL_UPLOADS_KEY, []) || [];
      row.id = "local-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
      row.created_at = new Date().toISOString();
      all.unshift(row);
      // Guest storage is a browser quota, not a database — keep it bounded.
      while (all.length > 12) all.pop();
      localSet(LOCAL_UPLOADS_KEY, all);
      return Promise.resolve(row);
    },

    updateUpload: function (id, patch) {
      if (store.isUser()) return api.updateUpload(id, patch);
      var all = localGet(LOCAL_UPLOADS_KEY, []) || [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) { for (var k in patch) all[i][k] = patch[k]; localSet(LOCAL_UPLOADS_KEY, all); return Promise.resolve(all[i]); }
      }
      return Promise.resolve(null);
    },

    deleteUpload: function (id) {
      if (store.isUser()) return api.deleteUpload(id);
      var all = (localGet(LOCAL_UPLOADS_KEY, []) || []).filter(function (u) { return u.id !== id; });
      localSet(LOCAL_UPLOADS_KEY, all);
      return Promise.resolve();
    },

    saveAnnotation: function (uploadId, dateKey, patch) {
      if (store.isUser() && uploadId && String(uploadId).indexOf("local-") !== 0) {
        return api.saveAnnotation(uploadId, dateKey, patch).catch(function () {});
      }
      return Promise.resolve();
    },

    listAnnotations: function (uploadId) {
      if (store.isUser() && uploadId && String(uploadId).indexOf("local-") !== 0) {
        return api.listAnnotations(uploadId).catch(function () { return []; });
      }
      return Promise.resolve([]);
    },

    saveAnswer: function (fuel, questionId, value) {
      if (store.isUser()) return api.saveAnswer(fuel, questionId, value).catch(function () {});
      return Promise.resolve();
    },

    listAnswers: function () {
      if (store.isUser()) return api.listAnswers().catch(function () { return []; });
      return Promise.resolve([]);
    }
  };

  /* ---- onboarding step machine ------------------------------------------ */

  var STEP_LABELS = ["Account", "Your home", "Upload", "Billing"];

  function show(step) {
    Acct.step = step;
    Acct.error = "";
    render();
    el("onboard").hidden = false;
  }
  function hide() { el("onboard").hidden = true; }

  function setError(msg) {
    Acct.error = msg || "";
    var e = el("ob-error");
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  /* Disabling a button is not feedback. While a request is in flight the
     primary action says what is happening, and restores its own label after —
     a slow network otherwise looks like a dead button. */
  function setBusy(b, pendingLabel) {
    Acct.busy = b;
    var actions = el("ob-actions");
    if (!actions) return;
    actions.querySelectorAll("button").forEach(function (btn) { btn.disabled = b; });
    var primary = actions.querySelector(".btn-primary");
    if (!primary) return;
    if (b) {
      if (primary.dataset.idleLabel == null) primary.dataset.idleLabel = primary.textContent;
      primary.textContent = pendingLabel || "Working…";
      primary.classList.add("is-busy");
    } else if (primary.dataset.idleLabel != null) {
      primary.textContent = primary.dataset.idleLabel;
      delete primary.dataset.idleLabel;
      primary.classList.remove("is-busy");
    }
  }

  function stepIndex() {
    return { account: 0, home: 1, upload: 2, billing: 3 }[Acct.step];
  }

  function renderSteps() {
    var idx = stepIndex();
    var box = el("ob-steps");
    if (idx == null) { box.innerHTML = ""; return; }
    box.innerHTML = STEP_LABELS.map(function (label, i) {
      var cls = i < idx ? "done" : (i === idx ? "active" : "");
      return "<span class='ob-step " + cls + "'><i></i>" + label + "</span>";
    }).join("");
  }

  /* ---- step renderers ---------------------------------------------------- */

  function renderAccountStep() {
    var canAuth = api.configured();
    el("ob-title").textContent = "Welcome to Wattwise";
    el("ob-lede").textContent = canAuth
      ? "Create an account to keep every upload, or explore first and sign up later."
      : "Accounts aren't configured for this deployment — your data is saved in this browser instead.";

    el("ob-body").innerHTML = canAuth
      ? "<div class='ob-tabs'>" +
          "<button class='ob-tab active' data-authmode='signup'>Create account</button>" +
          "<button class='ob-tab' data-authmode='signin'>Sign in</button>" +
        "</div>" +
        "<div class='ob-fields'>" +
          "<label class='field ob-name'><span class='field-label'>Your name</span>" +
            "<input id='ob-name' class='input' type='text' autocomplete='name' placeholder='Alex' /></label>" +
          "<label class='field'><span class='field-label'>Email</span>" +
            "<input id='ob-email' class='input' type='email' autocomplete='email' placeholder='you@example.com' /></label>" +
          "<label class='field'><span class='field-label'>Password</span>" +
            "<input id='ob-pass' class='input' type='password' autocomplete='new-password' placeholder='At least 8 characters' /></label>" +
        "</div>" +
        "<div class='ob-privacy'>🔒 Your usage data is stored in your own private account and is only ever visible to you.</div>"
      : "<div class='ob-privacy'>🔒 Everything stays in this browser.</div>";

    el("ob-actions").innerHTML = canAuth
      ? "<button class='btn btn-ghost' data-act='guest'>Explore without an account</button>" +
        "<button class='btn btn-primary' data-act='auth'>Create account</button>"
      : "<button class='btn btn-primary' data-act='guest'>Get started</button>";

    var authMode = "signup";
    el("ob-body").querySelectorAll("[data-authmode]").forEach(function (t) {
      t.onclick = function () {
        authMode = t.dataset.authmode;
        el("ob-body").querySelectorAll(".ob-tab").forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        el("ob-body").querySelector(".ob-name").style.display = authMode === "signup" ? "" : "none";
        el("ob-pass").setAttribute("autocomplete", authMode === "signup" ? "new-password" : "current-password");
        var btn = el("ob-actions").querySelector("[data-act='auth']");
        if (btn) btn.textContent = authMode === "signup" ? "Create account" : "Sign in";
        setError("");
      };
    });

    wireActions({
      guest: function () {
        Acct.mode = "guest";
        store.getProfile().then(function (p) {
          Acct.profile = p || {};
          show(p && p.zip ? "upload" : "home");
        });
      },
      auth: function () {
        var email = (el("ob-email").value || "").trim();
        var pass = el("ob-pass").value || "";
        var name = (el("ob-name") && el("ob-name").value || "").trim();
        if (!email || !pass) { setError("Enter your email and password to continue."); return; }
        if (authMode === "signup" && pass.length < 8) {
          setError("Use at least 8 characters for your password."); return;
        }
        setBusy(true, authMode === "signup" ? "Creating account…" : "Signing in…");
        setError("");
        var p = authMode === "signup" ? api.signUp(email, pass, name) : api.signIn(email, pass);
        p.then(function (res) {
          setBusy(false);
          if (authMode === "signup" && res && res.needsConfirmation) {
            renderConfirmNotice(email);
            return;
          }
          afterSignIn();
        }).catch(function (e) {
          setBusy(false);
          setError(friendlyAuthError(e, authMode));
        });
      }
    });
  }

  function friendlyAuthError(e, mode) {
    var msg = (e && e.message) || "";
    if (/invalid login credentials/i.test(msg)) return "That email and password don't match an account.";
    if (/already registered|already been registered/i.test(msg)) return "That email already has an account — switch to Sign in.";
    if (/email address .* is invalid|email_address_invalid/i.test(msg)) return "That email address isn't accepted. Try another.";
    if (/password/i.test(msg) && /length|short|6|8/i.test(msg)) return "That password is too short.";
    if (/not confirmed|email not confirmed/i.test(msg)) return "Confirm your email first — check your inbox for the link.";
    if (/reach the server/i.test(msg)) return msg;
    return msg || (mode === "signup" ? "Could not create the account." : "Could not sign in.");
  }

  function renderConfirmNotice(email) {
    el("ob-title").textContent = "Confirm your email";
    el("ob-lede").textContent = "";
    el("ob-body").innerHTML =
      "<div class='ob-notice'>We sent a confirmation link to <b>" + esc(email) + "</b>. " +
      "Click it, then come back and sign in.</div>" +
      "<div class='ob-privacy'>You can keep exploring in the meantime — nothing is lost.</div>";
    el("ob-actions").innerHTML =
      "<button class='btn btn-ghost' data-act='guest'>Explore meanwhile</button>" +
      "<button class='btn btn-primary' data-act='back'>Back to sign in</button>";
    wireActions({
      guest: function () {
        Acct.mode = "guest";
        store.getProfile().then(function (p) { Acct.profile = p || {}; show(p && p.zip ? "upload" : "home"); });
      },
      back: function () { show("account"); }
    });
  }

  var HOME_FIELDS = [
    { key: "ac_type", label: "Air conditioning", type: "select",
      options: [["", "Select…"], ["central", "Central AC"], ["heatpump", "Heat pump"],
                ["window", "Window / portable"], ["none", "No AC"]] },
    { key: "occupancy", label: "Typical weekday", type: "select",
      options: [["", "Select…"], ["home", "Someone home all day"], ["away", "Away 9–5"], ["varies", "Varies"]] },
    { key: "home_type", label: "Home type", type: "select",
      options: [["", "Select…"], ["house", "House"], ["townhouse", "Townhouse"],
                ["apartment", "Apartment / condo"]] }
  ];
  var HOME_CHECKS = [
    { key: "has_ev", label: "🚗 Electric vehicle" },
    { key: "has_pool", label: "🏊 Pool / spa pump" },
    { key: "has_electric_dryer", label: "🧺 Electric dryer" }
  ];

  function renderHomeStep() {
    var p = Acct.profile || {};
    el("ob-title").textContent = "Tell us about your home";
    el("ob-lede").textContent =
      "Your ZIP unlocks the local forecast and your AC schedule. The rest is optional — each answer makes the savings advice more specific.";
    el("ob-body").innerHTML =
      "<div class='ob-fields'>" +
        "<label class='field'><span class='field-label'>ZIP code</span>" +
          "<input id='ob-zip' class='input' type='text' inputmode='numeric' maxlength='5' " +
          "placeholder='95124' value='" + esc(p.zip || "") + "' /></label>" +
        HOME_FIELDS.map(function (f) {
          return "<label class='field'><span class='field-label'>" + f.label + "</span>" +
            "<select class='input' data-hk='" + f.key + "'>" +
            f.options.map(function (o) {
              return "<option value='" + o[0] + "'" + (p[f.key] === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
            }).join("") + "</select></label>";
        }).join("") +
      "</div>" +
      "<div class='ob-checks'>" +
        HOME_CHECKS.map(function (c) {
          return "<label class='ctx-check'><input type='checkbox' data-hk='" + c.key + "'" +
            (p[c.key] ? " checked" : "") + " /> <span>" + c.label + "</span></label>";
        }).join("") +
      "</div>";
    el("ob-actions").innerHTML =
      "<button class='btn btn-ghost' data-act='skip'>Skip for now</button>" +
      "<button class='btn btn-primary' data-act='save'>Continue</button>";

    function collect() {
      var patch = { zip: (el("ob-zip").value || "").trim() };
      el("ob-body").querySelectorAll("[data-hk]").forEach(function (n) {
        patch[n.dataset.hk] = n.type === "checkbox" ? n.checked : n.value;
      });
      return patch;
    }

    wireActions({
      skip: function () { show("upload"); },
      save: function () {
        var patch = collect();
        if (patch.zip && !/^\d{5}$/.test(patch.zip)) {
          setError("A ZIP code is five digits — or leave it blank and add it later."); return;
        }
        setBusy(true, "Saving…"); setError("");
        store.saveProfile(patch).then(function () {
          setBusy(false); show("upload");
        }).catch(function (e) {
          setBusy(false); setError((e && e.message) || "Could not save your details.");
        });
      }
    });
  }

  function renderUploadStep() {
    el("ob-title").textContent = "Add your PG&E usage file";
    el("ob-lede").textContent =
      "Download an interval CSV from pge.com (Energy Usage Details → Green Button), then drop it in. Electricity, gas, or both.";
    el("ob-body").innerHTML =
      "<div id='ob-drop' class='dropzone ob-drop' tabindex='0' role='button'>" +
        "<input id='ob-file' type='file' accept='.csv,text/csv' multiple hidden />" +
        "<div class='dropzone-text'><strong>Drop your CSV here</strong>" +
        "<span>or <u>browse</u> your files</span></div>" +
      "</div>" +
      "<div id='ob-filelist' class='ob-filelist'></div>";
    el("ob-actions").innerHTML =
      "<button class='btn btn-ghost' data-act='sample'>Use sample data instead</button>" +
      "<button class='btn btn-primary' data-act='next' disabled>Continue</button>";

    var dz = el("ob-drop"), fi = el("ob-file");
    function accept(files) {
      var list = Array.prototype.slice.call(files).filter(function (f) {
        return /\.csv$/i.test(f.name) || f.type === "text/csv";
      });
      if (!list.length) { setError("That doesn't look like a .csv file."); return; }
      setError("");
      Acct.pendingFiles = list;
      el("ob-filelist").innerHTML = list.map(function (f) {
        return "<div class='ob-file'>📄 " + esc(f.name) + "</div>";
      }).join("");
      var next = el("ob-actions").querySelector("[data-act='next']");
      if (next) next.disabled = false;
    }
    dz.onclick = function () { fi.click(); };
    dz.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    fi.onchange = function () { if (fi.files.length) accept(fi.files); };
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragging"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragging"); });
    });
    dz.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) accept(e.dataTransfer.files);
    });

    wireActions({
      sample: function () { hide(); App.onboardingDone({ sample: true }); },
      next: function () {
        if (!Acct.pendingFiles) { setError("Choose a CSV file first."); return; }
        hide();
        App.onboardingDone({ files: Acct.pendingFiles });
        Acct.pendingFiles = null;
      }
    });
  }

  function wireActions(handlers) {
    el("ob-actions").querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        if (Acct.busy) return;
        var fn = handlers[b.dataset.act];
        if (fn) fn();
      };
    });
  }

  function render() {
    renderSteps();
    setError(Acct.error);
    if (Acct.step === "account") renderAccountStep();
    else if (Acct.step === "home") renderHomeStep();
    else if (Acct.step === "upload") renderUploadStep();
    el("ob-close").hidden = !(Acct.step === "home" && Acct.profile && Acct.profile.zip);
  }

  /* ---- post-auth ---------------------------------------------------------- */

  function afterSignIn() {
    Acct.mode = "user";
    return store.getProfile().then(function (p) {
      Acct.profile = p || {};
      renderAccountMenu();
      return store.listUploads().then(function (ups) {
        Acct.uploads = ups || [];
        if (!Acct.profile.zip) { show("home"); return; }
        if (!Acct.uploads.length) { show("upload"); return; }
        hide();
        App.onboardingDone({ resumeLatest: true });
      });
    }).catch(function (e) {
      setError((e && e.message) || "Signed in, but couldn't load your account.");
    });
  }

  /* ---- account menu ------------------------------------------------------- */

  function renderAccountMenu() {
    var menu = el("account-menu");
    if (!menu) return;
    var user = api.currentUser && api.currentUser();
    if (Acct.mode === "user" && user) {
      var name = (Acct.profile && Acct.profile.display_name) || (user.email || "").split("@")[0];
      menu.hidden = false;
      el("account-label").textContent = name || "Account";
      el("account-avatar").textContent = (name || "?").charAt(0).toUpperCase();
      el("account-email").textContent = user.email || "";
      el("btn-signout").hidden = false;
    } else {
      menu.hidden = false;
      el("account-label").textContent = "Guest";
      el("account-avatar").textContent = "G";
      el("account-email").textContent = "Saved in this browser only";
      el("btn-signout").textContent = api.configured() ? "Create an account" : "";
      el("btn-signout").hidden = !api.configured();
    }
  }

  function wireAccountMenu() {
    var btn = el("btn-account"), dd = el("account-dropdown");
    if (!btn) return;
    btn.onclick = function (e) {
      e.stopPropagation();
      dd.hidden = !dd.hidden;
      btn.setAttribute("aria-expanded", String(!dd.hidden));
    };
    document.addEventListener("click", function () {
      if (dd && !dd.hidden) { dd.hidden = true; btn.setAttribute("aria-expanded", "false"); }
    });
    el("btn-edit-home").onclick = function () {
      dd.hidden = true;
      store.getProfile().then(function (p) { Acct.profile = p || {}; show("home"); });
    };
    el("btn-signout").onclick = function () {
      dd.hidden = true;
      if (Acct.mode !== "user") { show("account"); return; }
      api.signOut().then(function () {
        Acct.mode = "guest"; Acct.profile = null; Acct.uploads = []; Acct.currentUploadId = null;
        location.reload();
      });
    };
    el("ob-close").onclick = function () { hide(); };
  }

  /* ---- boot --------------------------------------------------------------- */

  function boot() {
    wireAccountMenu();
    if (App.config && !App.config.redirectTo && location.origin && location.origin !== "null") {
      App.config.redirectTo = location.origin + location.pathname;
    }
    if (!api.configured()) {
      Acct.mode = "guest";
      renderAccountMenu();
      return store.getProfile().then(function (p) {
        Acct.profile = p || {};
        return store.listUploads().then(function (ups) {
          Acct.uploads = ups || [];
          return { signedIn: false, profile: Acct.profile, uploads: Acct.uploads };
        });
      });
    }
    return api.restore().then(function (s) {
      if (s && api.signedIn()) {
        Acct.mode = "user";
        return store.getProfile().then(function (p) {
          Acct.profile = p || {};
          renderAccountMenu();
          return store.listUploads().then(function (ups) {
            Acct.uploads = ups || [];
            return { signedIn: true, uploads: Acct.uploads, profile: Acct.profile };
          });
        });
      }
      Acct.mode = "guest";
      renderAccountMenu();
      return store.getProfile().then(function (p) {
        Acct.profile = p || {};
        return store.listUploads().then(function (ups) {
          Acct.uploads = ups || [];
          return { signedIn: false, profile: Acct.profile, uploads: Acct.uploads };
        });
      });
    }).catch(function () {
      Acct.mode = "guest";
      renderAccountMenu();
      return { signedIn: false };
    });
  }

  App.account = {
    state: Acct,
    store: store,
    boot: boot,
    show: show,
    hide: hide,
    renderAccountMenu: renderAccountMenu,
    esc: esc
  };
})(window.App = window.App || {});
