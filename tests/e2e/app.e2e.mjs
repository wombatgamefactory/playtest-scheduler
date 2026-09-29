#!/usr/bin/env node
// End-to-end browser test for the Playtest Scheduler app.
//
// A plain Node script (not under `node --test` - see tests/**/*.test.mjs for
// the unit suite). It starts its own static file server for the project
// root, drives Chromium via Playwright at a 390x844 phone viewport, and
// exits non-zero if any flow fails. Run with `npm run e2e`.
//
// The flows below follow one continuous story (load demo -> schedule -> copy
// -> post-it -> move a table -> replan -> reload -> import -> paste -> finish
// -> export/restore -> layout checks -> bookmarklet page), because that's
// how a real evening actually uses the app and most steps depend on state
// left by the previous one. Each flow is still wrapped in its own try/catch
// so a failure is reported clearly and, where the state allows it, later
// independent checks (e.g. the no-horizontal-scroll and bookmarklet.html
// checks) still run.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';

import {
  parseAttendeesFromDocument,
  parseEventFromDocument,
  parseCommentsFromDocument,
  buildImportPayload,
} from '../../js/meetup-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');
const ATTENDEES_FIXTURE = path.join(FIXTURES_DIR, 'meetup-attendees-page.html');
const EVENT_FIXTURE = path.join(FIXTURES_DIR, 'meetup-event-page.html');
const FIXTURES_AVAILABLE = fs.existsSync(ATTENDEES_FIXTURE) && fs.existsSync(EVENT_FIXTURE);

const DEMO_DESIGNERS = ['Dean', 'Francesco', 'Tari', 'Shan', 'Miquel', 'Dotun', 'Faryad', 'Adi'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- server

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(ROOT, reqPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- browser launch

// A fresh `npm install playwright` can expect a Chromium build that isn't on
// disk yet under %LOCALAPPDATA%\ms-playwright (see the ledger's shared
// context). Prefer the normal launch (works once `npx playwright install
// chromium` has run); if the expected build is missing, fall back to the
// newest chromium-* build that IS present.
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (err) {
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    let fallback = null;
    if (fs.existsSync(base)) {
      const candidates = fs.readdirSync(base)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10));
      for (const dir of candidates) {
        const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(exe)) { fallback = exe; break; }
      }
    }
    if (!fallback) throw err;
    console.log(`(default Chromium build missing; falling back to ${fallback})`);
    return chromium.launch({ executablePath: fallback });
  }
}

// ---------------------------------------------------------------- small helpers

function nameAndCount(rowText) {
  // "Francesco +1" / "Shan +3 over max" -> { name: "Francesco", testers: 1 }
  const m = rowText.match(/^(.*?)\s*\+(\d+)/);
  return m ? { name: m[1].trim(), testers: parseInt(m[2], 10) } : { name: rowText.trim(), testers: null };
}

async function readSessions(page) {
  return page.$$eval('#tab-schedule .session-card', (cards) => cards.map((c) => ({
    header: c.querySelector('.session-header').textContent.trim(),
    locked: c.classList.contains('locked'),
    rows: Array.from(c.querySelectorAll('.table-row span')).map((s) => s.textContent.trim()),
  })));
}

function assertWhatsAppFormat(rawText, sessionCount) {
  // The system clipboard on Windows normalises "\n" to "\r\n" (a platform
  // quirk of Chromium's clipboard write, not something formatWhatsApp()
  // controls - its own source string uses "\n"), so normalise before
  // comparing rather than asserting on the exact bytes that round-tripped
  // through the OS clipboard.
  const text = rawText.replace(/\r\n/g, '\n');
  const blocks = text.split('\n\n');
  assert.equal(blocks.length, sessionCount, `expected ${sessionCount} blank-line-separated session blocks, got ${blocks.length}\n---\n${text}\n---`);
  blocks.forEach((block, i) => {
    const lines = block.split('\n');
    assert.match(lines[0], /^Session \d+ \d{1,2}:\d{2} - \d{1,2}:\d{2}$/, `session ${i + 1} header line: "${lines[0]}"`);
    for (const line of lines.slice(1)) {
      assert.match(line, /^- .+ \+\d+$/, `table line: "${line}"`);
    }
  });
}

