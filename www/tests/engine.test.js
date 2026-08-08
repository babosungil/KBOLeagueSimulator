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

  const starter = buildPitcher({ name: '선발', ERA: 3.5, G: 30, GS: 30, IP: 180, SO: 150, BB: 45 });
  const middle = buildPitcher({ name: '중간', ERA: 3.5, G: 50, GS: 0, IP: 100, SO: 90, BB: 30 });
  const closer = buildPitcher({ name: '마무리', ERA: 3.5, G: 60, GS: 0, IP: 60, SO: 70, BB: 20 });

  assert.equal(starter.role, 'starter');
  assert.equal(starter.isStarter, true);
  assert.equal(Number(starter.K9.toFixed(1)), 7.5);
  assert.equal(Number(starter.BB9.toFixed(1)), 2.3);
  assert.equal(middle.role, 'middle');
  assert.equal(closer.role, 'closer');
  assert.deepEqual(normalize(starter.todayStats), { IP_out: 0, H: 0, R: 0, ER: 0, BB: 0, K: 0 });
});

test('buildPitcher classifies by GS, not by IP/G diluted with relief outings', () => {
  const { buildPitcher } = loadKboScripts();

  // 선발 16경기 전원 + 구원 없음이지만 IP/G가 4.5에 못 미치는 케이스(한화 에르난데스 형)
  const shortStarter = buildPitcher({ name: '짧은선발', ERA: 4.9, G: 16, GS: 16, IP: 71.3, SO: 50, BB: 25 });
  assert.equal(shortStarter.isStarter, true, 'GS가 충분하면 IP/G가 낮아도 선발');

  // 선발 13 + 구원 7 → IP/G는 3.8이지만 실제로는 선발(KIA 황동하 형)
  const swingStarter = buildPitcher({ name: '스윙선발', ERA: 4.4, G: 20, GS: 13, IP: 76, SO: 55, BB: 25 });
  assert.equal(swingStarter.isStarter, true);
  // 체력 용량은 '선발 등판당' 이닝 기준이어야 한다 (76/13 = 5.85, IP/G 3.8이 아니라)
  assert.ok(swingStarter.avgIP > 5 && swingStarter.avgIP < 6.5, `avgIP=${swingStarter.avgIP}`);

  // 구원 위주 스윙맨은 선발이 아니며, 구원 등판당 이닝으로 계산
  const swingMan = buildPitcher({ name: '스윙맨', ERA: 5.1, G: 37, GS: 4, IP: 53, SO: 40, BB: 20 });
  assert.equal(swingMan.isStarter, false);
  assert.ok(swingMan.avgIP > 1 && swingMan.avgIP < 2.5, `avgIP=${swingMan.avgIP}`);
});

test('buildTeamPitchers guarantees a minimum starting rotation', () => {
  const { buildTeamPitchers } = loadKboScripts();

  // 정규 선발이 2명뿐인 팀
  const rows = [
    { name: 'A', ERA: 3.0, G: 20, GS: 20, IP: 120, SO: 100, BB: 30 },
    { name: 'B', ERA: 3.4, G: 18, GS: 18, IP: 105, SO: 90, BB: 28 },
    { name: 'C', ERA: 4.0, G: 16, GS: 4, IP: 40, SO: 30, BB: 15 },
    { name: 'D', ERA: 4.2, G: 20, GS: 3, IP: 38, SO: 28, BB: 14 },
    { name: 'E', ERA: 4.5, G: 30, GS: 2, IP: 45, SO: 35, BB: 18 },
    { name: 'F', ERA: 4.8, G: 40, GS: 0, IP: 42, SO: 38, BB: 16 },
  ];
  const ps = buildTeamPitchers(rows);
  const starters = ps.filter(p => p.isStarter);

  assert.equal(starters.length, 5, '선발이 5명으로 보충되어야 한다');
  // GS 많은 순으로 승격 (C:4, D:3, E:2) → F(GS 0)는 승격되지 않음
  assert.deepEqual(starters.map(p => p.name).sort(), ['A', 'B', 'C', 'D', 'E']);
  // 승격된 투수는 선발 기준 체력 용량(최소 3.0이닝)을 받는다
  const promoted = ps.find(p => p.name === 'E');
  assert.ok(promoted.avgIP >= 3.0, `승격 투수 avgIP=${promoted.avgIP}`);
  assert.equal(promoted.role, 'starter');

  // 이미 5명 이상이면 승격 없음
  const deep = buildTeamPitchers([
    ...rows.slice(0, 2),
    { name: 'G', ERA: 3.6, G: 17, GS: 17, IP: 95, SO: 80, BB: 25 },
    { name: 'H', ERA: 3.8, G: 15, GS: 15, IP: 88, SO: 70, BB: 22 },
    { name: 'I', ERA: 4.1, G: 14, GS: 14, IP: 80, SO: 65, BB: 20 },
    { name: 'F', ERA: 4.8, G: 40, GS: 0, IP: 42, SO: 38, BB: 16 },
  ]);
  assert.equal(deep.filter(p => p.isStarter).length, 5);
  assert.equal(deep.find(p => p.name === 'F').isStarter, false);
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
