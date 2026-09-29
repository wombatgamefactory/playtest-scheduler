# Playtest UK Evening Scheduler - Build

- Goal: Build the static web tool described in `S:\Dropbox\dev\Cardboard\Game-Matcher\scheduler-plan-v2.md`: attendance, game entry, one-press scheduling, WhatsApp copy, post-it view, live replanning, log, Meetup bookmarklet import.
- Created: 29/09/2026
- Run status: done
- Output location: S:\Dropbox\dev\Cardboard\Game-Matcher\

## Shared context (every brief assumes this)

- Project root: `S:\Dropbox\dev\Cardboard\Game-Matcher\` (Windows; Node 24, npm, git, gh, Python 3.14 and Playwright browsers are installed). The plan is `scheduler-plan-v2.md` in the root - read it first.
- User: Dean, a board game designer who co-hosts Playtest UK evenings in London. British English in all UI text and docs. Dates DD/MM/YYYY. Times are shown to users as 12-hour without am/pm ("6:45", "9:20"), because everything happens in the evening.
- Tech: static site, vanilla JavaScript ES modules, **no runtime dependencies, no build step for the app**. Dev-only npm packages (jsdom, playwright) are allowed for tests. Hosted later on GitHub Pages.
- New files use lowercase kebab-case names, no spaces. Never overwrite a file you did not create in this task unless the brief says so.
- Windows traps: use absolute paths; don't rely on `cd` persisting between shell calls; no backslash paths inside `python -c` one-liners; write files with LF line endings.
- Privacy: the two `.mhtml` samples and anything decoded from them contain real attendees' names and photos. They must stay out of git (`.gitignore`) and never be published.
- Key vocabulary: a **designer** brings a game and runs it for one whole session. **Testers** play it. "+N" means N testers plus the designer. A **watcher** is a designer who isn't running their game that session and sits out because the tables are full. The **organiser** is Dean, whose game always goes in Session 1.

## Tasks

### T0 - Project scaffold and test fixtures
- Status: done
- Depends on: -
- Worker: delegate-haiku
- Why this rung: mechanical setup with exact instructions.
- Brief: In `S:\Dropbox\dev\Cardboard\Game-Matcher\`:
  1. Create folders `js\`, `css\`, `tests\`, `tests\fixtures\`, `bookmarklet\`, `tools\`.
  2. Create `package.json`: `{"name":"playtest-scheduler","private":true,"type":"module","scripts":{"test":"node --test tests/"}}`, then run `npm install --save-dev jsdom` in the project root.
  3. Create `.gitignore` containing: `node_modules/`, `*.mhtml`, `tests/fixtures/`, `test-results/`, `playwright-report/`.
  4. Decode the two saved Meetup pages into plain HTML fixtures. Write a Python script at `S:\Dropbox\dev\Cardboard\Game-Matcher\tools\decode-mhtml.py` that takes an input .mhtml path and an output .html path, parses the file with `email.message_from_binary_file(..., policy=email.policy.default)`, and writes the **first** `text/html` part's `get_content()` as UTF-8. Run it twice:
     - `Sample_Meetup.mhtml` → `tests\fixtures\meetup-event-page.html`
     - `Attendees.mhtml` → `tests\fixtures\meetup-attendees-page.html`
  5. Run `git init` in the project root (no commit).
- Acceptance: folders exist; `package.json` is valid JSON with jsdom in devDependencies and `node_modules\jsdom` exists; `.gitignore` has the five lines; both fixture files exist, are over 200 KB, and contain "Francesco Salerno" (attendees) and "3-4 other players" (event); `git status` works and does not list any `.mhtml` or fixture file.
- Attempts: 1
- Result: Scaffold, jsdom, .gitignore, fixtures (578 KB / 320 KB) and git init done; the manager verified that the .mhtml files and tests/fixtures are ignored. `origin` remote added (private, empty repo).

### T1 - Scheduler core and tests
- Status: done
- Depends on: T0
- Worker: delegate-opus-medium
- Why this rung: a constrained search with soft scoring and subtle invariants. It needs judgement to get right.
- Brief: Read `S:\Dropbox\dev\Cardboard\Game-Matcher\scheduler-plan-v2.md` (sections "Hard rules", "Soft rules", "Scheduling algorithm"). Write `S:\Dropbox\dev\Cardboard\Game-Matcher\js\scheduler.js`: a pure ES module with no imports and no DOM, usable from both the browser and Node. Also write `S:\Dropbox\dev\Cardboard\Game-Matcher\tests\scheduler.test.mjs` using `node:test` and `node:assert`. Do not edit `package.json`.

  **API (other tasks are coded against this contract - keep it exactly):**
  ```js
  export function schedule(input) // → { options: Option[], error: null | { message, suggestions: string[] } }
  export function toMinutes("18:45") // → 1125
  export function fromMinutes(1125)  // → "18:45"
  export function formatTime12("21:05") // → "9:05"
  ```
  `input`:
  ```js
  {
    start: "18:45",                        // first new session starts here (24h HH:MM)
    earliestEnd: "21:00", latestEnd: "22:00", endStep: 15,  // candidate evening end times
    fixedEnd: null,                        // "21:30" forces a single end time
    changeoverMins: 0,                     // gap between sessions (back-to-back by default)
    graceMins: 10,                         // presence tolerance at session edges
    people: [{
      id: "p1", name: "Dean", present: true,
      arrive: null,                        // null = there from the start
      leave: null,                         // null = stays to the end
      arrivalOrder: 1,                     // lower = arrived earlier
      isOrganiser: true,
      game: null | { testersMin: 1, testersMax: 2, testersPreferred: 1, durationMins: 60 }
    }],
    locked: [],        // already-played sessions: [{ start, end, tables: [{ designerId, testers }] }]
    replanFrom: null,  // "20:45": when set, new sessions start here instead of `start`
    pins: {}           // { designerId: newSessionIndex (0-based) } manual placements to honour
  }
  ```
  `Option`:
  ```js
  { id, sessionCount, sessionLengthMins, end: "21:45",
    sessions: [{ index, start, end, locked: bool,
                 tables: [{ designerId, name, testers, testersMin, testersMax, overMax: bool, underMin: bool }],
                 watchers: [personId], presentCount }],
    unscheduled: [designerId],
    warnings: [{ type: "duration"|"overMax"|"underMin"|"unscheduled"|"lengthOutsideBand"|"other", message, personId? }],
    score }
  ```
  Return up to 3 options, best first, that differ meaningfully (a different session count or end time). Locked sessions come first in `sessions` unchanged, with `locked: true`. Messages are plain British English and use display names and 12-hour times.

  **Rules.**
  - Only `present: true` people count.
  - A person is *in* a session if `arrive ≤ start + grace` and `leave ≥ end − grace`.
  - Every game with a present designer is played exactly once. Games already in `locked` are not scheduled again, but their designers still count as testers.
  - The organiser's game goes in the first new session.
  - A designer must be in the session where their game runs.
  - Every new session has at least one table.
  - New sessions all have the same length and run back-to-back (plus `changeoverMins`) from `start` (or `replanFrom`) to the chosen end. The hard floor is 30 minutes and the hard ceiling is 120 minutes.
  - Seating in a session:
    - everyone in the session who isn't running a game is a tester, split across the tables;
    - start from each table's preferred count and stay within min–max;
    - if there are more people than max seats, designers who aren't running become watchers (never a non-designer);
    - only if seats are still short, go over max, with an `overMax` warning.
  - If no strict solution exists, relax to a table under min or over max (with warnings). Only as a last resort leave games unscheduled (with an `unscheduled` warning). Never throw. If no one present has a game, return an `error` with a message.
  - Scoring, most important first:
    1. fewer unscheduled games;
    2. fewer min/max violations;
    3. session length inside 45–60 minutes (gentle penalty up to 90, steep beyond);
    4. use the evening fully: prefer later ends where still feasible;
    5. tables close to their preferred counts;
    6. fewer watchers;
    7. balanced headcount across sessions;
    8. earlier arrivals' games in earlier sessions (small weight).
  - A `duration` warning is raised when a game's `durationMins` is longer than the session length. It is a warning only.
  - Performance: 15 designers plus 15 testers must solve in under 500 ms.

  **Required tests** (named fixtures, all passing with `node --test tests/`):
  - A, the real 28/09 evening. Start 18:45, ends 21:00-22:00. Games as min-max/preferred:
    - Dean (organiser) 1-2/1
    - Francesco 1-2/1
    - Tari 1-2/1
    - Shan 3-4/3
    - Miquel 2-3/2
    - Dotun 2-3/2
    - Faryad 2-3/2
    - Adi 3-4/3
    - plus Zoe with no game

    The best option schedules all 8 games in 3 sessions, with Dean in Session 1 and no overMax.
  - B, tester-heavy. 8 designers at 2-3/3 plus 8 non-designers. The best option is 2 sessions of 4 tables.
  - C: Adi leaves at 20:00, so Adi's game is in Session 1.
  - D: Miquel arrives at 19:50. His game is not in Session 1, and he is not counted in Session 1.
  - E, replan. Lock Session 1 of A's best option, set `replanFrom` to its end, and mark Faryad as leaving at that time. The result:
    - keeps the locked session unchanged;
    - schedules only the remaining games;
    - reports Faryad's game as unscheduled with a warning, since he has gone.
  - F: a pin is honoured.
  - G: 1 designer at 1-2 plus 10 non-designers returns without throwing, with an overMax warning or an error with suggestions.
  - H: no games at all returns `error`.
  - I: the performance case above.
  - J: a `duration` warning is raised.
  - Invariant checks run on every option in every test:
    - each game appears at most once;
    - in each session, designers running + sum of testers + watchers = presentCount;
    - watchers are only designers who aren't running;
    - new sessions are equal length and contiguous.
- Acceptance: `node --test tests/` passes; the API matches the contract exactly; the manager re-runs fixture A and reads the output as sensible (3 sessions, all games, Dean first); the code is readable with brief comments on the search and scoring.
- Attempts: 1
- Result: `js/scheduler.js` and `tests/scheduler.test.mjs` (12/12 passing, fixture I ~50 ms). `score` is a cost (lower is better); sessionCount/length refer to new sessions only; `lengthOutsideBand` also fires for long sessions, so the UI should treat it as info. The manager probed extra scenarios and all were sensible. The npm test script was fixed by the manager to `node --test "tests/**/*.test.mjs"` (the Node 24 directory form fails).

### T2 - Meetup import module and tests
- Status: done
- Depends on: T0
- Worker: delegate-sonnet-medium
- Why this rung: multi-function parsing against real HTML fixtures plus regex heuristics. Careful work, but well specified.
- Brief: Write `S:\Dropbox\dev\Cardboard\Game-Matcher\js\meetup-import.js`, a pure ES module with no imports that works in the browser and in Node (functions take a `Document`, never touch `window` directly). Write `S:\Dropbox\dev\Cardboard\Game-Matcher\tests\meetup-import.test.mjs` using `node:test` and jsdom (already installed). The fixtures are `tests\fixtures\meetup-attendees-page.html` and `tests\fixtures\meetup-event-page.html`. They are real saved Meetup pages with scripts stripped, so inspect their markup before writing selectors. Fixture-based tests must **skip** (not fail) when a fixture file is missing, because fixtures are gitignored. Do not edit `package.json`.

  Exports:
  - `parseAttendeesFromDocument(doc)` → `[{ meetupName, role }]`. Each attendee card is `button[data-event-label="attendee-card"]`. The name is reliably in the avatar `img` alt `"Photo of the user <name>"`, with a fallback to the card text. The role is "Co-host", "Member", "Event Organizer" or "Host" where shown. The fixture must yield exactly these 9 names in page order: Dean, Aditya Singh, Francesco Salerno, Miquel Mansachs, Oladotun Ogunsulire, faryad, Shan Syed, Zoe Lou, Tari. Check Dean's own card carefully; its markup may differ.
  - `parseAttendeeCountFromDocument(doc)` → 9 (from the "9 Attendees" text), or null.
  - `parseEventFromDocument(doc)` → `{ title, date: "YYYY-MM-DD", startTime: "HH:MM" }`. The fixture title is "London [Mondays] After-Hours Playtest, Mon, Sep 28, 2026, 6:30 PM | Meetup", which gives date 2026-09-28 and start 18:30. It should work from either fixture page.
  - `parseCommentsFromDocument(doc)` → `[{ author, text }]` from the event page's comment list. The fixture includes Dean ("We have a table on the first floor..."), gtcheung89 ("Apologies, can't make it today...") and Shan S. ("I'll be bringing my usual game, I'm looking for 3-4 other players..."). Exclude the "Like"/"Reply"/time-ago/"Host" chrome.
  - `hasMoreComments(doc)` → true if a "More comments" control is present.
  - `extractCommentsFromNextData(obj)`: a defensive recursive search of a parsed `__NEXT_DATA__`/Apollo-state object for comment-like nodes (objects with a text/comment string and a member/author name), returning `[{author, text}]`. This is **unverified against live data**, so test it with a synthetic object and document the assumption in a comment.
  - `parseGameNotes(text)` → `{ testersMin, testersMax, durationMins, cancelled }` with nulls where unknown, or `null` if nothing is found. Dean's rule: a stated number of players or testers means testers, *not counting the designer*.
    - "3-4 other players" gives testers 3-4.
    - "+2", "2 players" and "need 2 testers" each give 2-2.
    - "3 to 5 players" gives 3-5.
    - Only when the text says the total includes the designer ("4 players including me", "4 in total") subtract 1.
    - Duration: "45 mins" → 45, "1 hour" → 60, "an hour" → 60, "1.5 hours" → 90, "90m" → 90.
    - "can't make it", "cannot come" or "not coming" gives `cancelled: true`.

    Test at least 15 phrasings, including the Shan fixture sentence.
  - `matchName(author, attendees)` → the matching attendee or null. Try exact (case-insensitive) first, then first name plus last initial ("Shan S." matches "Shan Syed"), then a unique first-name match.
  - `suggestDisplayName(meetupName)` → the first word with its first letter capitalised ("faryad" → "Faryad", "Aditya Singh" → "Aditya").
  - `buildImportPayload({ event, eventId, url, attendees, attendeeCountShown, comments, warnings })` → `{ source: "meetup-bookmarklet", version: 1, capturedAt: <ISO>, event: { id, title, date, startTime, url }, attendeeCountShown, attendees, comments, warnings }`.
  - `parseImportText(text)` accepts either that payload's JSON or a plain pasted list of names, one per line. For a list:
    - strip bullets, numbering and blank lines;
    - treat trailing "+N" guest markers as `guests: N` on the attendee.

    It returns a payload-shaped object with `source: "paste"`. Invalid JSON that starts with `{` gives `{ error }`.
- Acceptance: `node --test tests/` passes (the T1 tests may not exist yet, which is fine); the attendee test asserts all 9 names exactly; the comment test finds Shan's comment and `matchName` maps it to "Shan Syed"; `parseGameNotes` on Shan's sentence gives 3-4; the module has no imports and no top-level DOM access.
- Attempts: 2 (the second was a same-worker follow-up for "N player game" phrasing and duration-only notes)
- Result: `js/meetup-import.js` and `tests/meetup-import.test.mjs`. 9 attendees in order; 3 comments; Shan S. → Shan Syed, 3-4. The date and start time are only recoverable from the event page. `extractCommentsFromNextData` is unverified live. The manager re-probed the parser and it is fixed.

### T3 - Web app UI
- Status: done
- Depends on: T1, T2
- Worker: delegate-sonnet-high
- Why this rung: the largest piece. Many screens and states that must stay consistent with two module contracts.
- Brief: Build the single-page app in `S:\Dropbox\dev\Cardboard\Game-Matcher\`. Create `index.html`, `css\app.css` and `js\app.js`, plus further `js\*.js` modules if it helps (e.g. `js\storage.js`, `js\format.js`). Read `scheduler-plan-v2.md` ("Screens", "Data model", "Hard rules"). Also read the finished modules: `js\scheduler.js` (use `schedule`, `formatTime12`, `toMinutes`, `fromMinutes`) and `js\meetup-import.js` (use `parseImportText`, `parseGameNotes`, `matchName`, `suggestDisplayName`). Do **not** edit those two modules or their tests. If you find a real bug in one, fix it minimally, keep `node --test tests/` passing, and list the change in your report. Do not edit `package.json`. Do not create `bookmarklet.html` (another task builds it); just link to it.

  **Design:**
  - mobile-first, used one-handed on a phone at the venue;
  - large touch targets, no horizontal scroll at 360 px wide, readable in bright or dim rooms;
  - light and dark theme via `prefers-color-scheme`, colours as CSS custom properties;
  - no external libraries, CDNs or fonts;
  - British English;
  - times shown as "6:45"-style 12-hour, entered with `<input type="time">`.

  Navigation is a tab bar with four views:
  1. **Evening:**
     - fields: date (default today), start (default 18:45), earliest end (21:00), latest end (22:00), changeover minutes (0);
     - "Import from Meetup": a textarea to paste the bookmarklet JSON or a list of names, plus a link to `bookmarklet.html` ("Install the Meetup import button");
     - importing creates or merges attendees (keyed by Meetup name) and fills the event date and title where present;
     - if a comment's author matches an attendee (`matchName`), `parseGameNotes` pre-fills their game, marked "suggested from Meetup comment", with the comment text shown for Dean to confirm;
     - `cancelled` comments mark that person as not coming;
     - buttons: "New evening" (saves the current one to the log if it was scheduled, then clears attendance) and "Load demo evening" (the 28/09 example: Dean, Francesco, Tari, Shan, Miquel, Dotun, Faryad, Adi with games, plus Zoe).
  2. **People:**
     - one row per attendee: display name, a tap-to-toggle "Here" check-in, and an expandable detail;
     - the detail holds: display name (editable, remembered in the roster), arrive time, leave time, "Organiser" flag, "Brought a game" toggle;
     - "Brought a game" shows testers min / preferred / max steppers (default 2/2/3; the label explains "testers, not counting you") and duration in minutes;
     - "Add walk-in" adds a person; regulars are pre-filled from the roster's last game settings;
     - a header shows the counts: here / designers / testers.
  3. **Schedule:**
     - a big "Schedule" button calls `schedule()` with everyone marked Here (converting times to 24h HH:MM, and passing locked sessions, `replanFrom` and pins);
     - the options are chips ("3 × 60 min, ends 9:45"), with the best selected;
     - each session is a card: "Session 1 · 6:45 - 7:45", one line per table ("Francesco +1"), then watchers in small text;
     - warnings are shown in a clear panel, and `error` messages with their suggestions;
     - each table has a "Move to session…" control that sets a pin and reschedules;
     - buttons:
       - "Copy for WhatsApp" copies the exact text format below, with a visible "Copied" confirmation and a fallback that selects the text if the clipboard API fails;
       - "Post-it view" opens a full-screen view: one card per session with the end time in very large type ("ends 7:45") and the designers listed, suitable for copying onto post-it notes.
     - **Live controls:**
       - "Mark session played" on the earliest unlocked session locks it;
       - in People, "Arrived now" and "Leaving now" set times to the current time;
       - "Replan" reschedules the rest, with `locked` = the played sessions and `replanFrom` = the end of the last played session;
       - "Finish evening" saves it to the log.
  4. **Log:** past evenings, newest first. Date, then sessions and designers. Expand for details.
  Plus a small **Settings/Data** area (in Log or a menu): "Export data" downloads JSON of everything; "Import data" restores from such a file after a confirm; "Clear roster".

  WhatsApp text format (exact; blank line between sessions; display names; allocated testers; no game names; no watchers):
  ```
  Session 1 6:45 - 7:45
  - Francesco +1
  - Tari +1
  - Shan +3

  Session 2 7:45 - 8:45
  - Dean +1
  ```
  **Storage:** `localStorage` keys `gm.roster` (people by Meetup name or id: display name, last game settings, isOrganiser), `gm.evening` (current evening including its schedule, selected option, locked sessions and pins) and `gm.log` (array of finished evenings). Wrap every storage access in try/catch, and the app must still work if storage is unavailable. Save on every change. Dean is the organiser by default when a person named "Dean" is imported.
  **Checking:** serve the folder with `python -m http.server 8765` (run from the project root; ES modules need http). Load the page with Playwright (browsers are installed, so use `npx playwright` or a short script) and confirm there are no console errors. The demo evening should schedule and copy correctly at a 390 px viewport. You may add a throwaway script in the scratchpad, but not in the project.
- Acceptance: the manager serves the app and:
  - loads the demo and presses Schedule, getting 3 sessions with all 8 designers and Dean in Session 1;
  - sees the WhatsApp text match the format exactly;
  - opens the post-it view;
  - marks Session 1 played, sets Faryad leaving, replans, and sees Session 1 unchanged;
  - reloads the page and finds the state persisted;
  - sees no console errors and no horizontal scroll at 390 px.

  Also: `node --test tests/` still passes.
- Attempts: 1
- Result: `index.html`, `css/app.css`, `js/app.js`, `js/storage.js`, `js/format.js`, `js/demo.js`. The manager drove it in headless Chromium at 390 px: the demo schedules to 3 × 60 with all 8 designers and Dean in S1, the WhatsApp text is exact, the post-it view works, there are no console errors and no horizontal scroll. Polish noted for T5: the post-it view isn't truly full-screen; check the fixed bottom nav never covers buttons.

### T4 - Meetup bookmarklet and install page
- Status: done
- Depends on: T2
- Worker: delegate-sonnet-medium
- Why this rung: a build script plus browser code against a known module. It can't be tested live, so it has to be defensive.
- Brief: In `S:\Dropbox\dev\Cardboard\Game-Matcher\`, create:
  - `bookmarklet\meetup-bookmarklet.src.js`: the bookmarklet's main logic;
  - `tools\build-bookmarklet.mjs`: a Node script that:
    - reads `js\meetup-import.js`, strips `export` keywords, and concatenates it with the src file inside an IIFE;
    - lightly minifies it (strip comments and collapse whitespace, safely; no dependencies);
    - URI-encodes it into a `javascript:` URL;
    - writes `bookmarklet.html` in the project root, and prints its length;
  - `tests\bookmarklet.test.mjs`.

  Add the script `"build:bookmarklet": "node tools/build-bookmarklet.mjs"` to `package.json` (this is the only change to it). Do not edit `js\meetup-import.js` unless a genuine bug blocks you; if you do, keep its tests passing and report it.

  **Bookmarklet behaviour:**
  1. If the page isn't a `meetup.com/<group>/events/<id>/attendees` page, show an overlay explaining how to get there. If it is the event page itself, offer to open the attendees page.
  2. Auto-scroll to load all attendee cards. Repeat scrolling until the count stops growing or matches `parseAttendeeCountFromDocument`, with at most 20 rounds of about 600 ms each.
  3. Parse the attendees and the event.
  4. `fetch` the event page `https://www.meetup.com/<group>/events/<id>/` with `credentials: "include"`, then parse it with `DOMParser`:
     - first try `script#__NEXT_DATA__` JSON with `extractCommentsFromNextData`;
     - otherwise fall back to `parseCommentsFromDocument`;
     - add a warning if `hasMoreComments` and only DOM comments were found.
  5. Build `buildImportPayload(...)` and copy its JSON to the clipboard. If the clipboard fails, show a textarea with the JSON selected.
  6. Show a small fixed overlay: "Copied 9 attendees and 3 comments. Paste into the scheduler's Import box." List any warnings, and add a close button. The overlay's styles are inline and namespaced so they can't clash with Meetup's page.

  All errors are caught and shown in the overlay, never thrown silently.

  **`bookmarklet.html`** (the generated install page, with styles consistent in spirit with a clean mobile page and light/dark):
  - a draggable "Playtest import" link for desktop;
  - a "Copy bookmarklet code" button plus step-by-step instructions for adding it on a phone (create any bookmark, then edit its URL and paste the code), covering Chrome on Android and Safari on iOS;
  - a note that it only reads Meetup and stores nothing;
  - a link back to `index.html`.

  **Tests:**
  - the built code is valid JS (`new Function` on the decoded body);
  - the core logic, run against the jsdom attendees fixture, produces a payload with 9 attendees (skip when fixtures are missing). Structure the src so its non-DOM-side-effect core (`collectFromDocuments(attendeesDoc, eventDoc, url)`) is testable.
- Acceptance: `npm run build:bookmarklet` writes `bookmarklet.html` and prints the length; `node --test tests/` passes; the manager reads the src and finds the flow above with error handling; the manager opens `bookmarklet.html` and sees working install instructions.
- Attempts: 1
- Result: `bookmarklet/meetup-bookmarklet.src.js`, `tools/build-bookmarklet.mjs`, `tests/bookmarklet.test.mjs`, generated `bookmarklet.html`; 46/46 tests pass. The manager confirmed the flow (URL check, scroll, fetch with credentials, __NEXT_DATA__ → DOM fallback, overlays). Risk: the URL is 26k characters, so pasting it into a phone bookmark is unverified. Not tested on live Meetup.

### T5 - End-to-end browser test and fixes
- Status: done
- Depends on: T3, T4
- Worker: delegate-sonnet-high
- Why this rung: it has to exercise the whole app, find the real bugs, and fix them without breaking the contracts.
- Brief: In `S:\Dropbox\dev\Cardboard\Game-Matcher\`, add Playwright as a dev dependency (`npm install --save-dev playwright`; browsers are already installed under `%LOCALAPPDATA%\ms-playwright`). Write `tests\e2e\app.e2e.mjs`, a plain Node script, not under `node --test`, which:
  - starts a static server itself (a small Node `http` server serving the project root);
  - runs Chromium at a 390×844 viewport;
  - exits non-zero on failure.

  Add `"e2e": "node tests/e2e/app.e2e.mjs"` to package.json.

  Flows to cover:
  1. No console errors on load.
  2. Load the demo evening, then Schedule. There are 3 sessions, all 8 designers appear once, and Dean is in Session 1.
  3. Copy for WhatsApp: grant clipboard permissions and read the text back. It matches the format `Session N H:MM - H:MM` / `- Name +N` with blank lines between sessions.
  4. Post-it view shows the end times.
  5. Move a table to another session. The pin is honoured.
  6. Mark Session 1 played, set Faryad leaving now, and Replan. Session 1 is unchanged, and there is a warning about Faryad's game if it hasn't been played.
  7. Reload. The state persists.
  8. Import:
     - build a payload from the fixtures with `js/meetup-import.js` in Node (skip this flow if the fixtures are missing) and paste it into the import box;
     - 9 attendees appear;
     - Shan's game is suggested as 3-4 testers;
     - gtcheung89 isn't added as an attendee.
  9. Paste a plain list of names, which adds people.
  10. Finish evening. The log shows it.
  11. Export data, clear it, then import it back. The data is restored.
  12. There's no horizontal scroll at 390 px and at 360 px.
  13. `bookmarklet.html` loads without errors.

  Fix any bugs you find in the app files (`index.html`, `css\`, `js\app.js` and siblings). Keep `node --test tests/` passing. Report each bug and its fix.
- Acceptance: `npm test` and `npm run e2e` both pass when the manager runs them; the report lists the bugs found and fixed; there are no skipped flows except the fixture-dependent one when fixtures are absent.
- Attempts: 1 (plus a manager nudge about an apparent hang, which turned out to be edit/re-run cycles; watchdog added)
- Result: `tests/e2e/app.e2e.mjs` (14 flows, ~6 s); playwright added as a devDependency with Chromium installed; `npm run e2e` script. Fixed a real off-by-one bug in "Move to session" pins (js/app.js setPin). Tab-bar padding formalised; post-it overlay clears the safe area and has a bigger Close button. The manager re-ran: 46/46 unit, 14/14 e2e.

### T6 - README
- Status: done
- Depends on: T5
- Worker: delegate-sonnet-low
- Why this rung: short documentation to a clear brief.
- Brief: Write `S:\Dropbox\dev\Cardboard\Game-Matcher\README.md` for Dean (British English, concise). Read `scheduler-plan-v2.md`, `package.json`, `index.html` and `bookmarklet.html` first. Cover:
  - what the tool does;
  - running it locally (`python -m http.server 8765` in the folder, then open http://localhost:8765);
  - installing the Meetup import bookmarklet, on desktop and phone;
  - the weekly workflow on the night (import → check in → games → Schedule → copy to WhatsApp → post-its → mark played / replan → finish);
  - data and backups (localStorage lives on one device and browser, so export regularly);
  - the scheduling rules in brief;
  - tests (`npm test`, `npm run e2e`, `npm run build:bookmarklet`);
  - the privacy note (sample .mhtml and fixtures are gitignored and never published);
  - publishing to GitHub Pages: steps only, not done yet.
- Acceptance: README exists, is accurate against the actual files and scripts, and has no invented features.
- Attempts: 1
- Result: `README.md`. The manager read it in full; it is accurate, with the known limits and publishing steps included.

## Log
- 29/09/2026 10:19 - Master file created from scheduler-plan-v2.md. Awaiting approval.
- 29/09/2026 10:25 - Approved by Dean (no publishing). T0 launched (haiku).
- 29/09/2026 - Dean created the GitHub repo https://github.com/wombatgamefactory/playtest-scheduler. Add it as `origin` after T0; push / Pages only after Dean confirms at the end.
- 29/09/2026 - T0 done (verified). origin added: the repo is PRIVATE and empty (note: Pages on a private repo needs a paid GitHub plan). T1 (opus-medium) and T2 (sonnet-medium) launched in parallel.
- 29/09/2026 - T1 done (verified, plus extra probes). package.json test script fixed. Open question for Dean at the end: when there are too few games for the people present (e.g. 3 designers + 12 testers), should a game be allowed to run twice? Currently the scheduler overfills tables with warnings.
- 29/09/2026 - T2 passes review (39/39 tests together; 9 attendees, Shan's comment → 3-4). Attempt 2 sent to the same worker for a minor parseGameNotes gap ("2 player game", duration-only notes); exports unchanged. T3 (sonnet-high) and T4 (sonnet-medium) launched in parallel, since the module API is stable.
- 29/09/2026 - T2 attempt 2 verified → done. T4 done (verified; 26k-character bookmarklet noted as a mobile risk). Waiting on T3.
- 29/09/2026 - T3 done (manager browser check passed). T5 (sonnet-high) launched.
- 29/09/2026 - T5 done (manager re-ran both suites). T6 (sonnet-low) launched.
- 29/09/2026 - T6 done. All 7 tasks done, none flagged. git status checked: the .mhtml files, tests/fixtures and node_modules are ignored. Nothing committed or pushed. Run complete.