// ---------------------------------------------------------------- main

// Per-action cap (page.click/fill/waitForEvent/etc.) so a single stuck
// locator or an unhandled dialog fails that one action in 10s instead of
// hanging the whole run.
const DEFAULT_ACTION_TIMEOUT_MS = 10000;
// Whole-run cap. If a step manages to hang anyway (e.g. waiting on a promise
// that isn't a Playwright action, so the per-action timeout above doesn't
// apply), this aborts the run instead of leaving `npm run e2e` stuck.
const WATCHDOG_MS = 180000;

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await launchChromium();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err && err.stack || err)));
  page.on('dialog', (d) => { d.accept(); }); // native confirm() used by data import

  const failures = [];
  let stepNum = 0;
  async function flow(name, fn, { skip = false } = {}) {
    stepNum++;
    if (skip) { console.log(`SKIP ${stepNum}. ${name}`); return; }
    console.log(`-->  ${stepNum}. ${name}`); // logged before running, so a hang shows exactly where
    try {
      await fn();
      console.log(`ok   ${stepNum}. ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.error(`FAIL ${stepNum}. ${name}`);
      console.error('     ' + (err && err.stack ? err.stack.split('\n').join('\n     ') : String(err)));
      try {
        const shotPath = path.join(os.tmpdir(), `gm-e2e-failure-${stepNum}.png`);
        await page.screenshot({ path: shotPath, timeout: 5000 });
        console.error(`     screenshot: ${shotPath}`);
      } catch { /* best effort */ }
    }
  }

  const clickTab = (tab) => page.click(`.tab-btn[data-tab="${tab}"]`);
  const settle = (ms = 150) => page.waitForTimeout(ms);

  // Everything from here down runs under the watchdog and is guaranteed to
  // close the browser and server in `finally`, whether it finishes, a flow
  // throws past its own try/catch, or the watchdog itself fires first.
  let watchdogTimer;
  const watchdog = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => reject(new Error(
      `Watchdog: the run exceeded ${WATCHDOG_MS / 1000}s. The last "-->" line above without a matching "ok"/"FAIL" is the step that hung ` +
      '(likely an unhandled dialog, a locator that never resolves, or a download/filechooser wait with no matching event).'
    )), WATCHDOG_MS);
  });
  // Belt-and-braces: if even the `finally` cleanup below hangs (e.g.
  // browser.close() itself stalls), force the process to exit shortly after
  // the watchdog fires rather than leaving `npm run e2e` running forever.
  const hardKill = setTimeout(() => {
    console.error('WATCHDOG: still alive well after the deadline - forcing process exit.');
    process.exit(1);
  }, WATCHDOG_MS + 15000);
  hardKill.unref();

  // All 13 flows, run in order. Defined as one function so it can be raced
  // against the watchdog above; state (demoSessionCount etc.) is shared via
  // closures the same way it would be as plain top-level statements.
  async function runFlows() {
  // -- 1. No console errors on load ---------------------------------------
  await flow('no console errors on load', async () => {
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' });
    await settle(100);
    assert.deepEqual(consoleErrors, [], `console errors on load: ${JSON.stringify(consoleErrors)}`);
  });

  // -- 2. Load demo, Schedule ----------------------------------------------
  let demoSessionCount = 0;
  await flow('load demo evening then Schedule: 3 sessions, all 8 designers once, Dean in Session 1', async () => {
    await page.click('[data-action="load-demo"]');
    await clickTab('schedule');
    await page.click('#tab-schedule [data-action="schedule"]');
    await settle();

    const sessions = await readSessions(page);
    demoSessionCount = sessions.length;
    assert.equal(sessions.length, 3, `expected 3 sessions, got ${sessions.length}`);

    const seen = new Map();
    for (const s of sessions) {
      for (const rowText of s.rows) {
        const { name } = nameAndCount(rowText);
        seen.set(name, (seen.get(name) || 0) + 1);
      }
    }
    for (const designer of DEMO_DESIGNERS) {
      assert.equal(seen.get(designer), 1, `${designer} should appear exactly once across sessions, appeared ${seen.get(designer) || 0} times`);
    }
    const session1Names = sessions[0].rows.map((r) => nameAndCount(r).name);
    assert.ok(session1Names.includes('Dean'), `Dean should be in Session 1, session 1 has: ${session1Names.join(', ')}`);
  });

  // -- 2b. Fixed tab bar never covers content (polish item) ----------------
  await flow('scrolled to the bottom, the last Schedule button is fully visible above the tab bar', async () => {
    const rects = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const tabbar = document.querySelector('nav.tabbar').getBoundingClientRect();
      const finishBtn = document.querySelector('#tab-schedule [data-action="finish-evening"]');
      const btnRect = finishBtn.getBoundingClientRect();
      return { tabbarTop: tabbar.top, btnTop: btnRect.top, btnBottom: btnRect.bottom, viewportH: window.innerHeight };
    });
    assert.ok(rects.btnBottom <= rects.tabbarTop + 0.5,
      `Finish evening button (bottom ${rects.btnBottom}) should be fully above the tab bar (top ${rects.tabbarTop})`);
    assert.ok(rects.btnTop >= 0 && rects.btnBottom <= rects.viewportH,
      `Finish evening button (${rects.btnTop}-${rects.btnBottom}) should be within the viewport (0-${rects.viewportH}) after scrolling to the bottom`);
  });

  // -- 3. Copy for WhatsApp --------------------------------------------------
  await flow('Copy for WhatsApp produces the exact text format', async () => {
    await page.click('[data-action="copy-whatsapp"]');
    await settle(200);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assertWhatsAppFormat(text, demoSessionCount);
  });

  // -- 4. Post-it view --------------------------------------------------------
  await flow('Post-it view shows end times and is genuinely full-screen', async () => {
    await page.click('[data-action="postit-open"]');
    await settle(100);
    const info = await page.evaluate(() => {
      const overlay = document.getElementById('postit-overlay');
      const cs = getComputedStyle(overlay);
      const rect = overlay.getBoundingClientRect();
      const endTexts = Array.from(document.querySelectorAll('.postit-end')).map((e) => e.textContent.trim());
      const tabbar = document.querySelector('nav.tabbar');
      const tabbarZ = parseInt(getComputedStyle(tabbar).zIndex, 10);
      return {
        hidden: overlay.classList.contains('hidden'),
        zIndex: parseInt(cs.zIndex, 10),
        tabbarZ,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        endTexts,
      };
    });
    assert.equal(info.hidden, false, 'post-it overlay should be visible after opening it');
    assert.equal(info.endTexts.length, demoSessionCount, `expected ${demoSessionCount} "ends H:MM" cards, got ${info.endTexts.length}`);
    for (const t of info.endTexts) assert.match(t, /^ends \d{1,2}:\d{2}$/, `post-it end time text: "${t}"`);
    assert.ok(info.zIndex > info.tabbarZ, `overlay z-index (${info.zIndex}) should be above the tab bar's (${info.tabbarZ})`);
    assert.deepEqual(info.rect, { x: 0, y: 0, width: info.viewportW, height: info.viewportH },
      'overlay should cover the full viewport (header, tab bar and Schedule button included)');

    await page.click('[data-action="postit-close"]');
    await settle(50);
    const stillHidden = await page.$eval('#postit-overlay', (el) => el.classList.contains('hidden'));
    assert.equal(stillHidden, true, 'Close button should hide the post-it overlay');
  });

  // -- 5. Move a table to another session; pin honoured -----------------------
  await flow('Move a table to another session: the pin is honoured', async () => {
    const moves = await page.$$eval('[data-action="move-session"]', (els) => els.map((el) => ({
      person: el.dataset.person,
      value: el.value,
      options: Array.from(el.options).map((o) => o.value),
    })));
    assert.ok(moves.length > 0, 'expected at least one "move to session" control');
    const mv = moves.find((m) => m.options.some((v) => v !== m.value));
    assert.ok(mv, 'expected at least one designer with another session to move to');
    const targetVal = mv.options.find((v) => v !== mv.value);

    // Look up the designer's display name from the currently rendered row.
    const personName = await page.$eval(`[data-action="move-session"][data-person="${mv.person}"]`, (el) => {
      const row = el.closest('.table-row');
      return row.querySelector('span').textContent.trim();
    }).then((t) => nameAndCount(t).name);

    await page.selectOption(`[data-action="move-session"][data-person="${mv.person}"]`, targetVal);
    await settle();

    const after = await readSessions(page);
    const targetSession = after[parseInt(targetVal, 10) - 1];
    assert.ok(targetSession, `no session at target index ${targetVal}`);
    const namesInTarget = targetSession.rows.map((r) => nameAndCount(r).name);
    assert.ok(namesInTarget.includes(personName),
      `expected ${personName} to be pinned into session ${targetVal}, but that session has: ${namesInTarget.join(', ')}`);
  });

  // -- 6. Mark Session 1 played, Faryad leaving now, Replan -------------------
  await flow('Mark session played + Faryad leaving now + Replan: Session 1 unchanged, Faryad warned', async () => {
    const before = await readSessions(page);
    const session1Before = before[0];

    await page.click('[data-action="mark-played"]');
    await settle();

    await clickTab('people');
    await page.click('[data-action="expand"][data-person="faryad"]');
    await page.click('[data-action="leaving-now"][data-person="faryad"]');

    await clickTab('schedule');
    await page.click('#tab-schedule [data-action="schedule"]'); // now labelled "Replan"
    await settle();

    const after = await readSessions(page);
    assert.equal(after[0].locked, true, 'Session 1 should be locked (played) after Replan');
    assert.deepEqual(after[0].rows, session1Before.rows, 'Session 1 tables should be unchanged by Replan');

    const warningsText = await page.$$eval('#tab-schedule .warn-panel, #tab-schedule .error-panel',
      (els) => els.map((e) => e.textContent).join(' '));
    assert.match(warningsText, /Faryad/, `expected a warning mentioning Faryad, got: "${warningsText}"`);
  });

  // -- 7. Reload: state persists ----------------------------------------------
  await flow('Reload: state persists', async () => {
    const before = await readSessions(page);
    await page.reload({ waitUntil: 'load' });
    await settle(100);
    await clickTab('schedule');
    const after = await readSessions(page);
    assert.deepEqual(after, before, 'sessions should be identical after a reload');
  });

  // -- 8. Import from Meetup fixtures -----------------------------------------
  await flow('Import: 9 attendees, Shan suggested 3-4 testers, gtcheung89 not added', async () => {
    // Start this check from a clean evening: the demo evening already uses
    // the same 9 Meetup names as the fixtures (by design, so the demo
    // matches the fixture's real evening), so importing on top of it would
    // just merge into the existing 9 people and Shan already has a 3-4 game
    // from the demo - which would pass even if import were broken. "New
    // evening" saves the demo to the log and clears attendance, giving a
    // fresh, meaningful test of the import path itself.
    await clickTab('evening');
    await page.click('[data-action="new-evening"]');
    await settle(100);

    const attendeesDoc = new JSDOM(fs.readFileSync(ATTENDEES_FIXTURE, 'utf8')).window.document;
    const eventDoc = new JSDOM(fs.readFileSync(EVENT_FIXTURE, 'utf8')).window.document;
    const attendees = parseAttendeesFromDocument(attendeesDoc);
    const event = parseEventFromDocument(eventDoc);
    const comments = parseCommentsFromDocument(eventDoc);
    const payload = buildImportPayload({
      event, eventId: 'e2e-test', url: 'https://www.meetup.com/test-group/events/e2e-test/',
      attendees, attendeeCountShown: attendees.length, comments, warnings: [],
    });

    await page.fill('#import-text', JSON.stringify(payload));
    await page.click('[data-action="import"]');
    await settle(100);

    await clickTab('people');
    const peopleText = await page.$eval('#tab-people', (el) => el.textContent);
    assert.match(peopleText, /Here 9\b/, `expected "Here 9" in the People header, got: ${peopleText.match(/Here \d+[^\n]*/)}`);
    assert.equal(peopleText.includes('gtcheung89'), false, 'gtcheung89 (a commenter, not an attendee) should not appear as a person');

    await page.click('[data-action="expand"][data-person="shan"]');
    const shanValues = await page.$$eval('.person-row:has([data-action="expand"][data-person="shan"]) .stepper-value',
      (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(shanValues, ['3', '3', '4'], `Shan's testers should be suggested Min/Preferred/Max = 3/3/4, got ${shanValues}`);
  }, { skip: !FIXTURES_AVAILABLE });

  // -- 9. Paste a plain list of names ------------------------------------------
  await flow('Paste a plain list of names adds people', async () => {
    await clickTab('evening');
    const beforeCount = await page.$eval('#tab-people .counts', (el) => el.textContent).catch(() => null);
    await clickTab('people');
    const beforeText = await page.$eval('#tab-people', (el) => el.textContent);
    const beforeHere = parseInt(beforeText.match(/Here (\d+)/)[1], 10);

    await clickTab('evening');
    await page.fill('#import-text', 'Grace\n- Henry +2\n1. Ivy');
    await page.click('[data-action="import"]');
    await settle(100);

    await clickTab('people');
    const afterText = await page.$eval('#tab-people', (el) => el.textContent);
    const afterHere = parseInt(afterText.match(/Here (\d+)/)[1], 10);
    assert.equal(afterHere, beforeHere + 3, `expected 3 more people present (Grace, Henry, Ivy); before ${beforeHere}, after ${afterHere}`);
    for (const n of ['Grace', 'Henry', 'Ivy']) {
      assert.ok(afterText.includes(n), `expected "${n}" in the People list`);
    }
  }, { skip: !FIXTURES_AVAILABLE });

  // -- 10. Finish evening: the log shows it ------------------------------------
  let logEntriesBeforeExport = null;
  await flow('Finish evening: the log shows it', async () => {
    // Shan is the only designer left after flows 8-9 (fresh import + a plain
    // paste of non-designer walk-ins). With only one game, the whole evening
    // becomes one session covering the full 18:45-21:00/22:00 span, which is
    // longer than the scheduler's hard 120-minute ceiling - a genuine,
    // correctly-reported error (see scheduler.js's session-length bound),
    // not a bug. Give Miquel a game too (his settings come back from the
    // roster, which remembers his testers/duration from the demo evening
    // earlier in this same run - itself a real behaviour worth touching) so
    // there's a schedulable evening to finish.
    await clickTab('people');
    await page.click('[data-action="expand"][data-person="miquel"]');
    await page.check('[data-checkbox="game"][data-person="miquel"]');
    await settle(100);

    await clickTab('schedule');
    await page.click('#tab-schedule [data-action="schedule"]');
    await settle(150);
    // Compare a plain boolean, never a raw ElementHandle: assert's failure
    // diff serialises "actual", and util.inspect on a Playwright handle's
    // heavy internal channel graph can blow the heap instead of failing cleanly.
    const errorCount = await page.locator('#tab-schedule .error-panel').count();
    if (errorCount > 0) {
      const errorText = await page.locator('#tab-schedule .error-panel').first().innerText();
      assert.fail(`expected schedule() to succeed (Shan has an imported game) rather than error: "${errorText}"`);
    }

    await clickTab('log');
    const beforeLog = await page.$$eval('.log-entry', (els) => els.length);

    await clickTab('schedule');
    await page.click('[data-action="finish-evening"]');
    await settle(150);

    await clickTab('log');
    const afterLog = await page.$$eval('.log-entry', (els) => els.length);
    assert.equal(afterLog, beforeLog + 1, `expected one more log entry after Finish evening (${beforeLog} -> ${afterLog})`);
    logEntriesBeforeExport = afterLog;
  }, { skip: !FIXTURES_AVAILABLE });

  // -- 11. Export data, clear it, import it back -------------------------------
  await flow('Export data, clear it, then import it back restores the data', async () => {
    await clickTab('log');
    const detailsOpen = await page.$('details.data-area[open]');
    if (!detailsOpen) await page.click('details.data-area summary');

    const expectedEntries = logEntriesBeforeExport ?? await page.$$eval('.log-entry', (els) => els.length);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-action="export-data"]'),
    ]);
    const downloadedPath = await download.path();
    assert.ok(downloadedPath, 'expected Export data to trigger a download');
    const exportedJson = fs.readFileSync(downloadedPath, 'utf8');
    const exported = JSON.parse(exportedJson); // throws if not valid JSON
    assert.ok(Array.isArray(exported.log) && exported.log.length === expectedEntries,
      `exported log should have ${expectedEntries} entries, got ${exported.log && exported.log.length}`);

    // Simulate a wiped browser, then confirm it really is empty.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'load' });
    await settle(100);
    await clickTab('log');
    const clearedText = await page.$eval('#tab-log', (el) => el.textContent);
    assert.match(clearedText, /No evenings finished yet/, 'log should be empty after clearing localStorage');

    const tmpFile = path.join(os.tmpdir(), `gm-e2e-export-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, exportedJson);
    try {
      await page.click('details.data-area summary');
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.click('[data-action="import-data"]'),
      ]);
      await chooser.setFiles(tmpFile);
      await settle(150); // dialog auto-accepted by the page-level handler above
      const restoredText = await page.$eval('#tab-log', (el) => el.textContent);
      assert.doesNotMatch(restoredText, /No evenings finished yet/, 'log should be restored after Import data');
      const restoredCount = await page.$$eval('.log-entry', (els) => els.length);
      assert.equal(restoredCount, expectedEntries, `expected ${expectedEntries} restored log entries, got ${restoredCount}`);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }, { skip: !FIXTURES_AVAILABLE });

  // -- 12. No horizontal scroll at 390px and 360px -----------------------------
  await flow('No horizontal scroll at 390px and 360px, on every tab', async () => {
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(50);
      for (const tab of ['evening', 'people', 'schedule', 'log']) {
        await clickTab(tab);
        const dims = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        assert.ok(dims.scrollWidth <= dims.clientWidth + 1,
          `horizontal scroll at ${width}px on the "${tab}" tab: scrollWidth ${dims.scrollWidth} > clientWidth ${dims.clientWidth}`);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });

  // -- 13. bookmarklet.html loads without errors --------------------------------
  await flow('bookmarklet.html loads without console errors', async () => {
    const bmErrors = [];
    const bmPage = await context.newPage();
    bmPage.on('console', (msg) => { if (msg.type() === 'error') bmErrors.push(msg.text()); });
    bmPage.on('pageerror', (err) => bmErrors.push(String(err && err.stack || err)));
    const response = await bmPage.goto(`${baseUrl}/bookmarklet.html`, { waitUntil: 'load' });
    assert.ok(response && response.ok(), `bookmarklet.html should load with a 2xx status, got ${response && response.status()}`);
    await bmPage.waitForTimeout(150);
    assert.deepEqual(bmErrors, [], `console errors on bookmarklet.html: ${JSON.stringify(bmErrors)}`);
    await bmPage.close();
  });

  } // end runFlows()

  try {
    await Promise.race([runFlows(), watchdog]);
  } finally {
    clearTimeout(watchdogTimer);
    clearTimeout(hardKill);
    await browser.close().catch(() => {});
    server.close();
  }

  if (!FIXTURES_AVAILABLE) {
    console.log('\n(Meetup fixtures not found under tests/fixtures/ - import-dependent flows were skipped, as intended.)');
  }
  console.log(`\n${stepNum - failures.length}/${stepNum} flows passed.`);
  if (consoleErrors.length) {
    console.log(`Console errors seen during the run (${consoleErrors.length}): ${JSON.stringify(consoleErrors)}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} flow(s) FAILED:`);
    for (const f of failures) console.error(` - ${f.name}: ${f.err.message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('e2e run crashed:', err);
  process.exitCode = 1;
});
