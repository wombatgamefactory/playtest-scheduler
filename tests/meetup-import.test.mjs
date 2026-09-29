import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import {
  parseAttendeesFromDocument,
  parseAttendeeCountFromDocument,
  parseEventFromDocument,
  parseCommentsFromDocument,
  hasMoreComments,
  extractCommentsFromNextData,
  parseGameNotes,
  matchName,
  suggestDisplayName,
  buildImportPayload,
  parseImportText,
} from "../js/meetup-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const ATTENDEES_FIXTURE = path.join(FIXTURES_DIR, "meetup-attendees-page.html");
const EVENT_FIXTURE = path.join(FIXTURES_DIR, "meetup-event-page.html");

function loadDoc(fixturePath) {
  const html = fs.readFileSync(fixturePath, "utf8");
  return new JSDOM(html).window.document;
}

function fixturesAvailable() {
  return fs.existsSync(ATTENDEES_FIXTURE) && fs.existsSync(EVENT_FIXTURE);
}

const EXPECTED_ATTENDEES = [
  "Dean",
  "Aditya Singh",
  "Francesco Salerno",
  "Miquel Mansachs",
  "Oladotun Ogunsulire",
  "faryad",
  "Shan Syed",
  "Zoe Lou",
  "Tari",
];

// --- Attendees (fixture-based; skip if fixtures are absent) --------------

test("parseAttendeesFromDocument: yields the 9 expected names in page order", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(ATTENDEES_FIXTURE);
  const attendees = parseAttendeesFromDocument(doc);
  assert.deepEqual(attendees.map((a) => a.meetupName), EXPECTED_ATTENDEES);
});

test("parseAttendeesFromDocument: Dean's own card still yields a role", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(ATTENDEES_FIXTURE);
  const attendees = parseAttendeesFromDocument(doc);
  const dean = attendees.find((a) => a.meetupName === "Dean");
  assert.ok(dean);
  assert.equal(dean.role, "Co-host");
});

test("parseAttendeesFromDocument: roles are plausible known values", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(ATTENDEES_FIXTURE);
  const attendees = parseAttendeesFromDocument(doc);
  const francesco = attendees.find((a) => a.meetupName === "Francesco Salerno");
  assert.equal(francesco.role, "Member");
});

test("parseAttendeeCountFromDocument: reads 9 Attendees", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(ATTENDEES_FIXTURE);
  assert.equal(parseAttendeeCountFromDocument(doc), 9);
});

test("parseAttendeeCountFromDocument: null when absent", () => {
  const doc = new JSDOM("<html><body>No count here</body></html>").window.document;
  assert.equal(parseAttendeeCountFromDocument(doc), null);
});

// --- Event -----------------------------------------------------------------

test("parseEventFromDocument: full title on the event page", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(EVENT_FIXTURE);
  const event = parseEventFromDocument(doc);
  assert.equal(event.title, "London [Mondays] After-Hours Playtest");
  assert.equal(event.date, "2026-09-28");
  assert.equal(event.startTime, "18:30");
});

test("parseEventFromDocument: does not throw on the attendees page (date/time aren't on that page)", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(ATTENDEES_FIXTURE);
  const event = parseEventFromDocument(doc);
  assert.equal(typeof event.title, "string");
  assert.ok(event.title.length > 0);
  assert.equal(event.date, null);
  assert.equal(event.startTime, null);
});

// --- Comments ----------------------------------------------------------

test("parseCommentsFromDocument: finds Dean, gtcheung89 and Shan S., excluding chrome", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(EVENT_FIXTURE);
  const comments = parseCommentsFromDocument(doc);
  assert.equal(comments.length, 3);

  const dean = comments.find((c) => c.author === "Dean");
  assert.ok(dean);
  assert.match(dean.text, /^We have a table on the first floor/);

  const gt = comments.find((c) => c.author === "gtcheung89");
  assert.ok(gt);
  assert.match(gt.text, /Apologies, can't make it today/);

  const shan = comments.find((c) => c.author === "Shan S.");
  assert.ok(shan);
  assert.match(shan.text, /looking for 3-4 other players/);

  for (const c of comments) {
    assert.doesNotMatch(c.text, /^(Like|Reply|Host)$/);
    assert.doesNotMatch(c.text, /\d+\s*(hours?|days?|minutes?)\s*ago/);
  }
});

test("hasMoreComments: true on the event fixture", { skip: !fixturesAvailable() && "fixtures missing" }, () => {
  const doc = loadDoc(EVENT_FIXTURE);
  assert.equal(hasMoreComments(doc), true);
});

test("hasMoreComments: false when there's no such control", () => {
  const doc = new JSDOM("<html><body><button>Something else</button></body></html>").window.document;
  assert.equal(hasMoreComments(doc), false);
});

