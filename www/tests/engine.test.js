const test = require('node:test');
const assert = require('node:assert/strict');
const { loadKboScripts } = require('./helpers/load-scripts');

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function seededRandom() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function simulateHalfInnings({ decidePAResult, advRunners, batter, pitcher, defenseLineup, innings, seed }) {
  const originalRandom = Math.random;
  Math.random = createSeededRandom(seed);
  try {
    let hits = 0, runs = 0, plateAppearances = 0;
    for (let i = 0; i < innings; i++) {
      let outs = 0;
      let bases = [null, null, null];
      while (outs < 3) {
        const result = decidePAResult(batter, pitcher, bases, 5, outs, defenseLineup);
        plateAppearances++;
        if (result === 'k' || result === 'out') {
          outs++;
        } else if (result === 'dp') {
          outs = Math.min(3, outs + (bases[0] ? 2 : 1));
          bases = advRunners(bases, 'dp').bases;
        } else if (result === 'bb') {
          const advanced = advRunners(bases, 'bb');
          bases = advanced.bases;
          runs += advanced.scored;
        } else {
          hits++;
          const advanced = advRunners(bases, result);
          bases = advanced.bases;
          runs += advanced.scored;
        }
      }
    }
    return { hits, runs, plateAppearances, hitRate: hits / plateAppearances, runsPer9: runs / innings * 9 };
  } finally {
    Math.random = originalRandom;
  }
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

test('buildDefenseStats derives per-nine fielding stats', () => {
  const { buildDefenseStats } = loadKboScripts();

  const defense = buildDefenseStats({
    POS: '유격수',
    G: '100',
    GS: '90',
    IP: '900',
    E: '10',
    PO: '180',
    A: '300',
    DP: '60',
    FPCT: '0.979',
    PB: '0',
    SB: '0',
    CS: '0',
    'CS%': '-',
  });

  assert.equal(defense.pos, '유격수');
  assert.equal(defense.IP, 900);
  assert.equal(Number(defense.rangePer9.toFixed(1)), 4.8);
  assert.equal(Number(defense.errPer9.toFixed(1)), 0.1);
  assert.equal(Number(defense.dpPer9.toFixed(1)), 0.6);
  assert.equal(defense.CSPercent, null);
});

test('calcTeamDefenseImpact rewards stronger defense with hit suppression', () => {
  const { DB, calcTeamDefenseImpact } = loadKboScripts();

  const goodShortstop = {
    name: '좋은유격수',
    pos: 'SS',
    defense: { pos: '유격수', IP: 900, rangePer9: 5.2, errPer9: 0.04, dpPer9: 0.75, FPCT: 0.991 },
  };
  const poorShortstop = {
    name: '나쁜유격수',
    pos: 'SS',
    defense: { pos: '유격수', IP: 900, rangePer9: 3.8, errPer9: 0.22, dpPer9: 0.35, FPCT: 0.950 },
  };
  DB.hitters = [goodShortstop, poorShortstop];

  const goodImpact = calcTeamDefenseImpact([goodShortstop]);
  const poorImpact = calcTeamDefenseImpact([poorShortstop]);

  assert.ok(goodImpact.score > poorImpact.score);
  assert.ok(goodImpact.hitAdj > 0);
  assert.ok(poorImpact.hitAdj < 0);
  assert.ok(goodImpact.dpAdj > poorImpact.dpAdj);
});

test('defense impact changes simulated hits and scoring in the expected direction', () => {
  const { DB, buildHitter, buildPitcher, decidePAResult, advRunners } = loadKboScripts();

  const goodShortstop = {
    name: '좋은유격수',
    pos: 'SS',
    defense: { pos: '유격수', IP: 900, rangePer9: 5.2, errPer9: 0.04, dpPer9: 0.75, FPCT: 0.991 },
  };
  const poorShortstop = {
    name: '나쁜유격수',
    pos: 'SS',
    defense: { pos: '유격수', IP: 900, rangePer9: 3.8, errPer9: 0.22, dpPer9: 0.35, FPCT: 0.950 },
  };
  DB.hitters = [goodShortstop, poorShortstop];

  const batter = buildHitter({
    name: '시뮬타자',
    AVG: 0.280,
    G: 130,
    PA: 560,
    AB: 500,
    H: 140,
    HR: 18,
    D2: 28,
    D3: 2,
    TB: 226,
    SAC: 1,
    SF: 4,
    hand: 'R',
  });
  const pitcher = buildPitcher({ name: '시뮬투수', ERA: 4.30, G: 30, IP: 170, SO: 145, BB: 52, hand: 'R' });

  const goodDefense = simulateHalfInnings({
    decidePAResult,
    advRunners,
    batter,
    pitcher,
    defenseLineup: [goodShortstop],
    innings: 5000,
    seed: 20250603,
  });
  const poorDefense = simulateHalfInnings({
    decidePAResult,
    advRunners,
    batter,
    pitcher,
    defenseLineup: [poorShortstop],
    innings: 5000,
    seed: 20250603,
  });

  assert.ok(goodDefense.hitRate < poorDefense.hitRate);
  assert.ok(goodDefense.runsPer9 < poorDefense.runsPer9);
});
