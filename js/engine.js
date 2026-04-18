// ═══════════════════════════════════════════════════════
//  KBO 시뮬레이터 — 게임 엔진 (engine.js)
//  데이터는 포함하지 않음. DataLoader가 주입한 뒤 사용.
// ═══════════════════════════════════════════════════════

'use strict';

// ── Base URL (상대경로 자동 감지) ──
// index.html이 있는 폴더를 기준으로 data/ 경로를 계산
// → 로컬/GitHub Pages/어떤 서버든 폴더 구조만 맞으면 동작
const BASE_URL = document.currentScript
  ? new URL('.', document.currentScript.src).href.replace(/js\/$/, '')
  : new URL('.', location.href).href;
function dataUrl(path) { return `${BASE_URL}${path}`; }

// ── 런타임 데이터 저장소 (DataLoader가 채움) ──
const DB = {
  hitters: [],   // buildHitter() 처리 전 원본
  pitchers: [],  // buildPitcher() 처리 전 원본
};

// ── 상수 ──
const PITCH_DIST = {
  k:   { mean: 4.8, sd: 0.9 },
  bb:  { mean: 5.2, sd: 1.0 },
  hr:  { mean: 3.2, sd: 1.1 },
  hit: { mean: 3.0, sd: 1.0 },
  out: { mean: 3.5, sd: 1.1 },
};
const SPEED_DELAYS = [0, 150, 500, 1100, 2200];
const SPEED_LABELS = ['최고속', '빠름', '보통', '느림', '아주느림'];
const MAX_INNINGS  = 12;

// ── 전역 상태 ──
let gs        = null;
let isPlaying = false;
let playTimer = null;
let speedIdx  = 2;

// ═══════════════════════════════════════════════════════
//  데이터 로더 (CSV 기반)
// ═══════════════════════════════════════════════════════

// ── batting_throwing → hand 변환 테이블 ──
const HAND_MAP = {
  '우투우타': ['R', 'R'],
  '우투좌타': ['L', 'R'],
  '우투양타': ['B', 'R'],
  '좌투좌타': ['L', 'L'],
  '좌투우타': ['R', 'L'],
  '좌투양타': ['B', 'L'],
  '우언우타': ['R', 'R'],
  '우언좌타': ['L', 'R'],
};

/**
 * CSV 텍스트를 파싱해 객체 배열로 반환.
 * 헤더 행을 키로 사용하며 각 셀의 앞뒤 공백을 제거한다.
 */
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

/**
 * "7 2/3" 형태의 이닝 문자열을 소수로 변환.
 * 예) "7 2/3" → 7.6667, "176" → 176.0
 */
function parseIP(str) {
  const s = String(str).trim();
  if (s.includes(' ')) {
    const [whole, frac] = s.split(' ');
    const [num, den]    = frac.split('/');
    return Math.round((parseInt(whole) + parseInt(num) / parseInt(den)) * 10000) / 10000;
  }
  return parseFloat(s);
}

/**
 * player_profile CSV로부터 playerId → { hitterHand, pitcherHand } 맵을 빌드.
 */
// playerId → 프로필 전체 맵 (hand + 나이·체격·연봉 등)
function buildProfileLookup(profileRows) {
  const map = {};
  profileRows.forEach(r => {
    const [hh, ph] = HAND_MAP[r['batting_throwing']] || ['R', 'R'];
    // 나이 계산
    const age = r['birthday']
      ? Math.floor((Date.now() - new Date(r['birthday'])) / (365.25 * 24 * 3600 * 1000))
      : null;
    // 연봉 정규화 (달러 표기 제거, 만원 단위)
    const salaryRaw = String(r['salary'] || '').replace('달러', '').trim();
    const salary    = salaryRaw ? parseInt(salaryRaw) : null;
    map[r['playerId']] = {
      hitterHand:      hh,
      pitcherHand:     ph,
      jerseyNumber:    r['jersey_number'] ? parseInt(r['jersey_number']) : null,
      age,
      height:          parseInt(r['height']) || null,
      weight:          parseInt(r['weight']) || null,
      position:        r['position'] || null,
      battingThrowing: r['batting_throwing'] || null,
      career:          r['career'] || null,
      draft:           r['draft'] || null,
      salary,
      salaryRaw:       r['salary'] || null,
    };
  });
  return map;
}

/**
 * 타자 CSV 행 → JSON hitter 객체 변환.
 * AVG='-' (타석 없는 투수) 는 null을 반환해 호출 측에서 걸러낸다.
 */
function csvRowToHitter(row, profileLookup, teamName) {
  if (row['AVG'] === '-') return null;           // 타석 없는 투수 제외
  const p = profileLookup[row['playerId']] || {};
  return {
    name:            row['선수명'],
    team:            teamName,
    AVG:             Math.round(parseFloat(row['AVG']) * 1000) / 1000,
    G:               parseInt(row['G']),
    PA:              parseInt(row['PA']),
    AB:              parseInt(row['AB']),
    H:               parseInt(row['H']),
    HR:              parseInt(row['HR']),
    D2:              parseInt(row['2B']),
    D3:              parseInt(row['3B']),
    RBI:             parseInt(row['RBI']),
    TB:              parseInt(row['TB']),
    SAC:             parseInt(row['SAC']),
    SF:              parseInt(row['SF']),
    BB:              parseInt(row['BB']),
    hand:            p.hitterHand      || 'R',
    // 도루 스탯 (run CSV에서 병합 — 없으면 0)
    SB:              0,
    CS:              0,
    SBA:             0,
    sbPct:           0,
    // 수비 포지션 (defense CSV에서 병합)
    defPos:          null,
    // 포수 도루 저지율 (defense CSV에서 병합)
    csPct:           null,
    // 프로필
    jerseyNumber:    p.jerseyNumber    || null,
    age:             p.age             || null,
    height:          p.height          || null,
    weight:          p.weight          || null,
    position:        p.position        || null,
    battingThrowing: p.battingThrowing || null,
    career:          p.career          || null,
    draft:           p.draft           || null,
    salary:          p.salary          || null,
    salaryRaw:       p.salaryRaw       || null,
  };
}

/**
 * 투수 CSV 행 → JSON pitcher 객체 변환.
 */
function csvRowToPitcher(row, profileLookup, teamName) {
  const p = profileLookup[row['playerId']] || {};
  return {
    name:            row['선수명'],
    team:            teamName,
    ERA:             Math.round(parseFloat(row['ERA'])  * 100) / 100,
    G:               parseInt(row['G']),
    IP:              parseIP(row['IP']),
    SO:              parseInt(row['SO']),
    BB:              parseInt(row['BB']),
    WHIP:            Math.round(parseFloat(row['WHIP']) * 100) / 100,
    hand:            p.pitcherHand     || 'R',
    // 프로필
    jerseyNumber:    p.jerseyNumber    || null,
    age:             p.age             || null,
    height:          p.height          || null,
    weight:          p.weight          || null,
    position:        p.position        || null,
    battingThrowing: p.battingThrowing || null,
    career:          p.career          || null,
    draft:           p.draft           || null,
    salary:          p.salary          || null,
    salaryRaw:       p.salaryRaw       || null,
  };
}