// --- extractCommentsFromNextData (synthetic - see module comment: unverified against live data) --

test("extractCommentsFromNextData: finds comment-like nodes in a synthetic Apollo/Next-style object", () => {
  const fakeNextData = {
    props: {
      pageProps: {
        apolloState: {
          "Comment:1": { __typename: "Comment", text: "Hello there", member: { name: "Alice" } },
          "Comment:2": { __typename: "Comment", body: "See you Monday", author: "Bob C." },
          "Comment:3": { __typename: "Comment", comment: "No author here" },
          "Member:99": { __typename: "Member", name: "Someone Else" },
        },
        list: [
          { message: "From an array", user: { displayName: "Carol" } },
        ],
      },
    },
  };
  const comments = extractCommentsFromNextData(fakeNextData);
  assert.ok(comments.some((c) => c.author === "Alice" && c.text === "Hello there"));
  assert.ok(comments.some((c) => c.author === "Bob C." && c.text === "See you Monday"));
  assert.ok(comments.some((c) => c.author === "Carol" && c.text === "From an array"));
  assert.equal(comments.some((c) => c.text === "No author here"), false);
});

test("extractCommentsFromNextData: does not throw on null, primitives or circular objects", () => {
  assert.deepEqual(extractCommentsFromNextData(null), []);
  assert.deepEqual(extractCommentsFromNextData("a string"), []);
  const circular = { text: "loop", author: "X" };
  circular.self = circular;
  const result = extractCommentsFromNextData(circular);
  assert.deepEqual(result, [{ author: "X", text: "loop" }]);
});

// --- parseGameNotes ------------------------------------------------------

test("parseGameNotes: at least 15 phrasings", () => {
  const cases = [
    ["3-4 other players", { testersMin: 3, testersMax: 4, durationMins: null, cancelled: false }],
    ["+2", { testersMin: 2, testersMax: 2, durationMins: null, cancelled: false }],
    ["2 players", { testersMin: 2, testersMax: 2, durationMins: null, cancelled: false }],
    ["need 2 testers", { testersMin: 2, testersMax: 2, durationMins: null, cancelled: false }],
    ["3 to 5 players", { testersMin: 3, testersMax: 5, durationMins: null, cancelled: false }],
    ["4 players including me", { testersMin: 3, testersMax: 3, durationMins: null, cancelled: false }],
    ["4 in total", { testersMin: 3, testersMax: 3, durationMins: null, cancelled: false }],
    ["45 mins", { testersMin: null, testersMax: null, durationMins: 45, cancelled: false }],
    ["1 hour", { testersMin: null, testersMax: null, durationMins: 60, cancelled: false }],
    ["an hour", { testersMin: null, testersMax: null, durationMins: 60, cancelled: false }],
    ["1.5 hours", { testersMin: null, testersMax: null, durationMins: 90, cancelled: false }],
    ["90m", { testersMin: null, testersMax: null, durationMins: 90, cancelled: false }],
    ["can't make it", { testersMin: null, testersMax: null, durationMins: null, cancelled: true }],
    ["cannot come", { testersMin: null, testersMax: null, durationMins: null, cancelled: true }],
    ["not coming", { testersMin: null, testersMax: null, durationMins: null, cancelled: true }],
    [
      "I'll be bringing my usual game, I'm looking for 3-4 other players to blind test the rules for me.",
      { testersMin: 3, testersMax: 4, durationMins: null, cancelled: false },
    ],
    ["Bringing my new one, 45 mins, need 2 testers", { testersMin: 2, testersMax: 2, durationMins: 45, cancelled: false }],
    ["I have a 2 player game, 30 minutes", { testersMin: 2, testersMax: 2, durationMins: 30, cancelled: false }],
    ["It's a 2-player game", { testersMin: 2, testersMax: 2, durationMins: null, cancelled: false }],
    ["A 2-4 player game, about 30 min", { testersMin: 2, testersMax: 4, durationMins: 30, cancelled: false }],
    ["about 45 mins", { testersMin: null, testersMax: null, durationMins: 45, cancelled: false }],
    ["Runs about 30 minutes", { testersMin: null, testersMax: null, durationMins: 30, cancelled: false }],
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(parseGameNotes(text), expected, `for text: ${JSON.stringify(text)}`);
  }
});

test("parseGameNotes: returns null when there's nothing to find", () => {
  assert.equal(parseGameNotes("Looking forward to it!"), null);
  assert.equal(parseGameNotes(""), null);
  assert.equal(parseGameNotes(null), null);
});

// --- matchName -----------------------------------------------------------

