// Playtest Scheduler - app controller.
//
// Vanilla ES modules, no build step. State lives in three localStorage keys
// (gm.roster, gm.evening, gm.log) via js/storage.js, and is rendered with
// plain template-string rebuilds of each tab panel (js/format.js has
// escapeHtml). Editable text/time/number fields update state on the
// 'input' event WITHOUT a rerender (so typing doesn't lose focus); anything
// that changes the shape of the UI (toggles, buttons, selects) goes through
// a single delegated 'click'/'change' handler and rerenders the active tab.

import { schedule, formatTime12 } from './scheduler.js';
import { parseImportText, parseGameNotes, matchName, suggestDisplayName } from './meetup-import.js';
import { loadJSON, saveJSON } from './storage.js';
import { todayISO, nowHHMM, isoToDMY, escapeHtml, formatWhatsApp } from './format.js';
import { buildDemoEvening } from './demo.js';

// ---------------------------------------------------------------- state

function emptyEvening() {
  return {
    date: todayISO(),
    start: '18:45',
    earliestEnd: '21:00',
    latestEnd: '22:00',
    changeoverMins: 0,
    title: null,
    meetupEventId: null,
    nextOrder: 1,
    people: [],
    lockedSessions: [],
    pins: {},
    schedule: null,
    selectedOptionId: null,
  };
}

const state = {
  roster: loadJSON('gm.roster', {}),
  evening: loadJSON('gm.evening', null) || emptyEvening(),
  log: loadJSON('gm.log', []),
};

function saveEvening() { saveJSON('gm.evening', state.evening); }
function saveRoster() { saveJSON('gm.roster', state.roster); }
function saveLog() { saveJSON('gm.log', state.log); }

// ---------------------------------------------------------------- ui state (not persisted)

let activeTab = 'evening';
let importMessage = '';
const expandedPeople = new Set();
const expandedLog = new Set();

// ---------------------------------------------------------------- small helpers

function findPerson(id) {
  return state.evening.people.find((p) => p.id === id) || null;
}

function slugify(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'person';
}

