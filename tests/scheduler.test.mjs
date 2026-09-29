import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, toMinutes, fromMinutes, formatTime12 } from '../js/scheduler.js';

// ---------------------------------------------------------------- helpers

let nextOrder = 1;
function person(id, name, game = null, extra = {}) {
  return {
    id, name, present: true, arrive: null, leave: null,
    arrivalOrder: nextOrder++, isOrganiser: false,
    game: game ? { durationMins: 60, ...game } : null,
    ...extra,
  };
}
const g = (min, max, pref, extra = {}) => ({ testersMin: min, testersMax: max, testersPreferred: pref, ...extra });

function baseInput(people, extra = {}) {
  return {
    start: '18:45', earliestEnd: '21:00', latestEnd: '22:00', endStep: 15,
    fixedEnd: null, changeoverMins: 0, graceMins: 10,
    people, locked: [], replanFrom: null, pins: {},
    ...extra,
  };
}

function fixtureAPeople() {
  nextOrder = 1;
  return [
    person('dean', 'Dean', g(1, 2, 1), { isOrganiser: true }),
    person('francesco', 'Francesco', g(1, 2, 1)),
    person('tari', 'Tari', g(1, 2, 1)),
    person('shan', 'Shan', g(3, 4, 3)),
    person('miquel', 'Miquel', g(2, 3, 2)),
    person('dotun', 'Dotun', g(2, 3, 2)),
    person('zoe', 'Zoe'),
    person('adi', 'Adi', g(3, 4, 3)),
    person('faryad', 'Faryad', g(2, 3, 2)),
  ];
}

const inSession = (p, s, grace) => {
  const a = p.arrive ? toMinutes(p.arrive) : -Infinity;
  const l = p.leave ? toMinutes(p.leave) : Infinity;
  return a <= toMinutes(s.start) + grace && l >= toMinutes(s.end) - grace;
};

