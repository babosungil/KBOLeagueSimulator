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

  // 비율 스탯은 표본 보정(리그 평균 50타석 가산)이 적용된 값이다.
  // 500타석 규모에서는 보정 폭이 작아 원래 값에 가깝게 남는다.
  assert.equal(hitter.BB_est, 44);
  assert.equal(Number(hitter.obp.toFixed(3)), 0.357);   // 보정 전 0.358
  assert.equal(Number(hitter.slg.toFixed(3)), 0.502);   // 보정 전 0.513
  assert.equal(Number(hitter.ops.toFixed(3)), 0.859);   // 보정 전 0.871
  assert.equal(Number(hitter.hit_rate.toFixed(3)), 0.297); // 보정 전 0.300
  assert.equal(Number(hitter.hr_rate.toFixed(3)), 0.044);  // 보정 대상 아님
  assert.deepEqual(normalize(hitter.todayStats), { PA: 0, H: 0, HR: 0, RBI: 0, K: 0, BB: 0, SB: 0, CS: 0, SAC: 0 });
});

test('buildHitter regresses tiny-sample rate stats toward the league mean', () => {
  const { buildHitter } = loadKboScripts();

  // 1타석 1안타 (보정이 없으면 타율 1.000, OPS 2.000으로 라인업 최상단을 차지)
  const fluke = buildHitter({
    name: '1타석타자', AVG: 1.000, G: 6, PA: 1, AB: 1, H: 1,
    HR: 0, D2: 0, D3: 0, TB: 1, SAC: 0, SF: 0,
  });
  assert.ok(fluke.hit_rate > 0.25 && fluke.hit_rate < 0.30,
    `1타석 타자는 리그 평균 근처여야 한다 (실제 ${fluke.hit_rate.toFixed(3)})`);
  assert.ok(fluke.ops < 0.85, `OPS도 압축되어야 한다 (실제 ${fluke.ops.toFixed(3)})`);
  // 안타 세부 비율도 무한대/1.0으로 튀지 않아야 한다
  assert.ok(fluke.hr_of_hit >= 0 && fluke.hr_of_hit < 0.3, `hr_of_hit=${fluke.hr_of_hit}`);

  // 규정타석급 강타자는 보정 후에도 확실히 우위를 유지해야 한다
  const star = buildHitter({
    name: '주전강타자', AVG: 0.340, G: 140, PA: 600, AB: 540, H: 184,
    HR: 30, D2: 35, D3: 2, TB: 313, SAC: 0, SF: 5,
  });
  assert.ok(star.hit_rate > fluke.hit_rate, '주전 강타자가 1타석 타자보다 높아야 한다');
  assert.ok(star.ops > fluke.ops);
  assert.ok(star.hit_rate > 0.32, `강타자는 과도하게 압축되면 안 된다 (실제 ${star.hit_rate.toFixed(3)})`);
});

test('buildLineup excludes tiny-sample hitters but falls back when short-handed', () => {
  const { buildHitter, buildLineup } = loadKboScripts();

  const mk = (name, PA, AB, H, TB) => buildHitter({
    name, AVG: H / AB, G: 100, PA, AB, H, HR: 5, D2: 10, D3: 1, TB, SAC: 0, SF: 0,
  });

  // 규정타석 9명 + 소표본 초고타율 1명
  const regulars = [];
  for (let i = 0; i < 9; i++) regulars.push(mk(`주전${i}`, 400, 360, 100, 150));
  const fluke = mk('한타석', 1, 1, 1, 1);

  const lineup = buildLineup([fluke, ...regulars]);
  assert.equal(lineup.length, 9);
  assert.ok(!lineup.some(p => p.name === '한타석'), '소표본 타자는 라인업에서 제외되어야 한다');

  // 자격자가 9명 미만이면 전체 풀로 되돌아간다
  const thin = buildLineup([fluke, ...regulars.slice(0, 5)]);
  assert.equal(thin.length, 6, '자격자 부족 시 소표본 타자라도 채워 넣는다');
  assert.ok(thin.some(p => p.name === '한타석'));
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

  // 만루 볼넷: 3루 주자 득점, 나머지는 한 베이스씩 밀려난다
  const walk = advRunners(['r1', 'r2', 'r3'], 'bb', 'B');
  assert.deepEqual(normalize(walk.bases), ['B', 'r1', 'r2']);
  assert.equal(walk.scored, 1);

  const homer = advRunners(['r1', null, 'r3'], 'hr', 'B');
  assert.deepEqual(normalize(homer.bases), [null, null, null]);
  assert.equal(homer.scored, 3);
});

test('advRunners carries runner identity to the correct base', () => {
  const { advRunners } = loadKboScripts();

  // 단타: 3루 주자 득점, 2루→3루, 1루→2루, 타자는 1루
  const single = advRunners(['a', 'b', 'c'], '1b', 'B');
  assert.deepEqual(normalize(single.bases), ['B', 'a', 'b']);
  assert.equal(single.scored, 1);

  // 2루타: 2·3루 주자 득점, 1루 주자는 3루까지, 타자는 2루
  const dbl = advRunners(['a', 'b', 'c'], '2b', 'B');
  assert.deepEqual(normalize(dbl.bases), [null, 'B', 'a']);
  assert.equal(dbl.scored, 2);

  // 3루타: 전원 득점, 타자만 3루
  const triple = advRunners(['a', 'b', null], '3b', 'B');
  assert.deepEqual(normalize(triple.bases), [null, null, 'B']);
  assert.equal(triple.scored, 2);

  // 밀어내기가 아닌 볼넷(1루 비어 있음): 기존 주자는 그대로
  const walk = advRunners([null, 'b', null], 'bb', 'B');
  assert.deepEqual(normalize(walk.bases), ['B', 'b', null]);
  assert.equal(walk.scored, 0);

  // 병살: 타자와 1루 주자가 지워지고 2·3루 주자는 유지
  const dp = advRunners(['a', 'b', 'c'], 'dp', 'B');
  assert.deepEqual(normalize(dp.bases), [null, 'b', 'c']);
  assert.equal(dp.scored, 0);

  // runner를 생략하면 익명 주자로 동작 (하위 호환)
  const anon = advRunners([null, null, null], '1b');
  assert.deepEqual(normalize(anon.bases), ['r', null, null]);
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
