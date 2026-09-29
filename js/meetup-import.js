// Meetup import module.
//
// Pure ES module, no imports. Every DOM-facing function takes a `Document`
// (never touches `window` directly) so it works the same in the browser
// bookmarklet and under Node + jsdom in tests.
//
// The selectors below were reverse-engineered from two saved, script-stripped
// Meetup pages (tests/fixtures/meetup-attendees-page.html and
// meetup-event-page.html). Meetup's markup is unversioned and can change at
// any time - that's why every parser here is defensive (returns null/[]
// rather than throwing) and there's a plain-text paste fallback
// (parseImportText) for when the page-scraping stops working altogether.

const KNOWN_ROLES = ["Co-host", "Member", "Event Organizer", "Host"];

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

// --- Attendees -------------------------------------------------------

/**
 * Find the role text ("Co-host", "Member", ...) for an attendee card.
 *
 * On the attendees fixture, the role sits in a sibling `<div class="flex
 * flex-wrap gap-ds2-6">...</div>` next to the card's own `<button>` - for
 * *every* attendee. For most attendees that sibling div is itself inside a
 * wrapper that also contains the button, so a plain `card.querySelector`
 * would have found it too; but Dean's own card (he's a co-host viewing his
 * own event) renders slightly differently and the role div is *only*
 * reachable by climbing to that shared wrapper. Climbing first keeps one
 * code path for every attendee, including Dean.
 */
function findRoleForCard(card) {
  let wrapper = card;
  let node = card.parentElement;
  while (node && node.nodeType === 1) {
    if (typeof node.className === "string" && node.className.indexOf("px-ds2-16") !== -1) {
      wrapper = node;
      break;
    }
    node = node.parentElement;
  }
  const roleEl = wrapper.querySelector(".flex.flex-wrap.gap-ds2-6 span");
  if (!roleEl) return null;
  const text = roleEl.textContent.trim();
  return KNOWN_ROLES.indexOf(text) !== -1 ? text : null;
}

/**
 * Parse the attendee list from a Meetup "/events/<id>/attendees/" page.
 * Returns [{ meetupName, role }] in page order.
 */
export function parseAttendeesFromDocument(doc) {
  const cards = doc.querySelectorAll('button[data-event-label="attendee-card"]');
  const results = [];
  for (const card of cards) {
    const img = card.querySelector('img[alt^="Photo of the user"]');
    let name = null;
    if (img) {
      const alt = img.getAttribute("alt") || "";
      const match = alt.match(/^Photo of the user (.+)$/);
      if (match) name = match[1].trim();
    }
    if (!name) {
      const h3 = card.querySelector("h3");
      name = h3 ? h3.textContent.trim() : card.textContent.trim();
    }
    if (!name) continue;
    results.push({ meetupName: name, role: findRoleForCard(card) });
  }
  return results;
}

/** Parse "9 Attendees" from the attendees page header. Returns a number or null. */
export function parseAttendeeCountFromDocument(doc) {
  const text = doc.body ? doc.body.textContent : "";
  const match = text.match(/(\d+)\s+Attendees?(?![a-z])/i);
  return match ? parseInt(match[1], 10) : null;
}

// --- Event -------------------------------------------------------------

/**
 * Parse { title, date, startTime } from the page's <title>.
 *
 * The event page's title looks like:
 *   "London [Mondays] After-Hours Playtest, Mon, Sep 28, 2026, 6:30 PM | Meetup"
 * which gives date "2026-09-28" and startTime "18:30".
 *
 * The attendees page's <title> does NOT carry the date/time (it's just
 * "Attendees | <event title>" on the saved fixture), so on that page this
 * falls back to a title-only result with date/startTime left null rather
 * than throwing - "works from either fixture page" is read here as "never
 * throws and returns the best it can find", not "recovers a date that
 * genuinely isn't on the page".
 */
export function parseEventFromDocument(doc) {
  const titleEl = doc.querySelector("title");
  const rawTitle = (doc.title || (titleEl ? titleEl.textContent : "") || "").trim();
  const normalised = rawTitle.replace(/\s+/g, " ").trim();

  const full = normalised.match(
    /^(.*?),\s*\w+,\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\|/i
  );
  if (full) {
    const [, title, monAbbr, day, year, hour12, min, ampm] = full;
    const monthNum = MONTHS[monAbbr.slice(0, 1).toUpperCase() + monAbbr.slice(1, 3).toLowerCase()];
    let date = null;
    if (monthNum) {
      date = `${year}-${String(monthNum).padStart(2, "0")}-${String(parseInt(day, 10)).padStart(2, "0")}`;
    }
    let hour = parseInt(hour12, 10) % 12;
    if (/pm/i.test(ampm)) hour += 12;
    const startTime = `${String(hour).padStart(2, "0")}:${min}`;
    return { title: title.trim(), date, startTime };
  }

  let title = normalised
    .replace(/^Attendees\s*\|\s*/i, "")
    .replace(/\s*\|\s*Meetup\s*$/i, "")
    .trim();
  if (!title) {
    const h2 = doc.querySelector("h2");
    title = h2 ? h2.textContent.trim() : "";
  }
  return { title, date: null, startTime: null };
}