/**
 * 한 팀의 CSV 3종(타자·투수·프로파일)을 병렬 fetch해서
 * { hitters, pitchers } 를 반환.
 *
 * 파일 경로 규칙:
 *   data/{year}/{team}_hitter.csv
 *   data/{year}/{team}_pitcher.csv
 *   data/player_profile.csv          ← 연도 무관 공통 파일
 */
async function loadTeamCSV(year, teamCode, korName, profileRows) {
  const [hitterRes, pitcherRes, runRes, defRes] = await Promise.all([
    fetch(dataUrl(`data/${year}/${year}_hitter_${teamCode}.csv`)),
    fetch(dataUrl(`data/${year}/${year}_pitcher_${teamCode}.csv`)),
    fetch(dataUrl(`data/${year}/${year}_run_${teamCode}.csv`)),
    fetch(dataUrl(`data/${year}/${year}_defense_${teamCode}.csv`)),
  ]);
  if (!hitterRes.ok)  throw new Error(`${korName}(${teamCode}) 타자 데이터를 찾을 수 없습니다 (${year})`);
  if (!pitcherRes.ok) throw new Error(`${korName}(${teamCode}) 투수 데이터를 찾을 수 없습니다 (${year})`);

  const [hitterText, pitcherText] = await Promise.all([
    hitterRes.text(),
    pitcherRes.text(),
  ]);

  const profileLookup = buildProfileLookup(profileRows);

  // team 필드에는 영문 코드 대신 한글명 저장 → 게임 내 UI 표시에 사용
  const hitters  = parseCSV(hitterText)
    .map(r => csvRowToHitter(r, profileLookup, korName))
    .filter(Boolean);                             // null(AVG='-') 제거
  const pitchers = parseCSV(pitcherText)
    .map(r => csvRowToPitcher(r, profileLookup, korName));

  // ── 도루 데이터 병합 (run CSV) ──────────────────────────────────────────
  if (runRes.ok) {
    const runRows = parseCSV(await runRes.text());
    hitters.forEach(h => {
      const rr = runRows.find(r => r['선수명'] === h.name);
      if (rr) {
        h.SB    = parseInt(rr['SB'])        || 0;
        h.CS    = parseInt(rr['CS'])        || 0;
        h.SBA   = parseInt(rr['SBA'])       || 0;
        h.sbPct = parseFloat(rr['SB%'])     || 0;
      }
    });
  }

  // ── 수비 데이터 병합 (defense CSV) ─────────────────────────────────────
  if (defRes.ok) {
    const defRows = parseCSV(await defRes.text());
    // 선수명 기준으로 출장 수 최다 포지션을 주 포지션으로 결정
    const defMap = {};
    defRows.forEach(r => {
      const name = r['선수명'];
      if (!defMap[name]) defMap[name] = [];
      defMap[name].push(r);
    });
    hitters.forEach(h => {
      const rows = defMap[h.name];
      if (!rows) return;
      const main = rows.slice().sort((a, b) => parseInt(b['G']) - parseInt(a['G']))[0];
      h.defPos = main['POS'] || null;
      // 포수인 경우 도루 저지율 추가
      const catcherRow = rows.find(r => r['POS'] === '포수');
      if (catcherRow) {
        const csVal = catcherRow['CS%'];
        h.csPct = (csVal && csVal !== '-') ? parseFloat(csVal) : 0;
      }
    });
  }

  return { hitters, pitchers };
}

/**
 * 두 팀의 CSV를 병렬로 fetch해서 DB에 적재한 뒤 콜백 실행.
 * @param {string}   year     - "2025"
 * @param {string}   home     - "두산"
 * @param {string}   away     - "KIA"
 * @param {Function} onReady  - 로드 완료 콜백
 * @param {Function} onError  - 에러 콜백 (message:string)
 */
async function loadTeamData(year, home, away, onReady, onError) {
  try {
    // player_profile은 연도 무관 공통 파일 — 한 번만 fetch
    const profileRes = await fetch(dataUrl('data/player_profile.csv'));
    if (!profileRes.ok) throw new Error('player_profile.csv를 찾을 수 없습니다');
    const profileRows = parseCSV(await profileRes.text());

    // _meta.json의 name_kor에서 한글명 조회 (없으면 영문 코드 그대로 사용)
    const metaRes  = await fetch(dataUrl('data/_meta.json'));
    const meta     = metaRes.ok ? await metaRes.json() : {};
    const nameKor  = (meta.name_kor) || {};
    const homeKor  = nameKor[home] || home;
    const awayKor  = nameKor[away] || away;

    // 홈·원정 팀 CSV 병렬 로드 (파일명=영문코드, 선수데이터 team=한글명)
    const [homeData, awayData] = await Promise.all([
      loadTeamCSV(year, home, homeKor, profileRows),
      loadTeamCSV(year, away, awayKor, profileRows),
    ]);

    DB.hitters  = [...homeData.hitters,  ...awayData.hitters];
    DB.pitchers = [...homeData.pitchers, ...awayData.pitchers];

    // 한글 팀명을 호출 측에 전달 (UI 표시용)
    onReady({ homeKor, awayKor });
  } catch (e) {
    onError(e.message || '데이터 로드 실패');
  }
}

/**
 * 연도·팀 목록 메타 정보를 fetch. (_meta.json 유지)
 * @param {Function} onReady  - ({ years, teams }) 콜백
 * @param {Function} onError
 */
async function loadMeta(onReady, onError) {
  try {
    const res  = await fetch(dataUrl('data/_meta.json'));
    if (!res.ok) throw new Error('메타 데이터를 찾을 수 없습니다');
    const meta = await res.json();
    onReady(meta);
  } catch (e) {
    onError(e.message || '메타 데이터 로드 실패');
  }
}

// ═══════════════════════════════════════════════════════
//  선수 처리
// ═══════════════════════════════════════════════════════

function buildHitter(r) {
  const AB = r.AB || 1, PA = r.PA || 1, H = r.H || 0,
        HR = r.HR || 0, D2 = r.D2 || 0, D3 = r.D3 || 0;
  const BB = Math.max(0, PA - AB - (r.SAC || 0) - (r.SF || 0));
  const slg = (r.TB || 0) / AB, obp = (H + BB) / PA, ops = obp + slg;
  const speedScore = Math.min(1, (D3 * 3 + r.SAC * 1.5) / Math.max(PA, 1) * 10 + 0.1);
  return {
    ...r, BB_est: BB, bb_rate: BB / PA,
    k_rate: Math.max(0.08, 0.21 - (r.AVG - 0.265) * 0.35),
    hr_rate: HR / Math.max(AB, 1), hit_rate: r.AVG,
    hr_of_hit: HR / Math.max(H, 1), d3_of_hit: D3 / Math.max(H, 1),
    d2_of_hit: D2 / Math.max(H, 1),
    ops, obp, slg, speedScore,
    todayStats: { PA: 0, H: 0, HR: 0, RBI: 0, K: 0, BB: 0, SB: 0, CS: 0, SAC: 0 },
  };
}