// Invariants that must hold for every option of every result.
function checkInvariants(result, input) {
  assert.ok(result && typeof result === 'object');
  assert.ok(Array.isArray(result.options));
  const byId = new Map(input.people.map((p) => [p.id, p]));
  const grace = input.graceMins ?? 10;
  for (const opt of result.options) {
    // each game at most once
    const seen = new Set();
    for (const s of opt.sessions) for (const t of s.tables) {
      assert.ok(!seen.has(t.designerId), `game ${t.designerId} appears twice in ${opt.id}`);
      seen.add(t.designerId);
    }
    for (const id of opt.unscheduled) assert.ok(!seen.has(id), `${id} both scheduled and unscheduled`);

    for (const s of opt.sessions) {
      // headcount adds up
      const testers = s.tables.reduce((a, t) => a + t.testers, 0);
      assert.equal(s.tables.length + testers + s.watchers.length, s.presentCount,
        `headcount mismatch in session ${s.index + 1} of ${opt.id}`);
      // watchers are designers not running this session
      const running = new Set(s.tables.map((t) => t.designerId));
      for (const w of s.watchers) {
        assert.ok(byId.get(w) && byId.get(w).game, `watcher ${w} is not a designer`);
        assert.ok(!running.has(w), `watcher ${w} is running a game`);
      }
      assert.equal(new Set(s.watchers).size, s.watchers.length, 'duplicate watcher');
    }

    // new sessions: equal length, contiguous, at least one table, designers present
    const fresh = opt.sessions.filter((s) => !s.locked);
    assert.equal(fresh.length, opt.sessionCount);
    const first = input.replanFrom || input.start;
    if (fresh.length) assert.equal(fresh[0].start, first);
    const change = input.changeoverMins || 0;
    fresh.forEach((s, i) => {
      assert.equal(toMinutes(s.end) - toMinutes(s.start), opt.sessionLengthMins, 'unequal session length');
      if (i > 0) assert.equal(toMinutes(s.start), toMinutes(fresh[i - 1].end) + change, 'sessions not contiguous');
      assert.ok(s.tables.length >= 1, 'empty session');
      for (const t of s.tables) assert.ok(inSession(byId.get(t.designerId), s, grace), `${t.designerId} not present for own session`);
    });
    assert.ok(opt.sessionLengthMins >= 30 && opt.sessionLengthMins <= 120);
    if (fresh.length) assert.equal(opt.end, fresh[fresh.length - 1].end);
    // locked sessions come first
    const lockedCount = (input.locked || []).length;
    opt.sessions.forEach((s, i) => {
      assert.equal(s.locked, i < lockedCount);
      assert.equal(s.index, i);
    });
  }
  // options differ meaningfully
  const keys = result.options.map((o) => `${o.sessionCount}@${o.end}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate options');
  assert.ok(result.options.length <= 3);
}

function run(input) {
  const result = schedule(input);
  checkInvariants(result, input);
  return result;
}

const sessionOf = (opt, id) => opt.sessions.findIndex((s) => s.tables.some((t) => t.designerId === id));

// ---------------------------------------------------------------- time helpers

test('time helpers', () => {
  assert.equal(toMinutes('18:45'), 1125);
  assert.equal(fromMinutes(1125), '18:45');
  assert.equal(formatTime12('21:05'), '9:05');
  assert.equal(formatTime12('18:45'), '6:45');
  assert.equal(formatTime12('12:30'), '12:30');
});

// ---------------------------------------------------------------- fixtures

test('A: the real 28/09 evening', () => {
  const input = baseInput(fixtureAPeople());
  const res = run(input);
  assert.equal(res.error, null);
  const best = res.options[0];
  assert.equal(best.sessionCount, 3);
  assert.equal(best.unscheduled.length, 0);
  const ids = best.sessions.flatMap((s) => s.tables.map((t) => t.designerId)).sort();
  assert.deepEqual(ids, ['adi', 'dean', 'dotun', 'faryad', 'francesco', 'miquel', 'shan', 'tari']);
  assert.equal(sessionOf(best, 'dean'), 0);
  assert.ok(!best.warnings.some((w) => w.type === 'overMax'));
  assert.ok(!best.sessions.some((s) => s.tables.some((t) => t.overMax)));
  assert.ok(best.sessionLengthMins >= 45 && best.sessionLengthMins <= 60);
});

test('B: tester-heavy evening gives 2 sessions of 4 tables', () => {
  nextOrder = 1;
  const people = [];
  for (let i = 1; i <= 8; i++) people.push(person(`d${i}`, `Designer ${i}`, g(2, 3, 3)));
  for (let i = 1; i <= 8; i++) people.push(person(`t${i}`, `Tester ${i}`));
  const res = run(baseInput(people));
  const best = res.options[0];
  assert.equal(best.sessionCount, 2);
  assert.deepEqual(best.sessions.map((s) => s.tables.length), [4, 4]);
  assert.equal(best.unscheduled.length, 0);
  assert.ok(!best.warnings.some((w) => w.type === 'overMax' || w.type === 'underMin'));
});

test('C: Adi leaves at 20:00, so his game is in Session 1', () => {
  const people = fixtureAPeople();
  people.find((p) => p.id === 'adi').leave = '20:00';
  const res = run(baseInput(people));
  const best = res.options[0];
  assert.equal(sessionOf(best, 'adi'), 0);
  assert.equal(sessionOf(best, 'dean'), 0);
  assert.equal(best.unscheduled.length, 0);
});

test('D: Miquel arrives at 19:50, so he is not in Session 1', () => {
  const people = fixtureAPeople();
  people.find((p) => p.id === 'miquel').arrive = '19:50';
  const input = baseInput(people);
  const res = run(input);
  const best = res.options[0];
  assert.ok(sessionOf(best, 'miquel') > 0);
  const s1 = best.sessions[0];
  assert.ok(!s1.watchers.includes('miquel'));
  // 9 people, Miquel not there yet
  assert.equal(s1.presentCount, 8);
  assert.equal(best.unscheduled.length, 0);
});

test('E: replan after Session 1 with Faryad leaving', () => {
  const inputA = baseInput(fixtureAPeople());
  const bestA = run(inputA).options[0];
  const s1 = bestA.sessions[0];
  assert.ok(!s1.tables.some((t) => t.designerId === 'faryad'), 'precondition: Faryad not in Session 1');

  const people = fixtureAPeople();
  people.find((p) => p.id === 'faryad').leave = s1.end;
  const input = baseInput(people, { locked: [s1], replanFrom: s1.end });
  const res = run(input);
  assert.equal(res.error, null);
  const best = res.options[0];
  assert.deepEqual(best.sessions[0], { ...s1, locked: true });
  const lockedIds = new Set(s1.tables.map((t) => t.designerId));
  const newIds = best.sessions.slice(1).flatMap((s) => s.tables.map((t) => t.designerId));
  for (const id of newIds) assert.ok(!lockedIds.has(id), `${id} scheduled again`);
  assert.ok(!newIds.includes('faryad'));
  assert.deepEqual(best.unscheduled, ['faryad']);
  assert.ok(best.warnings.some((w) => w.type === 'unscheduled' && w.personId === 'faryad' && /Faryad/.test(w.message)));
  // every other remaining game is scheduled
  const remaining = ['dean', 'francesco', 'tari', 'shan', 'miquel', 'dotun', 'adi', 'faryad']
    .filter((id) => !lockedIds.has(id) && id !== 'faryad').sort();
  assert.deepEqual(newIds.slice().sort(), remaining);
});

test('F: a pin is honoured', () => {
  const baseline = run(baseInput(fixtureAPeople())).options[0];
  // pin Francesco somewhere other than where he'd naturally go
  const natural = sessionOf(baseline, 'francesco');
  const target = natural === 2 ? 1 : 2;
  const res = run(baseInput(fixtureAPeople(), { pins: { francesco: target } }));
  const best = res.options[0];
  assert.equal(sessionOf(best, 'francesco'), target);
  assert.equal(sessionOf(best, 'dean'), 0);
  assert.equal(best.unscheduled.length, 0);
});

test('G: 1 designer and 10 testers does not throw', () => {
  nextOrder = 1;
  const people = [person('solo', 'Solo', g(1, 2, 1))];
  for (let i = 1; i <= 10; i++) people.push(person(`t${i}`, `Tester ${i}`));
  const input = baseInput(people);
  let res;
  assert.doesNotThrow(() => { res = run(input); });
  const overMax = res.options.length && res.options[0].warnings.some((w) => w.type === 'overMax');
  const errWithSuggestions = res.error && res.error.message && res.error.suggestions.length > 0;
  assert.ok(overMax || errWithSuggestions);

  // With a fixed end inside 2 hours it schedules, with an overMax warning.
  const res2 = run(baseInput(people, { fixedEnd: '20:45' }));
  assert.equal(res2.error, null);
  assert.ok(res2.options[0].warnings.some((w) => w.type === 'overMax'));
});

test('H: no games at all returns an error', () => {
  nextOrder = 1;
  const people = [person('a', 'Ann'), person('b', 'Bob')];
  const res = run(baseInput(people));
  assert.ok(res.error && typeof res.error.message === 'string');
  assert.ok(Array.isArray(res.error.suggestions));
  assert.equal(res.options.length, 0);
  const res2 = run(baseInput([]));
  assert.ok(res2.error);
});

test('I: 15 designers plus 15 testers solves in under 500 ms', () => {
  nextOrder = 1;
  const specs = [[1, 2, 1], [2, 3, 2], [3, 4, 3], [2, 4, 3], [1, 3, 2]];
  const people = [];
  for (let i = 0; i < 15; i++) {
    const [a, b, c] = specs[i % specs.length];
    people.push(person(`d${i}`, `Designer ${i}`, g(a, b, c), i === 0 ? { isOrganiser: true } : {}));
  }
  for (let i = 0; i < 15; i++) people.push(person(`t${i}`, `Tester ${i}`));
  people[3].leave = '20:00';
  people[7].arrive = '19:40';
  const input = baseInput(people);
  const t0 = performance.now();
  const res = schedule(input);
  const ms = performance.now() - t0;
  checkInvariants(res, input);
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  assert.equal(res.error, null);
  assert.equal(res.options[0].unscheduled.length, 0);
  assert.equal(sessionOf(res.options[0], 'd0'), 0);
});

test('J: a duration warning is raised', () => {
  const people = fixtureAPeople();
  people.find((p) => p.id === 'shan').game.durationMins = 120;
  const res = run(baseInput(people));
  const best = res.options[0];
  const w = best.warnings.find((x) => x.type === 'duration');
  assert.ok(w);
  assert.equal(w.personId, 'shan');
  assert.match(w.message, /Shan/);
  // still a warning only: Shan's game is scheduled
  assert.ok(sessionOf(best, 'shan') >= 0);
});

test('extra: absent people are ignored and results are deterministic', () => {
  const people = fixtureAPeople();
  people.push({ ...person('ghost', 'Ghost', g(1, 2, 1)), present: false });
  const input = baseInput(people);
  const a = run(input), b = run(input);
  assert.deepEqual(a, b);
  assert.ok(!a.options[0].sessions.some((s) => s.tables.some((t) => t.designerId === 'ghost')));
});
