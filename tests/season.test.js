const test = require('node:test');
const assert = require('node:assert/strict');
const { loadKboScripts } = require('./helpers/load-scripts');

const teams = ['kia', 'samsung', 'lg', 'doosan', 'kt', 'ssg', 'lotte', 'hanhwa', 'nc', 'kiwoom'];

test('buildSchedule creates a balanced 144-game season', () => {
  const { buildSchedule } = loadKboScripts();
  const schedule = buildSchedule(teams, 'doosan');

  assert.equal(schedule.length, 720);

  const counts = Object.fromEntries(teams.map(team => [team, { total: 0, home: 0 }]));
  for (const game of schedule) {
    counts[game.home].total++;
    counts[game.home].home++;
    counts[game.away].total++;
  }

  for (const team of teams) {
    assert.equal(counts[team].total, 144, `${team} total games`);
    assert.equal(counts[team].home, 72, `${team} home games`);
  }
});

test('buildSchedule places my team last inside each turn when present', () => {
  const { buildSchedule } = loadKboScripts();
  const schedule = buildSchedule(teams, 'doosan');
  const turns = new Map();

  for (const game of schedule) {
    if (!turns.has(game.turn)) turns.set(game.turn, []);
    turns.get(game.turn).push(game);
  }

  for (const games of turns.values()) {
    const myGameIndex = games.findIndex(game => game.home === 'doosan' || game.away === 'doosan');
    if (myGameIndex >= 0) assert.equal(myGameIndex, games.length - 1);
  }
});

test('applyResult updates standings for wins, losses, ties, runs, and streaks', () => {
  const { SS, initStandings, applyResult } = loadKboScripts();
  SS.standings = initStandings(['home', 'away']);

  applyResult({ home: 'home', away: 'away', result: { homeScore: 5, awayScore: 3 } });
  assert.equal(SS.standings.home.w, 1);
  assert.equal(SS.standings.away.l, 1);
  assert.equal(SS.standings.home.rs, 5);
  assert.equal(SS.standings.home.ra, 3);
  assert.equal(SS.standings.home.streak, 1);
  assert.equal(SS.standings.away.streak, -1);

  applyResult({ home: 'home', away: 'away', result: { homeScore: 4, awayScore: 4 } });
  assert.equal(SS.standings.home.d, 1);
  assert.equal(SS.standings.away.d, 1);
});

test('recordPitcherFatigue subtracts pitch count and tracks consecutive games once per game', () => {
  const { SS, recordPitcherFatigue } = loadKboScripts();
  SS.pitcherFatigue = {};
  SS.gameIdx = 10;

  recordPitcherFatigue([{ name: '투수', pitchCount: 25, isStarter: false }], 'doosan');
  assert.equal(SS.pitcherFatigue['투수_doosan'].stamina, 75);
  assert.equal(SS.pitcherFatigue['투수_doosan'].consecDays, 1);

  recordPitcherFatigue([{ name: '투수', pitchCount: 10, isStarter: false }], 'doosan');
  assert.equal(SS.pitcherFatigue['투수_doosan'].stamina, 65);
  assert.equal(SS.pitcherFatigue['투수_doosan'].consecDays, 1);

  SS.gameIdx = 11;
  recordPitcherFatigue([{ name: '투수', pitchCount: 5, isStarter: false }], 'doosan');
  assert.equal(SS.pitcherFatigue['투수_doosan'].stamina, 60);
  assert.equal(SS.pitcherFatigue['투수_doosan'].consecDays, 2);
});

test('recordCatcherFatigue supports numeric and innings-object inputs', () => {
  const { SS, recordCatcherFatigue } = loadKboScripts();
  SS.catcherFatigue = {};
  SS.gameIdx = 20;

  recordCatcherFatigue([{ name: '포수' }], 'doosan', 9);
  assert.equal(SS.catcherFatigue['포수_doosan'].stamina, 55);

  recordCatcherFatigue([{ name: '포수' }], 'doosan', { home: [0, 1, 0], away: [0, 0, 2, 1] });
  assert.equal(SS.catcherFatigue['포수_doosan'].stamina, 35);
  assert.equal(Number.isNaN(SS.catcherFatigue['포수_doosan'].stamina), false);
});