function buildPitcher(r) {
  const ip = r.IP || 1, g = r.G || 1;
  const avgIP = ip / g;
  const role = avgIP >= 4.5 ? 'starter' : avgIP >= 1.5 ? 'middle' : 'closer';
  return {
    ...r,
    K9: (r.SO / ip) * 9, BB9: (r.BB / ip) * 9,
    avgIP, pitchCount: 0, isStarter: avgIP >= 4.5, role, usedToday: false,
  };
}

function getTeamHitters(team) {
  return DB.hitters.filter(r => r.team === team).map(buildHitter).sort((a, b) => b.G - a.G);
}
function getTeamPitchers(team) {
  return DB.pitchers.filter(r => r.team === team).map(buildPitcher);
}
// 팀 영문 코드 역조회 (시즌 모드 피로도 연동용)
function getTeamCode(korName) {
  if (typeof SS === 'undefined' || !SS.nameKor) return null;
  return Object.keys(SS.nameKor).find(k => SS.nameKor[k] === korName) || null;
}
// 수비 포지션 한글 → 영문 약어
const POS_KOR_MAP = {
  '포수': 'C', '1루수': '1B', '2루수': '2B', '3루수': '3B',
  '유격수': 'SS', '좌익수': 'LF', '중견수': 'CF', '우익수': 'RF',
  '투수': 'P', '외야수': 'OF', '내야수': 'IF',
};

function buildLineup(hs) {
  const sorted = [...hs].sort((a, b) => b.ops - a.ops);
  const fallbackPos = ['CF', 'SS', '3B', '1B', 'RF', '2B', 'C', 'LF', 'DH'];
  const used   = new Set();
  const lineup = [];

  // 포수(C) 우선 배치 — 포수가 없으면 수비 포지션 무시
  const catcher = sorted.find(p => p.defPos === '포수');
  if (catcher) used.add(catcher.name);

  sorted.slice(0, 12).forEach(p => {
    if (lineup.length >= 9) return;
    if (used.has(p.name))   return;
    used.add(p.name);
    lineup.push(p);
  });

  // 포수를 7번 타순 자리에 삽입 (없으면 그냥 순서대로)
  if (catcher && lineup.length >= 6) lineup.splice(6, 0, catcher);
  else if (catcher)                  lineup.push(catcher);

  return lineup.slice(0, 9).map((p, i) => ({
    ...p,
    order: i + 1,
    pos: POS_KOR_MAP[p.defPos] || fallbackPos[i] || 'DH',
  }));
}
function pickStarter(ps) {
  const s = ps.filter(p => p.isStarter);
  if (!s.length) return ps[0];
  return s.sort((a, b) => a.ERA - b.ERA)[Math.floor(Math.random() * Math.min(3, s.length))];
}

// ═══════════════════════════════════════════════════════
//  투수 분업 전략
// ═══════════════════════════════════════════════════════

function selectReliever(allPitchers, currentPitcher, inning, scoreDiff) {
  const pool = allPitchers.filter(p => !p.isStarter && p.name !== currentPitcher.name && !p.usedToday);
  if (!pool.length) return null;

  if (inning >= 9 && scoreDiff > 0 && scoreDiff <= 3) {
    const closer = pool.filter(p => p.ERA < 3.0).sort((a, b) => a.ERA - b.ERA);
    if (closer.length) { const p = closer[0]; p.usedToday = true; return p; }
  }
  if (inning === 8) {
    const setup = pool.filter(p => p.ERA < 3.5).sort((a, b) => a.ERA - b.ERA);
    if (setup.length) { const p = setup[0]; p.usedToday = true; return p; }
  }
  if (inning >= 6) {
    const mid = pool.filter(p => p.ERA < 4.5).sort((a, b) => a.ERA - b.ERA);
    if (mid.length) { const p = mid[0]; p.usedToday = true; return p; }
  }
  const fallback = pool.sort((a, b) => a.ERA - b.ERA);
  if (fallback.length) { const p = fallback[0]; p.usedToday = true; return p; }
  return null;
}

// ═══════════════════════════════════════════════════════
//  엔진 유틸
// ═══════════════════════════════════════════════════════

