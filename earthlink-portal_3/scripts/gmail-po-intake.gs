// Earth Link Field Office — Gmail PO intake
// ------------------------------------------------------------------
// Runs INSIDE your Google account (script.google.com), every 10 minutes.
// Finds emails with PDF attachments, sends each PDF to the site, and labels
// the thread "EarthLink-Imported" so it is never sent twice. The site
// decides what each PDF is: a partner PO becomes a job (with its date on
// the schedule, or under "Need to schedule"); anything else is skipped.
//
// Setup (once): paste this file, fill SITE and KEY, run "setup" once.
// Not working? Run "testNow" and read the log (View → Logs / Executions).
// ------------------------------------------------------------------

var SITE = "https://www.earthlink-gc.com";   // the portal's address, no slash at the end
var KEY = "PASTE-THE-PO_INTAKE_KEY-HERE";     // same value as PO_INTAKE_KEY in Vercel

// Only emails from these senders are looked at. EMPTY = every email that
// carries a PDF is looked at (safe: the site only makes jobs out of real POs
// and turns everything else away). Add names only to cut down the noise.
var SENDERS = [];

var LABEL = "EarthLink-Imported";

// Only emails that arrive from the day "setup" is run onward are looked at —
// older POs are already handled by hand and must not come in again.
function sinceDay() {
  var p = PropertiesService.getScriptProperties();
  var d = p.getProperty("SINCE");
  if (!d) { d = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd"); p.setProperty("SINCE", d); }
  return d;
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("checkInbox").timeBased().everyMinutes(10).create();
  PropertiesService.getScriptProperties().setProperty("SINCE", Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd"));
  Logger.log("Timer set: the inbox is checked every 10 minutes, for emails from " + sinceDay() + " onward.");
  testNow();
}

// Says, in plain words, why POs are or aren't coming through.
function testNow() {
  // 1) can the site be reached, and is the intake switched on?
  try {
    var g = UrlFetchApp.fetch(SITE + "/api/inbound-po", { muteHttpExceptions: true, followRedirects: false });
    var code = g.getResponseCode();
    if (code === 301 || code === 302 || code === 307 || code === 308) {
      Logger.log("PROBLEM: " + SITE + " redirects to " + g.getHeaders()["Location"] + " — set SITE to that address (without the /api/... part).");
      return;
    }
    Logger.log("Site answered " + code + ": " + g.getContentText().slice(0, 200));
    if (code !== 200) { Logger.log("PROBLEM: the site is not answering the intake address."); return; }
    var cfg = JSON.parse(g.getContentText());
    if (!cfg.configured) { Logger.log("PROBLEM: the intake is OFF on the site. In Vercel add PO_INTAKE_KEY and SUPABASE_SERVICE_ROLE_KEY, then Redeploy."); return; }
  } catch (e) { Logger.log("PROBLEM: couldn't reach the site at all: " + e); return; }
  // 2) does the key match?
  var k = UrlFetchApp.fetch(SITE + "/api/inbound-po", { method: "post", contentType: "application/json", headers: { "x-intake-key": KEY }, payload: JSON.stringify({ attachments: [] }), muteHttpExceptions: true });
  if (k.getResponseCode() === 401) { Logger.log("PROBLEM: the KEY in this script doesn't match PO_INTAKE_KEY in Vercel."); return; }
  Logger.log("Key accepted (" + k.getResponseCode() + ").");
  // 3) what's in the inbox?
  var q = query();
  var threads = GmailApp.search(q, 0, 25);
  Logger.log("Gmail search [" + q + "] → " + threads.length + " thread(s) not yet imported.");
  threads.forEach(function (th) {
    th.getMessages().forEach(function (m) {
      var pdfs = m.getAttachments({ includeInlineImages: false, includeAttachments: true }).filter(function (a) { return /\.pdf$/i.test(a.getName()); });
      Logger.log("  • " + m.getDate().toDateString() + " | from: " + m.getFrom() + " | " + m.getSubject() + " | PDFs: " + pdfs.map(function (a) { return a.getName(); }).join(", ") + (senderOk(m) ? "" : "  (skipped: sender not in SENDERS)"));
    });
  });
  if (threads.length === 0) Logger.log("Nothing to import right now (only emails from " + sinceDay() + " onward are looked at). Send yourself a PO PDF and run testNow again, or wait for the next one.");
  else { Logger.log("Sending them now…"); checkInboxNow(); }
}

function query() { return "has:attachment filename:pdf after:" + sinceDay() + " -label:" + LABEL; }
function senderOk(msg) {
  var from = (msg.getFrom() || "").toLowerCase();
  return !SENDERS.length || SENDERS.some(function (s) { return from.indexOf(s.toLowerCase()) >= 0; });
}

function checkInbox() {
  // one run at a time — two overlapping runs could send the same PO twice
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Another run is still going — skipped this one."); return; }
  try { checkInboxNow(); } finally { lock.releaseLock(); }
}

function checkInboxNow() {
  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  var threads = GmailApp.search(query(), 0, 25);
  threads.forEach(function (thread) {
    var allOk = true, sentAny = false;
    thread.getMessages().forEach(function (msg) {
      if (!senderOk(msg)) return;
      var pdfs = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
        .filter(function (a) { return /\.pdf$/i.test(a.getName()); });
      if (!pdfs.length) return;
      var payload = {
        from: msg.getFrom(), subject: msg.getSubject(), date: msg.getDate().toISOString(), messageId: msg.getId(),
        attachments: pdfs.map(function (a) { return { name: a.getName(), base64: Utilities.base64Encode(a.getBytes()) }; })
      };
      var res = UrlFetchApp.fetch(SITE + "/api/inbound-po", {
        method: "post", contentType: "application/json", headers: { "x-intake-key": KEY },
        payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false
      });
      sentAny = true;
      var code = res.getResponseCode();
      var body = res.getContentText();
      Logger.log(msg.getSubject() + " → " + code + " " + body.slice(0, 400));
      if (code !== 200) { allOk = false; return; }
      var out = {};
      try { out = JSON.parse(body); } catch (e) { allOk = false; return; }
      // only a real intake answer counts — a redirect page or a login page doesn't
      if (!out.ok || !out.results) { allOk = false; return; }
      // a save error leaves the thread unlabeled so the next run tries again
      if (out.results.some(function (r) { return r.status === "error"; })) allOk = false;
      out.results.forEach(function (r) { Logger.log("    " + r.name + ": " + r.status + (r.po ? " PO " + r.po : "") + (r.startDate ? " → " + r.startDate : "") + (r.reason ? " — " + r.reason : "")); });
    });
    if (sentAny && allOk) thread.addLabel(label);
  });
}
