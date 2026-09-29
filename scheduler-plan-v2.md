# Playtest UK Evening Scheduler - Plan

v2, 29/09/2026. Nothing built yet. Changes from v1: Meetup import based on the saved sample
pages, start time is editable, a post-it view, open questions answered.

## Goal

A single-organiser web tool for a Playtest UK evening. Import the Meetup attendee list,
mark who turned up and what they brought, press **Schedule**, and get a session-by-session
list of designers that can be pasted into WhatsApp. Replan on the fly as people arrive or leave.

## Hard rules (from the interview)

1. **Every game gets played.** No designer misses out. This outranks everything else.
2. **One session per designer.** A designer with two games gets one session and splits the time.
   No double sessions, whatever the game's stated length.
3. **Everyone plays every session.** Nobody sits idle. If there are more people than seats, a
   designer who is not running their game that session watches instead of playing.
4. **Equal session lengths**, back-to-back, filling the evening. Designers set up during the
   changeover while testers take a break. A 15-minute game is simply played several times.
5. **"+N" means N testers plus the designer.** "Needs 2 testers" = a table of 3.
6. **The organiser (Dean) runs in Session 1**, to set expectations.
7. **People must be present for their own session.** Arrival and leave times constrain placement:
   early leavers go early, late arrivals go late.

## Soft rules (the scheduler scores against these)

- Session length ideally 45-60 min. Longer is fine when there are lots of pure testers and
  few designers (e.g. 2 sessions × 90 min with 4 tables each).
- Tables filled near each designer's *preferred* tester count, within their min-max range.
- Session headcounts balanced so no session is starved or overflowing.
- Arrival order breaks ties for who goes earlier.
- Stated game duration longer than the session length → **warning only**.

## Data model

```
Person      { id, meetupName, displayName, isOrganiser }   // "Oladotun Ogunsulire" → "Dotun"
Game        { designerId, testersMin, testersMax, testersPreferred, durationMins, notes }
Attendance  { personId, present, arrivedAt, arrivalOrder, leavesAt }   // leavesAt default = evening end
Evening     { date, meetupEventId?, start (default 18:45, editable - sometimes earlier), end (21:00-22:00), attendance[], games[],
              schedule?, lockedSessions[] }
Schedule    { sessions: [{ start, end, tables: [{ designerId, testers }], watchers: [personId] }],
              warnings[] }
Roster      { people[], lastGameSettings by personId }   // remembered between weeks
Log         [ past Evenings, read-only ]
```

The tester counts in a finished schedule are *allocated* numbers, not requested ones. The
testers choose which table to sit at themselves, so the tool only outputs counts.

## Scheduling algorithm

The problem is small (typically ≤ 12 games, ≤ 30 people), so an exhaustive or backtracking
search is instant. No clever solver is needed.

1. **Enumerate evening shapes.** For each number of sessions S = 1..G and each candidate end time
   (21:00-22:00 in 15-min steps), session length L = (end − start) / S.
2. **Assign games to sessions** (backtracking) subject to:
   - organiser's game in Session 1
   - each designer present for the whole of their session
   - per session: seats needed ≤ people present ≤ seats available, where
     - seats needed  = Σ (1 + testersMin) over games running
     - seats available = Σ (1 + testersMax) + designers-not-running who can watch
3. **Allocate testers to tables** within each session: everyone present who isn't running a game
   is spread across tables, starting from the preferred counts and staying within min-max. Any
   overflow becomes watchers (designers first). If someone *still* can't be seated, the tool
   goes one over max and warns.
4. **Score each feasible shape:** distance of L from the 45-60 band, distance of tables from
   preferred sizes, headcount balance, arrival-order tie-breaks, fewest warnings. Prefer using
   the full evening over finishing early.
5. **Show the best 2-3 shapes** (e.g. "3 × 55 min, ends 9:30" vs "2 × 80 min, ends 9:25"),
   best one pre-selected. Dean picks one and can override the end time.
