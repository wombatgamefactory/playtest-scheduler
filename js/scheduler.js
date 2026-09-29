// Playtest UK evening scheduler - pure module, no imports, no DOM.
//
// schedule(input) -> { options, error }
//
// How it works:
//  1. Enumerate evening "shapes": for each candidate end time and each session
//     count n, the equal session length L (hard limits 30-120 minutes).
//  2. For each shape, work out who is present for each session and which
//     sessions each designer can run in.
//  3. Assign games to sessions. Small problems are searched exhaustively;
//     larger ones use steepest-descent local search (move one game / swap two
//     games) from a greedy start plus a few seeded random restarts. Seating
//     inside a session depends only on which games run there, so each
//     session's cost is cached and only the sessions touched by a move are
//     recomputed.
//  4. Score every shape (lower cost is better; see WEIGHTS) and return up to
//     three distinct shapes, best first.
//
// Option.score is this cost: LOWER IS BETTER.

const HARD_MIN_LEN = 30;
const HARD_MAX_LEN = 120;
const BAND_LO = 45; // ideal session length band 45-60
const BAND_HI = 60;
const GENTLE_HI = 90; // gentle penalty 60-90, steep beyond
const LEN_STEP = 5; // session lengths are rounded down to 5 minutes when they don't divide exactly
const EXHAUSTIVE_LIMIT = 3000; // assignments per shape below which we search exhaustively
const MAX_OPTIONS = 3;

// Cost weights, in priority order. Each tier is large enough to dominate
// realistic totals of the tiers below it.
const WEIGHTS = {
  empty: 1e7, // a new session with no table (infeasible - shape is discarded)
  unscheduled: 1e6, // per game left out
  broken: 1e5, // per pin / organiser-first rule that could not be honoured
  violation: 1e4, // per tester over max or under min
  // session length: 0 inside 45-60; 3/min below 45 or 60-90; 30/min beyond 90
  lenGentle: 3,
  lenSteep: 30,
  unused: 0.5, // per minute between the evening's actual end and the latest end
  preferred: 4, // per tester away from a table's preferred count
  watcher: 3, // per watcher
  balance: 1, // per person of |seated - mean seated| across sessions
  arrival: 0.2, // per pair of games where the later arrival runs earlier
};

// ---------------------------------------------------------------- time helpers

const pad = (n) => String(n).padStart(2, '0');

export function toMinutes(hhmm) {
  if (typeof hhmm === 'number') return hhmm;
  const [h, m] = String(hhmm).trim().split(':').map(Number);
  return h * 60 + (m || 0);
}

