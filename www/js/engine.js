// ═══════════════════════════════════════════════════════
//  KBO 시뮬레이터 — 게임 엔진 (engine.js)
//  데이터는 포함하지 않음. DataLoader가 주입한 뒤 사용.
// ═══════════════════════════════════════════════════════

'use strict';

// 모음 변환 규칙 (중성 인덱스 기준, 일방향)
const VOWEL_MAP = {
  0: 4,  // ㅏ → ㅓ
  1: 5,  // ㅐ → ㅔ
  2: 6,  // ㅑ → ㅕ
  3: 7,  // ㅒ → ㅖ
  4: 0,  // ㅓ → ㅏ
  5: 1,  // ㅔ → ㅐ
  6: 2,  // ㅕ → ㅑ
  7: 3,  // ㅖ → ㅒ
  8: 13,  // ㅗ → ㅜ
  9: 14,  // ㅘ → ㅝ
  10: 15,  // ㅙ → ㅞ
  11: 16,  // ㅚ → ㅟ
  12: 17,  // ㅛ → ㅠ
  13: 8,  // ㅜ → ㅗ
  14: 9,  // ㅝ → ㅘ
  15: 10,  // ㅞ → ㅙ
  16: 11,  // ㅟ → ㅚ
  17: 12,  // ㅠ → ㅛ
  18: 20,  // ㅡ → ㅣ
  20: 19,  // ㅣ → ㅢ
  19: 18,  // ㅢ → ㅡ
};

// ② 한글 음절 분해/조합
function decompose(ch) {
  const code = ch.charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return null;
  return {
    o: Math.floor(code / 588),        // 초성 (0~18)
    v: Math.floor((code % 588) / 28), // 중성 (0~20)
    c: code % 28                       // 종성 (0~27)
  };
}
function compose(o, v, c) {
  return String.fromCharCode(0xAC00 + o * 588 + v * 28 + c);
}

// ③ 단일 글자에 모음 변환 적용
function applyVowelRules(ch) {
  const d = decompose(ch);
  if (!d) return ch;
  const newV = VOWEL_MAP[d.v] ?? d.v;
  return compose(d.o, newV, d.c);
}

// ④ 첫 글자 제외, 이후 글자만 모음 변환
// 입력이 1글자 이하면 그대로 반환
function formatPlayerName(name) {
  if (name.length <= 1) return name;
  const first = name[0];
  const rest = [...name.slice(1)].map(applyVowelRules).join('');
  return first + rest;
}

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
  k: { mean: 4.8, sd: 0.9 },
  bb: { mean: 5.2, sd: 1.0 },
  hr: { mean: 3.2, sd: 1.1 },
  hit: { mean: 3.0, sd: 1.0 },
  out: { mean: 3.5, sd: 1.1 },
};
const SPEED_DELAYS = [0, 150, 500, 1100, 2200];
const SPEED_LABELS = ['최고속', '빠름', '보통', '느림', '아주느림'];
// 최대 11회 지원. 포스트시즌 무제한 등은 함수화 하여 사용

// ── 전역 상태 ──
let gs = null;
let isPlaying = false;
let playTimer = null;
let speedIdx = 2;
let isAnimating = false;
// 디버그 전용: true인 동안 sleep()이 즉시 resolve되어 모든 연출 대기가 스킵됨
// (즉시 시뮬레이션 기능에서 사용, season.js의 instantSimSeasonGame 참고)
let simTurbo = false;

const sleep = ms => (simTurbo ? Promise.resolve() : new Promise(r => setTimeout(r, ms)));

async function doHREffect() {
  const mw = document.getElementById('diamond-wrap');
  if (mw) mw.classList.add('hr-celebration-active');
  await sleep(1500);
  if (mw) mw.classList.remove('hr-celebration-active');
}

async function doScoreEffect(runsScored) {
  const overlay = document.getElementById('score-overlay');
  if (!overlay) return;
  const oldAway = gs.awayScore;
  const oldHome = gs.homeScore;
  const newAway = gs.isTop ? oldAway + runsScored : oldAway;
  const newHome = !gs.isTop ? oldHome + runsScored : oldHome;

  document.getElementById('se-away-name').textContent = gs.awayTeam;
  document.getElementById('se-home-name').textContent = gs.homeTeam;
  document.getElementById('se-away-old').textContent = oldAway;
  document.getElementById('se-away-new').textContent = newAway;
  document.getElementById('se-home-old').textContent = oldHome;
  document.getElementById('se-home-new').textContent = newHome;
  setTeamColorVars(document.getElementById('se-away-name'), gs.awayTeam);
  setTeamColorVars(document.getElementById('se-home-name'), gs.homeTeam);
  setTeamColorVars(document.getElementById('se-away-new'), gs.awayTeam);
  setTeamColorVars(document.getElementById('se-home-new'), gs.homeTeam);

  const awayInner = document.getElementById('se-away-inner');
  const homeInner = document.getElementById('se-home-inner');

  awayInner.classList.remove('score-animate-up');
  homeInner.classList.remove('score-animate-up');

  overlay.classList.add('show');
  await sleep(100);

  if (gs.isTop && runsScored > 0) awayInner.classList.add('score-animate-up');
  if (!gs.isTop && runsScored > 0) homeInner.classList.add('score-animate-up');

  await sleep(2500);
  overlay.classList.remove('show');
}

async function doGameOverEffect() {
  const overlay = document.getElementById('game-over-overlay');
  if (!overlay) return;
  document.getElementById('go-overlay-score').textContent = `${gs.awayTeam} ${gs.awayScore} : ${gs.homeScore} ${gs.homeTeam}`;
  overlay.classList.add('show');
  await sleep(2500);
  overlay.classList.remove('show');
}

async function doGameStartEffect(awayTeam, homeTeam, subTag = 'MATCH START') {
  isAnimating = true;
  const overlay = document.getElementById('match-start-overlay');
  if (!overlay) { isAnimating = false; return; }

  const subTagEl = document.getElementById('ms-sub-tag');
  const awayEl = document.getElementById('ms-away-team');
  const homeEl = document.getElementById('ms-home-team');

  if (subTagEl) subTagEl.textContent = subTag;
  if (awayEl) { awayEl.textContent = awayTeam; setTeamColorVars(awayEl, awayTeam); }
  if (homeEl) { homeEl.textContent = homeTeam; setTeamColorVars(homeEl, homeTeam); }

  overlay.classList.add('show');
  await sleep(2100);
  overlay.classList.remove('show');
  await sleep(300);
  isAnimating = false;
}

function popBases(bases, prevBases) {
  [1, 2, 3].forEach((b, i) => {
    if (bases[i]) {
      const r = document.getElementById(`runner-${b}`);
      if (r) {
        r.classList.remove('pop-anim');
        void r.getBoundingClientRect(); // SVG 요소 reflow 강제 (offsetWidth는 SVG에서 동작 안 함)
        r.classList.add('pop-anim');
      }
      // 새로 점유된 베이스: 흰색 플래시 → 주황 전환
      if (prevBases && !prevBases[i]) {
        const baseEl = document.getElementById(`base-${b}`);
        if (baseEl) {
          baseEl.setAttribute('fill', '#ffffff');
          setTimeout(() => baseEl.setAttribute('fill', '#f5a623'), 260);
        }
      }
    }
  });
}

async function doInningEffect(oldInning, newInning, oldTeam, newTeam, onMidway) {
  isAnimating = true;
  const overlay = document.getElementById('inning-overlay');
  if (!overlay) return;

  const labelOld = document.getElementById('io-label-old');
  const labelNew = document.getElementById('io-label-new');
  const oldEl = document.getElementById('io-old-team');
  const newEl = document.getElementById('io-new-team');

  // 초기화
  if (labelOld) labelOld.textContent = oldInning;
  if (labelNew) labelNew.textContent = newInning;
  oldEl.textContent = oldTeam;
  newEl.textContent = newTeam;
  setTeamColorVars(oldEl, oldTeam);
  setTeamColorVars(newEl, newTeam);

  labelOld.className = 'inning-label old';
  labelNew.className = 'inning-label new';
  oldEl.className = 'inning-team-text old';
  newEl.className = 'inning-team-text new';

  labelOld.style.opacity = '0.7';
  labelNew.style.opacity = '0';
  oldEl.style.opacity = '1';
  newEl.style.opacity = '0';

  // 오버레이 표시 시작
  overlay.classList.add('show');
  await sleep(300);

  if (onMidway) onMidway();

  // 1단계: 이전 정보 사라짐 (0.4s)
  oldEl.classList.add('io-old-anim');
  if (labelOld) labelOld.classList.add('io-label-old-anim');
  await sleep(400);

  // 2단계: 다음 정보 등장 (0.4s + 유지)
  newEl.style.opacity = '';
  if (labelNew) labelNew.style.opacity = '';
  newEl.classList.add('io-new-anim');
  if (labelNew) labelNew.classList.add('io-label-new-anim');
  await sleep(700);

  overlay.classList.remove('show');
  isAnimating = false;
}

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
    const obj = {};
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
    const [num, den] = frac.split('/');
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
    const salary = salaryRaw ? parseInt(salaryRaw) : null;
    map[r['playerId']] = {
      hitterHand: hh,
      pitcherHand: ph,
      jerseyNumber: r['jersey_number'] ? parseInt(r['jersey_number']) : null,
      age,
      height: parseInt(r['height']) || null,
      weight: parseInt(r['weight']) || null,
      position: r['position'] || null,
      battingThrowing: r['batting_throwing'] || null,
      career: r['career'] || null,
      draft: r['draft'] || null,
      salary,
      salaryRaw: r['salary'] || null,
    };
  });
  return map;
}

/**
 * 타자 CSV 행 → JSON hitter 객체 변환.
 * AVG='-' (타석 없는 투수) 는 null을 반환해 호출 측에서 걸러낸다.
 */
function csvRowToHitter(row, profileLookup, fallbackTeamName = '') {
  if (row['AVG'] === '-') return null;           // 타석 없는 투수 제외
  const pId = row['playerId'] || null;
  const p = (pId && profileLookup[pId]) ? profileLookup[pId] : {};
  const teamName = row['팀명'] || fallbackTeamName;
  return {
    id: pId || `${row['선수명']}_${teamName}`,
    name: row['선수명'],
    team: teamName,
    AVG: Math.round(parseFloat(row['AVG']) * 1000) / 1000,
    G: parseInt(row['G']),
    PA: parseInt(row['PA']),
    AB: parseInt(row['AB']),
    H: parseInt(row['H']),
    HR: parseInt(row['HR']),
    D2: parseInt(row['2B']),
    D3: parseInt(row['3B']),
    RBI: parseInt(row['RBI']),
    TB: parseInt(row['TB']),
    SAC: parseInt(row['SAC']),
    SF: parseInt(row['SF']),
    BB: parseInt(row['BB']),
    hand: p.hitterHand || 'R',
    // 도루 스탯 (run CSV에서 병합 — 없으면 0)
    SB: 0,
    CS: 0,
    SBA: 0,
    sbPct: 0,
    // 수비 포지션 (defense CSV에서 병합)
    defPos: null,
    // 포수 도루 저지율 (defense CSV에서 병합)
    csPct: null,
    // 프로필
    jerseyNumber: p.jerseyNumber || null,
    age: p.age || null,
    height: p.height || null,
    weight: p.weight || null,
    position: p.position || null,
    battingThrowing: p.battingThrowing || null,
    career: p.career || null,
    draft: p.draft || null,
    salary: p.salary || null,
    salaryRaw: p.salaryRaw || null,
    defense: null,
  };
}

