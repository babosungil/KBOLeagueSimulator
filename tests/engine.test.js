const test = require('node:test');
const assert = require('node:assert/strict');
const { loadKboScripts } = require('./helpers/load-scripts');

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

test('parseIP handles whole and fractional innings', () => {
  const { parseIP } = loadKboScripts();

  assert.equal(parseIP('176'), 176);
  assert.equal(parseIP('7 2/3'), 7.6667);
  assert.equal(parseIP('0 1/3'), 0.3333);
});

test('buildHitter derives rate stats and initializes today stats', () => {
  const { buildHitter } = loadKboScripts();

  const hitter = buildHitter({
    name: '테스트타자',
    AVG: 0.300,
    G: 100,
    PA: 500,
    AB: 450,
    H: 135,
    HR: 20,
    D2: 30,
    D3: 3,
    TB: 231,
    SAC: 2,
    SF: 4,
  });

  assert.equal(hitter.BB_est, 44);
  assert.equal(Number(hitter.obp.toFixed(3)), 0.358);
  assert.equal(Number(hitter.slg.toFixed(3)), 0.513);
  assert.equal(Number(hitter.ops.toFixed(3)), 0.871);
  assert.equal(Number(hitter.hr_rate.toFixed(3)), 0.044);
  assert.deepEqual(normalize(hitter.todayStats), { PA: 0, H: 0, HR: 0, RBI: 0, K: 0, BB: 0, SB: 0, CS: 0, SAC: 0 });
});

test('buildPitcher derives role and rate stats', () => {
  const { buildPitcher } = loadKboScripts();

  const starter = buildPitcher({ name: '선발', ERA: 3.5, G: 30, IP: 180, SO: 150, BB: 45 });
  const middle = buildPitcher({ name: '중간', ERA: 3.5, G: 50, IP: 100, SO: 90, BB: 30 });
  const closer = buildPitcher({ name: '마무리', ERA: 3.5, G: 60, IP: 60, SO: 70, BB: 20 });

  assert.equal(starter.role, 'starter');
  assert.equal(starter.isStarter, true);
  assert.equal(Number(starter.K9.toFixed(1)), 7.5);
  assert.equal(Number(starter.BB9.toFixed(1)), 2.3);
  assert.equal(middle.role, 'middle');
  assert.equal(closer.role, 'closer');
  assert.deepEqual(normalize(starter.todayStats), { IP_out: 0, H: 0, R: 0, ER: 0, BB: 0, K: 0 });
});

test('advRunners scores forced walk and home run correctly', () => {
  const { advRunners } = loadKboScripts();

  const walk = advRunners(['r1', 'r2', 'r3'], 'bb');
  assert.deepEqual(normalize(walk.bases), ['r', 'r2', 'r3']);
  assert.equal(walk.scored, 1);

  const homer = advRunners(['r1', null, 'r3'], 'hr');
  assert.deepEqual(normalize(homer.bases), [null, null, null]);
  assert.equal(homer.scored, 3);
});

test('calcPlatoon returns batter advantage for opposite hands', () => {
  const { calcPlatoon } = loadKboScripts();

  assert.equal(calcPlatoon('L', 'R').advantage, 'batter');
  assert.equal(calcPlatoon('R', 'R').advantage, 'pitcher');
  assert.equal(calcPlatoon('B', 'R').advantage, 'batter');
});