6. **Infeasible?** Explain why in plain words (e.g. "Adi leaves at 8:00 but no early session can
   seat 4") and suggest the smallest fix.

**Replanning:** sessions already played or in progress are locked. The remaining evening is
re-solved from the next session start, using the current attendance and only the unplayed games.

## Screens (mobile-first, single page)

1. **Evening:** date, start/end, import from Meetup, or paste names.
2. **Attendance:** list of RSVPs plus walk-ins. Tap to mark present. Per person: arrive/leave
   time, "brought a game" toggle → testers min / preferred / max, duration, notes. Regulars'
   last settings are pre-filled from the roster. Meetup notes are shown next to the fields.
3. **Schedule:** big **Schedule** button, shape options, the sessions with tables and watchers,
   warnings. Move a game to another session by hand (the rest re-solves around it).
   **Copy for WhatsApp** button.
4. **Post-it view:** each session's end time in large type, with its designers listed
   underneath, for writing the post-it notes handed to designers.
5. **Live:** "Session N done", "X arrived", "X left" → Replan.
6. **Log:** past evenings: date, sessions, who tested.

WhatsApp output (session times and designers only; watchers are not listed):

```
Session 1 6:45 - 7:45
- Francesco +1
- Tari +1
- Shan +3

Session 2 7:45 - 8:45
- Dean +1
...
```

## Meetup import

No paid API (Meetup Pro is required for it). Instead, a **bookmarklet** runs in Dean's own
logged-in browser. Nothing is installed and no credentials are stored.

**What the saved sample pages showed (event 316433169, 28/09/2026):**

- `/events/<id>/attendees/` lists everyone going: name, role (Co-host / Member) and badges
  ("First event", "Familiar face"). Each attendee is a `button[data-event-label="attendee-card"]`,
  and the name is reliably in the avatar's `alt="Photo of the user <name>"`. Cancelled RSVPs are
  counted separately and are not in the list. Dean is a co-host, so he also sees Meetup's own
  check-in controls.
- There are **no RSVP answers or guest counts** on the page. **Game details live in the event
  comments** on `/events/<id>/`, e.g. Shan: *"I'm looking for 3-4 other players"*. Comments
  are paged behind "More comments".
- Meetup uses full names ("Oladotun Ogunsulire", "Aditya Singh") while the evening uses
  short ones ("Dotun", "Adi"), so the roster keeps a display name per Meetup name.
- The event is listed as 6:30-10:00pm; sessions start at 6:45.

**Flow:** run the bookmarklet on the attendee page → it collects the names, then fetches the
event page from the same logged-in session to read the comments → copies one JSON blob → paste it
into the scheduler. A comment by an attendee pre-fills their game fields with a best guess
("3-4 other players" → testers 3-4; "+2"; "60 mins"). Dean then confirms or edits. The saved
page had its scripts stripped, so the spike must check whether the event page's embedded data
(Next.js / Apollo state) includes the full comment list. If it doesn't, the bookmarklet is run
on each page in turn.

The tool only **reads** Meetup. It never marks check-ins or posts there.

Fallback: paste a plain list of names. Playwright with stored credentials stays a backup option.

Risk: Meetup changes its markup and the import breaks. The fallback covers this. The two sample
`.mhtml` files stay in the repo as test fixtures for the parser.

## Tech

- Static site, vanilla JS, no build step, no dependencies. Hosted free on GitHub Pages
  (same approach as Fancy That! / Firefly Festival).
- Data in `localStorage`, plus **Export / Import JSON** backup so a cleared phone browser
  doesn't lose the roster and log.
- The scheduler is a pure function (`schedule(evening) → options`) in its own file with Node
  tests, so it can be verified without the UI.

## Build order

0. ~~**Meetup spike.**~~ Page structure confirmed from the saved samples. Still to check live:
   whether the event page's embedded data includes all comments.
1. **Scheduler core + tests.** Fixtures include the 28/09 evening (8 designers → 3 sessions)
   and a tester-heavy evening (→ 2 long sessions, 4 tables).
2. **Attendance + game entry UI**, roster memory, localStorage, export/import.
3. **Schedule view**, shape options, warnings, manual move, WhatsApp copy, post-it view.
4. **Live replanning** (lock played sessions, arrivals/departures).
5. **Meetup bookmarklet** and notes parsing.
6. **Log**, git repo, GitHub Pages deploy.

## Settled

- Dean is a co-host, not an organiser. The import works from what a co-host can see.
- 6:45 is the usual start. It's editable because the group sometimes starts earlier.
- Watchers are not named in the WhatsApp output.