export function fromMinutes(mins) {
  const t = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

export function formatTime12(hhmm) {
  const t = ((toMinutes(hhmm) % 1440) + 1440) % 1440;
  let h = Math.floor(t / 60) % 12;
  if (h === 0) h = 12;
  return `${h}:${pad(t % 60)}`;
}

const fmt = (mins) => formatTime12(fromMinutes(mins));

// ---------------------------------------------------------------- entry point

export function schedule(input) {
  try {
    return scheduleInner(input || {});
  } catch (e) {
    return {
      options: [],
      error: {
        message: `The scheduler hit an unexpected problem: ${e && e.message ? e.message : e}`,
        suggestions: ['Check the times entered for the evening and for each person.'],
      },
    };
  }
}

function scheduleInner(input) {
  const ctx = normalise(input);

  if (ctx.people.every((p) => !p.game)) {
    return errorResult('Nobody here has a game to test yet.', [
      'Mark who has brought a game on the People screen.',
      'Check that the designers are marked as here.',
    ]);
  }
  if (ctx.games.length === 0) {
    return errorResult('Every game tonight has already been played.', [
      'Finish the evening to save it to the log.',
    ]);
  }

  const shapes = enumerateShapes(ctx);
  if (shapes.length === 0) return noShapeError(ctx);

  // Evaluate shapes cheapest-bound first so later shapes can be pruned.
  const prepared = shapes.map((s) => prepareShape(ctx, s)).filter(Boolean);
  prepared.sort((a, b) => a.constCost - b.constCost);

  const results = [];
  const keep = MAX_OPTIONS * 2;
  for (const shape of prepared) {
    if (results.length >= keep && shape.constCost >= results[keep - 1].cost) continue;
    const found = searchShape(ctx, shape);
    if (!found || found.varCost >= WEIGHTS.empty) continue; // could not give every session a table
    results.push({ shape, assign: found.assign, cost: shape.constCost + found.varCost });
    results.sort((a, b) => a.cost - b.cost);
  }

  if (results.length === 0) {
    return errorResult('No workable schedule was found for these times.', [
      'Widen the range of end times.',
      'Check the arrival and leave times: every session needs at least one designer who is here for all of it.',
    ]);
  }

  // Best first; then the best with a different session count (if any), then the next best.
  const chosen = [results[0]];
  const altCount = results.find((r) => r.shape.n !== results[0].shape.n);
  if (altCount) chosen.push(altCount);
  for (const r of results) {
    if (chosen.length >= MAX_OPTIONS) break;
    if (!chosen.includes(r)) chosen.push(r);
  }
  chosen.sort((a, b) => a.cost - b.cost);

  return { options: chosen.map((r) => materialise(ctx, r)), error: null };
}

function errorResult(message, suggestions) {
  return { options: [], error: { message, suggestions } };
}

// ---------------------------------------------------------------- input normalising

function normalise(input) {
  const start = toMinutes(input.replanFrom || input.start || '18:45');
  const endStep = Math.max(1, Number(input.endStep) || 15);
  let ends;
  if (input.fixedEnd) {
    ends = [toMinutes(input.fixedEnd)];
  } else {
    let lo = toMinutes(input.earliestEnd || '21:00');
    let hi = toMinutes(input.latestEnd || '22:00');
    if (lo > hi) [lo, hi] = [hi, lo];
    ends = [];
    for (let e = lo; e <= hi; e += endStep) ends.push(e);
    if (ends[ends.length - 1] !== hi) ends.push(hi);
  }
  const latestEnd = Math.max(...ends);

  const allPeople = new Map();
  const people = [];
  (input.people || []).forEach((p, i) => {
    if (!p || p.id == null) return;
    const person = {
      id: p.id,
      name: p.name || String(p.id),
      arrive: p.arrive ? toMinutes(p.arrive) : -Infinity,
      leave: p.leave ? toMinutes(p.leave) : Infinity,
      order: Number.isFinite(p.arrivalOrder) ? p.arrivalOrder : 1000 + i,
      index: i,
      isOrganiser: !!p.isOrganiser,
      game: p.game ? normaliseGame(p.game) : null,
    };
    allPeople.set(p.id, person);
    if (p.present) people.push(person);
  });

  const locked = (input.locked || []).map((s) => s || { tables: [] });
  const lockedDesigners = new Set();
  for (const s of locked) for (const t of s.tables || []) lockedDesigners.add(t.designerId);

  // Games still to play, in arrival order (used for the arrival tie-break).
  const games = people
    .filter((p) => p.game && !lockedDesigners.has(p.id))
    .sort((a, b) => a.order - b.order || a.index - b.index);

  return {
    start,
    ends,
    latestEnd,
    fixedEnd: !!input.fixedEnd,
    change: Math.max(0, Number(input.changeoverMins) || 0),
    grace: input.graceMins == null ? 10 : Number(input.graceMins),
    people,
    allPeople,
    locked,
    games,
    pins: input.pins || {},
  };
}

function normaliseGame(g) {
  const min = Math.max(0, Number.isFinite(g.testersMin) ? g.testersMin : 1);
  const max = Math.max(min, Number.isFinite(g.testersMax) ? g.testersMax : min);
  const prefRaw = Number.isFinite(g.testersPreferred) ? g.testersPreferred : min;
  const pref = Math.min(max, Math.max(min, prefRaw));
  const duration = Number.isFinite(g.durationMins) ? g.durationMins : null;
  return { min, max, pref, duration };
}

// ---------------------------------------------------------------- shapes

function enumerateShapes(ctx) {
  const seen = new Set();
  const shapes = [];
  for (const end of ctx.ends) {
    const total = end - ctx.start;
    for (let n = 1; n <= ctx.games.length; n++) {
      const avail = total - (n - 1) * ctx.change;
      if (avail <= 0) break;
      let L;
      if (avail % n === 0) L = avail / n;
      else if (ctx.fixedEnd) L = Math.floor(avail / n); // stay as close to the forced end as possible
      else L = Math.floor(avail / n / LEN_STEP) * LEN_STEP; // tidy 5-minute lengths
      if (L < HARD_MIN_LEN || L > HARD_MAX_LEN) continue;
      const key = `${n}:${L}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shapes.push({ n, L });
    }
  }
  return shapes;
}

function lengthPenalty(L) {
  if (L < BAND_LO) return (BAND_LO - L) * WEIGHTS.lenGentle;
  if (L <= BAND_HI) return 0;
  if (L <= GENTLE_HI) return (L - BAND_HI) * WEIGHTS.lenGentle;
  return (GENTLE_HI - BAND_HI) * WEIGHTS.lenGentle + (L - GENTLE_HI) * WEIGHTS.lenSteep;
}

const isIn = (p, s, e, grace) => p.arrive <= s + grace && p.leave >= e - grace;

// Work out session times, presence and each game's allowed sessions for a shape.
function prepareShape(ctx, { n, L }) {
  const sessions = [];
  for (let i = 0; i < n; i++) {
    const s = ctx.start + i * (L + ctx.change);
    const e = s + L;
    const present = ctx.people.filter((p) => isIn(p, s, e, ctx.grace));
    sessions.push({
      start: s,
      end: e,
      present,
      presentCount: present.length,
      designerCount: present.filter((p) => p.game).length, // anyone with a game can watch
    });
  }

  const G = ctx.games.length;
  const allowed = [];
  const fixed = new Array(G).fill(-1);
  const brokenRules = []; // { gameIndex, message }
  let unscheduled = 0;
  ctx.games.forEach((p, g) => {
    const ok = [];
    sessions.forEach((s, i) => { if (isIn(p, s.start, s.end, ctx.grace)) ok.push(i); });
    allowed.push(ok);
    if (ok.length === 0) { unscheduled++; return; }
    const pin = ctx.pins[p.id];
    if (pin != null && Number.isInteger(pin)) {
      if (ok.includes(pin)) fixed[g] = pin;
      else brokenRules.push({ g, message: pin >= n
        ? `${p.name}'s game was moved to Session ${ctx.locked.length + pin + 1}, but this plan only has ${n} new session${n === 1 ? '' : 's'}.`
        : `${p.name}'s game was moved to Session ${ctx.locked.length + pin + 1}, but ${p.name} isn't here for all of it.` });
    } else if (p.isOrganiser) {
      if (ok.includes(0)) fixed[g] = 0;
      else brokenRules.push({ g, message: `${p.name} isn't here for the whole of the first session, so ${p.name}'s game can't go first.` });
    }
  });

  const actualEnd = sessions[n - 1].end;
  const constCost =
    unscheduled * WEIGHTS.unscheduled +
    brokenRules.length * WEIGHTS.broken +
    lengthPenalty(L) +
    Math.max(0, ctx.latestEnd - actualEnd) * WEIGHTS.unused;

  return { n, L, sessions, allowed, fixed, brokenRules, actualEnd, constCost };
}