function parseDefNumber(v, fallback = 0) {
  if (v == null || v === '' || v === '-') return fallback;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function buildDefenseStats(row) {
  const ip = Math.max(parseIP(row['IP'] || 0) || 0, 0);
  const e = parseDefNumber(row['E']);
  const po = parseDefNumber(row['PO']);
  const a = parseDefNumber(row['A']);
  const dp = parseDefNumber(row['DP']);
  const fpct = parseDefNumber(row['FPCT'], 0.98);
  const pb = parseDefNumber(row['PB']);
  const csPctRaw = row['CS%'];
  return {
    pos: row['POS'] || null,
    G: parseDefNumber(row['G']),
    GS: parseDefNumber(row['GS']),
    IP: ip,
    E: e,
    PO: po,
    A: a,
    DP: dp,
    FPCT: fpct,
    PB: pb,
    SB: parseDefNumber(row['SB']),
    CS: parseDefNumber(row['CS']),
    CSPercent: (csPctRaw && csPctRaw !== '-') ? parseDefNumber(csPctRaw) : null,
    rangePer9: ip > 0 ? ((po + a) / ip) * 9 : 0,
    errPer9: ip > 0 ? (e / ip) * 9 : 0,
    dpPer9: ip > 0 ? ((dp) / ip) * 9 : 0,
    pbPer9: ip > 0 ? ((pb) / ip) * 9 : 0,
  };
}

// 투구 이닝이 0인 투수는 CSV의 ERA·WHIP이 '-'로 들어온다.
// 그대로 parseFloat하면 NaN이 되고, decidePAResult의 pq가 NaN이 되어
// 안타·볼넷·삼진 판정 비교가 모두 false로 떨어진다(= 절대 맞지 않는 투수).
// 기록이 없는 투수는 리그 평균값으로 대체한다.
const LEAGUE_AVG_ERA = 4.60;
const LEAGUE_AVG_WHIP = 1.46;

function parseStatOr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

/**
 * 투수 CSV 행 → JSON pitcher 객체 변환.
 */
function csvRowToPitcher(row, profileLookup, fallbackTeamName = '') {
  const pId = row['playerId'] || null;
  const p = (pId && profileLookup[pId]) ? profileLookup[pId] : {};
  const teamName = row['팀명'] || fallbackTeamName;
  return {
    id: pId || `${row['선수명']}_${teamName}`,
    name: row['선수명'],
    team: teamName,
    ERA: parseStatOr(row['ERA'], LEAGUE_AVG_ERA),
    G: parseInt(row['G']) || 0,
    GS: parseInt(row['GS']) || 0,   // 선발 등판 수 (선발/불펜 판정의 근거)
    QS: parseInt(row['QS']) || 0,
    IP: parseIP(row['IP']) || 0,
    SO: parseInt(row['SO']) || 0,
    BB: parseInt(row['BB']) || 0,
    WHIP: parseStatOr(row['WHIP'], LEAGUE_AVG_WHIP),
    hand: p.pitcherHand || 'R',
    // 프로필
    jerseyNumber: p.jerseyNumber || null,
    age: p.age || null,
    height: p.height || null,
    weight: p.weight || null,
    position: p.position || null,
    battingThrowing: p.battingThrowing || null,
    career: p.career || null,
    draft: p.draft || null,
    salary: p.salary || null,
    salaryRaw: p.salaryRaw || null,
  };
}

/**
 * 연도별 통합 CSV 4종(타자·투수·도루·수비)을 병렬 fetch해서
 * 전체 { hitters, pitchers } 를 반환.
 */
async function loadYearCSV(year, profileRows) {
  const [hitterRes, pitcherRes, runRes, defRes] = await Promise.all([
    fetch(dataUrl(`data/${year}/${year}_hitter.csv`)),
    fetch(dataUrl(`data/${year}/${year}_pitcher.csv`)),
    fetch(dataUrl(`data/${year}/${year}_run.csv`)),
    fetch(dataUrl(`data/${year}/${year}_defense.csv`)),
  ]);
  if (!hitterRes.ok) throw new Error(`${year}년 타자 데이터를 찾을 수 없습니다`);
  if (!pitcherRes.ok) throw new Error(`${year}년 투수 데이터를 찾을 수 없습니다`);

  const [hitterText, pitcherText] = await Promise.all([
    hitterRes.text(),
    pitcherRes.text(),
  ]);

  const profileLookup = buildProfileLookup(profileRows);

  const hitters = parseCSV(hitterText)
    .map(r => csvRowToHitter(r, profileLookup))
    .filter(Boolean);
  const pitchers = parseCSV(pitcherText)
    .map(r => csvRowToPitcher(r, profileLookup));

  // ── 도루 데이터 병합 (run CSV) ──
  if (runRes.ok) {
    const runRows = parseCSV(await runRes.text());
    const runMapById = {};
    const runMapByName = {};
    runRows.forEach(rr => {
      if (rr['playerId']) runMapById[rr['playerId']] = rr;
      if (rr['선수명']) runMapByName[rr['선수명']] = rr;
    });

    hitters.forEach(h => {
      const rr = (h.id && runMapById[h.id]) || runMapByName[h.name];
      if (rr) {
        h.SB = parseInt(rr['SB']) || 0;
        h.CS = parseInt(rr['CS']) || 0;
        h.SBA = parseInt(rr['SBA']) || 0;
        h.sbPct = parseFloat(rr['SB%']) || 0;
      }
    });
  }

  // ── 수비 데이터 병합 (defense CSV) ──
  if (defRes.ok) {
    const defRows = parseCSV(await defRes.text());
    const defMapById = {};
    const defMapByName = {};
    defRows.forEach(r => {
      const pId = r['playerId'];
      const name = r['선수명'];
      if (pId) {
        if (!defMapById[pId]) defMapById[pId] = [];
        defMapById[pId].push(r);
      }
      if (name) {
        if (!defMapByName[name]) defMapByName[name] = [];
        defMapByName[name].push(r);
      }
    });

    hitters.forEach(h => {
      const rows = (h.id && defMapById[h.id]) || defMapByName[h.name];
      if (!rows) return;
      const main = rows.slice().sort((a, b) => parseInt(b['G']) - parseInt(a['G']))[0];
      h.defPos = main['POS'] || null;
      h.defense = buildDefenseStats(main);
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
 * 전체 연도 데이터를 한 번에 로드하여 DB.hitters, DB.pitchers에 적재.
 */
async function loadYearData(year, onReady, onError) {
  try {
    const profileRes = await fetch(dataUrl('data/player_profile.csv'));
    if (!profileRes.ok) throw new Error('player_profile.csv를 찾을 수 없습니다');
    const profileRows = parseCSV(await profileRes.text());

    const data = await loadYearCSV(year, profileRows);

    DB.hitters = data.hitters;
    DB.pitchers = data.pitchers;
    resetDefenseCaches(); // 수비 기준값 캐시는 DB에 종속되므로 함께 무효화

    if (typeof onReady === 'function') onReady(data);
  } catch (e) {
    if (typeof onError === 'function') onError(e.message || '데이터 로드 실패');
  }
}

/**
 * 연도·팀 목록 메타 정보를 fetch. (_meta.json 유지)
 * @param {Function} onReady  - ({ years, teams }) 콜백
 * @param {Function} onError
 */
async function loadMeta(onReady, onError) {
  try {
    const res = await fetch(dataUrl('data/_meta.json'));
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

// 표본이 작은 선수의 비율 스탯을 리그 평균 쪽으로 축소(regression to the mean).
// 보정하지 않으면 1타석 1안타가 타율 1.000으로 그대로 쓰여
// 라인업 순서(OPS 정렬)와 타석 판정이 모두 왜곡된다.
// 상수는 2026 데이터 실측값이며 buildHitter의 계산식 정의와 동일하게 산출했다.
const LG_AVG = 0.2681, LG_SLG = 0.4014, LG_OBP = 0.3437;
const LG_HR_OF_H = 0.0993, LG_D2_OF_H = 0.1689, LG_D3_OF_H = 0.0153;
const PA_SHRINK = 50;   // 이만큼의 '리그 평균 타석'을 가상으로 더해 준다

function buildHitter(r) {
  const AB = r.AB || 1, PA = r.PA || 1, H = r.H || 0,
    HR = r.HR || 0, D2 = r.D2 || 0, D3 = r.D3 || 0;
  const BB = Math.max(0, PA - AB - (r.SAC || 0) - (r.SF || 0));
  const k = PA_SHRINK;
  const shrunkAVG = (H + k * LG_AVG) / (AB + k);
  const shrunkH = H + k * LG_AVG;   // 안타 세부 비율의 분모(축소된 안타 수)
  const slg = ((r.TB || 0) + k * LG_SLG) / (AB + k);
  const obp = (H + BB + k * LG_OBP) / (PA + k);
  const ops = obp + slg;
  const speedScore = Math.min(1, (D3 * 3 + r.SAC * 1.5) / Math.max(PA, 1) * 10 + 0.1);
  return {
    ...r, BB_est: BB, bb_rate: BB / PA,
    k_rate: Math.max(0.08, 0.21 - (shrunkAVG - 0.265) * 0.35),
    hr_rate: HR / Math.max(AB, 1), hit_rate: shrunkAVG,
    hr_of_hit: (HR + k * LG_AVG * LG_HR_OF_H) / shrunkH,
    d3_of_hit: (D3 + k * LG_AVG * LG_D3_OF_H) / shrunkH,
    d2_of_hit: (D2 + k * LG_AVG * LG_D2_OF_H) / shrunkH,
    ops, obp, slg, speedScore,
    todayStats: { PA: 0, H: 0, HR: 0, RBI: 0, K: 0, BB: 0, SB: 0, CS: 0, SAC: 0 },
  };
}

// 선발 판정은 실제 선발 등판 수(GS)로 한다.
// IP/G는 구원 등판이 섞여 평균이 희석되므로(선발 16경기 + 구원 4경기여도 탈락) 쓰지 않는다.
// GS 하한만 두면 '29경기 중 선발 5번' 같은 불펜 투수가 선발로 잡히므로,
// 선발 등판이 전체 등판의 과반이어야 한다는 조건을 함께 건다.
const STARTER_MIN_GS = 5;
const STARTER_MIN_GS_RATIO = 0.5;
const MIN_STARTERS_PER_TEAM = 5;

function isStarterRow(r) {
  const g = r.G || 0, gs = r.GS || 0;
  return gs >= STARTER_MIN_GS && g > 0 && (gs / g) >= STARTER_MIN_GS_RATIO;
}

// 등판당 이닝. calcStamina가 이 값을 체력 용량(0%가 되는 투구수 ≈ avgIP × 20)으로 쓰므로
// 선발은 '선발 등판당', 불펜은 '구원 등판당'으로 나눠 계산해야 실제 역할과 맞는다.
function calcAvgIP(r, asStarter) {
  const ip = r.IP || 0, g = r.G || 0, gs = r.GS || 0;
  if (asStarter) {
    const per = gs > 0 ? ip / gs : (g > 0 ? ip / g : 4.5);
    return clamp(per, 3.0, 7.5);
  }
  const relApp = Math.max(0, g - gs);
  const per = relApp > 0 ? ip / relApp : (g > 0 ? ip / g : 1);
  return clamp(per, 0.5, 3.0);
}

function buildPitcher(r) {
  const ip = r.IP || 1;
  const isStarter = isStarterRow(r);
  const avgIP = calcAvgIP(r, isStarter);
  const role = isStarter ? 'starter' : (avgIP >= 1.5 ? 'middle' : 'closer');
  return {
    ...r,
    K9: (r.SO / ip) * 9, BB9: (r.BB / ip) * 9,
    avgIP, pitchCount: 0, isStarter, role, usedToday: false,
    todayStats: { IP_out: 0, H: 0, R: 0, ER: 0, BB: 0, K: 0 },
  };
}

// 팀 단위 투수진 생성. 선발이 MIN_STARTERS_PER_TEAM명에 못 미치면
// GS(동률이면 IP)가 많은 순으로 승격시켜 최소 로테이션 인원을 보장한다.
function buildTeamPitchers(rows) {
  const ps = rows.map(buildPitcher);
  const shortage = MIN_STARTERS_PER_TEAM - ps.filter(p => p.isStarter).length;
  if (shortage <= 0) return ps;

  ps.filter(p => !p.isStarter)
    .sort((a, b) => (b.GS || 0) - (a.GS || 0) || (b.IP || 0) - (a.IP || 0))
    .slice(0, shortage)
    .forEach(p => {
      p.isStarter = true;
      p.role = 'starter';
      p.avgIP = calcAvgIP(p, true); // 선발 기준으로 체력 용량 재계산
    });
  return ps;
}

function getTeamHitters(team) {
  return DB.hitters.filter(r => r.team === team).map(buildHitter).sort((a, b) => b.G - a.G);
}
function getTeamPitchers(team) {
  return buildTeamPitchers(DB.pitchers.filter(r => r.team === team));
}
// 팀 영문 코드 역조회 (시즌 모드 피로도 연동용)
function getTeamCode(korName) {
  if (typeof SS === 'undefined' || !SS.nameKor) return null;
  return Object.keys(SS.nameKor).find(k => SS.nameKor[k] === korName) || null;
}
// 팀 한글명 → 팀 컬러 { primary, secondary } (없으면 null)
function getTeamColor(korName) {
  const code = getTeamCode(korName);
  if (!code || typeof SS === 'undefined' || !SS.teamColors) return null;
  return SS.teamColors[code] || null;
}

// ── 팀 컬러 유틸 ──────────────────────────────────────
// 어두운 앱 배경(--bg #0a0c10) 위에서 팀 컬러를 그대로 텍스트/보더로 쓰면
// NC(#071D49)·키움(#570861)처럼 명도가 낮은 팀은 거의 안 보인다.
// 배경 채움(탭 등)에는 원색을 그대로 쓰고, 텍스트로 쓸 때만 최소 대비(WCAG ≈3:1)를 확보하도록 밝힌다.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function relLuminance({ r, g, b }) {
  const lin = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const BG_LUMINANCE = 0.0037; // var(--bg) #0a0c10
function readableTeamColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const contrast = (relLuminance(rgb) + 0.05) / (BG_LUMINANCE + 0.05);
  if (contrast >= 3) return hex;
  const t = 0.4;
  const lighten = c => Math.round(c + (255 - c) * t);
  return `rgb(${lighten(rgb.r)}, ${lighten(rgb.g)}, ${lighten(rgb.b)})`;
}
// 팀 컬러를 배경으로 채울 때(탭 활성 상태 등) 그 위에 얹을 글자색(흑/백)을 고른다.
function contrastingTextColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#000';
  const l = relLuminance(rgb);
  const contrastBlack = (l + 0.05) / 0.05;
  const contrastWhite = 1.05 / (l + 0.05);
  return contrastWhite > contrastBlack ? '#fff' : '#000';
}
// 팀명을 다크 배경 위 텍스트로 칠할 때 쓰는 style 속성 문자열. 팀 컬러가 없으면 빈 문자열(기본 CSS 색 유지).
function teamColorStyle(korName) {
  const c = getTeamColor(korName);
  return c ? `style="color:${readableTeamColor(c.primary)}"` : '';
}
// 팀 탭처럼 원색을 배경으로 채우는 곳: --team-tab-bg/--team-tab-text 커스텀 프로퍼티로 넘긴다.
// (활성 상태일 때만 CSS가 이 값을 실제로 소비하므로, 비활성 탭은 그대로 둬도 무방)
function teamTabStyle(korName) {
  const c = getTeamColor(korName);
  if (!c) return '';
  return `style="--team-tab-bg:${c.primary};--team-tab-text:${contrastingTextColor(c.primary)}"`;
}
// 헤더 팀 박스처럼 보더(원색 그대로)와 텍스트(가독성 보정)를 함께 쓰는 요소에 커스텀 프로퍼티를 심어준다.
function setTeamColorVars(el, korName) {
  if (!el) return;
  const c = getTeamColor(korName);
  if (!c) {
    el.style.removeProperty('--team-color');
    el.style.removeProperty('--team-color-text');
    el.style.removeProperty('--team-color-tint');
    return;
  }
  const rgb = hexToRgb(c.primary);
  el.style.setProperty('--team-color', c.primary);
  el.style.setProperty('--team-color-text', readableTeamColor(c.primary));
  if (rgb) el.style.setProperty('--team-color-tint', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .15)`);
}

// 수비 포지션 한글 → 영문 약어
const POS_KOR_MAP = {
  '포수': 'C', '1루수': '1B', '2루수': '2B', '3루수': '3B',
  '유격수': 'SS', '좌익수': 'LF', '중견수': 'CF', '우익수': 'RF',
  '투수': 'P', '외야수': 'OF', '내야수': 'IF',
};

// 표본 보정을 해도 무기록 선수는 리그 평균 OPS를 받아 중위 타순에 들 수 있으므로,
// 선발 라인업 자체를 일정 타석 이상 소화한 선수로 제한한다.
// 자격자가 9명 미만인 팀은 전체 풀로 되돌린다.
const LINEUP_MIN_PA = 50;

function buildLineup(hs) {
  const eligible = hs.filter(h => (h.PA || 0) >= LINEUP_MIN_PA);
  const pool = eligible.length >= 9 ? eligible : hs;
  const sorted = [...pool].sort((a, b) => b.ops - a.ops);
  const fallbackPos = ['CF', 'SS', '3B', '1B', 'RF', '2B', 'C', 'LF', 'DH'];
  const used = new Set();
  const lineup = [];

  // 포수(C) 우선 배치 — 포수가 없으면 수비 포지션 무시
  const catcher = sorted.find(p => p.defPos === '포수');
  if (catcher) used.add(catcher.name);

  sorted.slice(0, 12).forEach(p => {
    if (lineup.length >= 9) return;
    if (used.has(p.name)) return;
    used.add(p.name);
    lineup.push(p);
  });

  // 포수를 7번 타순 자리에 삽입 (없으면 그냥 순서대로)
  if (catcher && lineup.length >= 6) lineup.splice(6, 0, catcher);
  else if (catcher) lineup.push(catcher);

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
  return Math.max(0, Math.min(100, 100 - (p.pitchCount / Math.max(p.avgIP, 1) / 16) * 80));
}
// decidePAResult의 pq 산출 기준. 이 값을 낮출수록 타자 쪽이 유리해진다.
const PQ_BASELINE_ERA = 4.00;

function adjERA(p) {
  const s = calcStamina(p);
  const mult = s >= 80 ? 1
    : s >= 60 ? 1.1
    : s >= 40 ? 1.25
    : s >= 30 ? 1.6
    : s >= 20 ? 1.75
    : s >= 10 ? 2
    : 3;
  return p.ERA * mult;
}
function isRISP(bases) { return bases[1] || bases[2]; }
function isFullBase(bases) { return bases[0] && bases[1] && bases[2]; }

// ── 좌우 매치업 (플래툰) ──
function calcPlatoon(bHand, pHand) {
  const bh = bHand || 'R', ph = pHand || 'R';
  const same = (bh === ph);
  return same
    ? { advantage: 'pitcher', label: `동타(${bh}타/${ph}투) 투수유리`, hitMod: -0.04, kMod: +0.08 }
    : { advantage: 'batter', label: `반대타(${bh}타/${ph}투) 타자유리`, hitMod: +0.03, kMod: -0.05 };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

const DEF_POS_WEIGHTS = {
  C: 0.12, '1B': 0.08, '2B': 0.14, '3B': 0.12, SS: 0.18,
  LF: 0.10, CF: 0.16, RF: 0.10, OF: 0.10, IF: 0.12,
};

function meanAndSd(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return { mean: 0, sd: 1 };
  const mean = nums.reduce((sum, v) => sum + v, 0) / nums.length;
  const variance = nums.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / nums.length;
  return { mean, sd: Math.sqrt(variance) || 1 };
}

// 포지션별 수비 기준값은 DB.hitters가 바뀌지 않는 한 상수인데,
// 매 타석 × 수비수 9명마다 전 선수를 스캔해 재계산하면 타석 비용의 대부분을 차지한다.
// DB 교체 시 resetDefenseCaches()로 무효화한다.
let _defBaselineCache = new Map();
let _fielderScoreCache = new WeakMap();

function resetDefenseCaches() {
  _defBaselineCache = new Map();
  _fielderScoreCache = new WeakMap();
}

function getDefenseBaselines(pos) {
  const hit = _defBaselineCache.get(pos);
  if (hit) return hit;
  const rows = DB.hitters
    .map(h => h.defense)
    .filter(d => d && d.pos === pos && d.IP > 0);
  const out = {
    range: meanAndSd(rows.map(d => d.rangePer9)),
    fpct: meanAndSd(rows.map(d => d.FPCT)),
    err: meanAndSd(rows.map(d => d.errPer9)),
    dp: meanAndSd(rows.map(d => d.dpPer9)),
  };
  _defBaselineCache.set(pos, out);
  return out;
}

function zScore(value, stat) {
  return stat.sd ? (value - stat.mean) / stat.sd : 0;
}

function calcFielderDefenseScore(player) {
  const d = player && player.defense;
  if (!d || !d.pos || d.IP <= 0) return 50;
  // 선수의 수비 기록은 경기 중 변하지 않으므로 선수 객체 단위로 캐시한다
  // (교체 선수는 새 객체이므로 자연히 새로 계산됨)
  const cached = _fielderScoreCache.get(player);
  if (cached !== undefined) return cached;
  const base = getDefenseBaselines(d.pos);
  const zRange = zScore(d.rangePer9, base.range);
  const zFpct = zScore(d.FPCT, base.fpct);
  const zErrAvoid = zScore(base.err.mean - d.errPer9, { mean: 0, sd: base.err.sd });
  const zDP = zScore(d.dpPer9, base.dp);
  const raw = 50 + 8 * (0.35 * zRange + 0.30 * zFpct + 0.25 * zErrAvoid + 0.10 * zDP);
  const out = clamp(raw, 35, 65);
  _fielderScoreCache.set(player, out);
  return out;
}

function calcTeamDefenseImpact(defenseLineup) {
  if (!Array.isArray(defenseLineup) || !defenseLineup.length) {
    return { score: 50, infieldScore: 50, hitAdj: 0, dpAdj: 0 };
  }
  let total = 0, weightSum = 0, infieldTotal = 0, infieldWeight = 0;
  defenseLineup.forEach(player => {
    const pos = player.pos || POS_KOR_MAP[player.defPos] || player.defPos;
    if (!pos || pos === 'DH' || pos === 'P') return;
    const weight = DEF_POS_WEIGHTS[pos] || 0.10;
    const score = calcFielderDefenseScore(player);
    total += score * weight;
    weightSum += weight;
    if (pos === '1B' || pos === '2B' || pos === '3B' || pos === 'SS' || pos === 'IF') {
      infieldTotal += score * weight;
      infieldWeight += weight;
    }
  });
  const score = weightSum ? total / weightSum : 50;
  const infieldScore = infieldWeight ? infieldTotal / infieldWeight : score;
  return {
    score,
    infieldScore,
    hitAdj: clamp((score - 50) / 50, -0.06, 0.06),
    dpAdj: clamp((infieldScore - 50) / 100, -0.08, 0.08),
  };
}

// ═══════════════════════════════════════════════════════
//  타석 결과 결정
// ═══════════════════════════════════════════════════════

const POS_KOR_FULL_MAP = {
  C: '포수', '1B': '1루수', '2B': '2루수', '3B': '3루수', SS: '유격수',
  LF: '좌익수', CF: '중견수', RF: '우익수', P: '투수', OF: '외야수', IF: '내야수'
};

const FINE_PLAY_DESCS = {
  OF: ['다이빙 캐치', '펜스 직전 점핑 캐치', '슬라이딩 캐치', '다이빙 슈퍼 캐치'],
  IF: ['다이빙 캐치 후 1루 송구', '빠진 타구를 차단하는 호수비', '점핑 캐치', '라인드라이브 호수비'],
  C: ['파울플라이 익스트림 캐치']
};

function getRandomFielder(defenseLineup, posGroup) {
  if (!Array.isArray(defenseLineup) || !defenseLineup.length) return null;
  const filtered = defenseLineup.filter(p => {
    const pos = p.pos || POS_KOR_MAP[p.defPos] || p.defPos;
    if (posGroup === 'OF') return ['LF', 'CF', 'RF'].includes(pos);
    if (posGroup === 'IF') return ['1B', '2B', '3B', 'SS'].includes(pos);
    return pos !== 'DH';
  });
  if (!filtered.length) {
    const nonDH = defenseLineup.filter(p => (p.pos || POS_KOR_MAP[p.defPos]) !== 'DH');
    return nonDH.length ? nonDH[Math.floor(rn() * nonDH.length)] : defenseLineup[0];
  }
  return filtered[Math.floor(rn() * filtered.length)];
}

// 계산식 탭 등에서 쓰는 결과 코드 → 한글 라벨
const RESULT_LABELS = {
  k: '삼진', bb: '볼넷', hr: '홈런', '1b': '단타', '2b': '2루타', '3b': '3루타',
  out: '범타', dp: '병살', fine_play: '호수비', error: '실책',
};

// decidePAResult가 실제로 사용한 중간 계산값 전체를 기록한 최신 trace.
// 계산식 탭은 이 값을 그대로 렌더링하므로 화면 표시가 실제 판정 로직과 항상 일치한다.
let lastCalcTrace = null;

function decidePAResult(b, p, bases, inning, outs, defenseLineup = null) {
  const steps = [];
  const push = (label, value) => steps.push({ label, value });
  const finish = (result) => {
    const type = typeof result === 'object' ? result.type : result;
    push('최종 결과', RESULT_LABELS[type] || type);
    lastCalcTrace = { steps, result: type };
    return result;
  };

  // pq(투수품질지수): 클수록 나쁜 투수. 기준값을 낮추면 타격이 전반적으로 살아난다.
  // 4.30에서는 리그 평균 득점이 실제 KBO 하한(4.5)에 못 미쳐 4.00으로 조정.
  const era = adjERA(p), pq = Math.max(0.5, Math.min(1.8, era / PQ_BASELINE_ERA));
  push('타자', `${b.hand || 'R'}타 · AVG ${(b.AVG || 0).toFixed(3)}`);
  push('투수', `${p.hand || 'R'}투 · ERA(보정) ${era.toFixed(2)}`);
  push('투수품질지수(pq)', pq.toFixed(3));

  // 포수 피로도 타격 페널티 (시즌 모드)
  let batterHitRate = b.hit_rate;
  if (typeof SS !== 'undefined' && SS.catcherFatigue && (b.position === 'C' || b.position === '포수' || b.defPos === '포수' || b.pos === 'C')) {
    const teamCode = typeof getTeamCode === 'function' ? getTeamCode(b.team) : null;
    if (teamCode) {
      const cf = SS.catcherFatigue[`${b.name}_${teamCode}`];
      if (cf && cf.stamina < 50) {
        batterHitRate *= 0.9; // 체력 50 미만 시 안타 확률 10% 하락
        push('포수 피로도 페널티', `안타율 ${b.hit_rate.toFixed(3)} → ${batterHitRate.toFixed(3)}`);
      }
    }
  }

  let hit = batterHitRate * (0.85 * pq + 0.15),
    bb = b.bb_rate * (0.5 + 0.5 * pq),
    k = b.k_rate * (0.5 + 0.5 / pq);
  push('기본 확률(pq 반영)', `안타 ${hit.toFixed(3)} · 볼넷 ${bb.toFixed(3)} · 삼진 ${k.toFixed(3)}`);

  const kb = (p.K9 - 7.5) * 0.006, bp = (p.BB9 - 3.5) * 0.004;
  k = Math.max(0.05, k + kb);
  bb = Math.max(0.02, bb + bp);
  hit = Math.max(0.05, hit - kb * 0.5);
  push('K9/BB9 보정', `안타 ${hit.toFixed(3)} · 볼넷 ${bb.toFixed(3)} · 삼진 ${k.toFixed(3)}`);

  // 좌우 유불리
  const pl = calcPlatoon(b.hand, p.hand);
  hit = Math.max(0.05, hit + pl.hitMod);
  k = Math.max(0.04, k + pl.kMod);
  push('좌우 매치업', `${pl.label} → 안타 ${hit.toFixed(3)} · 삼진 ${k.toFixed(3)}`);

  // 주자 상황
  if (isRISP(bases)) {
    hit = Math.min(hit * 1.06 + 0.02, 0.45);
    push('RISP 보정', `안타 → ${hit.toFixed(3)}`);
  }
  if (isFullBase(bases)) {
    bb *= 0.75;
    push('만루 보정', `볼넷 → ${bb.toFixed(3)}`);
  }
  if (inning >= 7) {
    k *= 1.05;
    push('7회 이후 보정', `삼진 → ${k.toFixed(3)}`);
  }

  // 수비진 보정: 평균보다 좋은 수비는 안타 확률을 낮추고 병살 가능성을 조금 높인다.
  const defenseImpact = calcTeamDefenseImpact(defenseLineup);
  hit = Math.max(0.05, hit * (1 - defenseImpact.hitAdj));
  push('수비진 보정', `수비점수 ${defenseImpact.score.toFixed(1)} → 안타 ${hit.toFixed(3)}`);

  const tot = hit + bb + k;
  if (tot > 0.93) { const r = 0.93 / tot; hit *= r; bb *= r; k *= r; push('확률 정규화', `합계 ${tot.toFixed(3)} > 0.93 → 비율 축소`); }

  push('최종 확률', `삼진 ${k.toFixed(3)} · 볼넷 ${bb.toFixed(3)} · 안타 ${hit.toFixed(3)} · 범타 ${Math.max(0, 1 - k - bb - hit).toFixed(3)}`);

  const roll = rn();
  push('난수(roll)', roll.toFixed(4));
  if (roll < k) return finish('k');
  if (roll < k + bb) return finish('bb');
  if (roll < k + bb + hit) {
    // 호수비 (Fine play) 판정 (수비진 수비점수가 높으면 안타 타구를 캐치)
    const finePlayChance = Math.max(0.01, 0.035 + (defenseImpact.score - 50) * 0.002);
    push('호수비 확률', finePlayChance.toFixed(3));
    if (rn() < finePlayChance && defenseLineup && defenseLineup.length) {
      const fielder = getRandomFielder(defenseLineup, rn() < 0.6 ? 'OF' : 'IF');
      if (fielder) {
        const pos = fielder.pos || POS_KOR_MAP[fielder.defPos] || 'OF';
        const posGroup = ['LF', 'CF', 'RF'].includes(pos) ? 'OF' : 'IF';
        const descs = FINE_PLAY_DESCS[posGroup] || FINE_PLAY_DESCS.IF;
        const catchType = descs[Math.floor(rn() * descs.length)];
        const posName = POS_KOR_FULL_MAP[pos] || pos;
        return finish({ type: 'fine_play', fielder, posName, catchType });
      }
    }

    const hr2 = Math.min(b.hr_of_hit, 0.35),
      d3 = Math.min(b.d3_of_hit, 0.06),
      d2 = Math.min(b.d2_of_hit, 0.25),
      r2 = rn();
    push('안타 세부 판정', `홈런${hr2.toFixed(3)}/3루타${d3.toFixed(3)}/2루타${d2.toFixed(3)} · 난수 ${r2.toFixed(4)}`);
    if (r2 < hr2) return finish('hr');
    if (r2 < hr2 + d3) return finish('3b');
    if (r2 < hr2 + d3 + d2) return finish('2b');
    return finish('1b');
  }

  // 병살은 1루 주자가 있고 2아웃 미만일 때만 성립한다.
  // (예전에는 주자가 없어도 굴려서, 성립 불가능한 병살이 아웃 2개를 소모했다)
  const canDP = !!bases[0] && outs < 2;
  const dpChance = canDP ? 0.14 * (1 + defenseImpact.dpAdj) : 0;
  const isDP = canDP && rn() < dpChance;
  push('병살 확률', canDP ? dpChance.toFixed(3) : '0.000 (1루 주자 없음)');
  if (!isDP) {
    // 수비 실책 (Error) 판정 (범타 처리 중 일부가 수비실책으로 변경)
    const errorChance = Math.max(0.005, 0.025 - (defenseImpact.score - 50) * 0.0015);
    push('실책 확률', errorChance.toFixed(3));
    if (rn() < errorChance && defenseLineup && defenseLineup.length) {
      const fielder = getRandomFielder(defenseLineup, 'ALL');
      if (fielder) {
        const pos = fielder.pos || POS_KOR_MAP[fielder.defPos] || 'IF';
        const posName = POS_KOR_FULL_MAP[pos] || pos;
        return finish({ type: 'error', fielder, posName });
      }
    }
  }

  return finish(isDP ? 'dp' : 'out');
}

// ── 투구 시퀀스 생성 ──
function buildSeq(pr) {
  const prType = typeof pr === 'object' ? pr.type : pr;
  const dk = (prType === '1b' || prType === '2b' || prType === '3b' || prType === 'error') ? 'hit'
    : prType === 'hr' ? 'hr'
      : prType === 'k' ? 'k'
        : prType === 'bb' ? 'bb' : 'out';
  const d = PITCH_DIST[dk], target = randN(d.mean, d.sd), seq = [];
  let balls = 0, strikes = 0;
  for (let i = 0; i < target - 1; i++) {
    const rem = target - 1 - i;
    if (rem === 1) {
      if (prType === 'k' && strikes < 2) { seq.push('S'); strikes++; continue; }
      if (prType === 'bb' && balls < 3) { seq.push('B'); balls++; continue; }
      if (prType === 'bb') { seq.push('F'); continue; }
    }
    let bP = 0.35, sP = 0.25, fP = 0.22;
    if (prType === 'k') { bP = 0.27; sP = 0.33; fP = 0.25; }
    if (prType === 'bb') { bP = 0.46; sP = 0.17; fP = 0.17; }
    const r = rn();
    if (r < bP && balls < 3) { seq.push('B'); balls++; }
    else if (r < bP + sP) { strikes < 2 ? (seq.push('S'), strikes++) : seq.push('F'); }
    else if (r < bP + sP + fP) { if (strikes < 2) strikes++; seq.push('F'); }
    else if (balls < 3) { seq.push('B'); balls++; }
    else { if (strikes < 2) strikes++; seq.push('F'); }
  }
  seq.push({ k: 'K', bb: 'W', hr: 'HR', '1b': '1B', '2b': '2B', '3b': '3B', dp: 'DP', fine_play: 'OUT', error: '1B', out: 'OUT' }[prType] || 'OUT');
  return seq;
}

// ── 주자 이동 ──
// bases의 각 칸에는 주자 식별자(선수명)를 담는다. 누가 어느 베이스에 있는지 알아야
// 도루 주체를 정확히 판정·기록할 수 있다. runner를 생략하면 익명 주자('r')로 처리한다.
// 진루 규칙 자체는 기존과 동일하며, 옮겨지는 값만 익명 'r' → 실제 주자로 바뀐다.
function advRunners(bases, ht, runner = 'r') {
  let scored = 0, nb = [null, null, null];
  if (ht === 'hr') { scored = 1 + bases.filter(Boolean).length; return { bases: [null, null, null], scored }; }
  if (ht === '3b') { scored = bases.filter(Boolean).length; nb[2] = runner; return { bases: nb, scored }; }
  if (ht === '2b') { if (bases[2]) scored++; if (bases[1]) scored++; if (bases[0]) nb[2] = bases[0]; nb[1] = runner; return { bases: nb, scored }; }
  if (ht === '1b') { if (bases[2]) scored++; if (bases[1]) nb[2] = bases[1]; if (bases[0]) nb[1] = bases[0]; nb[0] = runner; return { bases: nb, scored }; }
  if (ht === 'bb') {
    // 밀어내기: 1루가 차 있으면 1루 주자가 2루로, 1·2루가 모두 차 있으면 2루 주자가 3루로
    if (bases[0] && bases[1] && bases[2]) scored++;
    nb[2] = bases[0] && bases[1] ? bases[1] : bases[2];
    nb[1] = bases[0] ? bases[0] : bases[1];
    nb[0] = runner;
    return { bases: nb, scored };
  }
  if (ht === 'dp') return { bases: [null, bases[1], bases[2]], scored: 0 };
  return { bases, scored: 0 };
}

// ═══════════════════════════════════════════════════════
//  스페셜 이벤트 (도루 / 희생번트)
// ═══════════════════════════════════════════════════════

function trySteal(batter, bases, outs) {
  if (outs >= 2) return false;
  if (!bases[0] || bases[1]) return false;

  // 도루하는 주체는 타석의 타자가 아니라 1루 주자다.
  // bases[0]에 담긴 이름으로 실제 주자를 찾아 능력치·기록에 사용한다.
  const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
  const runner = lineup.find(p => p.name === bases[0]);
  if (!runner) return false;   // 주자를 특정할 수 없으면 도루 시도하지 않음

  // ── 도루 시도 확률: 실제 SBA/G 데이터 우선, 없으면 speedScore 추정 ──
  const sbaPerGame = runner.SBA > 0
    ? runner.SBA / Math.max(runner.G, 1)
    : null;
  const attemptProb = sbaPerGame !== null
    ? Math.min(sbaPerGame * 0.4, 0.35)          // 실제 도루 시도율 반영
    : (runner.speedScore || 0.2) * 0.35;         // 추정값 fallback

  if (rn() >= attemptProb) return false;

  // ── 성공률: 실제 SB% 우선, 없으면 기본 72% ──
  let successRate = runner.sbPct > 0
    ? runner.sbPct / 100
    : 0.72;

  // ── 포수 도루 저지율 반영 ──
  const pitcher = gs.isTop ? gs.curHP : gs.curAP;
  const defLineup = gs.isTop ? gs.homeLineup : gs.awayLineup;
  const catcher = defLineup.find(p => p.pos === 'C');
  if (catcher && catcher.csPct > 0) {
    let baseCsPct = catcher.csPct;

    // 포수 피로도 수비 페널티 (시즌 모드)
    if (typeof SS !== 'undefined' && SS.catcherFatigue) {
      const teamCode = typeof getTeamCode === 'function' ? getTeamCode(catcher.team) : null;
      if (teamCode) {
        const cf = SS.catcherFatigue[`${catcher.name}_${teamCode}`];
        if (cf && cf.stamina < 50) {
          baseCsPct = Math.max(0, baseCsPct - 15); // 체력 50 미만 시 도루 저지율 15%p 하락
        }
      }
    }

    // 포수 CS%가 높을수록 성공률 감소 (리그 평균 25% 기준 보정)
    const catcherAdj = (baseCsPct - 25) / 100;
    successRate = Math.max(0.40, Math.min(0.90, successRate - catcherAdj));
  }

  if (rn() < successRate) {
    gs.bases = [null, runner.name, bases[2]];   // 주자 신원을 유지한 채 2루로
    runner.todayStats.SB++;
    const currentTotalSB = (runner.SB || 0) + runner.todayStats.SB;
    addLog(`🟣 ${formatPlayerName(runner.name)} 도루 성공! (시즌 ${currentTotalSB}도루)`, 'steal');
    showPitch('도루!', 'steal');
  } else {
    gs.bases = [null, null, bases[2]];
    gs.outs = Math.min(gs.outs + 1, 3);
    runner.todayStats.CS++;
    const catcherName = catcher ? ` (포수: ${formatPlayerName(catcher.name)})` : '';
    addLog(`🔴 ${formatPlayerName(runner.name)} 도루 실패${catcherName}`, 'out');
    showPitch('도루 실패', 'out');
  }
  return true;
}

async function trySacBunt(batter, bases, outs, pitcher) {
  if (outs >= 2) return false;
  if (!bases[0]) return false;
  const sacRate = batter.SAC / Math.max(batter.G, 1);
  if (sacRate < 0.06) return false;
  if (batter.order > 6) return false;
  if (rn() < 0.30) {
    if (rn() < 0.82) {
      let scored = 0;
      const nb = [null, null, null];
      if (bases[2]) scored++;
      nb[2] = bases[1] || null;   // 2루 주자 → 3루 (신원 유지)
      nb[1] = bases[0] || null;   // 1루 주자 → 2루
      gs.outs = Math.min(gs.outs + 1, 3);
      gs.bases = nb;
      batter.todayStats.SAC++;
      if (scored) {
        await doScoreEffect(scored);
        batter.todayStats.RBI += scored;
        pitcher.todayStats.R += scored;
        addRuns(scored);
      }
      addLog(`🟢 ${formatPlayerName(batter.name)} 희생번트 성공` + (scored ? ` (${scored}점)` : ''), 'bunt');
      showPitch('희생번트', 'bunt');
    } else {
      gs.outs = Math.min(gs.outs + 1, 3);
      addLog(`🔴 ${formatPlayerName(batter.name)} 번트 실패 (아웃)`, 'out');
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
  const hH = getTeamHitters(home), hA = getTeamHitters(away);
  const pH = getTeamPitchers(home), pA = getTeamPitchers(away);
  const hL = buildLineup(hH), aL = buildLineup(hA);
  if (!hL.length || !aL.length) { alert('해당 팀 데이터 부족'); return null; }
  const homeCode = getTeamCode(home) || home;
  const awayCode = getTeamCode(away) || away;
  const isSeasonGame = typeof SS !== 'undefined' && Array.isArray(SS.schedule) && SS.schedule.length > 0;
  const homeIsMine = typeof SS !== 'undefined' && SS.myTeamKor === home;
  const awayIsMine = typeof SS !== 'undefined' && SS.myTeamKor === away;
  const homeStarter = isSeasonGame
    ? (homeIsMine && typeof pickStarterFromRotation === 'function'
      ? pickStarterFromRotation(pH, homeCode)
      : pickStarterWithFatigue(pH, homeCode))
    : pickStarter(pH);
  const awayStarter = isSeasonGame
    ? (awayIsMine && typeof pickStarterFromRotation === 'function'
      ? pickStarterFromRotation(pA, awayCode)
      : pickStarterWithFatigue(pA, awayCode))
    : pickStarter(pA);
  return {
    homeTeam: home, awayTeam: away,
    homeScore: 0, awayScore: 0,
    inning: 1, isTop: true, isExtra: false,
    outs: 0, bases: [null, null, null],
    homeLineup: hL, awayLineup: aL,
    homePitchers: pH, awayPitchers: pA,
    curHP: homeStarter,
    curAP: awayStarter,
    homeOrder: 0, awayOrder: 0,
    innings: { home: [], away: [0] },
    currentPA: null,
    balls: 0, strikes: 0,
    gamePitches: 0, totalAB: 0,
    gameOver: false,
  };
}

function getCurrentDefenseLineup() {
  if (!gs) return null;
  return gs.isTop ? gs.homeLineup : gs.awayLineup;
}

async function startPA() {
  const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
  const order = gs.isTop ? gs.awayOrder : gs.homeOrder;
  const pitcher = gs.isTop ? gs.curHP : gs.curAP;
  const batter = lineup[order % lineup.length];

  // 도루 시도 (PA 소비 없음)
  if (trySteal(batter, gs.bases, gs.outs)) {
    if (gs.outs >= 3) {
      await sleep(1000);
      await endHalf();
      return;
    }
    updateGameUI(); updateLnpUI(); updateSbUI();
    return;
  }
  // 희생번트 시도 (PA 소비)
  if (await trySacBunt(batter, gs.bases, gs.outs, pitcher)) {
    batter.todayStats.PA++;
    if (gs.outs >= 3) {
      await sleep(1000);
      await endHalf();
      return;
    }
    gs.isTop ? gs.awayOrder++ : gs.homeOrder++;
    updateGameUI(); updateLnpUI(); updateSbUI();
    return;
  }

  const prRes = decidePAResult(batter, pitcher, gs.bases, gs.inning, gs.outs, getCurrentDefenseLineup());
  let pr = prRes, fielderDetail = null;
  if (prRes && typeof prRes === 'object') {
    pr = prRes.type;
    fielderDetail = prRes;
  }
  gs.currentPA = { batter, pitcher, pr, seq: buildSeq(pr), pidx: 0, fielderDetail, trace: lastCalcTrace };
  gs.balls = 0; gs.strikes = 0;
  updateBatUI(batter); updatePitUI(pitcher); updateCntUI(0, 0);
  const pcab = document.getElementById('pc-ab');
  if (pcab) pcab.textContent = '0';
  updateFml(gs.currentPA.trace);
  updateSituationBar();
}

async function processOnePitch() {
  if (!gs || gs.gameOver || isAnimating) return;
  isAnimating = true;
  try {
    // ── 강제 종료 체크 (안전 장치) ──
    if (gs.inning >= 9 && !gs.isTop && gs.homeScore > gs.awayScore) { await endGame(); return; }

    if (!gs.currentPA) { await startPA(); return; }
    const pa = gs.currentPA;
    if (pa.pidx >= pa.seq.length) { await startPA(); return; }

    const pitch = pa.seq[pa.pidx++];
    gs.gamePitches++;
    pa.pitcher.pitchCount++;
    const pcab = document.getElementById('pc-ab');
    if (pcab) pcab.textContent = pa.pidx;
    const pcp = document.getElementById('pc-p');
    if (pcp) pcp.textContent = pa.pitcher.pitchCount;
    const pctot = document.getElementById('pc-tot');
    if (pctot) pctot.textContent = gs.gamePitches;
    updateStamUI(pa.pitcher);

    if (pa.pidx >= pa.seq.length) {
      gs.totalAB++;
      const pcavg = document.getElementById('pc-avg');
      if (pcavg) pcavg.textContent = (gs.gamePitches / gs.totalAB).toFixed(1);
      await handlePA(pa);
      gs.currentPA = null;
      gs.balls = 0; gs.strikes = 0;
      // ── 이닝/경기 종료 판정 ──
      if (gs.inning >= 9 && !gs.isTop && gs.homeScore > gs.awayScore) {
        await sleep(1000); // 득점 연출을 볼 시간을 줌
        await endGame();
      } else if (gs.outs >= 3) {
        await sleep(1000); // 투구 결과 연출을 볼 시간을 줌
        await endHalf();
      } else {
        checkChange(true); // 이닝 중 강판 판정
        updateGameUI();
      }
    } else {
      if (pitch === 'B') { gs.balls++; showPitch('볼', 'ball'); }
      else if (pitch === 'S') { gs.strikes++; showPitch('스트라이크', 'strike'); }
      else if (pitch === 'F') {
        if (gs.strikes < 2) gs.strikes++; // 2스트라이크 미만에서는 파울도 스트라이크로 카운트
        showPitch('파울', 'foul');
      }
      updateCntUI(gs.balls, gs.strikes);
      updateGameUI();
    }
    updateLnpUI();
  } finally {
    isAnimating = false;
  }
}

async function handlePA(pa) {
  isAnimating = true;
  const prResult = pa.pr;
  const r = typeof prResult === 'object' ? prResult.type : prResult;
  const fielderDetail = pa.fielderDetail || (typeof prResult === 'object' ? prResult : null);
  const b = pa.batter, p = pa.pitcher, n = pa.pidx;
  if (!p.todayStats) p.todayStats = { IP_out: 0, H: 0, R: 0, ER: 0, BB: 0, K: 0 };
  b.todayStats.PA++; // 타석 결과가 확정되는 시점에 카운트 (체력 계산이 진행 중인 타석을 미리 반영하지 않도록)
  const rbiBeforePA = b.todayStats.RBI || 0;

  if (r === 'k') {
    gs.outs = Math.min(gs.outs + 1, 3);
    b.todayStats.K++;
    p.todayStats.K++;
    p.todayStats.IP_out++;
    showPitch('삼진', 'k');
    addLog(`🔴 ${formatPlayerName(b.name)} 삼진 (${n}구)`, 'out');
  } else if (r === 'bb') {
    b.todayStats.BB++;
    p.todayStats.BB++;
    showPitch('볼넷', 'walk');
    const prevBases_bb = [...gs.bases];
    const res = advRunners(gs.bases, 'bb', b.name); gs.bases = res.bases;
    updateBasesUI(gs.bases);
    popBases(gs.bases, prevBases_bb);
    if (res.scored) {
      await doScoreEffect(res.scored);
      b.todayStats.RBI += res.scored;
      p.todayStats.R += res.scored;
      addRuns(res.scored);
    }
    addLog(`🔵 ${formatPlayerName(b.name)} 볼넷${res.scored ? ` (${res.scored}점)` : ''}`, res.scored ? 'score' : '');
  } else if (r === 'hr') {
    b.todayStats.H++; b.todayStats.HR++;
    p.todayStats.H++;
    showPitch('홈런!', 'hr');
    await doHREffect();
    const res = advRunners(gs.bases, 'hr', b.name); gs.bases = res.bases;
    updateBasesUI(gs.bases);
    if (res.scored) {
      await doScoreEffect(res.scored);
      b.todayStats.RBI += res.scored;
      p.todayStats.R += res.scored;
      addRuns(res.scored);
    }
    addLog(`🏠 ${formatPlayerName(b.name)} ${res.scored}런 홈런!! (${n}구)`, 'hr');
  } else if (r === '1b' || r === '2b' || r === '3b') {
    b.todayStats.H++;
    p.todayStats.H++;
    const lbl = { '1b': '단타', '2b': '2루타', '3b': '3루타' }[r];
    showPitch(lbl, 'hit');
    const prevBases_hit = [...gs.bases];
    const res = advRunners(gs.bases, r, b.name); gs.bases = res.bases;
    updateBasesUI(gs.bases);
    popBases(gs.bases, prevBases_hit);
    if (res.scored) {
      await doScoreEffect(res.scored);
      b.todayStats.RBI += res.scored;
      p.todayStats.R += res.scored;
      addRuns(res.scored);
    }
    addLog(`✅ ${formatPlayerName(b.name)} ${lbl}${res.scored ? ` (${res.scored}점)` : ''}`, res.scored ? 'score' : 'hit');
  } else if (r === 'fine_play') {
    gs.outs = Math.min(gs.outs + 1, 3);
    p.todayStats.IP_out++;
    showPitch('호수비!', 'fineplay');
    const fName = fielderDetail && fielderDetail.fielder ? formatPlayerName(fielderDetail.fielder.name) : '수비수';
    const posName = fielderDetail ? fielderDetail.posName : '야수';
    const catchType = fielderDetail ? fielderDetail.catchType : '호수비';
    addLog(`🛡️ [호수비] ${posName} ${fName}의 ${catchType}! 안타를 지워냅니다! (${n}구)`, 'fineplay');
  } else if (r === 'error') {
    showPitch('수비실책', 'error');
    const prevBases_err = [...gs.bases];
    const res = advRunners(gs.bases, '1b', b.name); gs.bases = res.bases;
    updateBasesUI(gs.bases);
    popBases(gs.bases, prevBases_err);
    if (res.scored) {
      await doScoreEffect(res.scored);
      p.todayStats.R += res.scored;
      addRuns(res.scored);
    }
    const fName = fielderDetail && fielderDetail.fielder ? formatPlayerName(fielderDetail.fielder.name) : '수비수';
    const posName = fielderDetail ? fielderDetail.posName : '야수';
    addLog(`⚠️ [실책] ${posName} ${fName} 실책! ${formatPlayerName(b.name)} 1루 출루${res.scored ? ` (${res.scored}점)` : ''} (${n}구)`, 'error');
  } else if (r === 'dp') {
    const doublePlayOuts = Math.min(2, 3 - gs.outs);
    gs.outs += doublePlayOuts;
    p.todayStats.IP_out += doublePlayOuts;
    showPitch('병살', 'out');
    const prevBases_dp = [...gs.bases];
    const res = advRunners(gs.bases, 'dp'); gs.bases = res.bases;
    updateBasesUI(gs.bases);
    popBases(gs.bases, prevBases_dp);
    addLog(`⛔ ${formatPlayerName(b.name)} 병살 (${n}구)`, 'out');
  } else {
    gs.outs = Math.min(gs.outs + 1, 3);
    p.todayStats.IP_out++;
    showPitch('범타', 'out');
    addLog(`🔴 ${formatPlayerName(b.name)} 아웃 (${n}구)`, 'out');
  }
  if (typeof SS !== 'undefined' && typeof recordMatchupHistory === 'function') {
    recordMatchupHistory(p, b, r, (b.todayStats.RBI || 0) - rbiBeforePA);
  }
  gs.isTop ? gs.awayOrder++ : gs.homeOrder++;
  updateTodayStats();
}

function addRuns(n) {
  if (!n) return;
  const i = gs.inning - 1;
  if (gs.isTop) {
    if (gs.innings.away[gs.inning - 1] === undefined) gs.innings.away[gs.inning - 1] = 0;
    gs.awayScore += n;
    gs.innings.away[gs.inning - 1] += n;
  } else {
    if (gs.innings.home[gs.inning - 1] === undefined) gs.innings.home[gs.inning - 1] = 0;
    gs.homeScore += n;
    gs.innings.home[gs.inning - 1] += n;
  }
  document.getElementById('min-h-score').textContent = gs.homeScore;
  document.getElementById('min-a-score').textContent = gs.awayScore;
  updateSbUI();
}

async function endHalf() {
  const prevInningText = `${gs.inning}회 ${gs.isTop ? '초' : '말'}`;
  const prevTeam = gs.isTop ? gs.awayTeam : gs.homeTeam;
  let nextInningText = "";

  // 1. 내부 상태만 먼저 변경 (UI 업데이트는 애니메이션 중간으로 예약)
  gs.outs = 0; gs.bases = [null, null, null];
  gs.balls = 0; gs.strikes = 0; gs.currentPA = null;

  const updateUI = () => {
    updateGameUI();
    updateSbUI();
    updateLnpUI();
    updateSituationBar();
  };

  if (gs.isTop) {
    // 초 → 말 공수 교대
    gs.isTop = false;
    gs.innings.home[gs.inning - 1] = 0;
    nextInningText = `${gs.inning}회 말`;
    if (gs.inning >= 9 && gs.homeScore > gs.awayScore) { await endGame(); return; }

    // 이제부터 원정 투수가 던지므로 원정 투수 교체 여부를 검사
    // (이 호출이 없으면 checkChange가 홈 투수만 보게 되어 원정 투수는 완투하게 됨)
    checkChange();
    await doInningEffect(prevInningText, nextInningText, prevTeam, gs.homeTeam, updateUI);
    addLog(`── ${gs.inning}회 말 시작 ──`, '');
  } else {
    // 말 → 다음 회 초 공수 교대
    gs.isTop = true;
    gs.inning++;
    nextInningText = `${gs.inning}회 초`;
    if (gs.inning > 9) {
      if (gs.homeScore === gs.awayScore) {
        const _maxInn = (typeof SS !== 'undefined' && SS.phase === 'postseason') ? 999 : 11;
        if (gs.inning > _maxInn) { await endGame(); return; }
        gs.isExtra = true;
        showExtraBanner(gs.inning);
        gs.innings.away[gs.inning - 1] = 0;
        addLog(`── ⚡ ${gs.inning}회 연장전 시작! ──`, 'ext');
      } else {
        await endGame(); return;
      }
    } else {
      gs.innings.away[gs.inning - 1] = 0;
    }

    checkChange();
    await doInningEffect(prevInningText, nextInningText, prevTeam, gs.awayTeam, updateUI);
    addLog(`── ${gs.inning}회 초 시작 ──`, '');
  }
}

// midInning=true면 이닝 도중(타석 종료 시점) 판정.
// 이닝 중에는 완전히 무너진 경우에만 강판한다. 이 경로가 없으면 3아웃이 나올 때까지
// 교체가 불가능해, 지친 투수가 얻어맞을수록 adjERA가 올라 더 얻어맞는 폭주가 발생한다.
function checkChange(midInning = false) {
  const isHomePitching = gs.isTop;
  const p = isHomePitching ? gs.curHP : gs.curAP;
  const s = calcStamina(p);
  const scoreDiff = isHomePitching
    ? (gs.homeScore - gs.awayScore)
    : (gs.awayScore - gs.homeScore);
  const allPitchers = isHomePitching ? gs.homePitchers : gs.awayPitchers;
  const needChange = midInning
    ? (s < 15 || p.pitchCount > 110)
    : (s < 30 || (gs.inning >= 6 && p.pitchCount > 80) || (gs.inning >= 9 && p.isStarter));

  // 내 팀 투수는 수동 플레이 중엔 "선수 교체" 버튼으로 직접 결정하도록 자동 교체 대상에서 제외.
  // 즉시 시뮬레이션(simTurbo)처럼 사람이 개입하지 않을 때는 내 팀도 자동 교체 대상에 포함.
  const pitchingTeamKor = isHomePitching ? gs.homeTeam : gs.awayTeam;
  const isMyPitching = typeof SS !== 'undefined' && SS.myTeamKor === pitchingTeamKor;
  const allowAutoSub = !isMyPitching || simTurbo;

  if (needChange && allowAutoSub) {
    if (gs.isExtra) allPitchers.forEach(pp => { if (!pp.isStarter) pp.usedToday = false; });
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

async function endGame() {
  gs.gameOver = true;
  stopPlay();
  if (typeof clearGameState === 'function') clearGameState(); // 즉시 저장된 게임 삭제 (12이닝 재시작 방지)

  await doGameOverEffect();
  const hKor = gs.homeTeam;
  const aKor = gs.awayTeam;
  const homeWins = gs.homeScore > gs.awayScore;
  const awayWins = gs.awayScore > gs.homeScore;
  document.getElementById('go-score').innerHTML = `
    <div class="gos-line">
      <span class="gos-team${homeWins ? ' gos-team-winner' : ''}" ${teamColorStyle(hKor)}>${hKor}</span>
      <span class="gos-score">${gs.homeScore}</span>
      <span class="gos-colon">:</span>
      <span class="gos-score">${gs.awayScore}</span>
      <span class="gos-team${awayWins ? ' gos-team-winner' : ''}" ${teamColorStyle(aKor)}>${aKor}</span>
    </div>
  `;
  if (gs.isExtra) {
    // 실제 종료된 이닝 계산: 초 공격 시작 전(0아웃, 해당이닝 득점없음)이면 이전 이닝 종료임
    let lastInn = gs.inning;
    if (gs.isTop && gs.outs === 0 && (gs.innings.away[gs.inning - 1] === undefined)) {
      lastInn = gs.inning - 1;
    }
    document.getElementById('go-ext-label').innerHTML =
      `<span class="go-ext-badge">${lastInn}회 연장전 종료</span>`;
  }
  buildFinalScoreboard();
  buildMVP();
  buildBoxScore();
  // ── 시즌 모드 훅 ──
  if (typeof onSeasonGameEnd === 'function' && gs._seasonGame) {
    onSeasonGameEnd(gs.homeScore, gs.awayScore);
    document.getElementById('go-season-btn').style.display = 'inline-block';
    document.getElementById('go-restart-btn').style.display = 'none';
  } else {
    document.getElementById('go-season-btn').style.display = 'none';
    document.getElementById('go-restart-btn').style.display = 'inline-block';
  }
  document.getElementById('game-over').classList.add('show');
  fitGosLine();
}

// ═══════════════════════════════════════════════════════
//  결과 화면 빌더
// ═══════════════════════════════════════════════════════

// "팀명 점수 : 점수 팀명"이 화면 좌우 폭을 최대한 채우면서도 한 줄을 넘지 않도록
// 기준 크기에서 실측한 너비를 기반으로 목표 폭에 맞는 글자 크기를 역산한다.
// .gos-line은 inline-flex(내용에 맞춰 축소)라서 scrollWidth가 실제 내용 너비를 그대로 보여준다.
// (width:100%인 블록이었다면 내용이 더 좁아도 scrollWidth가 컨테이너 너비 아래로 못 내려가
//  "이미 꽉 찼다"고 착각해 확대가 전혀 일어나지 않는다.)
function fitGosLine() {
  const line = document.querySelector('.gos-line');
  if (!line) return;
  const targetWidth = line.parentElement.clientWidth;
  if (!targetWidth) return;
  const minFs = 18, maxFs = 84, probeFs = 40;
  line.style.fontSize = probeFs + 'px';
  const probeWidth = line.scrollWidth;
  if (!probeWidth) return;
  let fs = Math.floor(probeFs * (targetWidth / probeWidth));
  fs = Math.max(minFs, Math.min(maxFs, fs));
  line.style.fontSize = fs + 'px';
  while (line.scrollWidth > targetWidth && fs > minFs) {
    fs -= 1;
    line.style.fontSize = fs + 'px';
  }
}

function buildFinalScoreboard() {
  const t = document.getElementById('final-scoreboard');
  const maxInn = Math.max(9, gs.isTop ? gs.inning - 1 : gs.inning);
  let h = `<tr><th>팀</th>`;
  for (let i = 1; i <= maxInn; i++) h += `<th class="${i > 9 ? 'ext-cell' : ''}">${i}</th>`;
  h += '<th class="u-accent">R</th></tr>';
  ['away', 'home'].forEach(side => {
    const team = side === 'away' ? gs.awayTeam : gs.homeTeam;
    const score = side === 'away' ? gs.awayScore : gs.homeScore;
    h += `<tr><td class="tc2" ${teamColorStyle(team)}>${team}</td>`;
    for (let i = 0; i < maxInn; i++) {
      const v = gs.innings[side][i];
      h += `<td class="${i >= 9 ? 'ext-cell' : ''}">${v || 0}</td>`;
    }
    h += `<td class="tot2">${score}</td></tr>`;
  });
  t.innerHTML = h;
}

function buildTeamBoxHtml(side) {
  const lineup = side === 'away' ? gs.awayLineup : gs.homeLineup;
  const pitchers = side === 'away' ? gs.awayPitchers : gs.homePitchers;
  const team = side === 'away' ? gs.awayTeam : gs.homeTeam;

  let bh = `<div class="bs-section">
    <div class="bs-title"><span ${teamColorStyle(team)}>${team}</span> 타선</div>
    <table class="bs-table">
      <tr><th>타자</th><th>타석</th><th>안타</th><th>홈런</th><th>타점</th><th>삼진</th><th>볼넷</th><th>도루</th></tr>`;
  let totPA = 0, totH = 0, totHR = 0, totRBI = 0, totK = 0, totBB = 0, totSB = 0;
  lineup.forEach(p => {
    const ts = p.todayStats;
    const hi = ts.H >= 2 || ts.HR >= 1 || ts.RBI >= 2;
    bh += `<tr class="${hi ? 'highlight' : ''}">
      <td>${formatPlayerName(p.name)}</td><td>${ts.PA}</td><td>${ts.H}</td>
      <td>${ts.HR || 0}</td><td>${ts.RBI || 0}</td><td>${ts.K || 0}</td><td>${ts.BB || 0}</td><td>${ts.SB || 0}</td>
    </tr>`;
    totPA += ts.PA; totH += ts.H; totHR += ts.HR || 0; totRBI += ts.RBI || 0; totK += ts.K || 0; totBB += ts.BB || 0; totSB += ts.SB || 0;
  });
  bh += `<tr class="bs-total">
    <td>합계</td><td>${totPA}</td><td>${totH}</td><td>${totHR}</td><td>${totRBI}</td><td>${totK}</td><td>${totBB}</td><td>${totSB}</td>
  </tr></table></div>`;

  let ph = `<div class="bs-section">
    <div class="bs-title"><span ${teamColorStyle(team)}>${team}</span> 투수</div>
    <table class="bs-table">
      <tr><th>투수</th><th>이닝</th><th>투구수</th><th>안타</th><th>볼넷</th><th>삼진</th><th>실점</th></tr>`;
  pitchers.filter(p => p.todayStats && p.todayStats.IP_out > 0).forEach(p => {
    const ts = p.todayStats;
    const ip = (ts.IP_out / 3).toFixed(1);
    ph += `<tr>
      <td>${formatPlayerName(p.name)}</td><td>${ip}</td><td>${p.pitchCount || 0}</td>
      <td>${ts.H || 0}</td><td>${ts.BB || 0}</td><td>${ts.K || 0}</td><td>${ts.R || 0}</td>
    </tr>`;
  });
  ph += `</table></div>`;

  return bh + ph;
}

function buildBoxScore() {
  const wrap = document.getElementById('boxscore-wrap');
  const mySide = getMySide();

  wrap.innerHTML = `
    <div class="bs-tabs">
      <div class="bs-tab${mySide === 'home' ? ' active' : ''}" id="bs-tab-home" ${teamTabStyle(gs.homeTeam)} onclick="switchBoxTab('home')">${gs.homeTeam}</div>
      <div class="bs-tab${mySide === 'away' ? ' active' : ''}" id="bs-tab-away" ${teamTabStyle(gs.awayTeam)} onclick="switchBoxTab('away')">${gs.awayTeam}</div>
    </div>
    <div class="bs-tab-panel" id="bs-panel-home" style="display:${mySide === 'home' ? '' : 'none'}">${buildTeamBoxHtml('home')}</div>
    <div class="bs-tab-panel" id="bs-panel-away" style="display:${mySide === 'away' ? '' : 'none'}">${buildTeamBoxHtml('away')}</div>
  `;
}

function switchBoxTab(side) {
  document.getElementById('bs-tab-home').classList.toggle('active', side === 'home');
  document.getElementById('bs-tab-away').classList.toggle('active', side === 'away');
  document.getElementById('bs-panel-home').style.display = side === 'home' ? '' : 'none';
  document.getElementById('bs-panel-away').style.display = side === 'away' ? '' : 'none';
}

function buildMVP() {
  const body = document.getElementById('mvp-body');
  if (!body) return;
  body.innerHTML = '';

  const winner = gs.homeScore > gs.awayScore ? 'home' : (gs.awayScore > gs.homeScore ? 'away' : 'draw');
  const candidates = [];

  // 타자 후보
  [...gs.homeLineup, ...gs.awayLineup].forEach(p => {
    const ts = p.todayStats;
    const score = (ts.H || 0) * 1.5 + (ts.HR || 0) * 4.5 + (ts.RBI || 0) * 2.0 + (ts.BB || 0) * 0.8 + (ts.SB || 0) * 1.2 - (ts.K || 0) * 0.3;
    const isWinner = (winner === 'home' && gs.homeLineup.includes(p)) || (winner === 'away' && gs.awayLineup.includes(p));
    candidates.push({ player: p, score: score + (isWinner ? 5 : 0), type: 'hitter', team: gs.homeLineup.includes(p) ? gs.homeTeam : gs.awayTeam });
  });

  // 투수 후보
  [...gs.homePitchers, ...gs.awayPitchers].forEach(p => {
    if (!p.todayStats || p.todayStats.IP_out === 0) return;
    const ts = p.todayStats;
    const ip = ts.IP_out / 3;
    const score = (ip * 3.5) + (ts.K * 1.5) - (ts.R * 3.0) - (ts.H * 0.8) - (ts.BB * 0.8);
    const isWinner = (winner === 'home' && gs.homePitchers.includes(p)) || (winner === 'away' && gs.awayPitchers.includes(p));
    candidates.push({ player: p, score: score + (isWinner ? 10 : 0), type: 'pitcher', team: gs.homePitchers.includes(p) ? gs.homeTeam : gs.awayTeam });
  });

  candidates.sort((a, b) => b.score - a.score);
  const mvp = candidates[0];

  if (mvp) {
    const p = mvp.player;
    const ts = p.todayStats;
    let statsHtml = '';
    if (mvp.type === 'hitter') {
      statsHtml = `<span>${ts.PA}</span>타석 <span>${ts.H}</span>안타 ${ts.HR ? `<span>${ts.HR}</span>홈런 ` : ''}<span>${ts.RBI}</span>타점`;
    } else {
      const ip = (ts.IP_out / 3).toFixed(1);
      statsHtml = `<span>${ip}</span>이닝 <span>${ts.K}</span>탈삼진 <span>${ts.R}</span>실점 <span>${p.pitchCount}</span>구`;
    }

    body.innerHTML = `
      <div class="mvp-card overall-mvp">
        <div class="mvp-tag" ${teamColorStyle(mvp.team)}>${mvp.team}</div>
        <div class="mvp-name">${formatPlayerName(p.name)}</div>
        <div class="mvp-stats">${statsHtml}</div>
      </div>
    `;
  }
}

// ═══════════════════════════════════════════════════════
//  UI 업데이트
// ═══════════════════════════════════════════════════════

function updateBatUI(b) {
  const nameEl = document.getElementById('b-name');
  nameEl.textContent = formatPlayerName(b.name);
  // 프로필 툴팁 사용 안 함

  const pitcher = (gs && gs.curHP && gs.curAP) ? (gs.isTop ? gs.curHP : gs.curAP) : null;
  const pl = pitcher ? calcPlatoon(b.hand, pitcher.hand) : null;
  const platoonTag = (pl && pl.advantage === 'batter')
    ? `<span class="edge-tag edge-tag-left">유리</span>` : '';

  const bHandKR = b.hand === 'L' ? '좌' : '우';
  document.getElementById('b-info').innerHTML = `${bHandKR}타${platoonTag}`;
  // 타자 체력: PA 기반 (9타석 기준, 최소 20%)
  const bPA = (b.todayStats && b.todayStats.PA) || 0;
  const bStam = Math.max(20, 100 - bPA * (80 / 9));
  const bStamFill = document.getElementById('b-stamina-fill');
  const bStamPct = document.getElementById('b-stamina-pct');
  if (bStamFill) {
    bStamFill.style.width = bStam + '%';
    bStamFill.style.background = bStam > 70 ? 'var(--accent3)' : bStam > 40 ? 'var(--accent)' : 'var(--accent2)';
  }
  if (bStamPct) bStamPct.textContent = Math.round(bStam) + '%';
  updateTodayStats();
}

function updatePitUI(p) {
  const nameEl = document.getElementById('p-name');
  nameEl.textContent = formatPlayerName(p.name);
  // 프로필 툴팁 사용 안 함

  let batter = null;
  if (gs) {
    const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
    const order = gs.isTop ? gs.awayOrder : gs.homeOrder;
    if (lineup && lineup.length > 0) {
      batter = lineup[order % lineup.length];
    }
  }

  const plPit = batter ? calcPlatoon(batter.hand, p.hand) : null;
  const platoonTagPit = (plPit && plPit.advantage === 'pitcher')
    ? `<span class="edge-tag edge-tag-right">유리</span>` : '';

  const pHandKR = p.hand === 'L' ? '좌' : '우';
  document.getElementById('p-team').innerHTML = `${platoonTagPit}${pHandKR}투`;
  updateStamUI(p);
  const badge = document.getElementById('p-role-badge');
  const role = p.role || 'middle';
  if (badge) {
    badge.textContent = { starter: '선발', middle: '중간계투', closer: '마무리' }[role] || '계투';
    badge.className = 'pitcher-role-badge ' + ({ starter: 'role-starter', middle: 'role-middle', closer: 'role-closer' }[role] || 'role-middle');
  }
}

function updateStamUI(p) {
  const s = calcStamina(p);
  document.getElementById('stamina-fill').style.width = s + '%';
  document.getElementById('stamina-fill').style.background = s > 70 ? 'var(--accent3)' : s > 40 ? 'var(--accent)' : 'var(--accent2)';
  document.getElementById('stamina-pct').textContent = Math.round(s) + '%';
}

// ── 선수 정보 팝업 (능력치 / 맞대결 기록) ──
function getDisplayedBatter() {
  if (!gs) return null;
  if (gs.currentPA && gs.currentPA.batter) return gs.currentPA.batter;
  const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
  const order = gs.isTop ? gs.awayOrder : gs.homeOrder;
  return (lineup && lineup.length) ? lineup[order % lineup.length] : null;
}
function getDisplayedPitcher() {
  if (!gs) return null;
  if (gs.currentPA && gs.currentPA.pitcher) return gs.currentPA.pitcher;
  return gs.isTop ? gs.curHP : gs.curAP;
}

function showPlayerPopup(title, bodyHtml) {
  document.getElementById('player-popup-title').textContent = title;
  document.getElementById('player-popup-body').innerHTML = bodyHtml;
  document.getElementById('player-popup').style.display = 'flex';
}
function closePlayerPopup() {
  document.getElementById('player-popup').style.display = 'none';
}
window.closePlayerPopup = closePlayerPopup;

// 이름 탭 → 현재 투수 vs 현재 타자 맞대결(시즌 누적) 기록 + 두 선수 능력치 팝업
window.openMatchupPopup = function () {
  const batter = getDisplayedBatter(), pitcher = getDisplayedPitcher();
  if (!batter || !pitcher) return;
  const title = `${formatPlayerName(pitcher.name)} vs ${formatPlayerName(batter.name)}`;

  const key = `${pitcher.name}_${pitcher.team}__${batter.name}_${batter.team}`;
  const m = (typeof SS !== 'undefined' && SS.matchupHistory) ? SS.matchupHistory[key] : null;
  const matchupBody = (!m || !m.PA)
    ? `<div class="player-popup-empty">이번 시즌 맞대결 기록이 없습니다 (첫 상대)</div>`
    : (() => {
      const avg = m.AB > 0 ? (m.H / m.AB).toFixed(3) : '-.---';
      return `
        <div class="player-popup-row"><span>타석</span><span class="v">${m.PA}</span></div>
        <div class="player-popup-row"><span>타수</span><span class="v">${m.AB}</span></div>
        <div class="player-popup-row"><span>안타</span><span class="v">${m.H}</span></div>
        <div class="player-popup-row"><span>홈런</span><span class="v">${m.HR}</span></div>
        <div class="player-popup-row"><span>볼넷</span><span class="v">${m.BB}</span></div>
        <div class="player-popup-row"><span>삼진</span><span class="v">${m.K}</span></div>
        <div class="player-popup-row"><span>타점</span><span class="v">${m.RBI}</span></div>
        <div class="player-popup-row"><span>맞대결 타율</span><span class="v">${avg}</span></div>`;
    })();

  const body = `
    <div class="player-popup-section-title">맞대결 기록</div>
    ${matchupBody}
    <div class="player-popup-section-title">${formatPlayerName(pitcher.name)} (투수)</div>
    <div class="player-popup-row"><span>ERA</span><span class="v">${pitcher.ERA.toFixed(2)}</span></div>
    <div class="player-popup-row"><span>K/9</span><span class="v">${pitcher.K9.toFixed(1)}</span></div>
    <div class="player-popup-row"><span>WHIP</span><span class="v">${pitcher.WHIP.toFixed(2)}</span></div>
    <div class="player-popup-row"><span>BB/9</span><span class="v">${pitcher.BB9.toFixed(1)}</span></div>
    <div class="player-popup-section-title">${formatPlayerName(batter.name)} (타자)</div>
    <div class="player-popup-row"><span>AVG</span><span class="v">${batter.AVG.toFixed(3)}</span></div>
    <div class="player-popup-row"><span>HR</span><span class="v">${batter.HR}</span></div>
    <div class="player-popup-row"><span>RBI</span><span class="v">${Math.round(batter.RBI)}</span></div>
    <div class="player-popup-row"><span>OPS</span><span class="v">${(batter.ops || 0).toFixed(3)}</span></div>`;
  showPlayerPopup(title, body);
};

function updateCntUI(b, s) {
  ['b0', 'b1', 'b2'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.className = 'sbo-dot' + (i < b ? ' ab' : '');
  });
  ['s0', 's1'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.className = 'sbo-dot' + (i < s ? ' as' : '');
  });
  ['o0', 'o1'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.className = 'sbo-dot' + (gs && i < gs.outs ? ' ao' : '');
  });
}

let pitchTimeout = null;
function showPitch(text, type) {
  const area = document.getElementById('last-pitch-area');
  if (pitchTimeout) { clearTimeout(pitchTimeout); pitchTimeout = null; }
  if (!text) { area.innerHTML = ''; return; }
  const cls = {
    ball: 'badge-ball', strike: 'badge-strike', foul: 'badge-foul',
    hit: 'badge-hit', out: 'badge-out', hr: 'badge-hr',
    walk: 'badge-walk', k: 'badge-k', steal: 'badge-steal',
    bunt: 'badge-bunt', ext: 'badge-ext',
    fineplay: 'badge-fineplay', error: 'badge-error',
  }[type] || '';
  area.innerHTML = `<span class="pitch-badge ${cls}">${text}</span>`;
  pitchTimeout = setTimeout(() => { area.innerHTML = ''; }, 1000);
}

function addLog(msg, type) {
  const el = document.getElementById('game-log');
  const d = document.createElement('div');
  d.className = 'log-entry';
  const inn = `${gs.inning}${gs.isTop ? '초' : '말'}`;
  d.innerHTML = `<span class="log-inn">${inn}</span><span class="log-msg ${type}">${msg}</span>`;
  el.prepend(d);
}

function updateGameUI() {
  if (!gs) return;
  updateBasesUI(gs.bases);
  updateCntUI(gs.balls || 0, gs.strikes || 0);

  const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
  const order = gs.isTop ? gs.awayOrder : gs.homeOrder;
  const pitcher = gs.isTop ? gs.curHP : gs.curAP;
  const batter = lineup[order % lineup.length];

  if (pitcher) updatePitUI(pitcher);
  if (batter) updateBatUI(batter);

  updateTodayStats();
}

function updateBasesUI(bases) {
  [1, 2, 3].forEach((b, i) => {
    const r = document.getElementById(`runner-${b}`);
    const base = document.getElementById(`base-${b}`);
    if (bases[i]) {
      if (r) { r.setAttribute('fill', '#ffffff'); r.removeAttribute('stroke'); }
      if (base) base.setAttribute('fill', '#f5a623');
    } else {
      if (r) { r.setAttribute('fill', 'transparent'); r.removeAttribute('stroke'); }
      if (base) base.setAttribute('fill', '#4a5468');
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
        if (ts.H > 0) parts.push(ts.H + '안' + (ts.HR ? ' ' + ts.HR + 'HR' : ''));
        else if (ts.BB > 0) parts.push('볼넷');
        else if (ts.K > 0) parts.push('K');
        else parts.push('0안');
        if (ts.SB > 0) parts.push(ts.SB + '도');
      }
      const ttxt = ts.PA > 0 ? parts.join(' ') : '-';
      d.innerHTML = `<span class="lr-num">${i + 1}</span><span class="lr-pos">${p.pos || '-'}</span><span class="lr-name">${formatPlayerName(p.name)}</span><span class="lr-avg">${p.AVG.toFixed(3)}</span><span class="lr-today ${todayCls}">${ts.PA}타${ts.PA > 0 ? '/' + ttxt : ''}</span>`;
      el.appendChild(d);
    });
  }
  render(gs.homeLineup, gs.homeOrder, 'home-lineup');
  render(gs.awayLineup, gs.awayOrder, 'away-lineup');
  render(gs.homeLineup, gs.homeOrder, 'mobile-home-lineup');
  render(gs.awayLineup, gs.awayOrder, 'mobile-away-lineup');
}

function updateSbUI() {
  const t = document.getElementById('scoreboard');
  const ht = document.getElementById('header-scoreboard');
  if (!gs) {
    // 게임 데이터가 없는 경우 초기화 상태 유지 (index.html의 initHeaderScoreboard와 동일 로직)
    return;
  }

  // 메인 화면 점수판 (스크롤 가능)
  if (t) {
    const maxInn = Math.min(gs.inning, 12);
    let h = `<tr><th>팀</th>`;
    for (let i = 1; i <= maxInn; i++) h += `<th class="${i === gs.inning ? 'ci' : ''}">${i}</th>`;
    h += '<th class="tot">R</th></tr>';
    ['away', 'home'].forEach(side => {
      const team = side === 'away' ? gs.awayTeam : gs.homeTeam;
      const score = side === 'away' ? gs.awayScore : gs.homeScore;
      h += `<tr><td class="tc">${team}</td>`;
      for (let i = 0; i < maxInn; i++) {
        const v = gs.innings[side][i];
        h += `<td class="${i + 1 === gs.inning ? 'ci' : ''}">${v !== undefined ? v : ''}</td>`;
      }
      h += `<td class="tot">${score}</td></tr>`;
    });
    t.innerHTML = h;
  }

  // 헤더 고정 점수판 (1~9회 고정)
  if (ht) {
    // 9회 이상(연장)일 경우 동적으로 늘리거나 9회까지만 표시할지 결정 (여기서는 9회 고정 또는 필요시 확장)
    const displayInn = Math.max(9, gs.inning);
    let hh = `<tr><th>팀</th>`;
    for (let i = 1; i <= displayInn; i++) hh += `<th class="${i === gs.inning ? 'current-inn' : ''}">${i}</th>`;
    hh += '<th class="tot">R</th></tr>';
    ['away', 'home'].forEach(side => {
      const team = side === 'away' ? gs.awayTeam : gs.homeTeam;
      const score = side === 'away' ? gs.awayScore : gs.homeScore;
      hh += `<tr><td class="tc" ${teamColorStyle(team)}>${team}</td>`;
      for (let i = 0; i < displayInn; i++) {
        const v = gs.innings[side][i];
        hh += `<td class="${i + 1 === gs.inning ? 'current-inn' : ''}">${v !== undefined ? v : ''}</td>`;
      }
      hh += `<td class="tot">${score}</td></tr>`;
    });
    ht.innerHTML = hh;
  }

  // 최소화 모드 공격팀 하이라이트 + 팀 컬러
  const abox = document.getElementById('min-a-box');
  const hbox = document.getElementById('min-h-box');
  if (abox && hbox) {
    abox.classList.toggle('attacking', gs.isTop);
    hbox.classList.toggle('attacking', !gs.isTop);
    setTeamColorVars(abox, gs.awayTeam);
    setTeamColorVars(hbox, gs.homeTeam);
  }
}

function updateSituationBar() {
  if (!gs) return;
  const risp = isRISP(gs.bases);
  const batter = gs.isTop ? gs.awayLineup[gs.awayOrder % 9] : gs.homeLineup[gs.homeOrder % 9];
  const sitInn = document.getElementById('sit-inning');
  if (sitInn) sitInn.textContent = `${gs.inning}회 ${gs.isTop ? '초' : '말'}${gs.isExtra ? '⚡' : ''}`;
  const sitRisp = document.getElementById('sit-risp');
  if (sitRisp) sitRisp.textContent = risp ? '있음' : '-';
  const sitRispAvg = document.getElementById('sit-risp-avg');
  if (sitRispAvg) sitRispAvg.textContent = risp ? (batter.AVG + 0.02).toFixed(3) : batter.AVG.toFixed(3);
  const sitSteal = document.getElementById('sit-steal');
  if (sitSteal) sitSteal.textContent = gs.bases[0] && !gs.bases[1] ? '가능' : '-';
  const sitBunt = document.getElementById('sit-bunt');
  if (sitBunt) sitBunt.textContent = (batter.SAC / Math.max(batter.G, 1) > 0.05 && gs.outs < 2 && gs.bases[0]) ? '가능' : '-';
}

// trace: decidePAResult가 남긴 lastCalcTrace (steps 배열). 실제 판정에 쓰인 값을 그대로 표시한다.
function updateFml(trace) {
  const el = document.getElementById('formula-calc');
  if (!el) return;
  if (!trace || !trace.steps || !trace.steps.length) {
    el.innerHTML = `<div class="fr"><span class="fv">계산 기록 없음</span></div>`;
    return;
  }
  el.innerHTML = trace.steps.map((s, i) => {
    const isLast = i === trace.steps.length - 1;
    return `<div class="fr${isLast ? ' fr-final' : ''}"><span class="fk">${s.label}</span><span class="fv">${s.value}</span></div>`;
  }).join('');
}

function updateTodayStats() {
  if (!gs) return;
  const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
  const order = gs.isTop ? gs.awayOrder : gs.homeOrder;
  const b = lineup[order % lineup.length];
  const p = gs.isTop ? gs.curHP : gs.curAP;

  if (b) {
    const ts = b.todayStats || {};
    document.getElementById('ts-pa').textContent = ts.PA || 0;
    document.getElementById('ts-h').textContent = ts.H || 0;
    document.getElementById('ts-hr').textContent = ts.HR || 0;
    document.getElementById('ts-rbi').textContent = ts.RBI || 0;
    document.getElementById('ts-k').textContent = ts.K || 0;
    document.getElementById('ts-bb').textContent = ts.BB || 0;
  }

  if (p) {
    const tsP = p.todayStats || {};
    const ip = ((tsP.IP_out || 0) / 3).toFixed(1);
    document.getElementById('ts-p-pc').textContent = p.pitchCount || 0;
    document.getElementById('ts-p-ip').textContent = ip;
    document.getElementById('ts-p-rer').textContent = `${tsP.R || 0}/${tsP.ER || 0}`;
    document.getElementById('ts-p-k').textContent = tsP.K || 0;
    document.getElementById('ts-p-h').textContent = tsP.H || 0;
    document.getElementById('ts-p-bb').textContent = tsP.BB || 0;
  }
}

// ═══════════════════════════════════════════════════════
//  재생 제어
// ═══════════════════════════════════════════════════════

function togglePlay(forceState) {
  isPlaying = (forceState !== undefined) ? forceState : !isPlaying;
  const btn = document.getElementById('play-btn');
  if (btn) btn.textContent = isPlaying ? '⏸ 정지' : '▶ 재생';

  const gPlayBtn = document.getElementById('game-play-btn');
  const gPlayLabel = document.getElementById('game-play-label');
  if (gPlayBtn) {
    gPlayBtn.classList.toggle('playing', isPlaying);
    if (gPlayLabel) gPlayLabel.textContent = isPlaying ? '정지' : '진행';
  }

  if (isPlaying) {
    schedNext();
  } else {
    clearTimeout(playTimer); playTimer = null;
    if (typeof saveGameState === 'function') saveGameState();
  }
}

let progressTimer = null;
let isLongPress = false;

function setupGameControls() {
  const btn = document.getElementById('game-play-btn');
  if (!btn) return;

  // 시스템 컨텍스트 메뉴 및 선택 방지
  btn.style.userSelect = 'none';
  btn.style.webkitTouchCallout = 'none';
  btn.addEventListener('contextmenu', e => e.preventDefault());

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (isPlaying) {
      // 이미 진행 중이면 즉시 정지
      togglePlay(false);
      isLongPress = false;
      return;
    }
    isLongPress = false;
    progressTimer = setTimeout(() => {
      isLongPress = true;
      togglePlay(true);
    }, 300);
    btn.setPointerCapture(e.pointerId);
  });

  btn.addEventListener('pointerup', (e) => {
    clearTimeout(progressTimer);
    if (!isLongPress && !isPlaying) {
      // 진행 중이 아니었고, 롱프레스도 아니었다면 1구 진행
      stepOnce();
    }
    isLongPress = false;
  });

  btn.addEventListener('pointercancel', () => {
    clearTimeout(progressTimer);
    isLongPress = false;
  });
}
async function schedNext() {
  if (!isPlaying || (gs && gs.gameOver)) return;
  await processOnePitch();
  if (isPlaying && (!gs || !gs.gameOver)) {
    playTimer = setTimeout(schedNext, SPEED_DELAYS[speedIdx]);
  }
}
function stopPlay() {
  togglePlay(false);
}
async function stepOnce() {
  if (isAnimating) return;
  if (isPlaying) stopPlay();
  await processOnePitch();
  if (typeof saveGameState === 'function') saveGameState();
}
function showSetup() { stopPlay(); document.getElementById('setup-screen').style.display = 'flex'; }
function restartGame() { document.getElementById('game-over').classList.remove('show'); showSetup(); }
function getMySide() {
  const myTeamKor = (typeof SS !== 'undefined' && SS.myTeamKor) ? SS.myTeamKor : gs.homeTeam;
  return gs.homeTeam === myTeamKor ? 'home' : 'away';
}

function getHitterStaminaForSub(h, teamCode) {
  if (h.defPos === '포수' || h.position === 'C' || h.pos === 'C') {
    const key = `${h.name}_${teamCode}`;
    const cf = (typeof SS !== 'undefined' && SS.catcherFatigue) ? SS.catcherFatigue[key] : null;
    return cf ? Math.round(cf.stamina) : 100;
  }
  return 100;
}

function getCurrentBatterForSide(side) {
  const lineup = side === 'home' ? gs.homeLineup : gs.awayLineup;
  const order = side === 'home' ? gs.homeOrder : gs.awayOrder;
  return { lineup, order, idx: order % lineup.length, batter: lineup[order % lineup.length] };
}

function getNextOpponentBatter() {
  const lineup = gs.isTop ? gs.awayLineup : gs.homeLineup;
  const order = gs.isTop ? gs.awayOrder : gs.homeOrder;
  return lineup[order % lineup.length];
}

function getSubContext() {
  const side = getMySide();
  const isBatting = (side === 'home' && !gs.isTop) || (side === 'away' && gs.isTop);
  return { side, isBatting };
}

function renderSubCardHtml(item, idx, onclickName, isPitcher) {
  const simpleCard = !!isPitcher || item.simpleCard;
  const badgeClass = item.badgeClass || '';
  const stamina = item.stamina == null ? null : Math.max(0, Math.min(100, Math.round(item.stamina)));
  const stColor = stamina == null ? 'var(--accent3)' : stamina >= 80 ? 'var(--accent3)' : stamina >= 50 ? 'var(--accent)' : 'var(--accent2)';
  return `
    <div class="sub-card${simpleCard ? ' is-pitcher' : ''}" onclick="${onclickName}('${item.name.replace(/'/g, "\\'")}')">
      ${simpleCard ? '' : `<div class="sub-rank">${idx + 1}</div>`}
      <div class="sub-main">
        <div class="sub-name-row">
          <div class="sub-name">${formatPlayerName(item.name)}</div>
          ${simpleCard ? '' : `<div class="sub-badge ${badgeClass}">${item.badge}</div>`}
        </div>
        <div class="sub-meta">${item.meta}</div>
        ${simpleCard ? '' : `<div class="sub-reason">${item.reason}</div>`}
        ${stamina == null ? '' : `<div class="sub-stamina"><div class="sub-stamina-fill" style="width:${stamina}%;background:${stColor}"></div></div>`}
      </div>
      ${simpleCard ? '' : `<div class="sub-score">${Math.round(item.score)}</div>`}
    </div>`;
}

function fmtNum(v, digits, fallback = '-') {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : fallback;
}

function renderHitterSubCandidates(side) {
  const team = side === 'home' ? gs.homeTeam : gs.awayTeam;
  const teamCode = getTeamCode(team) || team;
  const { lineup } = getCurrentBatterForSide(side);
  const lineupNames = new Set(lineup.map(p => p.name));
  const usedSetName = side === 'home' ? 'homeUsedHitters' : 'awayUsedHitters';
  if (!gs[usedSetName]) gs[usedSetName] = new Set();
  const pitcher = gs.isTop ? gs.curHP : gs.curAP;
  const pool = getTeamHitters(team)
    .filter(h => !lineupNames.has(h.name) && !gs[usedSetName].has(h.name));

  const candidates = pool.map(h => {
    const pl = calcPlatoon(h.hand, pitcher.hand);
    const stamina = getHitterStaminaForSub(h, teamCode);
    let score = (h.ops || 0) * 100 + (h.AVG || 0) * 35;
    if (pl.advantage === 'batter') score += 18; else score -= 10;
    score += (stamina - 70) * 0.18;
    if (isRISP(gs.bases)) score += (h.RBI || 0) * 0.035 + (h.obp || 0) * 12;
    if (gs.inning >= 7 && Math.abs(gs.homeScore - gs.awayScore) <= 2) score += (h.HR || 0) * 0.18 + (h.slg || 0) * 10;
    const hand = h.hand === 'L' ? '좌타' : '우타';
    const pos = h.pos || POS_KOR_MAP[h.defPos] || h.defPos || h.position || 'DH';
    return {
      name: h.name,
      score,
      stamina,
      simpleCard: true,
      meta: `${hand} · ${pos} · AVG ${fmtNum(h.AVG, 3)} · OPS ${fmtNum(h.ops, 3)} · HR ${h.HR || 0}`,
    };
  }).sort((a, b) => b.score - a.score);

  const titleEl = document.getElementById('sub-sheet-title');
  const contextEl = document.getElementById('sub-sheet-context');
  const listEl = document.getElementById('sub-candidate-list');
  if (titleEl) titleEl.textContent = '타자 교체';
  if (contextEl) contextEl.innerHTML = '';
  if (listEl) listEl.innerHTML = candidates.length
    ? candidates.map((item, idx) => renderSubCardHtml(item, idx, 'changeHitterInGame')).join('')
    : '<div class="sub-empty">교체 가능한 타자가 없습니다.</div>';
}

function scorePitcherRoleFit(p, inning, scoreDiff) {
  const absDiff = Math.abs(scoreDiff);
  if (inning >= 9 && scoreDiff > 0 && scoreDiff <= 3) return p.role === 'closer' ? 28 : p.role === 'middle' ? 10 : -8;
  if (inning >= 8 && absDiff <= 3) return p.role === 'closer' ? 18 : p.role === 'middle' ? 14 : -6;
  if (inning >= 6) return p.role === 'middle' ? 18 : p.role === 'closer' ? 6 : -4;
  return p.role === 'middle' ? 12 : p.role === 'starter' ? 2 : -6;
}

function renderPitcherSubCandidates(side) {
  const teamCode = side === 'home' ? getTeamCode(gs.homeTeam) || gs.homeTeam : getTeamCode(gs.awayTeam) || gs.awayTeam;
  const pitchers = side === 'home' ? gs.homePitchers : gs.awayPitchers;
  const curP = side === 'home' ? gs.curHP : gs.curAP;
  const scoreDiff = side === 'home' ? gs.homeScore - gs.awayScore : gs.awayScore - gs.homeScore;
  const nextBatter = getNextOpponentBatter();
  // 선발 포함 전체 교체 후보 풀 (현재 투수 및 오늘 등판한 투수 제외)
  const pool = pitchers.filter(p => p.name !== curP.name && !p.usedToday);

  const candidates = pool.map(p => {
    const isStarter = !!p.isStarter;
    const fatigueInfo = (typeof getPitcherFatigueInfo === 'function')
      ? getPitcherFatigueInfo(p, teamCode, isStarter)
      : { staminaPct: Math.round(calcStamina(p)), stColor: 'var(--accent3)' };
    const stamina = fatigueInfo.staminaPct;
    const pl = nextBatter ? calcPlatoon(nextBatter.hand, p.hand) : null;
    const roleFit = scorePitcherRoleFit(p, gs.inning, scoreDiff);
    let score = roleFit + Math.max(0, 6 - p.ERA) * 8 + Math.max(0, 1.6 - p.WHIP) * 18 + (p.K9 || 0) * 1.4 - (p.BB9 || 0) * 1.2;
    score += (stamina - 60) * 0.45;
    if (pl && pl.advantage === 'pitcher') score += 10;
    if (pl && pl.advantage === 'batter') score -= 7;
    if (stamina < 30) score -= 80;
    const roleLabel = { starter: '선발', middle: '계투', closer: '마무리' }[p.role] || '투수';
    const hand = p.hand === 'L' ? '좌투' : '우투';
    return {
      name: p.name,
      score,
      stamina,
      isStarter,
      meta: `${hand} · ${roleLabel} · ERA ${fmtNum(p.ERA, 2)} · WHIP ${fmtNum(p.WHIP, 2)} · K/9 ${fmtNum(p.K9, 1)}`,
    };
  }).filter(item => item.stamina >= 30)
    .sort((a, b) => b.score - a.score);

  // 그룹 분리
  const starters = candidates.filter(c => c.isStarter);
  const relievers = candidates.filter(c => !c.isStarter);

  function renderGroup(label, list) {
    if (!list.length) return '';
    const cards = list.map((item, idx) => renderSubCardHtml(item, idx, 'changePitcherInGame', true)).join('');
    return `<div class="sub-group-label">${label}</div>${cards}`;
  }

  const titleEl = document.getElementById('sub-sheet-title');
  const contextEl = document.getElementById('sub-sheet-context');
  const listEl = document.getElementById('sub-candidate-list');
  if (titleEl) titleEl.textContent = '투수 교체';
  if (contextEl) contextEl.innerHTML = '';
  if (listEl) {
    const html = renderGroup('계투 · 마무리', relievers) + renderGroup('선발 투수', starters);
    listEl.innerHTML = html || '<div class="sub-empty">교체 가능한 투수가 없습니다.</div>';
  }
}

window.openSubstitutionModal = function () {
  if (!gs || gs.gameOver) return;
  stopPlay();
  const modal = document.getElementById('in-game-sub-modal');
  const listEl = document.getElementById('sub-candidate-list');
  if (modal) modal.style.display = 'block';
  if (listEl) listEl.innerHTML = '<div class="sub-empty">교체 후보를 계산 중입니다.</div>';
  try {
    const { side, isBatting } = getSubContext();
    if (isBatting) renderHitterSubCandidates(side);
    else renderPitcherSubCandidates(side);
  } catch (err) {
    console.error('선수교체 후보 렌더링 실패:', err);
    if (listEl) listEl.innerHTML = '<div class="sub-empty">교체 후보를 표시하지 못했습니다.<br>콘솔 오류를 확인해 주세요.</div>';
  }
};

window.closeSubModal = function () {
  document.getElementById('in-game-sub-modal').style.display = 'none';
};

window.openMobileLineupSheet = function () {
  if (!gs) return;
  updateLnpUI();
  switchMobileLineupTab(gs.isTop ? 'away' : 'home');
  const sheet = document.getElementById('mobile-lineup-sheet');
  if (sheet) sheet.classList.add('open');
};

window.closeMobileLineupSheet = function () {
  const sheet = document.getElementById('mobile-lineup-sheet');
  if (sheet) sheet.classList.remove('open');
};

window.switchMobileLineupTab = function (side) {
  const isAway = side === 'away';
  const awayTab = document.getElementById('mobile-away-lineup-tab');
  const homeTab = document.getElementById('mobile-home-lineup-tab');
  const awayList = document.getElementById('mobile-away-lineup');
  const homeList = document.getElementById('mobile-home-lineup');
  if (awayTab) awayTab.classList.toggle('active', isAway);
  if (homeTab) homeTab.classList.toggle('active', !isAway);
  if (awayList) awayList.classList.toggle('active', isAway);
  if (homeList) homeList.classList.toggle('active', !isAway);
};

window.changePitcherInGame = function (name) {
  if (!confirm(`${name} 투수로 교체하시겠습니까?`)) return;

  const { side } = getSubContext();
  const isMyHome = side === 'home';
  const myPitchers = isMyHome ? gs.homePitchers : gs.awayPitchers;
  const np = myPitchers.find(p => p.name === name);

  if (np) {
    np.pitchCount = 0;
    np.usedToday = true;
    if (isMyHome) gs.curHP = np; else gs.curAP = np;

    const roleLabel = { starter: '선발', middle: '중간계투', closer: '마무리' }[np.role] || '계투';
    addLog(`🔄 투수교체(사용자) → ${formatPlayerName(np.name)} [${roleLabel}] (ERA ${np.ERA})`, 'change');
    if (gs.currentPA) {
      gs.currentPA.pitcher = np;
      if (gs.currentPA.pidx === 0) {
        gs.currentPA.pr = decidePAResult(gs.currentPA.batter, np, gs.bases, gs.inning, gs.outs, getCurrentDefenseLineup());
        gs.currentPA.seq = buildSeq(gs.currentPA.pr);
        gs.currentPA.trace = lastCalcTrace;
        updateFml(gs.currentPA.trace);
      }
    }
    updatePitUI(np);
    updateGameUI();
    closeSubModal();
    alert(`${formatPlayerName(np.name)} 투수로 교체되었습니다.`);
  }
};

window.changeHitterInGame = function (name) {
  const { side, isBatting } = getSubContext();
  if (!isBatting) return;

  const team = side === 'home' ? gs.homeTeam : gs.awayTeam;
  const { lineup, idx, batter: oldBatter } = getCurrentBatterForSide(side);
  const usedSetName = side === 'home' ? 'homeUsedHitters' : 'awayUsedHitters';
  if (!gs[usedSetName]) gs[usedSetName] = new Set();

  const lineupNames = new Set(lineup.map(p => p.name));
  const np = getTeamHitters(team).find(h => h.name === name && !lineupNames.has(h.name) && !gs[usedSetName].has(h.name));
  if (!np) return;
  if (!confirm(`${formatPlayerName(oldBatter.name)} 대신 ${formatPlayerName(np.name)} 타자로 교체하시겠습니까?`)) return;

  np.pos = oldBatter.pos || POS_KOR_MAP[np.defPos] || 'PH';
  np.order = oldBatter.order;
  np.usedToday = true;
  oldBatter.usedToday = true;
  gs[usedSetName].add(oldBatter.name);
  gs[usedSetName].add(np.name);
  lineup[idx] = np;

  const pitcher = gs.isTop ? gs.curHP : gs.curAP;
  if (gs.currentPA && gs.currentPA.batter && gs.currentPA.batter.name === oldBatter.name) {
    gs.currentPA.batter = np;
    if (gs.currentPA.pidx === 0) {
      gs.currentPA.pr = decidePAResult(np, pitcher, gs.bases, gs.inning, gs.outs, getCurrentDefenseLineup());
      gs.currentPA.seq = buildSeq(gs.currentPA.pr);
      gs.currentPA.trace = lastCalcTrace;
      updateFml(gs.currentPA.trace);
    }
  }

  addLog(`🔄 대타 교체(사용자) → ${formatPlayerName(oldBatter.name)} 대신 ${formatPlayerName(np.name)}`, 'change');
  updateBatUI(np);
  updateGameUI();
  updateLnpUI();
  closeSubModal();
};

function switchTab(t) {
  document.getElementById('tab-log').classList.toggle('active', t === 'log');
  document.getElementById('tab-formula').classList.toggle('active', t === 'formula');
  document.getElementById('content-log').style.display = t === 'log' ? '' : 'none';
  document.getElementById('content-formula').style.display = t === 'formula' ? '' : 'none';
}

// ── 개발자 모드 (계산식 탭 등 디버그 전용 UI 노출) ──
// 콘솔에서 enableDevMode() / disableDevMode() 로 전환. 기본값은 항상 꺼짐(일반 사용자 미노출).
function isDevMode() {
  try { return localStorage.getItem('kbo_dev_mode') === '1'; } catch (e) { return false; }
}
window.enableDevMode = function () {
  try { localStorage.setItem('kbo_dev_mode', '1'); } catch (e) {}
  location.reload();
};
window.disableDevMode = function () {
  try { localStorage.removeItem('kbo_dev_mode'); } catch (e) {}
  location.reload();
};
function applyDevModeVisibility() {
  const tabFormula = document.getElementById('tab-formula');
  if (tabFormula) tabFormula.style.display = isDevMode() ? '' : 'none';
}
if (typeof document !== 'undefined' && document.getElementById) {
  applyDevModeVisibility();
}

if (typeof globalThis !== 'undefined') {
  globalThis.__KBO_TEST__ = Object.assign(globalThis.__KBO_TEST__ || {}, {
    DB,
    parseCSV,
    parseIP,
    buildHitter,
    buildLineup,
    buildPitcher,
    buildTeamPitchers,
    calcAvgIP,
    advRunners,
    calcPlatoon,
    decidePAResult,
    buildDefenseStats,
    calcFielderDefenseScore,
    calcTeamDefenseImpact,
    formatPlayerName,
    loadYearCSV,
    loadYearData,
  });
}