function rn() { return Math.random(); }
function randN(mean, sd) {
  const u = 1 - rn(), v = rn();
  return Math.max(1, Math.round(mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}
function calcStamina(p) {
  return Math.max(5, Math.min(100, 100 - (p.pitchCount / Math.max(p.avgIP, 1) / 16) * 80));
}
function adjERA(p) {
  const s = calcStamina(p);
  return p.ERA * (s >= 80 ? 1 : s >= 60 ? 1.1 : s >= 40 ? 1.25 : 1.5);
}
function isRISP(bases)     { return bases[1] || bases[2]; }
function isFullBase(bases) { return bases[0] && bases[1] && bases[2]; }

// ── 좌우 매치업 (플래툰) ──
function calcPlatoon(bHand, pHand) {
  const bh = bHand || 'R', ph = pHand || 'R';
  const same = (bh === ph);
  return same
    ? { advantage: 'pitcher', label: `동타(${bh}타/${ph}투) 투수유리`,  hitMod: -0.04, kMod: +0.08 }
    : { advantage: 'batter',  label: `반대타(${bh}타/${ph}투) 타자유리`, hitMod: +0.03, kMod: -0.05 };
}

// ═══════════════════════════════════════════════════════
//  타석 결과 결정
// ═══════════════════════════════════════════════════════

function decidePAResult(b, p, bases, inning, outs) {
  const era = adjERA(p), pq = Math.max(0.5, Math.min(1.8, era / 4.30));
  let hit = b.hit_rate * (0.85 / pq + 0.15),
      bb  = b.bb_rate  * (0.5 + 0.5 * pq),
      k   = b.k_rate   * (0.5 + 0.5 / pq);
  const kb = (p.K9 - 7.5) * 0.006, bp = (p.BB9 - 3.5) * 0.004;
  k   = Math.max(0.05, k + kb);
  bb  = Math.max(0.02, bb + bp);
  hit = Math.max(0.05, hit - kb * 0.5);

  // 좌우 유불리
  const pl = calcPlatoon(b.hand, p.hand);
  hit = Math.max(0.05, hit + pl.hitMod);
  k   = Math.max(0.04, k   + pl.kMod);

  // 주자 상황
  if (isRISP(bases))     hit = Math.min(hit * 1.06 + 0.02, 0.45);
  if (isFullBase(bases)) bb *= 0.75;
  if (inning >= 7)       k  *= 1.05;

  const tot = hit + bb + k;
  if (tot > 0.93) { const r = 0.93 / tot; hit *= r; bb *= r; k *= r; }

  const roll = rn();
  if (roll < k)        return 'k';
  if (roll < k + bb)   return 'bb';
  if (roll < k + bb + hit) {
    const hr2 = Math.min(b.hr_of_hit, 0.35),
          d3  = Math.min(b.d3_of_hit, 0.06),
          d2  = Math.min(b.d2_of_hit, 0.25),
          r2  = rn();
    if (r2 < hr2)           return 'hr';
    if (r2 < hr2 + d3)      return '3b';
    if (r2 < hr2 + d3 + d2) return '2b';
    return '1b';
  }
  const dpMult = bases[0] && outs < 2 ? 2.0 : 1.0;
  return rn() < 0.07 * dpMult ? 'dp' : 'out';
}

// ── 투구 시퀀스 생성 ──
function buildSeq(pr) {
  const dk = (pr === '1b' || pr === '2b' || pr === '3b') ? 'hit'
           : pr === 'hr'  ? 'hr'
           : pr === 'k'   ? 'k'
           : pr === 'bb'  ? 'bb' : 'out';
  const d = PITCH_DIST[dk], target = randN(d.mean, d.sd), seq = [];
  let balls = 0, strikes = 0;
  for (let i = 0; i < target - 1; i++) {
    const rem = target - 1 - i;
    if (rem === 1) {
      if (pr === 'k'  && strikes < 2) { seq.push('S'); strikes++; continue; }
      if (pr === 'bb' && balls   < 3) { seq.push('B'); balls++;   continue; }
      if (pr === 'bb') { seq.push('F'); continue; }
    }
    let bP = 0.35, sP = 0.25, fP = 0.22;
    if (pr === 'k')  { bP = 0.27; sP = 0.33; fP = 0.25; }
    if (pr === 'bb') { bP = 0.46; sP = 0.17; fP = 0.17; }
    const r = rn();
    if      (r < bP           && balls   < 3) { seq.push('B'); balls++;   }
    else if (r < bP + sP)                     { strikes < 2 ? (seq.push('S'), strikes++) : seq.push('F'); }
    else if (r < bP + sP + fP)                { strikes >= 2 ? seq.push('F') : (seq.push('S'), strikes++); }
    else                                       { balls   < 3  ? (seq.push('B'), balls++)  : seq.push('F'); }
  }
  seq.push({ k:'K', bb:'W', hr:'HR', '1b':'1B', '2b':'2B', '3b':'3B', dp:'DP', out:'OUT' }[pr] || 'OUT');
  return seq;
}

// ── 주자 이동 ──
function advRunners(bases, ht) {
  let scored = 0, nb = [null, null, null];
  if (ht === 'hr') { scored = 1 + bases.filter(Boolean).length; return { bases: [null, null, null], scored }; }
  if (ht === '3b') { scored = bases.filter(Boolean).length; nb[2] = 'r'; return { bases: nb, scored }; }
  if (ht === '2b') { if (bases[2]) scored++; if (bases[1]) scored++; if (bases[0]) nb[2] = 'r'; nb[1] = 'r'; return { bases: nb, scored }; }
  if (ht === '1b') { if (bases[2]) scored++; if (bases[1]) nb[2] = 'r'; if (bases[0]) nb[1] = 'r'; nb[0] = 'r'; return { bases: nb, scored }; }
  if (ht === 'bb') {
    if (bases[0] && bases[1] && bases[2]) scored++;
    nb[2] = bases[0] && bases[1] ? bases[2] || 'r' : bases[2];
    nb[1] = bases[0] ? bases[1] || 'r' : bases[1];
    nb[0] = 'r';
    return { bases: nb, scored };
  }
  if (ht === 'dp') return { bases: [null, bases[1], bases[2]], scored: 0 };
  return { bases, scored: 0 };
}

// ═══════════════════════════════════════════════════════
//  스페셜 이벤트 (도루 / 희생번트)
// ═══════════════════════════════════════════════════════

function trySteal(batter, bases, outs) {
  if (outs >= 2)             return false;
  if (!bases[0] || bases[1]) return false;

  // ── 도루 시도 확률: 실제 SBA/G 데이터 우선, 없으면 speedScore 추정 ──
  const sbaPerGame = batter.SBA > 0
    ? batter.SBA / Math.max(batter.G, 1)
    : null;
  const attemptProb = sbaPerGame !== null
    ? Math.min(sbaPerGame * 0.4, 0.35)          // 실제 도루 시도율 반영
    : (batter.speedScore || 0.2) * 0.35;         // 추정값 fallback

  if (rn() >= attemptProb) return false;

  // ── 성공률: 실제 SB% 우선, 없으면 기본 72% ──
  let successRate = batter.sbPct > 0
    ? batter.sbPct / 100
    : 0.72;

  // ── 포수 도루 저지율 반영 ──
  const pitcher   = gs.isTop ? gs.curHP : gs.curAP;
  const defLineup = gs.isTop ? gs.homeLineup : gs.awayLineup;
  const catcher   = defLineup.find(p => p.pos === 'C');
  if (catcher && catcher.csPct > 0) {
    // 포수 CS%가 높을수록 성공률 감소 (리그 평균 25% 기준 보정)
    const catcherAdj = (catcher.csPct - 25) / 100;
    successRate = Math.max(0.40, Math.min(0.90, successRate - catcherAdj));
  }

  if (rn() < successRate) {
    gs.bases = [null, 'r', bases[2]];
    batter.todayStats.SB++;
    addLog(`🟣 ${batter.name} 도루 성공! (시즌 ${batter.SB}도루)`, 'steal');
    showPitch('도루!', 'steal');
  } else {
    gs.bases = [null, null, bases[2]];
    gs.outs  = Math.min(gs.outs + 1, 3);
    batter.todayStats.CS++;
    const catcherName = catcher ? ` (포수: ${catcher.name})` : '';
    addLog(`🔴 ${batter.name} 도루 실패${catcherName}`, 'out');
    showPitch('도루 실패', 'out');
  }
  return true;
}

function trySacBunt(batter, bases, outs) {
  if (outs >= 2)  return false;
  if (!bases[0])  return false;
  const sacRate = batter.SAC / Math.max(batter.G, 1);
  if (sacRate < 0.06)    return false;
  if (batter.order > 6)  return false;
  if (rn() < 0.30) {
    if (rn() < 0.82) {
      let scored = 0;
      const nb = [null, null, null];
      if (bases[2]) scored++;
      nb[2] = bases[1] ? 'r' : null;
      nb[1] = bases[0] ? 'r' : null;
      gs.outs  = Math.min(gs.outs + 1, 3);
      gs.bases = nb;
      batter.todayStats.SAC++;
      if (scored) addRuns(scored);
      addLog(`🟢 ${batter.name} 희생번트 성공` + (scored ? ` (${scored}점)` : ''), 'bunt');
      showPitch('희생번트', 'bunt');
    } else {
      gs.outs = Math.min(gs.outs + 1, 3);
      addLog(`🔴 ${batter.name} 번트 실패 (아웃)`, 'out');
      showPitch('번트 실패', 'out');
    }
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════
//  게임 초기화 / 흐름 제어
// ═══════════════════════════════════════════════════════

function initGame(home, away) {
  const hH = getTeamHitters(home),  hA = getTeamHitters(away);
  const pH = getTeamPitchers(home), pA = getTeamPitchers(away);
  const hL = buildLineup(hH),       aL = buildLineup(hA);
  if (!hL.length || !aL.length) { alert('해당 팀 데이터 부족'); return null; }
  return {
    homeTeam: home, awayTeam: away,
    homeScore: 0,   awayScore: 0,
    inning: 1, isTop: true, isExtra: false,
    outs: 0, bases: [null, null, null],
    homeLineup: hL,   awayLineup: aL,
    homePitchers: pH, awayPitchers: pA,
    curHP: (typeof pickStarterWithFatigue === 'function' && typeof SS !== 'undefined' && SS.gameIdx > 0)
           ? pickStarterWithFatigue(pH, getTeamCode(home) || home)
           : pickStarter(pH),
    curAP: (typeof pickStarterWithFatigue === 'function' && typeof SS !== 'undefined' && SS.gameIdx > 0)
           ? pickStarterWithFatigue(pA, getTeamCode(away) || away)
           : pickStarter(pA),
    homeOrder: 0, awayOrder: 0,
    innings: { home: [], away: [] },
    currentPA: null,
    balls: 0, strikes: 0,
    gamePitches: 0, totalAB: 0,
    gameOver: false,
  };
}

function startPA() {
  const lineup  = gs.isTop ? gs.awayLineup  : gs.homeLineup;
  const order   = gs.isTop ? gs.awayOrder   : gs.homeOrder;
  const pitcher = gs.isTop ? gs.curHP       : gs.curAP;
  const batter  = lineup[order % lineup.length];

  // 도루 시도 (PA 소비 없음)
  if (trySteal(batter, gs.bases, gs.outs)) {
    if (gs.outs >= 3) { endHalf(); return; }
    updateGameUI(); updateLnpUI(); updateSbUI();
    return;
  }
  // 희생번트 시도 (PA 소비)
  if (trySacBunt(batter, gs.bases, gs.outs)) {
    batter.todayStats.PA++;
    if (gs.outs >= 3) { endHalf(); return; }
    gs.isTop ? gs.awayOrder++ : gs.homeOrder++;
    updateGameUI(); updateLnpUI(); updateSbUI();
    return;
  }

  batter.todayStats.PA++;
  const pr = decidePAResult(batter, pitcher, gs.bases, gs.inning, gs.outs);
  gs.currentPA = { batter, pitcher, pr, seq: buildSeq(pr), pidx: 0 };
  gs.balls = 0; gs.strikes = 0;
  updateBatUI(batter); updatePitUI(pitcher); updateCntUI(0, 0); showPitch('');
  document.getElementById('pc-ab').textContent = '0';
  updateFml(batter, pitcher, pr);
  updateSituationBar();
}

function processOnePitch() {
  if (!gs || gs.gameOver) return;
  if (!gs.currentPA) { startPA(); return; }
  const pa = gs.currentPA;
  if (pa.pidx >= pa.seq.length) { startPA(); return; }

  const pitch = pa.seq[pa.pidx++];
  gs.gamePitches++;
  pa.pitcher.pitchCount++;
  document.getElementById('pc-ab').textContent  = pa.pidx;
  document.getElementById('pc-p').textContent   = pa.pitcher.pitchCount;
  document.getElementById('pc-tot').textContent = gs.gamePitches;
  updateStamUI(pa.pitcher);

  if (pa.pidx >= pa.seq.length) {
    gs.totalAB++;
    document.getElementById('pc-avg').textContent = (gs.gamePitches / gs.totalAB).toFixed(1);
    handlePA(pa);
    gs.currentPA = null;
    if (gs.outs >= 3) endHalf(); else updateGameUI();
  } else {
    if      (pitch === 'B') { gs.balls++;   showPitch('볼',        'ball');   }
    else if (pitch === 'S') { gs.strikes++; showPitch('스트라이크', 'strike'); }
    else if (pitch === 'F')                 showPitch('파울',       'foul');
    updateCntUI(gs.balls, gs.strikes);
    updateGameUI();
  }
  updateLnpUI();
}

function handlePA(pa) {
  const r = pa.pr, b = pa.batter, n = pa.pidx;
  if (r === 'k') {
    gs.outs = Math.min(gs.outs + 1, 3);
    b.todayStats.K++;
    showPitch('삼진', 'k');
    addLog(`🔴 ${b.name} 삼진 (${n}구)`, 'out');
  } else if (r === 'bb') {
    b.todayStats.BB++;
    showPitch('볼넷', 'walk');
    const res = advRunners(gs.bases, 'bb'); gs.bases = res.bases;
    if (res.scored) { b.todayStats.RBI += res.scored; addRuns(res.scored); }
    addLog(`🔵 ${b.name} 볼넷${res.scored ? ` (${res.scored}점)` : ''}`, res.scored ? 'score' : '');
  } else if (r === 'hr') {
    b.todayStats.H++; b.todayStats.HR++;
    showPitch('홈런!', 'hr');
    const res = advRunners(gs.bases, 'hr'); gs.bases = res.bases;
    b.todayStats.RBI += res.scored; addRuns(res.scored);
    addLog(`🏠 ${b.name} ${res.scored}런 홈런!! (${n}구)`, 'hr');
  } else if (r === '1b' || r === '2b' || r === '3b') {
    b.todayStats.H++;
    const lbl = { '1b': '단타', '2b': '2루타', '3b': '3루타' }[r];
    showPitch(lbl, 'hit');
    const res = advRunners(gs.bases, r); gs.bases = res.bases;
    if (res.scored) { b.todayStats.RBI += res.scored; addRuns(res.scored); }
    addLog(`✅ ${b.name} ${lbl}${res.scored ? ` (${res.scored}점)` : ''}`, res.scored ? 'score' : 'hit');
  } else if (r === 'dp') {
    gs.outs = Math.min(gs.outs + 2, 3);
    showPitch('병살', 'out');
    const res = advRunners(gs.bases, 'dp'); gs.bases = res.bases;
    addLog(`⛔ ${b.name} 병살 (${n}구)`, 'out');
  } else {
    gs.outs = Math.min(gs.outs + 1, 3);
    showPitch('범타', 'out');
    addLog(`🔴 ${b.name} 아웃 (${n}구)`, 'out');
  }
  gs.isTop ? gs.awayOrder++ : gs.homeOrder++;
  updateTodayStats(b);
}

function addRuns(n) {
  if (!n) return;
  const i = gs.inning - 1;
  if (gs.isTop) {
    gs.awayScore += n;
    if (gs.innings.away[i] === undefined) gs.innings.away[i] = 0;
    gs.innings.away[i] += n;
  } else {
    gs.homeScore += n;
    if (gs.innings.home[i] === undefined) gs.innings.home[i] = 0;
    gs.innings.home[i] += n;
  }
  document.getElementById('h-score').textContent = gs.homeScore;
  document.getElementById('a-score').textContent = gs.awayScore;
}

function endHalf() {
  gs.outs = 0; gs.bases = [null, null, null];
  gs.balls = 0; gs.strikes = 0; gs.currentPA = null;

  if (gs.isTop) {
    gs.isTop = false;
    if (gs.inning >= 9 && gs.homeScore > gs.awayScore) { endGame(); return; }
    addLog(`── ${gs.inning}회 말 시작 ──`, '');
  } else {
    gs.isTop = true;
    gs.inning++;
    if (gs.inning > 9) {
      if (gs.homeScore === gs.awayScore) {
        if (gs.inning > MAX_INNINGS) { endGame(); return; }
        gs.isExtra = true;
        showExtraBanner(gs.inning);
        addLog(`── ⚡ ${gs.inning}회 연장전 시작! ──`, 'ext');
      } else {
        endGame(); return;
      }
    } else {
      addLog(`── ${gs.inning}회 초 시작 ──`, '');
    }
    checkChange();
  }
  updateGameUI(); updateSbUI(); showPitch('');
}

function checkChange() {
  const isHomePitching = gs.isTop;
  const p = isHomePitching ? gs.curHP : gs.curAP;
  const s = calcStamina(p);
  const scoreDiff = isHomePitching
    ? (gs.homeScore - gs.awayScore)
    : (gs.awayScore - gs.homeScore);
  const allPitchers = isHomePitching ? gs.homePitchers : gs.awayPitchers;
  const needChange  = s < 30 || (gs.inning >= 6 && p.pitchCount > 80) || (gs.inning >= 9 && p.isStarter);

  if (needChange) {
    if (gs.isExtra) allPitchers.forEach(p => { if (!p.isStarter) p.usedToday = false; });
    const teamCode = isHomePitching ? getTeamCode(gs.homeTeam) : getTeamCode(gs.awayTeam);
    const np = (typeof selectRelieverWithFatigue === 'function' && teamCode)
      ? selectRelieverWithFatigue(allPitchers, p, gs.inning, scoreDiff, teamCode)
      : selectReliever(allPitchers, p, gs.inning, scoreDiff);
    if (np) {
      np.pitchCount = 0;
      if (isHomePitching) gs.curHP = np; else gs.curAP = np;
      const roleLabel = { starter: '선발', middle: '중간계투', closer: '마무리' }[np.role] || '계투';
      addLog(`🔄 투수교체 → ${np.name} [${roleLabel}] (ERA ${np.ERA})`, 'change');
    }
  }
}

function showExtraBanner(inning) {
  const ov = document.getElementById('extra-overlay');
  const bn = document.getElementById('extra-banner');
  bn.textContent = `${inning}회 연장전`;
  ov.style.display = 'flex';
  setTimeout(() => ov.style.display = 'none', 1800);
}

function endGame() {
  gs.gameOver = true; stopPlay();
  const w = gs.homeScore > gs.awayScore ? gs.homeTeam
          : gs.awayScore > gs.homeScore ? gs.awayTeam : '무승부';
  document.getElementById('go-score').textContent  = `${gs.awayTeam} ${gs.awayScore} : ${gs.homeScore} ${gs.homeTeam}`;
  document.getElementById('go-winner').textContent = w === '무승부' ? '⚾ 무승부!' : '🏆 ' + w + ' 승!';
  if (gs.isExtra) {
    const lastInn = gs.isTop ? gs.inning : gs.inning - 1;
    document.getElementById('go-ext-label').innerHTML =
      `<span class="go-ext-badge">${lastInn}회 연장전 종료</span>`;
  }
  buildFinalScoreboard();
  buildBoxScore();
  buildMVP();
  // ── 시즌 모드 훅 ──
  if (typeof onSeasonGameEnd === 'function' && gs._seasonGame) {
    onSeasonGameEnd(gs.homeScore, gs.awayScore);
    document.getElementById('go-season-btn').style.display  = 'inline-block';
    document.getElementById('go-restart-btn').style.display = 'none';
  } else {
    document.getElementById('go-season-btn').style.display  = 'none';
    document.getElementById('go-restart-btn').style.display = 'inline-block';
  }
  document.getElementById('game-over').classList.add('show');
}

// ═══════════════════════════════════════════════════════
//  결과 화면 빌더
// ═══════════════════════════════════════════════════════

function buildFinalScoreboard() {
  const t = document.getElementById('final-scoreboard');
  const maxInn = Math.max(9, gs.isTop ? gs.inning - 1 : gs.inning);
  let h = `<tr><th>팀</th>`;
  for (let i = 1; i <= maxInn; i++) h += `<th class="${i > 9 ? 'ext-cell' : ''}">${i}</th>`;
  h += '<th style="color:var(--accent)">R</th></tr>';
  ['away', 'home'].forEach(side => {
    const team  = side === 'away' ? gs.awayTeam  : gs.homeTeam;
    const score = side === 'away' ? gs.awayScore : gs.homeScore;
    h += `<tr><td class="tc2">${team}</td>`;
    for (let i = 0; i < maxInn; i++) {
      const v = gs.innings[side][i];
      h += `<td class="${i >= 9 ? 'ext-cell' : ''}">${v || 0}</td>`;
    }
    h += `<td class="tot2">${score}</td></tr>`;
  });
  t.innerHTML = h;
}

function buildBoxScore() {
  const wrap = document.getElementById('boxscore-wrap');
  wrap.innerHTML = '';
  ['away', 'home'].forEach(side => {
    const lineup = side === 'away' ? gs.awayLineup : gs.homeLineup;
    const team   = side === 'away' ? gs.awayTeam   : gs.homeTeam;
    const div = document.createElement('div'); div.className = 'bs-section';
    let h = `<div class="bs-title">${team} 타선</div>
    <table class="bs-table">
      <tr><th>타자</th><th>타석</th><th>안타</th><th>홈런</th><th>타점</th><th>삼진</th><th>볼넷</th><th>도루</th></tr>`;
    let totPA=0,totH=0,totHR=0,totRBI=0,totK=0,totBB=0,totSB=0;
    lineup.forEach(p => {
      const ts = p.todayStats;
      const hi = ts.H >= 2 || ts.HR >= 1 || ts.RBI >= 2;
      h += `<tr class="${hi ? 'highlight' : ''}">
        <td>${p.name}</td><td>${ts.PA}</td><td>${ts.H}</td>
        <td>${ts.HR||0}</td><td>${ts.RBI||0}</td><td>${ts.K||0}</td><td>${ts.BB||0}</td><td>${ts.SB||0}</td>
      </tr>`;
      totPA+=ts.PA;totH+=ts.H;totHR+=ts.HR||0;totRBI+=ts.RBI||0;totK+=ts.K||0;totBB+=ts.BB||0;totSB+=ts.SB||0;
    });
    h += `<tr style="font-weight:700;color:var(--accent)">
      <td>합계</td><td>${totPA}</td><td>${totH}</td><td>${totHR}</td><td>${totRBI}</td><td>${totK}</td><td>${totBB}</td><td>${totSB}</td>
    </tr></table>`;
    div.innerHTML = h; wrap.appendChild(div);
  });
}

function buildMVP() {
  const body = document.getElementById('mvp-body');
  body.innerHTML = '';
  const getBest = lineup => lineup.slice().sort((a, b) => {
    const sc = p => (p.todayStats.H||0)*1 + (p.todayStats.HR||0)*4 + (p.todayStats.RBI||0)*1.5 + (p.todayStats.BB||0)*0.3;
    return sc(b) - sc(a);
  })[0];
  [gs.awayLineup, gs.homeLineup].forEach((lineup, i) => {
    const best = getBest(lineup), ts = best.todayStats;
    const div = document.createElement('div'); div.className = 'mvp-card';
    div.innerHTML = `<div class="mvp-tag">${i === 0 ? gs.awayTeam : gs.homeTeam} MVP</div>
      <div class="mvp-name">${best.name}</div>
      <div class="mvp-stats">
        <span>${ts.PA}</span>타석 <span>${ts.H}</span>안타
        ${ts.HR  ? `<span>${ts.HR}</span>홈런 ` : ''}
        <span>${ts.RBI||0}</span>타점
        ${ts.SB  ? `<span>${ts.SB}</span>도루 ` : ''}
      </div>`;
    body.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════
//  UI 업데이트
// ═══════════════════════════════════════════════════════

// 선수 프로필 툴팁 HTML 생성
function buildProfileTooltip(p, type) {
  const jersey  = p.jerseyNumber ? `#${p.jerseyNumber} ` : '';
  const age     = p.age     ? `${p.age}세` : '';
  const body    = (p.height && p.weight) ? `${p.height}cm / ${p.weight}kg` : '';
  const sbInfo  = (type === 'hitter' && p.SBA > 0)
    ? `도루 ${p.SB}/${p.SBA} (${p.sbPct}%)` : '';
  const csInfo  = (type === 'hitter' && p.csPct !== null && p.pos === 'C')
    ? `도루저지 ${p.csPct}%` : '';
  const salaryStr = p.salaryRaw
    ? (p.salaryRaw.includes('달러') ? p.salaryRaw : `${Number(p.salary).toLocaleString()}만원`)
    : '';
  const career  = p.career || '';
  const rows = [
    age && body ? `${age} · ${body}` : (age || body),
    sbInfo, csInfo, salaryStr,
    career,
  ].filter(Boolean);
  return `<div class="profile-tooltip">
    <div class="pt-name">${jersey}${p.name}</div>
    <div class="pt-pos">${p.battingThrowing || ''} · ${p.defPos || p.position || ''}</div>
    ${rows.map(r => `<div class="pt-row">${r}</div>`).join('')}
  </div>`;
}

function updateBatUI(b) {
  const nameEl = document.getElementById('b-name');
  nameEl.textContent = b.name;
  // 프로필 툴팁
  nameEl.title = '';
  const existTip = nameEl.parentNode.querySelector('.profile-tooltip');
  if (existTip) existTip.remove();
  nameEl.parentNode.insertAdjacentHTML('beforeend', buildProfileTooltip(b, 'hitter'));

  const pitcher = (gs && gs.curHP && gs.curAP) ? (gs.isTop ? gs.curHP : gs.curAP) : null;
  const pl = pitcher ? calcPlatoon(b.hand, pitcher.hand) : null;
  const platoonTag = pl
    ? `<span style="margin-left:6px;font-size:9px;padding:1px 5px;border-radius:8px;
        ${pl.advantage === 'batter'
          ? 'background:rgba(45,204,111,.2);color:#2dcc6f;border:1px solid #2dcc6f'
          : 'background:rgba(232,52,10,.2);color:#e8340a;border:1px solid #e8340a'}">
        ${pl.advantage === 'batter' ? '타자유리' : '투수유리'}</span>` : '';
  document.getElementById('b-info').innerHTML = `${b.team}·${b.order||'-'}번·${b.pos||''}·<b>${b.hand||'R'}타</b>${platoonTag}`;
  document.getElementById('b-avg').textContent = b.AVG.toFixed(3);
  document.getElementById('b-hr').textContent  = b.HR;
  document.getElementById('b-rbi').textContent = Math.round(b.RBI);
  document.getElementById('b-ops').textContent = (b.ops || 0).toFixed(3);
  updateTodayStats(b);
}

function updatePitUI(p) {
  const nameEl = document.getElementById('p-name');
  nameEl.textContent = p.name;
  // 프로필 툴팁
  const existTip = nameEl.parentNode.querySelector('.profile-tooltip');
  if (existTip) existTip.remove();
  nameEl.parentNode.insertAdjacentHTML('beforeend', buildProfileTooltip(p, 'pitcher'));

  document.getElementById('p-team').textContent  = `${p.team} · ${p.hand||'R'}투`;
  document.getElementById('p-era').textContent   = p.ERA.toFixed(2);
  document.getElementById('p-k9').textContent    = p.K9.toFixed(1);
  document.getElementById('p-whip').textContent  = p.WHIP.toFixed(2);
  document.getElementById('p-bb9').textContent   = p.BB9.toFixed(1);
  updateStamUI(p);
  const badge = document.getElementById('p-role-badge');
  const role  = p.role || 'middle';
  badge.textContent  = { starter:'선발', middle:'중간계투', closer:'마무리' }[role] || '계투';
  badge.className    = 'pitcher-role-badge ' + ({ starter:'role-starter', middle:'role-middle', closer:'role-closer' }[role] || 'role-middle');
}

function updateStamUI(p) {
  const s = calcStamina(p);
  document.getElementById('stamina-fill').style.width      = s + '%';
  document.getElementById('stamina-fill').style.background = s > 70 ? 'var(--accent3)' : s > 40 ? 'var(--accent)' : 'var(--accent2)';
  document.getElementById('stamina-pct').textContent       = Math.round(s) + '%';
}

function updateCntUI(b, s) {
  ['b0','b1','b2','b3'].forEach((id, i) => { document.getElementById(id).className = 'dot' + (i < b ? ' ab' : ''); });
  ['s0','s1','s2'].forEach((id, i)       => { document.getElementById(id).className = 'dot' + (i < s ? ' as' : ''); });
  ['o0','o1','o2'].forEach((id, i)       => { document.getElementById(id).className = 'dot' + (gs && i < gs.outs ? ' ao' : ''); });
}

function showPitch(text, type) {
  const area = document.getElementById('last-pitch-area');
  if (!text) { area.innerHTML = ''; return; }
  const cls = {
    ball:'badge-ball', strike:'badge-strike', foul:'badge-foul',
    hit:'badge-hit',   out:'badge-out',       hr:'badge-hr',
    walk:'badge-walk', k:'badge-k',           steal:'badge-steal',
    bunt:'badge-bunt', ext:'badge-ext',
  }[type] || '';
  area.innerHTML = `<span class="pitch-badge ${cls}">${text}</span>`;
}

function addLog(msg, type) {
  const el  = document.getElementById('game-log');
  const d   = document.createElement('div');
  d.className = 'log-entry';
  const inn = `${gs.inning}${gs.isTop ? '초' : '말'}`;
  d.innerHTML = `<span class="log-inn">${inn}</span><span class="log-msg ${type}">${msg}</span>`;
  el.prepend(d);
}

function updateGameUI() {
  if (!gs) return;
  updateBasesUI(gs.bases);
  updateCntUI(gs.balls || 0, gs.strikes || 0);
  document.getElementById('inning-display').textContent = `${gs.inning}회`;
  document.getElementById('half-display').textContent   = gs.isTop ? '초' : '말';
}

function updateBasesUI(bases) {
  const cols = ['#2dcc6f','#f5a623','#3b82f6'];
  [1,2,3].forEach((b, i) => {
    const r    = document.getElementById(`runner-${b}`);
    const base = document.getElementById(`base-${b}`);
    if (bases[i]) {
      r.setAttribute('fill', cols[i]); r.setAttribute('stroke', '#fff'); r.setAttribute('stroke-width', '1.5');
      if (base) base.setAttribute('fill', '#2a4a20');
    } else {
      r.setAttribute('fill', 'transparent'); r.removeAttribute('stroke');
      if (base) base.setAttribute('fill', '#1a2a10');
    }
  });
}

function updateLnpUI() {
  if (!gs) return;
  function render(lineup, order, id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    lineup.forEach((p, i) => {
      const isBat = (i === order % lineup.length);
      const d = document.createElement('div');
      d.className = 'lr' + (isBat ? ' batting' : '');
      const ts = p.todayStats, parts = [];
      const todayCls = ts.HR > 0 ? 'ghr' : ts.H > 0 ? 'gh' : '';
      if (ts.PA > 0) {
        if (ts.H > 0)       parts.push(ts.H + '안' + (ts.HR ? ' ' + ts.HR + 'HR' : ''));
        else if (ts.BB > 0) parts.push('볼넷');
        else if (ts.K > 0)  parts.push('K');
        else                parts.push('0안');
        if (ts.SB > 0)      parts.push(ts.SB + '도');
      }
      const ttxt = ts.PA > 0 ? parts.join(' ') : '-';
      d.innerHTML = `<span class="lr-num">${i+1}</span><span class="lr-pos">${p.pos||'-'}</span><span class="lr-name">${p.name}</span><span class="lr-avg">${p.AVG.toFixed(3)}</span><span class="lr-today ${todayCls}">${ts.PA}타${ts.PA > 0 ? '/' + ttxt : ''}</span>`;
      el.appendChild(d);
    });
  }
  render(gs.homeLineup, gs.homeOrder, 'home-lineup');
  render(gs.awayLineup, gs.awayOrder, 'away-lineup');
}

function updateSbUI() {
  if (!gs) return;
  const t = document.getElementById('scoreboard');
  const maxInn = Math.min(gs.inning, 12);
  let h = `<tr><th>팀</th>`;
  for (let i = 1; i <= maxInn; i++) h += `<th class="${i === gs.inning ? 'ci' : ''}">${i}</th>`;
  h += '<th class="tot">R</th></tr>';
  ['away','home'].forEach(side => {
    const team  = side === 'away' ? gs.awayTeam  : gs.homeTeam;
    const score = side === 'away' ? gs.awayScore : gs.homeScore;
    h += `<tr><td class="tc">${team}</td>`;
    for (let i = 0; i < maxInn; i++) {
      const v = gs.innings[side][i];
      h += `<td class="${i + 1 === gs.inning ? 'ci' : ''}">${v || ''}</td>`;
    }
    h += `<td class="tot">${score}</td></tr>`;
  });
  t.innerHTML = h;
}

function updateSituationBar() {
  if (!gs) return;
  const risp   = isRISP(gs.bases);
  const batter = gs.isTop ? gs.awayLineup[gs.awayOrder % 9] : gs.homeLineup[gs.homeOrder % 9];
  document.getElementById('sit-inning').textContent   = `${gs.inning}회 ${gs.isTop?'초':'말'}${gs.isExtra?'⚡':''}`;
  document.getElementById('sit-risp').textContent     = risp ? '있음' : '-';
  document.getElementById('sit-risp-avg').textContent = risp ? (batter.AVG + 0.02).toFixed(3) : batter.AVG.toFixed(3);
  document.getElementById('sit-steal').textContent    = gs.bases[0] && !gs.bases[1] ? '가능' : '-';
  document.getElementById('sit-bunt').textContent     = (batter.SAC / Math.max(batter.G, 1) > 0.05 && gs.outs < 2 && gs.bases[0]) ? '가능' : '-';
}

function updateFml(b, p, r) {
  const era = adjERA(p), pq = (era / 4.30).toFixed(2);
  const adj = (b.hit_rate * (0.85 / parseFloat(pq) + 0.15)).toFixed(3);
  const lbl = { k:'삼진', bb:'볼넷', hr:'홈런', '1b':'단타', '2b':'2루타', '3b':'3루타', out:'범타', dp:'병살' }[r] || r;
  const risp = isRISP(gs.bases);
  const pl   = calcPlatoon(b.hand, p.hand);
  const plColor = pl.advantage === 'batter' ? 'var(--accent3)' : 'var(--accent2)';
  const plSign  = pl.hitMod > 0 ? '+' : '';
  document.getElementById('formula-calc').innerHTML =
    `<div class="fr"><span class="fk">타자</span><span class="fv">${b.hand||'R'}타 · AVG ${b.AVG.toFixed(3)}</span></div>` +
    `<div class="fr"><span class="fk">투수</span><span class="fv">${p.hand||'R'}투 · ERA ${era.toFixed(2)}</span></div>` +
    `<div class="fr" style="color:${plColor}"><span class="fk">좌우 매치업</span><span class="fv">${pl.label.split(' ')[1]} | 안타${plSign}${(pl.hitMod*100).toFixed(0)}%</span></div>` +
    `<div class="fr"><span class="fk">투수품질지수</span><span class="fv">${pq}</span></div>` +
    `<div class="fr"><span class="fk">보정 안타율</span><span class="fv">${adj}</span></div>` +
    (risp ? `<div class="fr" style="color:var(--accent3)"><span class="fk">RISP 보정</span><span class="fv">+2~6%</span></div>` : '') +
    `<div class="fr" style="color:var(--accent);margin-top:4px"><span class="fk">결과</span><span class="fv">${lbl}</span></div>`;
}

function updateTodayStats(b) {
  const ts = b.todayStats;
  document.getElementById('ts-pa').textContent  = ts.PA;
  document.getElementById('ts-h').textContent   = ts.H;
  document.getElementById('ts-hr').textContent  = ts.HR  || 0;
  document.getElementById('ts-rbi').textContent = ts.RBI || 0;
  document.getElementById('ts-k').textContent   = ts.K   || 0;
  document.getElementById('ts-bb').textContent  = ts.BB  || 0;
}

// ═══════════════════════════════════════════════════════
//  재생 제어
// ═══════════════════════════════════════════════════════

function togglePlay() {
  isPlaying = !isPlaying;
  document.getElementById('play-btn').textContent = isPlaying ? '⏸ 정지' : '▶ 재생';
  if (isPlaying) {
    schedNext();
  } else {
    clearTimeout(playTimer); playTimer = null;
    // 자동 진행을 수동으로 멈춘 시점에 저장
    if (typeof saveGameState === 'function') saveGameState();
  }
}
function schedNext() {
  if (!isPlaying || (gs && gs.gameOver)) return;
  processOnePitch();
  playTimer = setTimeout(schedNext, SPEED_DELAYS[speedIdx]);
}
function stopPlay() {
  isPlaying = false;
  document.getElementById('play-btn').textContent = '▶ 재생';
  clearTimeout(playTimer); playTimer = null;
}
function stepOnce() {
  if (isPlaying) stopPlay();
  processOnePitch();
  // 1구 실행 직후 저장
  if (typeof saveGameState === 'function') saveGameState();
}
function showSetup()   { stopPlay(); document.getElementById('setup-screen').style.display = 'flex'; }
function restartGame() { document.getElementById('game-over').classList.remove('show'); showSetup(); }
function switchTab(t) {
  document.getElementById('tab-log').classList.toggle('active',     t === 'log');
  document.getElementById('tab-formula').classList.toggle('active', t === 'formula');
  document.getElementById('content-log').style.display     = t === 'log'     ? '' : 'none';
  document.getElementById('content-formula').style.display = t === 'formula' ? '' : 'none';
}