// ---------------------------------------------------------------- seating

// Seat k testers across tables (each {min,max,pref}); `pool` people could watch.
// Start from preferred, stay within min-max, then watchers, then over max.
function allocate(tables, k, pool) {
  const t = tables.map((x) => x.pref);
  let minSum = 0, maxSum = 0, sum = 0;
  for (let i = 0; i < tables.length; i++) { minSum += tables[i].min; maxSum += tables[i].max; sum += t[i]; }
  let watchers = 0, over = 0, under = 0;
  if (k >= minSum && k <= maxSum) {
    while (sum < k) {
      let best = -1;
      for (let i = 0; i < t.length; i++) {
        if (t[i] >= tables[i].max) continue;
        if (best < 0 || t[i] - tables[i].pref < t[best] - tables[best].pref) best = i;
      }
      t[best]++; sum++;
    }
    while (sum > k) {
      let best = -1;
      for (let i = 0; i < t.length; i++) {
        if (t[i] <= tables[i].min) continue;
        if (best < 0 || t[i] - tables[i].pref > t[best] - tables[best].pref) best = i;
      }
      t[best]--; sum--;
    }
  } else if (k > maxSum) {
    for (let i = 0; i < t.length; i++) t[i] = tables[i].max;
    const excess = k - maxSum;
    watchers = Math.min(excess, pool);
    over = excess - watchers;
    for (let r = 0; r < over; r++) {
      let best = 0;
      for (let i = 1; i < t.length; i++) if (t[i] - tables[i].max < t[best] - tables[best].max) best = i;
      t[best]++;
    }
  } else {
    for (let i = 0; i < t.length; i++) t[i] = tables[i].min;
    under = minSum - k;
    for (let r = 0; r < under; r++) {
      let best = -1; // take from the fullest table, so the shortfall is spread
      for (let i = 0; i < t.length; i++) if (t[i] > 0 && (best < 0 || t[i] > t[best])) best = i;
      t[best]--;
    }
  }
  let prefDist = 0;
  for (let i = 0; i < t.length; i++) prefDist += Math.abs(t[i] - tables[i].pref);
  return { testers: t, watchers, violations: over + under, prefDist };
}

