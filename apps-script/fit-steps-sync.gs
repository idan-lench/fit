/**
 * Google Fit auto-sync — ADD this to your existing Fit-tracker webhook Apps Script.
 *
 * It runs server-side on an hourly trigger (no browser, no expiring token), pulls
 * the last few days of step counts from Google Fit, and writes them to
 * `fit-steps.json` in your Fit Drive folder. The app reads that file via
 * `?steps=1` and merges today's steps in automatically on open / every 30 min.
 *
 * ── ONE-TIME SETUP ──────────────────────────────────────────────────────────
 * 1. Paste the functions below into your webhook script (alongside doGet/doPost).
 * 2. Add the Fit read scope so ScriptApp.getOAuthToken() can read Fit:
 *    Project Settings → "Show appsscript.json" → add to "oauthScopes":
 *        "https://www.googleapis.com/auth/fitness.activity.read"
 *    (keep your existing scopes too).
 * 3. In your doGet(e), add the `?steps=1` branch shown in DOGET_SNIPPET below,
 *    right after you validate the secret.
 * 4. Run `setupFitTrigger` once (authorize when prompted) — this both creates the
 *    hourly trigger and does a first sync so fit-steps.json exists immediately.
 *
 * Re-deploy is NOT needed for the trigger; it IS needed if you changed doGet
 * (Deploy → Manage deployments → Edit → New version).
 */

var FIT_STEPS_FILE = 'fit-steps.json';
var FIT_SYNC_DAYS = 3; // today + 2 prior days (catches late-arriving Fit data)

/** Hourly trigger target: fetch recent steps and write fit-steps.json. */
function syncFitSteps() {
  var token = ScriptApp.getOAuthToken();
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var days = [];

  for (var i = 0; i < FIT_SYNC_DAYS; i++) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    var start = d.getTime();
    var end = start + 24 * 60 * 60 * 1000 - 1;

    var resp = UrlFetchApp.fetch(
      'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          aggregateBy: [{
            dataTypeName: 'com.google.step_count.delta',
            dataSourceId: 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps'
          }],
          bucketByTime: { durationMillis: 86400000 },
          startTimeMillis: start,
          endTimeMillis: end
        })
      });
    if (resp.getResponseCode() !== 200) continue;

    var buckets = (JSON.parse(resp.getContentText()).bucket) || [];
    var count = 0;
    buckets.forEach(function (b) {
      (b.dataset || []).forEach(function (ds) {
        (ds.point || []).forEach(function (p) {
          (p.value || []).forEach(function (v) { count += v.intVal || 0; });
        });
      });
    });
    days.push({ date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), count: count });
  }

  var body = JSON.stringify({ ok: true, steps: days, updatedAt: new Date().toISOString() });
  var folder = DriveApp.getFolderById(FIT_FOLDER_ID); // FIT_FOLDER_ID defined in your main script
  var existing = folder.getFilesByName(FIT_STEPS_FILE);
  if (existing.hasNext()) existing.next().setContent(body);
  else folder.createFile(FIT_STEPS_FILE, body, 'application/json');
}

/** Run once: create the hourly trigger (idempotent) and do a first sync. */
function setupFitTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncFitSteps') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('syncFitSteps').timeBased().everyHours(1).create();
  syncFitSteps();
}

/**
 * DOGET_SNIPPET — paste inside your existing doGet(e), after the secret check:
 *
 *   if (e.parameter.steps) {
 *     var f = DriveApp.getFolderById(FIT_FOLDER_ID).getFilesByName(FIT_STEPS_FILE);
 *     var out = f.hasNext() ? f.next().getBlob().getDataAsString()
 *                           : JSON.stringify({ ok: true, steps: [] });
 *     return ContentService.createTextOutput(out)
 *       .setMimeType(ContentService.MimeType.JSON);
 *   }
 */