function uniqueId(name) {
  const base = slugify(name);
  const used = new Set([...Object.keys(state.roster), ...state.evening.people.map((p) => p.id)]);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function syncRosterLastGame(p) {
  if (!state.roster[p.id]) {
    state.roster[p.id] = { id: p.id, meetupName: p.meetupName || null, displayName: p.displayName, isOrganiser: p.isOrganiser, lastGame: null };
  }
  state.roster[p.id].lastGame = p.game ? { ...p.game } : null;
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function getSelectedOption() {
  const sch = state.evening.schedule;
  if (!sch || sch.error || !sch.options || !sch.options.length) return null;
  return sch.options.find((o) => o.id === state.evening.selectedOptionId) || sch.options[0];
}

// ---------------------------------------------------------------- scheduling

function buildScheduleInput() {
  const ev = state.evening;
  const people = ev.people.filter((p) => p.present).map((p) => ({
    id: p.id,
    name: p.displayName,
    present: true,
    arrive: p.arrive || null,
    leave: p.leave || null,
    arrivalOrder: p.arrivalOrder,
    isOrganiser: !!p.isOrganiser,
    game: p.game ? {
      testersMin: p.game.testersMin,
      testersMax: p.game.testersMax,
      testersPreferred: p.game.testersPreferred,
      durationMins: p.game.durationMins,
    } : null,
  }));
  const replanFrom = ev.lockedSessions.length ? ev.lockedSessions[ev.lockedSessions.length - 1].end : null;
  return {
    start: ev.start,
    earliestEnd: ev.earliestEnd,
    latestEnd: ev.latestEnd,
    endStep: 15,
    fixedEnd: null,
    changeoverMins: Number(ev.changeoverMins) || 0,
    graceMins: 10,
    people,
    locked: ev.lockedSessions,
    replanFrom,
    pins: ev.pins,
  };
}

function runSchedule() {
  const input = buildScheduleInput();
  const result = schedule(input);
  state.evening.schedule = result;
  state.evening.selectedOptionId = (result.options && result.options[0]) ? result.options[0].id : null;
  saveEvening();
  render();
}

function selectOption(optionId) {
  state.evening.selectedOptionId = optionId;
  saveEvening();
  render();
}

function setPin(designerId, newSessionIndexGlobal) {
  const lockedCount = state.evening.lockedSessions.length;
  // moveOptions() offers 1-based GLOBAL session numbers (locked sessions come
  // first), but scheduler.js's `pins` are 0-based indices into the NEW
  // sessions only (see its `ctx.locked.length + pin + 1` messages) - so the
  // first selectable ("Session lockedCount+1") must map to pin 0, not 1.
  const newIdx = newSessionIndexGlobal - lockedCount - 1;
  if (newIdx < 0) return;
  state.evening.pins[designerId] = newIdx;
  saveEvening();
  runSchedule();
}

function markSessionPlayed() {
  const option = getSelectedOption();
  if (!option) return;
  const first = option.sessions.find((s) => !s.locked);
  if (!first) return;
  state.evening.lockedSessions.push({
    start: first.start,
    end: first.end,
    tables: first.tables.map((t) => ({ designerId: t.designerId, testers: t.testers })),
  });
  for (const t of first.tables) delete state.evening.pins[t.designerId];
  saveEvening();
  runSchedule();
}

// ---------------------------------------------------------------- import

function applyImportPayload(payload) {
  const ev = state.evening;
  if (payload.event) {
    if (payload.event.date) ev.date = payload.event.date;
    if (payload.event.startTime) ev.start = payload.event.startTime;
    if (payload.event.title) ev.title = payload.event.title;
    if (payload.event.id) ev.meetupEventId = payload.event.id;
  }

  const attendees = payload.attendees || [];
  const meetupNameToPersonId = new Map();

  for (const a of attendees) {
    if (!a || !a.meetupName) continue;
    const existing = ev.people.find((p) => p.meetupName && p.meetupName.toLowerCase() === a.meetupName.toLowerCase());
    if (existing) {
      existing.present = true;
      meetupNameToPersonId.set(a.meetupName, existing.id);
      continue;
    }
    const rosterMatch = Object.values(state.roster).find((r) => r.meetupName && r.meetupName.toLowerCase() === a.meetupName.toLowerCase());
    const id = rosterMatch ? rosterMatch.id : uniqueId(a.meetupName);
    const displayName = rosterMatch ? rosterMatch.displayName : suggestDisplayName(a.meetupName);
    const isOrganiser = rosterMatch ? !!rosterMatch.isOrganiser : /^dean$/i.test(a.meetupName.trim());
    if (isOrganiser) ev.people.forEach((pp) => { pp.isOrganiser = false; });
    const person = {
      id,
      meetupName: a.meetupName,
      displayName,
      present: true,
      arrive: null,
      leave: null,
      arrivalOrder: ev.nextOrder++,
      isOrganiser,
      game: null,
      suggestedFromComment: null,
      cancelledNote: null,
    };
    ev.people.push(person);
    meetupNameToPersonId.set(a.meetupName, id);
    if (!state.roster[id]) {
      state.roster[id] = { id, meetupName: a.meetupName, displayName, isOrganiser, lastGame: rosterMatch ? rosterMatch.lastGame : null };
    }
  }

  let gameNotesApplied = 0;
  for (const c of (payload.comments || [])) {
    const match = matchName(c.author, attendees);
    if (!match) continue;
    const personId = meetupNameToPersonId.get(match.meetupName);
    const person = personId ? findPerson(personId) : null;
    if (!person) continue;
    const notes = parseGameNotes(c.text);
    if (!notes) continue;
    if (notes.cancelled) {
      person.present = false;
      person.cancelledNote = c.text;
      continue;
    }
    if (notes.testersMin != null || notes.testersMax != null || notes.durationMins != null) {
      const min = notes.testersMin != null ? notes.testersMin : 1;
      const max = notes.testersMax != null ? notes.testersMax : min;
      const pref = Math.min(max, Math.max(min, min));
      person.game = { testersMin: min, testersMax: max, testersPreferred: pref, durationMins: notes.durationMins };
      person.suggestedFromComment = c.text;
      syncRosterLastGame(person);
      gameNotesApplied++;
    }
  }

  const n = attendees.length;
  const c = (payload.comments || []).length;
  return `Imported ${n} attendee${n === 1 ? '' : 's'}${c ? `, ${c} comment${c === 1 ? '' : 's'}` : ''}${gameNotesApplied ? `, ${gameNotesApplied} game suggestion${gameNotesApplied === 1 ? '' : 's'}` : ''}.`;
}

function doImport() {
  const ta = document.getElementById('import-text');
  const text = ta ? ta.value : '';
  if (!text || !text.trim()) { importMessage = 'Paste something to import first.'; render(); return; }
  const payload = parseImportText(text);
  if (payload.error) { importMessage = payload.error; render(); return; }
  importMessage = applyImportPayload(payload);
  saveEvening();
  saveRoster();
  render();
}

// ---------------------------------------------------------------- evening lifecycle

function resetEveningKeepingTimes() {
  const ev = state.evening;
  state.evening = {
    date: todayISO(),
    start: ev.start,
    earliestEnd: ev.earliestEnd,
    latestEnd: ev.latestEnd,
    changeoverMins: ev.changeoverMins,
    title: null,
    meetupEventId: null,
    nextOrder: 1,
    people: [],
    lockedSessions: [],
    pins: {},
    schedule: null,
    selectedOptionId: null,
  };
  saveEvening();
}

function pushEveningToLog() {
  const option = getSelectedOption();
  if (!option) return false;
  state.log.push({
    date: state.evening.date,
    title: state.evening.title,
    finishedAt: new Date().toISOString(),
    option: JSON.parse(JSON.stringify(option)),
    people: JSON.parse(JSON.stringify(state.evening.people)),
  });
  saveLog();
  return true;
}

function newEvening() {
  pushEveningToLog();
  resetEveningKeepingTimes();
  importMessage = '';
  render();
}

function finishEvening() {
  const ok = pushEveningToLog();
  if (!ok) { toast('Nothing scheduled yet.'); return; }
  resetEveningKeepingTimes();
  importMessage = '';
  toast('Evening saved to the log.');
  render();
}

function loadDemo() {
  const demo = buildDemoEvening(todayISO());
  state.evening = demo;
  for (const p of demo.people) {
    if (!state.roster[p.id]) {
      state.roster[p.id] = { id: p.id, meetupName: p.meetupName, displayName: p.displayName, isOrganiser: p.isOrganiser, lastGame: p.game ? { ...p.game } : null };
    }
  }
  importMessage = '';
  saveEvening();
  saveRoster();
  render();
}

// ---------------------------------------------------------------- people edits

function updatePersonField(id, field, value, opts = {}) {
  const { save = true, rerender = false } = opts;
  const p = findPerson(id);
  if (!p) return;
  if (field.startsWith('game.')) {
    const gf = field.slice(5);
    if (!p.game) p.game = { testersMin: 2, testersPreferred: 2, testersMax: 3, durationMins: null };
    p.game[gf] = gf === 'durationMins' ? (value === '' ? null : Number(value)) : value;
    syncRosterLastGame(p);
  } else if (field === 'displayName') {
    p.displayName = value;
    if (state.roster[p.id]) state.roster[p.id].displayName = value;
  } else if (field === 'arrive' || field === 'leave') {
    p[field] = value || null;
  } else {
    p[field] = value;
  }
  if (save) { saveEvening(); saveRoster(); }
  if (rerender) render();
}

function togglePresent(id) {
  const p = findPerson(id);
  if (!p) return;
  p.present = !p.present;
  saveEvening();
  render();
}

function toggleOrganiser(id) {
  const p = findPerson(id);
  if (!p) return;
  const newVal = !p.isOrganiser;
  state.evening.people.forEach((pp) => { pp.isOrganiser = false; });
  p.isOrganiser = newVal;
  if (state.roster[p.id]) state.roster[p.id].isOrganiser = newVal;
  saveEvening();
  saveRoster();
  render();
}

function toggleGame(id) {
  const p = findPerson(id);
  if (!p) return;
  if (p.game) {
    p.game = null;
  } else {
    const roster = state.roster[p.id];
    p.game = roster && roster.lastGame ? { ...roster.lastGame } : { testersMin: 2, testersPreferred: 2, testersMax: 3, durationMins: null };  }
  saveEvening();
  render();
}

function stepper(id, field, dir) {
  const p = findPerson(id);
  if (!p || !p.game) return;
  const g = p.game;
  let v = (Number.isFinite(g[field]) ? g[field] : 0) + dir;
  if (field === 'testersMin') {
    v = Math.max(0, v);
    if (v > g.testersMax) g.testersMax = v;
    if (g.testersPreferred < v) g.testersPreferred = v;
  } else if (field === 'testersMax') {
    v = Math.max(g.testersMin, v);
    if (g.testersPreferred > v) g.testersPreferred = v;
  } else if (field === 'testersPreferred') {
    v = Math.min(g.testersMax, Math.max(g.testersMin, v));
  }
  g[field] = v;
  syncRosterLastGame(p);
  saveEvening();
  saveRoster();
  render();
}

function arrivedNow(id) { updatePersonField(id, 'arrive', nowHHMM(), { rerender: true }); }
function leavingNow(id) { updatePersonField(id, 'leave', nowHHMM(), { rerender: true }); }

function addWalkin() {
  const input = document.getElementById('walkin-name');
  const name = input ? input.value.trim() : '';
  if (!name) return;
  const rosterMatch = Object.values(state.roster).find(
    (r) => r.displayName.toLowerCase() === name.toLowerCase() || (r.meetupName && r.meetupName.toLowerCase() === name.toLowerCase())
  );
  const id = rosterMatch ? rosterMatch.id : uniqueId(name);
  const displayName = rosterMatch ? rosterMatch.displayName : name;
  const isOrganiser = rosterMatch ? !!rosterMatch.isOrganiser : false;
  if (isOrganiser) state.evening.people.forEach((pp) => { pp.isOrganiser = false; });
  const person = {
    id,
    meetupName: rosterMatch ? rosterMatch.meetupName : null,
    displayName,
    present: true,
    arrive: null,
    leave: null,
    arrivalOrder: state.evening.nextOrder++,
    isOrganiser,
    game: rosterMatch && rosterMatch.lastGame ? { ...rosterMatch.lastGame } : null,
    suggestedFromComment: null,
    cancelledNote: null,
  };
  state.evening.people.push(person);  if (!state.roster[id]) {
    state.roster[id] = { id, meetupName: person.meetupName, displayName, isOrganiser, lastGame: person.game };
  }
  if (input) input.value = '';
  saveEvening();
  saveRoster();
  render();
}

// ---------------------------------------------------------------- clipboard / views

async function copyWhatsApp() {
  const option = getSelectedOption();
  if (!option) return;
  const text = formatWhatsApp(option, formatTime12);
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch (e) {
    copied = false;
  }
  if (!copied) {
    const ta = document.getElementById('wa-fallback');
    if (ta) {
      ta.classList.remove('hidden');
      ta.value = text;
      ta.focus();
      ta.select();
      try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    }
  }
  toast(copied ? 'Copied' : 'Select the text below and copy it');
}

function openPostit() {
  const option = getSelectedOption();
  const content = document.getElementById('postit-content');
  if (!option || !content) return;
  content.innerHTML = option.sessions.map((s, i) => `
    <div class="postit-card">
      <div class="postit-end">ends ${formatTime12(s.end)}</div>
      <div class="postit-session">Session ${i + 1}</div>
      <ul>${s.tables.map((t) => `<li>${escapeHtml(t.name)}</li>`).join('')}</ul>
    </div>`).join('');
  document.getElementById('postit-overlay').classList.remove('hidden');
}

function closePostit() {
  document.getElementById('postit-overlay').classList.add('hidden');
}

// ---------------------------------------------------------------- data (export/import/clear)

function exportData() {
  const data = { roster: state.roster, log: state.log, evening: state.evening, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `playtest-scheduler-export-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function triggerImportFile() {
  const input = document.getElementById('import-file');
  if (!input) return;
  input.value = '';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (!confirm('Import data? This replaces the current roster, evening and log.')) return;
      try {
        const data = JSON.parse(reader.result);
        state.roster = data.roster || {};
        state.log = data.log || [];
        state.evening = data.evening || emptyEvening();
        saveRoster(); saveLog(); saveEvening();
        toast('Data imported.');
        render();
      } catch (e) {
        toast('That file is not valid export data.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function clearRoster() {
  if (!confirm('Clear the saved roster? This does not affect the current evening or log.')) return;
  state.roster = {};
  saveRoster();
  toast('Roster cleared.');
}

// ---------------------------------------------------------------- rendering: Evening

function renderEvening() {
  const panel = document.getElementById('tab-evening');
  const ev = state.evening;
  panel.innerHTML = `
    <h2>Evening</h2>
    <div class="field"><label>Date<input type="date" data-field="date" value="${ev.date || ''}"></label></div>
    <div class="field"><label>Start<input type="time" data-field="start" value="${ev.start || ''}"></label></div>
    <div class="row2">
      <div class="field"><label>Earliest end<input type="time" data-field="earliestEnd" value="${ev.earliestEnd || ''}"></label></div>
      <div class="field"><label>Latest end<input type="time" data-field="latestEnd" value="${ev.latestEnd || ''}"></label></div>
    </div>
    <div class="field"><label>Changeover (mins)<input type="number" min="0" step="1" data-field="changeoverMins" value="${ev.changeoverMins || 0}"></label></div>

    <h3>Import from Meetup</h3>
    <p class="muted">Paste the JSON copied by the bookmarklet, or a plain list of names (one per line).</p>
    <textarea id="import-text" rows="5" placeholder="Paste here..."></textarea>
    <div class="btn-row">
      <button class="btn btn-primary" data-action="import">Import</button>
    </div>
    <p><a href="bookmarklet.html">Install the Meetup import button</a></p>
    ${importMessage ? `<p class="muted">${escapeHtml(importMessage)}</p>` : ''}

    <h3>Evening</h3>
    <div class="btn-row">
      <button class="btn" data-action="new-evening">New evening</button>
      <button class="btn" data-action="load-demo">Load demo evening</button>
    </div>
  `;
}

// ---------------------------------------------------------------- rendering: People

function stepperRow(id, field, label, value) {
  return `<div class="stepper-row">
    <span>${label}</span>
    <button type="button" class="btn btn-mini" data-action="stepper" data-person="${id}" data-field="${field}" data-dir="-1">&minus;</button>
    <span class="stepper-value">${value}</span>
    <button type="button" class="btn btn-mini" data-action="stepper" data-person="${id}" data-field="${field}" data-dir="1">+</button>
  </div>`;
}

// One-line summary shown under each name, so game details are visible without expanding.
function gameSummary(g) {
  if (!g) return 'Tester';
  const range = g.testersMin === g.testersMax ? `+${g.testersMin}` : `+${g.testersMin}-${g.testersMax}`;
  const mins = g.durationMins ? ` &middot; ${g.durationMins} min` : '';
  return `${range} testers${mins}`;
}

function renderPersonRow(p) {
  const expanded = expandedPeople.has(p.id);
  const g = p.game;
  return `
  <div class="person-row ${p.present ? 'present' : ''}">
    <div class="person-main">
      <button type="button" class="here-toggle" data-action="toggle-present" data-person="${p.id}" aria-pressed="${p.present}" title="Here">${p.present ? '&#10003;' : ''}</button>
      <div class="person-name">
        <span class="person-name-line">${escapeHtml(p.displayName)}${p.isOrganiser ? ' <span class="tag">Organiser</span>' : ''}${!p.present && p.cancelledNote ? ' <span class="tag tag-warn">Not coming</span>' : ''}</span>
        <span class="person-sub ${g ? '' : 'muted'}">${gameSummary(g)}</span>
      </div>
      <label class="game-tick"><input type="checkbox" data-checkbox="game" data-person="${p.id}" ${g ? 'checked' : ''}> Game</label>
      <button type="button" class="person-chevron" data-action="expand" data-person="${p.id}" aria-expanded="${expanded}" aria-label="${expanded ? 'Close' : 'Edit'} ${escapeHtml(p.displayName)}">${expanded ? '&#9662;' : '&#9656;'}</button>
    </div>
    ${expanded ? `
    <div class="person-detail">
      <div class="field"><label>Display name<input type="text" data-person="${p.id}" data-field="displayName" value="${escapeHtml(p.displayName)}"></label></div>
      <div class="row2">
        <div class="field">
          <label>Arrive<input type="time" data-person="${p.id}" data-field="arrive" value="${p.arrive || ''}"></label>
          <button type="button" class="btn btn-mini" data-action="arrived-now" data-person="${p.id}">Now</button>
        </div>
        <div class="field">
          <label>Leave<input type="time" data-person="${p.id}" data-field="leave" value="${p.leave || ''}"></label>
          <button type="button" class="btn btn-mini" data-action="leaving-now" data-person="${p.id}">Now</button>
        </div>
      </div>
      <label class="switch-row"><input type="checkbox" data-checkbox="organiser" data-person="${p.id}" ${p.isOrganiser ? 'checked' : ''}> Organiser</label>
      ${g ? `
        <div class="game-fields">
          <p class="muted">Testers - not counting you</p>
          ${stepperRow(p.id, 'testersMin', 'Min', g.testersMin)}
          ${stepperRow(p.id, 'testersPreferred', 'Preferred', g.testersPreferred)}
          ${stepperRow(p.id, 'testersMax', 'Max', g.testersMax)}
          <div class="field"><label>Duration (mins)<input type="number" min="0" step="5" data-person="${p.id}" data-field="game.durationMins" value="${g.durationMins ?? ''}"></label></div>
          ${p.suggestedFromComment ? `<p class="suggested">Suggested from Meetup comment: &ldquo;${escapeHtml(p.suggestedFromComment)}&rdquo;</p>` : ''}
        </div>` : ''}
      ${p.cancelledNote ? `<p class="cancelled-note">Marked not coming - Meetup comment: &ldquo;${escapeHtml(p.cancelledNote)}&rdquo;</p>` : ''}
    </div>` : ''}
  </div>`;
}

function renderPeople() {
  const panel = document.getElementById('tab-people');
  const ev = state.evening;
  const here = ev.people.filter((p) => p.present).length;
  const designers = ev.people.filter((p) => p.present && p.game).length;
  const testers = here - designers;
  const rows = ev.people.map(renderPersonRow).join('');
  panel.innerHTML = `
    <h2>People</h2>
    <div class="counts">Here ${here} &middot; Designers ${designers} &middot; Testers ${testers}</div>
    <p class="muted hint">Tap the circle to check someone in. Tick Game if they brought one. Tap the arrow to change testers, length or arrive/leave times.</p>
    <div class="people-list">${rows || '<p class="muted">No one yet. Import from Meetup or add a walk-in.</p>'}</div>
    <div class="walkin-row">
      <input id="walkin-name" type="text" placeholder="Name">
      <button type="button" class="btn" data-action="add-walkin">Add walk-in</button>
    </div>
  `;
}

// ---------------------------------------------------------------- rendering: Schedule

function renderWarnings(option) {
  const other = option.warnings.filter((w) => w.type !== 'duration' && w.type !== 'lengthOutsideBand');
  const durationWarnings = option.warnings.filter((w) => w.type === 'duration');
  const bandWarnings = option.warnings.filter((w) => w.type === 'lengthOutsideBand');
  let html = '';
  if (other.length) {
    html += `<div class="warn-panel">${other.map((w) => `<p>&#9888; ${escapeHtml(w.message)}</p>`).join('')}</div>`;
  }
  if (durationWarnings.length) {
    const names = durationWarnings.map((w) => {
      const p = findPerson(w.personId);
      return p ? p.displayName : null;
    }).filter(Boolean);
    html += `<div class="warn-panel muted-panel"><p>${durationWarnings.length} game${durationWarnings.length === 1 ? '' : 's'} want${durationWarnings.length === 1 ? 's' : ''} longer than ${option.sessionLengthMins} min: ${names.map(escapeHtml).join(', ')}</p></div>`;
  }
  if (bandWarnings.length) {
    html += `<div class="info-panel">${bandWarnings.map((w) => `<p>${escapeHtml(w.message)}</p>`).join('')}</div>`;
  }
  return html;
}

function moveOptions(lockedCount, total, currentGlobal) {
  let opts = '';
  for (let g = lockedCount + 1; g <= total; g++) {
    opts += `<option value="${g}" ${g === currentGlobal ? 'selected' : ''}>Session ${g}</option>`;
  }
  return opts;
}

function renderSessionCard(s, i, isFirstUnlocked, lockedCount, totalSessions) {
  const tablesHtml = s.tables.map((t) => `
    <div class="table-row">
      <span>${escapeHtml(t.name)} +${t.testers}${t.overMax ? ' <span class="tag tag-warn">over max</span>' : ''}${t.underMin ? ' <span class="tag tag-warn">under min</span>' : ''}</span>
      ${!s.locked ? `<select data-action="move-session" data-person="${t.designerId}">${moveOptions(lockedCount, totalSessions, i + 1)}</select>` : ''}
    </div>`).join('');
  const watchersHtml = s.watchers.length
    ? `<p class="watchers">Watching: ${s.watchers.map((id) => { const p = findPerson(id); return escapeHtml(p ? p.displayName : id); }).join(', ')}</p>`
    : '';
  return `
    <div class="card session-card ${s.locked ? 'locked' : ''}">
      <div class="session-header">Session ${i + 1} &middot; ${formatTime12(s.start)} - ${formatTime12(s.end)}${s.locked ? ' <span class="tag">played</span>' : ''}</div>
      ${tablesHtml}
      ${watchersHtml}
      ${isFirstUnlocked ? '<div class="btn-row"><button type="button" class="btn btn-mini" data-action="mark-played">Mark session played</button></div>' : ''}
    </div>`;
}

function renderSchedule() {
  const panel = document.getElementById('tab-schedule');
  const ev = state.evening;
  const sch = ev.schedule;
  const lockedCount = ev.lockedSessions.length;
  const scheduleLabel = lockedCount > 0 ? 'Replan' : 'Schedule';

  let body = '';
  if (!sch) {
    body = '<p class="muted">Press Schedule to plan the evening.</p>';
  } else if (sch.error) {
    body = `<div class="error-panel"><p>${escapeHtml(sch.error.message)}</p><ul>${(sch.error.suggestions || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`;
  } else {
    const options = sch.options;
    const selected = getSelectedOption() || options[0];
    let markedDone = false;
    const sessionCards = selected.sessions.map((s, i) => {
      let isFirstUnlocked = false;
      if (!s.locked && !markedDone) { isFirstUnlocked = true; markedDone = true; }
      return renderSessionCard(s, i, isFirstUnlocked, lockedCount, selected.sessions.length);
    }).join('');
    body = `
      <div class="chip-row">${options.map((o) => `<button type="button" class="chip ${o.id === selected.id ? 'selected' : ''}" data-action="select-option" data-option="${o.id}">${o.sessionCount} &times; ${o.sessionLengthMins} min, ends ${formatTime12(o.end)}</button>`).join('')}</div>
      ${renderWarnings(selected)}
      <div class="sessions">${sessionCards}</div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="copy-whatsapp">Copy for WhatsApp</button>
        <button type="button" class="btn" data-action="postit-open">Post-it view</button>
      </div>
      <textarea id="wa-fallback" class="hidden" readonly></textarea>
    `;
  }

  panel.innerHTML = `
    <h2>Schedule</h2>
    <div class="btn-row">
      <button type="button" class="btn btn-primary btn-large" data-action="schedule">${scheduleLabel}</button>
    </div>
    ${body}
    <div class="btn-row">
      <button type="button" class="btn" data-action="finish-evening">Finish evening</button>
    </div>
  `;
}

// ---------------------------------------------------------------- rendering: Log

function renderLogEntry(entry, idx) {
  const designers = entry.option.sessions.flatMap((s) => s.tables.map((t) => t.name));
  const expanded = expandedLog.has(idx);
  return `
    <div class="card log-entry">
      <button type="button" class="log-summary" data-action="expand-log" data-idx="${idx}">
        ${isoToDMY(entry.date)} &mdash; ${entry.option.sessionCount} session${entry.option.sessionCount === 1 ? '' : 's'}: ${designers.map(escapeHtml).join(', ')}
      </button>
      ${expanded ? `<div class="log-detail">${entry.option.sessions.map((s, i) => `
        <p><strong>Session ${i + 1} &middot; ${formatTime12(s.start)} - ${formatTime12(s.end)}</strong></p>
        <ul>${s.tables.map((t) => `<li>${escapeHtml(t.name)} +${t.testers}</li>`).join('')}</ul>
      `).join('')}</div>` : ''}
    </div>`;
}

function renderLog() {
  const panel = document.getElementById('tab-log');
  const log = state.log;
  const items = log.map((entry, idx) => renderLogEntry(entry, idx)).reverse().join('');
  panel.innerHTML = `
    <h2>Log</h2>
    ${log.length ? `<div class="log-list">${items}</div>` : '<p class="muted">No evenings finished yet.</p>'}
    <details class="data-area">
      <summary>Data</summary>
      <div class="btn-row">
        <button type="button" class="btn" data-action="export-data">Export data</button>
        <button type="button" class="btn" data-action="import-data">Import data</button>
        <button type="button" class="btn btn-danger" data-action="clear-roster">Clear roster</button>
      </div>
      <input type="file" id="import-file" accept="application/json" class="hidden">
    </details>
  `;
}

// ---------------------------------------------------------------- render dispatch

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  render();
}

function render() {
  if (activeTab === 'evening') renderEvening();
  else if (activeTab === 'people') renderPeople();
  else if (activeTab === 'schedule') renderSchedule();
  else if (activeTab === 'log') renderLog();
}

// ---------------------------------------------------------------- event delegation

function onInput(e) {
  const t = e.target;
  if (t.matches('#tab-evening [data-field]')) {
    state.evening[t.dataset.field] = t.value;
    saveEvening();
  } else if (t.matches('#tab-people [data-field][data-person]')) {
    updatePersonField(t.dataset.person, t.dataset.field, t.value, { rerender: false });
  }
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-checkbox="organiser"]')) toggleOrganiser(t.dataset.person);
  else if (t.matches('[data-checkbox="game"]')) toggleGame(t.dataset.person);
  else if (t.matches('[data-action="move-session"]')) setPin(t.dataset.person, Number(t.value));
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const personId = el.dataset.person;
  switch (action) {
    case 'set-tab': setTab(el.dataset.tab); break;
    case 'toggle-present': togglePresent(personId); break;
    case 'expand':
      if (expandedPeople.has(personId)) expandedPeople.delete(personId); else expandedPeople.add(personId);
      render();
      break;
    case 'stepper': stepper(personId, el.dataset.field, Number(el.dataset.dir)); break;
    case 'arrived-now': arrivedNow(personId); break;
    case 'leaving-now': leavingNow(personId); break;
    case 'add-walkin': addWalkin(); break;
    case 'import': doImport(); break;
    case 'new-evening': newEvening(); break;
    case 'load-demo': loadDemo(); break;
    case 'schedule': runSchedule(); break;
    case 'select-option': selectOption(el.dataset.option); break;
    case 'copy-whatsapp': copyWhatsApp(); break;
    case 'postit-open': openPostit(); break;
    case 'postit-close': closePostit(); break;
    case 'mark-played': markSessionPlayed(); break;
    case 'finish-evening': finishEvening(); break;
    case 'expand-log': {
      const idx = el.dataset.idx;
      if (expandedLog.has(idx)) expandedLog.delete(idx); else expandedLog.add(idx);
      render();
      break;
    }
    case 'export-data': exportData(); break;
    case 'import-data': triggerImportFile(); break;
    case 'clear-roster': clearRoster(); break;
    default: break;
  }
}

// ---------------------------------------------------------------- init

function init() {
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('click', onClick);
  setTab('evening');
}

init();
