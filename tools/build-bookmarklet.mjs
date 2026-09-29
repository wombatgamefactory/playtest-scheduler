#!/usr/bin/env node
// Builds the Meetup import bookmarklet.
//
// Reads js/meetup-import.js (a real ES module, exported for tests) and
// bookmarklet/meetup-bookmarklet.src.js (plain functions, no exports,
// written to be concatenated straight after it), strips the `export`
// keywords off the first file, concatenates the two inside one IIFE that
// calls the src file's `run()` at the end, lightly minifies the result,
// URI-encodes it into a `javascript:` URL, and writes bookmarklet.html in
// the project root.
//
// No dependencies - this is a small hand-rolled comment/whitespace
// stripper, not a full JS parser. It is deliberately conservative: it only
// removes `//` line comments, `/* */` block comments, and collapses runs of
// whitespace, while leaving string/template literal and regex-literal
// contents completely untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MEETUP_IMPORT_PATH = path.join(ROOT, "js", "meetup-import.js");
const SRC_PATH = path.join(ROOT, "bookmarklet", "meetup-bookmarklet.src.js");
const OUTPUT_HTML_PATH = path.join(ROOT, "bookmarklet.html");

/** Strip top-level `export ` keywords, e.g. "export function foo(" -> "function foo(". */
export function stripExports(source) {
  return source.replace(/^export\s+/gm, "");
}

/**
 * Lightly minify JS: strip `//` and `/* *\/` comments and collapse runs of
 * whitespace, while leaving the contents of string literals ('...', "...",
 * `...`) and regex literals completely alone.
 *
 * This is a small state machine, not a real parser - it is only expected to
 * cope with straightforward code like this project's own source files, not
 * arbitrary third-party JS.
 */
export function minify(source) {
  let out = "";
  let i = 0;
  const n = source.length;

  // The last significant (non-whitespace, non-comment) character emitted,
  // used to decide whether a `/` starts a regex literal or is division.
  let lastSignificant = "";
  const regexPrecedingKeywords = /(^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield)$/;

  function tailOf(str, len) {
    return str.length <= len ? str : str.slice(str.length - len);
  }

  function canBeRegexStart() {
    if (lastSignificant === "") return true;
    if ("([{,;:=!&|?+-*%^~<>".indexOf(lastSignificant) !== -1) return true;
    const tail = tailOf(out.replace(/\s+$/, ""), 12);
    return regexPrecedingKeywords.test(tail);
  }

  while (i < n) {
    const ch = source[i];

    // String literals: copy verbatim, respecting backslash escapes.
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let literal = ch;
      i++;
      while (i < n) {
        const c = source[i];
        literal += c;
        i++;
        if (c === "\\") {
          if (i < n) {
            literal += source[i];
            i++;
          }
          continue;
        }
        if (c === quote) break;
      }
      out += literal;
      lastSignificant = quote;
      continue;
    }

    // Comments.
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Regex literals (best-effort): only treated as regex when a `/` shows
    // up somewhere a value (not division) would be expected.
    if (ch === "/" && canBeRegexStart()) {
      let literal = "/";
      i++;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        literal += c;
        i++;
        if (c === "\\") {
          if (i < n) {
            literal += source[i];
            i++;
          }
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      // Trailing flags.
      while (i < n && /[a-z]/i.test(source[i])) {
        literal += source[i];
        i++;
      }
      out += literal;
      lastSignificant = "/";
      continue;
    }

    // Whitespace: collapse a run to a single space (or a single newline if
    // the run contains one, which keeps ASI-sensitive code safe).
    if (/\s/.test(ch)) {
      let hasNewline = false;
      let j = i;
      while (j < n && /\s/.test(source[j])) {
        if (source[j] === "\n") hasNewline = true;
        j++;
      }
      out += hasNewline ? "\n" : " ";
      i = j;
      continue;
    }

    out += ch;
    lastSignificant = ch;
    i++;
  }

  return out;
}

export function buildBookmarkletCode() {
  const meetupImportSrc = stripExports(readFileSync(MEETUP_IMPORT_PATH, "utf8"));
  const bookmarkletSrc = readFileSync(SRC_PATH, "utf8");

  const combined =
    '(function(){"use strict";\n' +
    meetupImportSrc +
    "\n" +
    bookmarkletSrc +
    "\ntry{run();}catch(e){try{window.alert('Playtest import error: '+((e&&e.message)?e.message:e));}catch(e2){}}" +
    "\n})();";

  return minify(combined);
}

