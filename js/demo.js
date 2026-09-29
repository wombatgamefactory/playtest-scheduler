// The 28/09 demo evening ("Load demo evening" on the Evening tab), matching
// scheduler.test.mjs fixture A exactly: 8 designers plus Zoe (no game),
// start 18:45, ends 21:00-22:00. The best schedule() result for this input
// is 3 sessions, all 8 games played, Dean in Session 1, no overMax.

const GAMES = [
  ['dean', 'Dean', 'Dean', true, 1, 2, 1],
  ['francesco', 'Francesco Salerno', 'Francesco', false, 1, 2, 1],
  ['tari', 'Tari', 'Tari', false, 1, 2, 1],
  ['shan', 'Shan Syed', 'Shan', false, 3, 4, 3],
  ['miquel', 'Miquel Mansachs', 'Miquel', false, 2, 3, 2],
  ['dotun', 'Oladotun Ogunsulire', 'Dotun', false, 2, 3, 2],
  ['faryad', 'faryad', 'Faryad', false, 2, 3, 2],
  ['adi', 'Aditya Singh', 'Adi', false, 3, 4, 3],
];

export function buildDemoEvening(dateISO) {
  const people = GAMES.map(([id, meetupName, displayName, isOrganiser, min, max, pref], i) => ({
    id,
    meetupName,
    displayName,
    present: true,
    arrive: null,
    leave: null,
    arrivalOrder: i + 1,
    isOrganiser,
    game: { testersMin: min, testersMax: max, testersPreferred: pref, durationMins: null },
    suggestedFromComment: null,
    cancelledNote: null,
  }));
  people.push({
    id: 'zoe',
    meetupName: 'Zoe Lou',
    displayName: 'Zoe',
    present: true,
    arrive: null,
    leave: null,
    arrivalOrder: people.length + 1,
    isOrganiser: false,
    game: null,
    suggestedFromComment: null,
    cancelledNote: null,
  });

  return {
    date: dateISO,
    start: '18:45',
    earliestEnd: '21:00',
    latestEnd: '22:00',
    changeoverMins: 0,
    title: 'London [Mondays] After-Hours Playtest (demo)',
    meetupEventId: null,
    nextOrder: people.length + 1,
    people,
    lockedSessions: [],
    pins: {},
    schedule: null,
    selectedOptionId: null,
  };
}