// --- Comments ------------------------------------------------------------

/**
 * Parse [{ author, text }] from the event page's comment list, excluding
 * the "Like"/"Reply"/time-ago/"Host" chrome around each comment.
 */
export function parseCommentsFromDocument(doc) {
  const containers = doc.querySelectorAll("div.flex.gap-ds2-12.md\\:gap-ds2-20");
  const results = [];
  for (const container of containers) {
    const nameEl = container.querySelector("a.ds2-m14");
    const textEl = container.querySelector("p.mb-ds2-10");
    if (!nameEl || !textEl) continue;
    const author = nameEl.textContent.trim();
    const text = textEl.textContent.trim();
    if (author && text) results.push({ author, text });
  }
  return results;
}

/** True if a "More comments" control is present (comments are paged). */
export function hasMoreComments(doc) {
  const buttons = doc.querySelectorAll("button");
  for (const button of buttons) {
    if (button.textContent && button.textContent.trim() === "More comments") return true;
  }
  return false;
}

/**
 * Defensive recursive search of a parsed __NEXT_DATA__ / Apollo-state object
 * for comment-like nodes: any object with a text/comment/body/message string
 * and a member/author/user name nearby.
 *
 * UNVERIFIED: the saved fixtures have scripts stripped, so this has never
 * been run against Meetup's real __NEXT_DATA__ payload. The field names
 * below (text/comment/body/message, author/member/user/commenter, plus a
 * nested name/displayName/memberName/fullName) are a best guess at likely
 * shapes, not confirmed ones. Treat this function as a "try it, and fall
 * back to parseCommentsFromDocument if it finds nothing" safety net, not a
 * primary path - see T4's bookmarklet flow.
 */
export function extractCommentsFromNextData(obj) {
  const TEXT_KEYS = ["text", "comment", "body", "message", "content"];
  const AUTHOR_KEYS = ["author", "member", "user", "commenter"];
  const NAME_KEYS = ["name", "displayName", "memberName", "fullName"];

  const results = [];
  const seen = new Set();

  function nameOf(value) {
    if (typeof value === "string") return value.trim() || null;
    if (value && typeof value === "object") {
      for (const key of NAME_KEYS) {
        if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
      }
    }
    return null;
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    let text = null;
    for (const key of TEXT_KEYS) {
      if (typeof node[key] === "string" && node[key].trim()) {
        text = node[key].trim();
        break;
      }
    }

    let author = null;
    for (const key of AUTHOR_KEYS) {
      if (key in node) {
        author = nameOf(node[key]);
        if (author) break;
      }
    }
    if (!author && text && typeof node.name === "string" && node.name.trim()) {
      author = node.name.trim();
    }

    if (text && author) results.push({ author, text });

    for (const key of Object.keys(node)) {
      walk(node[key]);
    }
  }

  walk(obj);
  return results;
}

// --- Game notes ------------------------------------------------------------

function parseTesterCounts(text) {
  // Dean's rule: a stated number of players/testers means testers, NOT
  // counting the designer - except when the text explicitly says the total
  // includes the designer ("4 players including me", "4 in total"), in
  // which case we subtract 1.
  let match = text.match(/(\d+)\s*(?:players?|people)?\s*(?:including me|in total)\b/i);
  if (match) {
    const total = parseInt(match[1], 10);
    const testers = Math.max(0, total - 1);
    return { min: testers, max: testers };
  }

  // "3-4 other players", "3 to 5 players", "2-4 player game" (range; "player"/
  // "players"/"tester"/"testers" all accepted, same testers rule either way).
  match = text.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:other\s+)?(?:players?|testers?)\b/i);
  if (match) {
    return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  }

  match = text.match(/\+(\d+)\b/);
  if (match) {
    const n = parseInt(match[1], 10);
    return { min: n, max: n };
  }

  // "2 players", "need 2 testers", "2 player game", "2-player game".
  match = text.match(/(\d+)\s*-?\s*(?:other\s+)?(?:players?|testers?)\b/i);
  if (match) {
    const n = parseInt(match[1], 10);
    return { min: n, max: n };
  }

  return null;
}

