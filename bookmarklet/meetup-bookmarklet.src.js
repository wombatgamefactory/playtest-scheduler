// Meetup import bookmarklet - main logic.
//
// This file has NO imports/exports. `tools/build-bookmarklet.mjs` strips the
// `export` keywords out of `js/meetup-import.js` and concatenates that
// stripped text directly above this file inside one IIFE, so every function
// exported by meetup-import.js (parseAttendeesFromDocument,
// parseAttendeeCountFromDocument, parseEventFromDocument,
// parseCommentsFromDocument, hasMoreComments, extractCommentsFromNextData,
// buildImportPayload, ...) is already an in-scope function when this file's
// code runs. Do not add an import/require here - it would break the build.
//
// Nothing in this file runs itself. The build script appends the call to
// `run()` (with its own top-level try/catch) after concatenating everything,
// so this file is safe to load on its own - e.g. in a test harness that
// wants to call `collectFromDocuments` directly against jsdom documents
// without triggering any DOM side effects (scrolling, fetch, overlay,
// clipboard).

var GM_OVERLAY_ID = "gm-meetup-import-overlay-2b7f";

// --- URL helpers -----------------------------------------------------------

function gmExtractGroupFromUrl(url) {
  var m = (url || "").match(/meetup\.com\/([^/]+)\/events\//i);
  return m ? m[1] : null;
}

function gmExtractEventIdFromUrl(url) {
  var m = (url || "").match(/\/events\/(\d+)/);
  return m ? m[1] : null;
}

function gmIsAttendeesUrl(url) {
  return /meetup\.com\/[^/]+\/events\/\d+\/attendees\/?/i.test(url || "");
}

function gmIsEventUrl(url) {
  return /meetup\.com\/[^/]+\/events\/\d+\/?(?:[?#].*)?$/i.test(url || "");
}

function gmBuildAttendeesUrl(url) {
  var group = gmExtractGroupFromUrl(url);
  var id = gmExtractEventIdFromUrl(url);
  if (!group || !id) return null;
  return "https://www.meetup.com/" + group + "/events/" + id + "/attendees/";
}

function gmBuildEventUrl(url) {
  var group = gmExtractGroupFromUrl(url);
  var id = gmExtractEventIdFromUrl(url);
  if (!group || !id) return null;
  return "https://www.meetup.com/" + group + "/events/" + id + "/";
}

// --- Core parsing (pure - no DOM side effects, no fetch, no clipboard) -----

/**
 * Build the import payload from the two already-loaded documents.
 *
 * `attendeesDoc` is the attendees page (the page the bookmarklet is run on).
 * `eventDoc` is the fetched event page, or null/undefined if the fetch
 * failed - in that case the payload still comes back with attendees and no
 * comments, plus a warning.
 *
 * This is the non-DOM-side-effect core the build's tests exercise directly:
 * it never touches `window`, `document`, `fetch`, `navigator` or scrolling,
 * so it can be called with jsdom documents in Node.
 */
function collectFromDocuments(attendeesDoc, eventDoc, url) {
  var warnings = [];

  var attendees = parseAttendeesFromDocument(attendeesDoc);
  var attendeeCountShown = parseAttendeeCountFromDocument(attendeesDoc);

  // The date/time are only recoverable from the event page (see
  // meetup-import.js) - the attendees page's own parseEventFromDocument
  // result only reliably has a title, so prefer the event page's result
  // whenever we have one.
  var event = parseEventFromDocument(attendeesDoc);
  if (eventDoc) {
    var eventFromEventPage = parseEventFromDocument(eventDoc);
    if (eventFromEventPage.date || eventFromEventPage.startTime || eventFromEventPage.title) {
      event = eventFromEventPage;
    }
  } else {
    warnings.push("Couldn't load the event page, so comments and the exact event time are missing.");
  }

  var comments = [];
  if (eventDoc) {
    var usedNextData = false;
    var nextDataEl = eventDoc.querySelector && eventDoc.querySelector("script#__NEXT_DATA__");
    if (nextDataEl && nextDataEl.textContent) {
      try {
        var parsed = JSON.parse(nextDataEl.textContent);
        var found = extractCommentsFromNextData(parsed);
        if (found && found.length) {
          comments = found;
          usedNextData = true;
        }
      } catch (err) {
        // Malformed/unexpected __NEXT_DATA__ shape - fall back to the DOM.
      }
    }
    if (!usedNextData) {
      comments = parseCommentsFromDocument(eventDoc);
      if (hasMoreComments(eventDoc)) {
        warnings.push("More comments were available on the event page; only the ones shown were captured.");
      }
    }
  }

  var eventId = gmExtractEventIdFromUrl(url);

  return buildImportPayload({
    event: event,
    eventId: eventId,
    url: url || null,
    attendees: attendees,
    attendeeCountShown: attendeeCountShown,
    comments: comments,
    warnings: warnings,
  });
}

// --- DOM side effects --------------------------------------------------

function gmCountAttendeeCards(doc) {
  return doc.querySelectorAll('button[data-event-label="attendee-card"]').length;
}

function gmWait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Scroll the window to load lazily-rendered attendee cards. Stops once the
 * count stops growing for two rounds in a row, or matches the "N Attendees"
 * header count, or after 20 rounds (~600ms apart, so ~12s worst case).
 */
async function gmAutoScrollAttendees(doc, win) {
  var expected = parseAttendeeCountFromDocument(doc);
  var lastCount = -1;
  var stableRounds = 0;
  for (var round = 0; round < 20; round++) {
    win.scrollTo(0, (doc.body && doc.body.scrollHeight) || 999999);
    await gmWait(600);
    var count = gmCountAttendeeCards(doc);
    if (expected != null && count >= expected) break;
    if (count === lastCount) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastCount = count;
  }
  // Leave the page where it lands - scrolling back up is cosmetic only and
  // not worth the risk of interfering with Meetup's own lazy-load logic.
}

async function gmFetchEventDocument(eventUrl) {
  var res = await fetch(eventUrl, { credentials: "include" });
  if (!res || !res.ok) throw new Error("Event page fetch failed (" + (res && res.status) + ")");
  var html = await res.text();
  var parser = new DOMParser();
  return parser.parseFromString(html, "text/html");
}

async function gmCopyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // fall through to the textarea fallback
  }
  return false;
}

// --- Overlay (inline-styled and namespaced so it can't clash with Meetup) --

function gmEscapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gmRemoveOverlay() {
  var existing = document.getElementById(GM_OVERLAY_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

/** Creates (or replaces) the fixed overlay and returns its content element. */
function gmCreateOverlay() {
  gmRemoveOverlay();

  var box = document.createElement("div");
  box.id = GM_OVERLAY_ID;
  box.style.cssText = [
    "position:fixed",
    "top:16px",
    "right:16px",
    "left:16px",
    "max-width:420px",
    "margin-left:auto",
    "z-index:2147483647",
    "background:#1b1f27",
    "color:#f4f5f7",
    "font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif",
    "border-radius:10px",
    "box-shadow:0 8px 30px rgba(0,0,0,0.35)",
    "padding:16px",
    "box-sizing:border-box",
  ].join(";");

  var content = document.createElement("div");
  content.id = GM_OVERLAY_ID + "-content";
  box.appendChild(content);

  var closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = [
    "margin-top:12px",
    "background:#3a3f4b",
    "color:#f4f5f7",
    "border:0",
    "border-radius:6px",
    "padding:8px 14px",
    "font-size:14px",
    "cursor:pointer",
  ].join(";");
  closeBtn.addEventListener("click", gmRemoveOverlay);
  box.appendChild(closeBtn);

  document.body.appendChild(box);
  return content;
}

function gmSetOverlayHtml(html) {
  var content = document.getElementById(GM_OVERLAY_ID + "-content") || gmCreateOverlay();
  content.innerHTML = html;
}

function gmShowLoadingOverlay() {
  gmCreateOverlay();
  gmSetOverlayHtml("<strong>Playtest import</strong><p>Collecting attendees&hellip;</p>");
}

function gmShowNeedAttendeesPageOverlay(url) {
  gmCreateOverlay();
  var attendeesUrl = gmBuildAttendeesUrl(url);
  var linkHtml = attendeesUrl
    ? '<p><a href="' + gmEscapeHtml(attendeesUrl) + '" style="color:#8ab4ff;">Open the attendees page</a></p>'
    : "";
  gmSetOverlayHtml(
    "<strong>Playtest import</strong>" +
      "<p>This is the event page. Open its Attendees page, then click this bookmarklet again.</p>" +
      linkHtml
  );
}

function gmShowNeedNavigationOverlay() {
  gmCreateOverlay();
  gmSetOverlayHtml(
    "<strong>Playtest import</strong>" +
      "<p>Open a Meetup event's Attendees page first (it looks like " +
      "<code>meetup.com/&lt;group&gt;/events/&lt;id&gt;/attendees/</code>), then click this bookmarklet again.</p>"
  );
}

function gmShowTextareaFallback(text) {
  var container = document.createElement("div");
  var label = document.createElement("p");
  label.textContent = "Couldn't copy automatically - copy this text instead:";
  container.appendChild(label);

  var textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = [
    "width:100%",
    "height:140px",
    "box-sizing:border-box",
    "font:12px/1.3 monospace",
    "background:#0f1115",
    "color:#f4f5f7",
    "border:1px solid #3a3f4b",
    "border-radius:6px",
    "padding:8px",
  ].join(";");
  container.appendChild(textarea);

  var content = document.getElementById(GM_OVERLAY_ID + "-content") || gmCreateOverlay();
  content.appendChild(container);
  textarea.focus();
  textarea.select();
}

function gmShowResultOverlay(payload, copied) {
  var attendeeCount = payload.attendees.length;
  var commentCount = payload.comments.length;
  var summary = copied
    ? "Copied " + attendeeCount + " attendee" + (attendeeCount === 1 ? "" : "s") +
      " and " + commentCount + " comment" + (commentCount === 1 ? "" : "s") +
      ". Paste into the scheduler's Import box."
    : attendeeCount + " attendee" + (attendeeCount === 1 ? "" : "s") +
      " and " + commentCount + " comment" + (commentCount === 1 ? "" : "s") + " collected.";

  var warningsHtml = "";
  if (payload.warnings && payload.warnings.length) {
    warningsHtml =
      "<p style='margin-top:8px;color:#ffcf5c;'><strong>Warnings:</strong></p><ul style='margin:4px 0 0 18px;padding:0;'>" +
      payload.warnings.map(function (w) { return "<li>" + gmEscapeHtml(w) + "</li>"; }).join("") +
      "</ul>";
  }

  gmSetOverlayHtml(
    "<strong>Playtest import</strong><p>" + gmEscapeHtml(summary) + "</p>" + warningsHtml
  );

  if (!copied) {
    gmShowTextareaFallback(JSON.stringify(payload, null, 2));
  }
}

function gmShowErrorOverlay(err) {
  gmCreateOverlay();
  var message = (err && err.message) || String(err);
  gmSetOverlayHtml(
    "<strong>Playtest import</strong><p style='color:#ff8080;'>Something went wrong: " +
      gmEscapeHtml(message) +
      "</p><p>Nothing was sent anywhere - it's safe to try again, or fall back to pasting names into the scheduler.</p>"
  );
}

// --- Orchestration -----------------------------------------------------

async function run() {
  var url = window.location.href;

  if (!gmIsAttendeesUrl(url)) {
    if (gmIsEventUrl(url)) {
      gmShowNeedAttendeesPageOverlay(url);
    } else {
      gmShowNeedNavigationOverlay();
    }
    return;
  }

  gmShowLoadingOverlay();

  try {
    await gmAutoScrollAttendees(document, window);

    var eventDoc = null;
    var eventUrl = gmBuildEventUrl(url);
    if (eventUrl) {
      try {
        eventDoc = await gmFetchEventDocument(eventUrl);
      } catch (fetchErr) {
        eventDoc = null;
      }
    }

    var payload = collectFromDocuments(document, eventDoc, url);
    var json = JSON.stringify(payload, null, 2);
    var copied = await gmCopyToClipboard(json);
    gmShowResultOverlay(payload, copied);
  } catch (err) {
    gmShowErrorOverlay(err);
  }
}
