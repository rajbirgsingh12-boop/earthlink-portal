// Earth Link Field Office — Gmail PO intake
// ------------------------------------------------------------------
// Runs INSIDE your Google account (script.google.com), every 10 minutes.
// Finds emails with PDF attachments, sends each PDF to the site, and labels
// the thread "Earth Link/Imported" so it is never sent twice. The site
// decides what each PDF is: a partner PO becomes a job (with its date on
// the schedule, or under "Need to schedule"); anything else is skipped.
//
// Setup (once, ~5 minutes) — full steps in docs/EMAIL_PO_INTAKE.md:
//   1. script.google.com → New project → paste this whole file.
//   2. Fill in SITE and KEY below (KEY = the PO_INTAKE_KEY set in Vercel).
//   3. Run ▶ "setup" once → allow the permissions Google asks for.
//      That creates the 10-minute timer. Done.
// ------------------------------------------------------------------

var SITE = "https://YOUR-SITE.vercel.app";   // the portal's address, no slash at the end
var KEY = "PASTE-THE-PO_INTAKE_KEY-HERE";     // same value as PO_INTAKE_KEY in Vercel

// Only emails from these senders are looked at. Leave the list EMPTY to look
// at every email carrying a PDF (the site still only makes jobs out of POs).
var SENDERS = ["fairstead", "boulevard"];

var LABEL = "Earth Link/Imported";
var LOOKBACK = "newer_than:7d";

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("checkInbox").timeBased().everyMinutes(10).create();
  checkInbox();
  Logger.log("Timer set: the inbox is checked every 10 minutes.");
}

function checkInbox() {
  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  var threads = GmailApp.search("has:attachment filename:pdf " + LOOKBACK + " -label:\"" + LABEL + "\"", 0, 25);
  threads.forEach(function (thread) {
    var allOk = true, sentAny = false;
    thread.getMessages().forEach(function (msg) {
      var from = (msg.getFrom() || "").toLowerCase();
      if (SENDERS.length && !SENDERS.some(function (s) { return from.indexOf(s.toLowerCase()) >= 0; })) return;
      var pdfs = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
        .filter(function (a) { return /\.pdf$/i.test(a.getName()); });
      if (!pdfs.length) return;
      var payload = {
        from: msg.getFrom(), subject: msg.getSubject(), date: msg.getDate().toISOString(), messageId: msg.getId(),
        attachments: pdfs.map(function (a) { return { name: a.getName(), base64: Utilities.base64Encode(a.getBytes()) }; })
      };
      var res = UrlFetchApp.fetch(SITE + "/api/inbound-po", {
        method: "post", contentType: "application/json", headers: { "x-intake-key": KEY },
        payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      sentAny = true;
      var code = res.getResponseCode();
      Logger.log(msg.getSubject() + " → " + code + " " + res.getContentText().slice(0, 300));
      if (code !== 200) { allOk = false; return; }
      var out = JSON.parse(res.getContentText());
      // a save error leaves the thread unlabeled so the next run tries again
      if ((out.results || []).some(function (r) { return r.status === "error"; })) allOk = false;
    });
    if (sentAny && allOk) thread.addLabel(label);
  });
}