function parseDurationMins(text) {
  let match = text.match(/\b(\d+(?:\.\d+)?)\s*hours?\b/i);
  if (match) return Math.round(parseFloat(match[1]) * 60);

  if (/\ban hour\b/i.test(text)) return 60;

  // "45 mins", "30 min", "30 minutes", "30 minute" - anywhere in the sentence,
  // with or without a player/tester count also present.
  match = text.match(/\b(\d+)\s*(?:min(?:ute)?s?)\b/i);
  if (match) return parseInt(match[1], 10);

  match = text.match(/\b(\d+)m\b/);
  if (match) return parseInt(match[1], 10);

  return null;
}

/**
 * Extract { testersMin, testersMax, durationMins, cancelled } from a free-text
 * comment, or null if nothing recognisable is in it.
 */
export function parseGameNotes(text) {
  if (!text) return null;

  const cancelled = /can'?t make it|cannot make it|can not make it|cannot come|can'?t come|not coming/i.test(text);
  const testers = parseTesterCounts(text);
  const durationMins = parseDurationMins(text);

  if (!cancelled && !testers && durationMins === null) return null;

  return {
    testersMin: testers ? testers.min : null,
    testersMax: testers ? testers.max : null,
    durationMins,
    cancelled,
  };
}

// --- Name matching ---------------------------------------------------------

function firstWord(name) {
  return name.trim().split(/\s+/)[0] || "";
}

/**
 * Match a comment author's display name against the attendee list.
 * Tries, in order: exact (case-insensitive) match, first-name + last-initial
 * ("Shan S." -> "Shan Syed"), then a unique first-name match.
 */
export function matchName(author, attendees) {
  if (!author || !attendees || !attendees.length) return null;
  const trimmedAuthor = author.trim();
  const authorLower = trimmedAuthor.toLowerCase();

  const exact = attendees.find((a) => a.meetupName.trim().toLowerCase() === authorLower);
  if (exact) return exact;

  const parts = trimmedAuthor.split(/\s+/);
  if (parts.length >= 2) {
    const first = parts[0].toLowerCase();
    const initial = parts[1].replace(/\.$/, "").toLowerCase();
    if (initial.length === 1) {
      const initialMatches = attendees.filter((a) => {
        const nameParts = a.meetupName.trim().split(/\s+/);
        return (
          nameParts[0].toLowerCase() === first &&
          nameParts[1] &&
          nameParts[1][0].toLowerCase() === initial
        );
      });
      if (initialMatches.length === 1) return initialMatches[0];
    }
  }

  const first = parts[0].toLowerCase();
  const firstNameMatches = attendees.filter((a) => firstWord(a.meetupName).toLowerCase() === first);
  if (firstNameMatches.length === 1) return firstNameMatches[0];

  return null;
}

/** "faryad" -> "Faryad", "Aditya Singh" -> "Aditya": first word, capitalised. */
export function suggestDisplayName(meetupName) {
  if (!meetupName) return "";
  const first = firstWord(meetupName);
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// --- Import payload ----------------------------------------------------

/**
 * Build the JSON payload the bookmarklet copies to the clipboard, and that
 * the app's paste box also accepts.
 */
export function buildImportPayload({ event, eventId, url, attendees, attendeeCountShown, comments, warnings }) {
  return {
    source: "meetup-bookmarklet",
    version: 1,
    capturedAt: new Date().toISOString(),
    event: {
      id: eventId || null,
      title: (event && event.title) || null,
      date: (event && event.date) || null,
      startTime: (event && event.startTime) || null,
      url: url || null,
    },
    attendeeCountShown: attendeeCountShown == null ? null : attendeeCountShown,
    attendees: attendees || [],
    comments: comments || [],
    warnings: warnings || [],
  };
}

function stripListDecoration(line) {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
}

/**
 * Accept either buildImportPayload's JSON, or a plain pasted list of names
 * (one per line, bullets/numbering stripped, trailing "+N" read as guests).
 * Returns a payload-shaped object (source "meetup-bookmarklet" or "paste"),
 * or { error } if it looks like JSON but doesn't parse.
 */
export function parseImportText(text) {
  const trimmed = (text || "").trim();

  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      return { error: "That doesn't look like valid Meetup import JSON." };
    }
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const attendees = [];
  for (const rawLine of lines) {
    let name = stripListDecoration(rawLine);
    let guests = null;
    const guestMatch = name.match(/\+(\d+)\s*$/);
    if (guestMatch) {
      guests = parseInt(guestMatch[1], 10);
      name = name.slice(0, guestMatch.index).trim();
    }
    if (!name) continue;
    const attendee = { meetupName: name, role: null };
    if (guests !== null) attendee.guests = guests;
    attendees.push(attendee);
  }

  return {
    source: "paste",
    version: 1,
    capturedAt: new Date().toISOString(),
    event: { id: null, title: null, date: null, startTime: null, url: null },
    attendeeCountShown: null,
    attendees,
    comments: [],
    warnings: [],
  };
}
