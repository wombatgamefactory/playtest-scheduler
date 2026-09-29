import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import * as meetupImport from "../js/meetup-import.js";
import { buildBookmarkletCode, stripExports, minify } from "../tools/build-bookmarklet.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const ATTENDEES_FIXTURE = path.join(FIXTURES_DIR, "meetup-attendees-page.html");
const EVENT_FIXTURE = path.join(FIXTURES_DIR, "meetup-event-page.html");
const SRC_PATH = path.join(ROOT, "bookmarklet", "meetup-bookmarklet.src.js");
const HTML_PATH = path.join(ROOT, "bookmarklet.html");

function fixturesAvailable() {
  return fs.existsSync(ATTENDEES_FIXTURE) && fs.existsSync(EVENT_FIXTURE);
}

function loadDoc(fixturePath) {
  const html = fs.readFileSync(fixturePath, "utf8");
  return new JSDOM(html).window.document;
}

// --- minify() itself --------------------------------------------------

test("minify strips // and /* */ comments but leaves strings and regexes alone", () => {
  const src = [
    "// a leading comment",
    'const a = "keep // this slash-slash inside a string";',
    "const re = /a\\/b/g; // trailing comment",
    "/* block\n   comment */",
    "const b = `template ${1 + 1} literal`;",
    "const c = 1 / 2; // division, not a comment",
  ].join("\n");
  const out = minify(src);
  assert.ok(!out.includes("a leading comment"));
  assert.ok(!out.includes("trailing comment"));
  assert.ok(!out.includes("block"));
  assert.ok(out.includes('"keep // this slash-slash inside a string"'));
  assert.ok(out.includes("/a\\/b/g"));
  assert.ok(out.includes("`template ${1 + 1} literal`"));
  assert.ok(out.includes("1 / 2"));
  new Function(out); // still valid JS
});

test("stripExports removes only leading `export` keywords", () => {
  const src = "export function foo() {}\nconst bar = 1; // export in a comment stays untouched here\nexport const baz = 2;";
  const out = stripExports(src);
  assert.ok(!out.includes("export function"));
  assert.ok(!out.includes("export const"));
  assert.ok(out.includes("function foo"));
  assert.ok(out.includes("const baz"));
});

// --- the built bookmarklet -------------------------------------------

test("the built bookmarklet code is valid JS", () => {
  const code = buildBookmarkletCode();
  assert.doesNotThrow(() => new Function(code));
});

test("npm run build:bookmarklet writes bookmarklet.html with a javascript: link", () => {
  execFileSync(process.execPath, [path.join(ROOT, "tools", "build-bookmarklet.mjs")], { cwd: ROOT });
  assert.ok(fs.existsSync(HTML_PATH));
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.match(html, /href="javascript:/);
  assert.match(html, /href="index\.html"/);
});

// --- collectFromDocuments(), the src file's non-DOM-side-effect core -----

function loadCollectFromDocuments() {
  // Reproduce the same concatenation the build does (meetup-import.js's
  // exports made available as bare functions), but WITHOUT calling run()
  // or touching window/document/fetch/clipboard - just to get
  // collectFromDocuments defined so it can be called directly against
  // jsdom documents built from the fixtures.
  const sandbox = { ...meetupImport, console };
  vm.createContext(sandbox);
  const srcText = fs.readFileSync(SRC_PATH, "utf8");
  vm.runInContext(srcText, sandbox, { filename: SRC_PATH });
  assert.equal(typeof sandbox.collectFromDocuments, "function");
  return sandbox.collectFromDocuments;
}

test("bookmarklet/meetup-bookmarklet.src.js defines collectFromDocuments without running anything", () => {
  loadCollectFromDocuments();
});

test(
  "collectFromDocuments produces a payload with 9 attendees from the fixtures",
  { skip: !fixturesAvailable() && "fixture HTML files are not present (gitignored)" },
  () => {
    const collectFromDocuments = loadCollectFromDocuments();
    const attendeesDoc = loadDoc(ATTENDEES_FIXTURE);
    const eventDoc = loadDoc(EVENT_FIXTURE);

    const payload = collectFromDocuments(
      attendeesDoc,
      eventDoc,
      "https://www.meetup.com/playtest/events/316433169/attendees/"
    );

    assert.equal(payload.source, "meetup-bookmarklet");
    assert.equal(payload.attendees.length, 9);
    assert.equal(payload.event.id, "316433169");
    assert.ok(Array.isArray(payload.comments));
    assert.ok(payload.comments.some((c) => /looking for 3-4 other players/i.test(c.text)));
  }
);

test(
  "collectFromDocuments still returns attendees (with a warning) when the event page is unavailable",
  { skip: !fixturesAvailable() && "fixture HTML files are not present (gitignored)" },
  () => {
    const collectFromDocuments = loadCollectFromDocuments();
    const attendeesDoc = loadDoc(ATTENDEES_FIXTURE);

    const payload = collectFromDocuments(attendeesDoc, null, "https://www.meetup.com/playtest/events/316433169/attendees/");

    assert.equal(payload.attendees.length, 9);
    assert.equal(payload.comments.length, 0);
    assert.ok(payload.warnings.length >= 1);
  }
);