// ---------------------------------------------------------------- search

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function searchShape(ctx, shape) {
  const { n, sessions, allowed, fixed } = shape;
  const G = ctx.games.length;
  const gameSpec = ctx.games.map((p) => p.game);

  // Cost of session s given the list of game indices running in it.
  const costOf = (s, list) => {
    if (list.length === 0) return { cost: WEIGHTS.empty, seated: 0 };
    const sess = sessions[s];
    const tables = list.map((g) => gameSpec[g]);
    const k = sess.presentCount - list.length;
    const pool = sess.designerCount - list.length;
    const a = allocate(tables, k, pool);
    return {
      cost: a.violations * WEIGHTS.violation + a.prefDist * WEIGHTS.preferred + a.watchers * WEIGHTS.watcher,
      seated: sess.presentCount - a.watchers,
    };
  };

  const schedulable = [];
  const free = [];
  for (let g = 0; g < G; g++) {
    if (allowed[g].length === 0) continue;
    schedulable.push(g);
    if (fixed[g] < 0) free.push(g);
  }
  if (schedulable.length < n) return null; // can't give every session a table

  // Cross-session terms: headcount balance and arrival-order inversions.
  const crossCost = (assign, seated) => {
    let mean = 0;
    for (let s = 0; s < n; s++) mean += seated[s];
    mean /= n;
    let bal = 0;
    for (let s = 0; s < n; s++) bal += Math.abs(seated[s] - mean);
    let inv = 0; // games are in arrival order, so i < j means i arrived first
    for (let i = 0; i < G; i++) {
      if (assign[i] < 0) continue;
      for (let j = i + 1; j < G; j++) if (assign[j] >= 0 && assign[i] > assign[j]) inv++;
    }
    return bal * WEIGHTS.balance + inv * WEIGHTS.arrival;
  };

  const fullCost = (assign) => {
    const lists = Array.from({ length: n }, () => []);
    for (let g = 0; g < G; g++) if (assign[g] >= 0) lists[assign[g]].push(g);
    let total = 0;
    const seated = new Array(n);
    for (let s = 0; s < n; s++) {
      const c = costOf(s, lists[s]);
      total += c.cost;
      seated[s] = c.seated;
    }
    return total + crossCost(assign, seated);
  };

  const base = new Array(G).fill(-1);
  for (let g = 0; g < G; g++) if (fixed[g] >= 0) base[g] = fixed[g];

  // Exhaustive search when the space is small.
  let space = 1;
  for (const g of free) { space *= allowed[g].length; if (space > EXHAUSTIVE_LIMIT) break; }
  if (space <= EXHAUSTIVE_LIMIT) {
    const assign = base.slice();
    let best = null, bestCost = Infinity;
    const rec = (i) => {
      if (i === free.length) {
        const c = fullCost(assign);
        if (c < bestCost - 1e-9) { bestCost = c; best = assign.slice(); }
        return;
      }
      const g = free[i];
      for (const s of allowed[g]) { assign[g] = s; rec(i + 1); }
      assign[g] = -1;
    };
    rec(0);
    return { assign: best, varCost: bestCost };
  }

  // Local search with cached per-session costs.
  const climb = (start) => {
    const assign = start.slice();
    const lists = Array.from({ length: n }, () => []);
    for (let g = 0; g < G; g++) if (assign[g] >= 0) lists[assign[g]].push(g);
    const sc = new Array(n), seated = new Array(n);
    for (let s = 0; s < n; s++) { const c = costOf(s, lists[s]); sc[s] = c.cost; seated[s] = c.seated; }
    const total = () => { let t = 0; for (let s = 0; s < n; s++) t += sc[s]; return t + crossCost(assign, seated); };
    let current = total();

    // Try moving games (moves: [g, toSession] pairs); returns the resulting cost and restores state.
    const tryMoves = (moves, commit) => {
      const saved = [];
      const touched = new Set();
      for (const [g, to] of moves) {
        const from = assign[g];
        saved.push([g, from]);
        lists[from].splice(lists[from].indexOf(g), 1);
        lists[to].push(g);
        assign[g] = to;
        touched.add(from); touched.add(to);
      }
      const old = [];
      for (const s of touched) { old.push([s, sc[s], seated[s]]); const c = costOf(s, lists[s]); sc[s] = c.cost; seated[s] = c.seated; }
      const result = total();
      if (!commit) {
        for (let i = saved.length - 1; i >= 0; i--) {
          const [g, from] = saved[i];
          const to = assign[g];
          lists[to].splice(lists[to].indexOf(g), 1);
          lists[from].push(g);
          assign[g] = from;
        }
        for (const [s, c, st] of old) { sc[s] = c; seated[s] = st; }
      }
      return result;
    };

    for (;;) {
      let bestMoves = null, bestCost = current;
      for (const g of free) {
        for (const s of allowed[g]) {
          if (s === assign[g]) continue;
          const c = tryMoves([[g, s]], false);
          if (c < bestCost - 1e-9) { bestCost = c; bestMoves = [[g, s]]; }
        }
      }
      for (let i = 0; i < free.length; i++) {
        const g = free[i];
        for (let j = i + 1; j < free.length; j++) {
          const h = free[j];
          const sg = assign[g], sh = assign[h];
          if (sg === sh || !allowed[g].includes(sh) || !allowed[h].includes(sg)) continue;
          const c = tryMoves([[g, sh], [h, sg]], false);
          if (c < bestCost - 1e-9) { bestCost = c; bestMoves = [[g, sh], [h, sg]]; }
        }
      }
      if (!bestMoves) break;
      current = tryMoves(bestMoves, true);
    }
    return { assign, varCost: current };
  };

  // Greedy start: most constrained games first, each into the session that
  // currently has the most spare people per table (fills empty sessions first).
  const greedy = base.slice();
  const load = new Array(n).fill(0);
  for (let g = 0; g < G; g++) if (greedy[g] >= 0) load[greedy[g]] += 1 + gameSpec[g].pref;
  const order = free.slice().sort((a, b) => allowed[a].length - allowed[b].length || a - b);
  for (const g of order) {
    let best = allowed[g][0], bestSpare = -Infinity;
    for (const s of allowed[g]) {
      const spare = sessions[s].presentCount - load[s] + (load[s] === 0 ? 1000 : 0);
      if (spare > bestSpare) { bestSpare = spare; best = s; }
    }
    greedy[g] = best;
    load[best] += 1 + gameSpec[g].pref;
  }

  let best = climb(greedy);
  const rand = mulberry32(12345 + n * 1000 + shape.L);
  const restarts = Math.min(8, 2 + Math.floor(free.length / 3));
  for (let r = 0; r < restarts; r++) {
    const start = base.slice();
    for (const g of free) start[g] = allowed[g][Math.floor(rand() * allowed[g].length)];
    const res = climb(start);
    if (res.varCost < best.varCost - 1e-9) best = res;
  }
  return best;
}

