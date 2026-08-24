/* ============================================================================
 * config.js — Backend configuration.
 *
 * The URL and publishable key below are meant to ship in client code: the key
 * only identifies the project, and every table is protected by Postgres
 * row-level security, so a signed-in person can read and write their own rows
 * and nothing else. It is NOT a secret and grants no access on its own.
 *
 * Set `url` to "" to build a purely local, account-free version of the app.
 * ==========================================================================*/
(function (App) {
  "use strict";

  App.config = {
    supabase: {
      url: "https://rhdtwvdcwlmaptdutelx.supabase.co",
      publishableKey: "sb_publishable_zmi1YyO8v8qJQCCxwTKL5g_uC265Eiw"
    },
    // Where a confirmation link should send people back to. Overridden at
    // runtime with the current origin so it works on any deployment.
    redirectTo: null
  };
})(window.App = window.App || {});