function buildHtml(bookmarkletCode) {
  const href = "javascript:" + encodeURIComponent(bookmarkletCode);
  const hrefAttr = href.replace(/"/g, "&quot;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install the Meetup import bookmarklet</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --fg: #1b1f27;
    --card: #ffffff;
    --border: #d8dbe0;
    --accent: #2a63e4;
    --accent-fg: #ffffff;
    --muted: #5b606b;
    --code-bg: #eef0f3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #f0f1f3;
      --card: #1c1f26;
      --border: #33363d;
      --accent: #6d9bff;
      --accent-fg: #0d1117;
      --muted: #a6abb5;
      --code-bg: #12141a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    padding: 24px 16px 64px;
  }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 32px 0 8px; }
  p { color: var(--fg); }
  .muted { color: var(--muted); font-size: 0.95em; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin: 16px 0;
  }
  .bookmarklet-link {
    display: inline-block;
    background: var(--accent);
    color: var(--accent-fg);
    text-decoration: none;
    font-weight: 600;
    padding: 12px 20px;
    border-radius: 8px;
    cursor: grab;
    touch-action: none;
  }
  .drag-hint { margin-top: 10px; }
  button {
    font: inherit;
    background: var(--accent);
    color: var(--accent-fg);
    border: 0;
    border-radius: 8px;
    padding: 12px 18px;
    cursor: pointer;
  }
  button.secondary {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  code, .code-box {
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  code { padding: 2px 5px; }
  .code-box {
    display: block;
    padding: 10px;
    max-height: 160px;
    overflow: auto;
    word-break: break-all;
    white-space: pre-wrap;
    margin-top: 10px;
  }
  ol { padding-left: 22px; }
  li { margin-bottom: 8px; }
  a { color: var(--accent); }
  .status { margin-top: 8px; font-size: 0.9em; color: var(--muted); }
  nav.back { margin-bottom: 8px; }
</style>
</head>
<body>
<main>
  <nav class="back"><a href="index.html">&larr; Back to the scheduler</a></nav>
  <h1>Install the Meetup import bookmarklet</h1>
  <p class="muted">It only reads the Meetup pages you're already viewing in your own logged-in browser, and stores nothing. Nothing is sent anywhere except back to this scheduler, via your clipboard.</p>

  <section class="card">
    <h2 style="margin-top:0;">Desktop: drag the button to your bookmarks bar</h2>
    <p><a class="bookmarklet-link" href="${hrefAttr}" onclick="return false;">Playtest import</a></p>
    <p class="drag-hint muted">Drag it up onto your browser's bookmarks bar (show it first if it's hidden - usually Ctrl/Cmd+Shift+B). Then open a Meetup event's Attendees page and click the bookmark.</p>
  </section>

  <section class="card">
    <h2 style="margin-top:0;">Phone: create a bookmark, then paste this code into it</h2>
    <ol>
      <li>Copy the bookmarklet code below.</li>
      <li><strong>Chrome on Android:</strong> bookmark any page (star icon or menu &rarr; Add to bookmarks), then open Bookmarks, edit that bookmark, and replace its URL with the copied code. Save.</li>
      <li><strong>Safari on iOS:</strong> bookmark any page (Share &rarr; Add Bookmark), then open Bookmarks, tap Edit, tap the bookmark, and replace its URL with the copied code. Save.</li>
      <li>Open a Meetup event's Attendees page in that browser, then open your bookmarks and tap the one you just edited.</li>
    </ol>
    <button id="copy-code-btn" type="button">Copy bookmarklet code</button>
    <p id="copy-status" class="status" hidden></p>
    <code class="code-box" id="code-box">${href}</code>
  </section>

  <section class="card">
    <h2 style="margin-top:0;">Using it</h2>
    <ol>
      <li>Open the event's <strong>Attendees</strong> page on meetup.com.</li>
      <li>Click/tap the bookmarklet. A small overlay appears in the corner while it collects attendees and event comments.</li>
      <li>When it's done, the import JSON is on your clipboard (or shown in a text box to copy by hand). Paste it into the scheduler's <strong>Import from Meetup</strong> box on the Evening tab.</li>
    </ol>
    <p class="muted">If Meetup's page layout has changed and the bookmarklet can't find something, it shows what went wrong rather than failing silently - fall back to pasting a plain list of names into the same import box.</p>
  </section>
</main>
<script>
(function () {
  var btn = document.getElementById("copy-code-btn");
  var status = document.getElementById("copy-status");
  var codeBox = document.getElementById("code-box");
  btn.addEventListener("click", function () {
    var text = codeBox.textContent;
    function done(ok) {
      status.hidden = false;
      status.textContent = ok ? "Copied." : "Couldn't copy automatically - select the text below and copy it manually.";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  });
})();
</script>
</body>
</html>
`;
}

function main() {
  const code = buildBookmarkletCode();
  const html = buildHtml(code);
  writeFileSync(OUTPUT_HTML_PATH, html, { encoding: "utf8" });
  const href = "javascript:" + encodeURIComponent(code);
  console.log("Wrote " + OUTPUT_HTML_PATH);
  console.log("Bookmarklet javascript: URL length: " + href.length + " characters");
}

// Only run when executed directly (not when imported by tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