const ATTENDEES = EXPECTED_ATTENDEES.map((meetupName) => ({ meetupName, role: null }));

test("matchName: exact case-insensitive match", () => {
  const m = matchName("dean", ATTENDEES);
  assert.equal(m.meetupName, "Dean");
});

test("matchName: first name + last initial (Shan S. -> Shan Syed)", () => {
  const m = matchName("Shan S.", ATTENDEES);
  assert.equal(m.meetupName, "Shan Syed");
});

test("matchName: unique first-name match", () => {
  const m = matchName("Tari", ATTENDEES);
  assert.equal(m.meetupName, "Tari");
});

test("matchName: no match returns null", () => {
  assert.equal(matchName("gtcheung89", ATTENDEES), null);
  assert.equal(matchName("", ATTENDEES), null);
  assert.equal(matchName("Someone Unrelated", ATTENDEES), null);
});

test("matchName: ambiguous first name with no initial given returns null", () => {
  const attendees = [{ meetupName: "Sam Jones" }, { meetupName: "Sam Patel" }];
  assert.equal(matchName("Sam", attendees), null);
});

// --- suggestDisplayName --------------------------------------------------

test("suggestDisplayName", () => {
  assert.equal(suggestDisplayName("faryad"), "Faryad");
  assert.equal(suggestDisplayName("Aditya Singh"), "Aditya");
  assert.equal(suggestDisplayName("Oladotun Ogunsulire"), "Oladotun");
  assert.equal(suggestDisplayName(""), "");
});

// --- buildImportPayload ---------------------------------------------------

test("buildImportPayload: shape", () => {
  const payload = buildImportPayload({
    event: { title: "Playtest", date: "2026-09-28", startTime: "18:30" },
    eventId: "316433169",
    url: "https://www.meetup.com/playtest/events/316433169/",
    attendees: ATTENDEES,
    attendeeCountShown: 9,
    comments: [{ author: "Dean", text: "hi" }],
    warnings: ["something"],
  });

  assert.equal(payload.source, "meetup-bookmarklet");
  assert.equal(payload.version, 1);
  assert.equal(typeof payload.capturedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(payload.capturedAt)));
  assert.deepEqual(payload.event, {
    id: "316433169",
    title: "Playtest",
    date: "2026-09-28",
    startTime: "18:30",
    url: "https://www.meetup.com/playtest/events/316433169/",
  });
  assert.equal(payload.attendeeCountShown, 9);
  assert.equal(payload.attendees.length, 9);
  assert.equal(payload.comments.length, 1);
  assert.deepEqual(payload.warnings, ["something"]);
});

// --- parseImportText -------------------------------------------------------

test("parseImportText: accepts a payload's JSON as-is", () => {
  const payload = buildImportPayload({
    event: { title: "Playtest", date: "2026-09-28", startTime: "18:30" },
    eventId: "1",
    url: "https://www.meetup.com/playtest/events/1/",
    attendees: ATTENDEES,
    attendeeCountShown: 9,
    comments: [],
    warnings: [],
  });
  const result = parseImportText(JSON.stringify(payload));
  assert.equal(result.source, "meetup-bookmarklet");
  assert.equal(result.attendees.length, 9);
});

test("parseImportText: invalid JSON starting with { gives an error", () => {
  const result = parseImportText("{ not valid json");
  assert.ok(result.error);
});

test("parseImportText: plain list of names, one per line", () => {
  const result = parseImportText("Dean\nFrancesco Salerno\nTari");
  assert.equal(result.source, "paste");
  assert.deepEqual(
    result.attendees.map((a) => a.meetupName),
    ["Dean", "Francesco Salerno", "Tari"]
  );
});

test("parseImportText: strips bullets, numbering and blank lines", () => {
  const result = parseImportText("- Dean\n\n1. Francesco Salerno\n* Tari\n\n2) Shan Syed");
  assert.deepEqual(
    result.attendees.map((a) => a.meetupName),
    ["Dean", "Francesco Salerno", "Tari", "Shan Syed"]
  );
});

test("parseImportText: trailing +N reads as guests", () => {
  const result = parseImportText("Francesco +1\nTari +2\nDean");
  assert.deepEqual(result.attendees, [
    { meetupName: "Francesco", role: null, guests: 1 },
    { meetupName: "Tari", role: null, guests: 2 },
    { meetupName: "Dean", role: null },
  ]);
});

// --- Module hygiene --------------------------------------------------------

test("module has no imports and no top-level DOM access", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "meetup-import.js"), "utf8");
  assert.doesNotMatch(src, /^\s*import /m);
  assert.doesNotMatch(src, /\bwindow\./);
  assert.doesNotMatch(src, /\bdocument\./);
});