// ---------------------------------------------------------------- building the option

function materialise(ctx, { shape, assign, cost }) {
  const { n, L, sessions, brokenRules } = shape;
  const warnings = [];
  const out = [];

  // Locked sessions pass through unchanged (plus locked: true and names/limits if missing).
  ctx.locked.forEach((s, i) => {
    const tables = (s.tables || []).map((t) => {
      const p = ctx.allPeople.get(t.designerId);
      const g = p && p.game;
      return {
        name: p ? p.name : String(t.designerId),
        testersMin: g ? g.min : undefined,
        testersMax: g ? g.max : undefined,
        overMax: false,
        underMin: false,
        ...t,
      };
    });
    const watchers = s.watchers || [];
    const presentCount = s.presentCount != null
      ? s.presentCount
      : tables.length + tables.reduce((a, t) => a + (t.testers || 0), 0) + watchers.length;
    out.push({ ...s, index: i, locked: true, tables, watchers, presentCount });
  });

  const offset = ctx.locked.length;
  const watchCount = new Map(); // spread watching across different people
  for (const s of ctx.locked) for (const w of s.watchers || []) watchCount.set(w, (watchCount.get(w) || 0) + 1);

  sessions.forEach((sess, s) => {
    const running = ctx.games.filter((_, g) => assign[g] === s);
    const runningIds = new Set(running.map((p) => p.id));
    const k = sess.presentCount - running.length;
    const pool = sess.present.filter((p) => p.game && !runningIds.has(p.id));
    const a = allocate(running.map((p) => p.game), k, pool.length);

    // Watchers: those who have watched least so far, then the latest arrivals.
    const watchers = pool
      .slice()
      .sort((x, y) => (watchCount.get(x.id) || 0) - (watchCount.get(y.id) || 0) || y.order - x.order)
      .slice(0, a.watchers)
      .map((p) => p.id);
    for (const w of watchers) watchCount.set(w, (watchCount.get(w) || 0) + 1);

    const tables = running.map((p, i) => {
      const t = a.testers[i];
      const tbl = {
        designerId: p.id,
        name: p.name,
        testers: t,
        testersMin: p.game.min,
        testersMax: p.game.max,
        overMax: t > p.game.max,
        underMin: t < p.game.min,
      };
      if (tbl.overMax) warnings.push({ type: 'overMax', personId: p.id,
        message: `${p.name}'s table in Session ${offset + s + 1} has ${t} testers, over the maximum of ${p.game.max}.` });
      if (tbl.underMin) warnings.push({ type: 'underMin', personId: p.id,
        message: `${p.name}'s table in Session ${offset + s + 1} has only ${t} tester${t === 1 ? '' : 's'}, under the minimum of ${p.game.min}.` });
      if (p.game.duration && p.game.duration > L) warnings.push({ type: 'duration', personId: p.id,
        message: `${p.name}'s game takes ${p.game.duration} minutes, but sessions are ${L} minutes.` });
      return tbl;
    });

    out.push({
      index: offset + s,
      start: fromMinutes(sess.start),
      end: fromMinutes(sess.end),
      locked: false,
      tables,
      watchers,
      presentCount: sess.presentCount,
    });
  });

  const unscheduled = [];
  ctx.games.forEach((p, g) => {
    if (assign[g] >= 0) return;
    unscheduled.push(p.id);
    const first = sessions[0], last = sessions[n - 1];
    let why;
    if (p.leave < first.end - ctx.grace) why = `${p.name} leaves at ${fmt(p.leave)}, before any remaining session ends.`;
    else if (p.arrive > last.start + ctx.grace) why = `${p.name} arrives at ${fmt(p.arrive)}, too late for any session.`;
    else why = `${p.name} isn't here for the whole of any session.`;
    warnings.push({ type: 'unscheduled', personId: p.id, message: `${p.name}'s game can't be scheduled: ${why}` });
  });
  for (const b of brokenRules) warnings.push({ type: 'other', personId: ctx.games[b.g].id, message: b.message });

  if (L < BAND_LO || L > BAND_HI) {
    warnings.push({ type: 'lengthOutsideBand',
      message: `Sessions are ${L} minutes, ${L < BAND_LO ? 'shorter' : 'longer'} than the usual 45-60.` });
  }

  const end = fromMinutes(shape.actualEnd);
  return {
    id: `${n}x${L}-${end}`,
    sessionCount: n,
    sessionLengthMins: L,
    end,
    sessions: out,
    unscheduled,
    warnings,
    score: Math.round(cost * 100) / 100,
  };
}

// ---------------------------------------------------------------- explaining failure

function noShapeError(ctx) {
  const G = ctx.games.length;
  const earliest = Math.min(...ctx.ends);
  const latest = Math.max(...ctx.ends);
  if (latest - ctx.start < HARD_MIN_LEN) {
    return errorResult(`There isn't time for a session between ${fmt(ctx.start)} and ${fmt(latest)}.`, [
      `Set the end time to ${fmt(ctx.start + HARD_MIN_LEN)} or later.`,
      'Start the sessions earlier.',
    ]);
  }
  const maxEnd = ctx.start + G * HARD_MAX_LEN + (G - 1) * ctx.change;
  if (maxEnd < earliest) {
    return errorResult(
      `With ${G} game${G === 1 ? '' : 's'}, each session would be longer than 2 hours (one session per game at most).`,
      [
        `Finish by ${fmt(maxEnd)}, or set a fixed end time.`,
        'Add another game - a walk-in designer, or a spare game someone has brought.',
      ]);
  }
  return errorResult('No session length between 30 minutes and 2 hours fits these times.', [
    'Widen the range of end times.',
    'Reduce the changeover time between sessions.',
  ]);
}
