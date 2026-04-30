
// ═══════════════════════════════════════════════════════
//  KBO 시뮬레이터 — 시즌 엔진 (season.js)
//  engine.js 이후에 로드됨
// ═══════════════════════════════════════════════════════

'use strict';

// ── 시즌 전역 상태 ──────────────────────────────────────
const SS = {
  year:      null,   // '2025'
  myTeam:    null,   // 'doosan' (영문 코드)
  myTeamKor: null,   // '두산'
  teams:     [],     // ['kia','samsung', ...]
  nameKor:   {},     // { doosan:'두산', ... }
  schedule:  [],     // 144경기 배열
  gameIdx:   0,      // 현재 경기 인덱스
  standings: {},     // { doosan:{ w,l,d,rs,ra }, ... }
  playerStats:{},    // { '선수명_팀': { PA,H,HR,RBI,... } }
  phase:     'season', // 'season' | 'postseason' | 'done'
  // 투수 피로도: { '선수명_팀': { lastGame, consecDays, type } }
  // lastGame: 마지막 등판 경기 인덱스
  // consecDays: 연속 등판 일수 (불펜)
  // type: 'starter' | 'reliever'
  pitcherFatigue: {},
};

// ── localStorage 키 ──────────────────────────────────────
const LS_KEY      = 'kbo_season_v1';
const LS_GAME_KEY = 'kbo_game_state_v1';   // 게임 진행 중 저장용

// 게임 진행 중 상태 저장 (gs 전체 + 시즌 컨텍스트)
function saveGameState() {
  if (!gs || !gs._seasonGame) return;
  try {
    // gs 객체에서 직렬화 가능한 부분만 추출
    const snapshot = {
      homeTeam:    gs.homeTeam,
      awayTeam:    gs.awayTeam,
      homeScore:   gs.homeScore,
      awayScore:   gs.awayScore,
      inning:      gs.inning,
      isTop:       gs.isTop,
      isExtra:     gs.isExtra,
      outs:        gs.outs,
      bases:       gs.bases,
      homeOrder:   gs.homeOrder,
      awayOrder:   gs.awayOrder,
      innings:     gs.innings,
      gamePitches: gs.gamePitches,
      totalAB:     gs.totalAB,
      gameOver:    gs.gameOver,
      _seasonGame: gs._seasonGame,
      // 라인업·투수 todayStats 보존
      homeLineupStats: gs.homeLineup.map(p => ({ name: p.name, todayStats: p.todayStats, pitchCount: p.pitchCount || 0 })),
      awayLineupStats: gs.awayLineup.map(p => ({ name: p.name, todayStats: p.todayStats, pitchCount: p.pitchCount || 0 })),
      homePitcherStats: gs.homePitchers.map(p => ({ name: p.name, pitchCount: p.pitchCount || 0, usedToday: p.usedToday || false })),
      awayPitcherStats: gs.awayPitchers.map(p => ({ name: p.name, pitchCount: p.pitchCount || 0, usedToday: p.usedToday || false })),
      curHPName: gs.curHP ? gs.curHP.name : null,
      curAPName: gs.curAP ? gs.curAP.name : null,
    };
    localStorage.setItem(LS_GAME_KEY, JSON.stringify(snapshot));
  } catch(e) { console.warn('게임 저장 실패', e); }
}

// 저장된 게임 상태 여부 확인
function hasSavedGame() {
  try {
    const raw = localStorage.getItem(LS_GAME_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    // 시즌 컨텍스트와 일치하는지 확인
    return data._seasonGame !== undefined;
  } catch(e) { return false; }
}

// 게임 저장 상태 복원 (gs에 todayStats·pitchCount 덮어쓰기)
function restoreGameState() {
  try {
    const raw = localStorage.getItem(LS_GAME_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);

    // gs 기본 필드 복원
    gs.homeScore   = snap.homeScore;
    gs.awayScore   = snap.awayScore;
    gs.inning      = snap.inning;
    gs.isTop       = snap.isTop;
    gs.isExtra     = snap.isExtra;
    gs.outs        = snap.outs;
    gs.bases       = snap.bases;
    gs.homeOrder   = snap.homeOrder;
    gs.awayOrder   = snap.awayOrder;
    gs.innings     = snap.innings;
    gs.gamePitches = snap.gamePitches;
    gs.totalAB     = snap.totalAB;
    gs._seasonGame = snap._seasonGame;

    // 라인업 todayStats 복원
    snap.homeLineupStats.forEach(s => {
      const p = gs.homeLineup.find(p => p.name === s.name);
      if (p) { p.todayStats = s.todayStats; p.pitchCount = s.pitchCount; }
    });
    snap.awayLineupStats.forEach(s => {
      const p = gs.awayLineup.find(p => p.name === s.name);
      if (p) { p.todayStats = s.todayStats; p.pitchCount = s.pitchCount; }
    });

    // 투수 pitchCount·usedToday 복원
    snap.homePitcherStats.forEach(s => {
      const p = gs.homePitchers.find(p => p.name === s.name);
      if (p) { p.pitchCount = s.pitchCount; p.usedToday = s.usedToday; }
    });
    snap.awayPitcherStats.forEach(s => {
      const p = gs.awayPitchers.find(p => p.name === s.name);
      if (p) { p.pitchCount = s.pitchCount; p.usedToday = s.usedToday; }
    });

    // 현재 투수 복원
    if (snap.curHPName) gs.curHP = gs.homePitchers.find(p => p.name === snap.curHPName) || gs.curHP;
    if (snap.curAPName) gs.curAP = gs.awayPitchers.find(p => p.name === snap.curAPName) || gs.curAP;

    return true;
  } catch(e) { console.warn('게임 복원 실패', e); return false; }
}

// 게임 저장 삭제 (경기 종료 시)
function clearGameState() {
  try { localStorage.removeItem(LS_GAME_KEY); } catch(e) {}
}

function saveSeasonState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      year:            SS.year,
      myTeam:          SS.myTeam,
      myTeamKor:       SS.myTeamKor,
      teams:           SS.teams,
      nameKor:         SS.nameKor,
      schedule:        SS.schedule,
      gameIdx:         SS.gameIdx,
      standings:       SS.standings,
      playerStats:     SS.playerStats,
      phase:           SS.phase,
      pitcherFatigue:  SS.pitcherFatigue,
      starterRotation: SS.starterRotation,
    }));
  } catch(e) { console.warn('시즌 저장 실패', e); }
}

function loadSeasonState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    Object.assign(SS, data);
    return true;
  } catch(e) { return false; }
}

function clearSeasonState() {
  localStorage.removeItem(LS_KEY);
}


// ═══════════════════════════════════════════════════════
//  투수 피로도 시스템
// ═══════════════════════════════════════════════════════

/**
 * 경기 종료 후 등판한 투수들의 피로도를 기록.
 * @param {Array}  pitchers  - 해당 경기에 등판한 투수 객체 배열
 * @param {string} teamCode  - 영문 팀 코드
 */
function recordPitcherFatigue(pitchers, teamCode) {
  pitchers.forEach(p => {
    if (!p.pitchCount || p.pitchCount === 0) return; // 미등판 제외
    const key  = `${p.name}_${teamCode}`;
    const prev = SS.pitcherFatigue[key];
    const isConsec = prev && (SS.gameIdx - prev.lastGame <= 1);
    SS.pitcherFatigue[key] = {
      lastGame:   SS.gameIdx,
      consecDays: isConsec ? (prev.consecDays || 1) + 1 : 1,
      type:       p.isStarter ? 'starter' : 'reliever',
      pitchCount: p.pitchCount,
    };
  });
}

/**
 * 피로도를 반영한 ERA 보정 계수 반환.
 * 선발: 휴식일 기반 / 불펜: 연속 등판일 기반
 * @param {string} pitcherName
 * @param {string} teamCode
 * @param {boolean} isStarter
 * @returns {number} ERA 보정 계수 (1.0 = 정상, 1.5 = 50% 악화)
 */
function getFatigueMult(pitcherName, teamCode, isStarter) {
  const key  = `${pitcherName}_${teamCode}`;
  const f    = SS.pitcherFatigue[key];
  if (!f) return 1.0; // 피로도 기록 없음 = 정상

  const daysSince = SS.gameIdx - f.lastGame; // 마지막 등판 이후 경기 수

  if (isStarter) {
    // 선발: 등판 후 4경기 휴식이 이상적 (5선발 로테이션)
    if (daysSince <= 3) return 99;  // 등판 불가 (99 = 사실상 무한대)
    if (daysSince === 4) return 1.2; // 4일 휴식: 80% 컨디션
    return 1.0;                      // 5일+ 휴식: 정상
  } else {
    // 불펜: 연속 등판일 수에 따라 피로 누적
    if (daysSince > 1) return 1.0;   // 하루라도 쉬면 회복
    const c = f.consecDays || 1;
    if (c >= 3) return 1.5;          // 3일 연속: ERA +50%
    if (c === 2) return 1.3;         // 2일 연속: ERA +30%
    return 1.15;                     // 1일 연속: ERA +15%
  }
}

/**
 * 피로도를 반영해 선발 투수를 선택.
 * 휴식이 충분한 선발 중 ERA 낮은 순으로 선택.
 */
function pickStarterWithFatigue(pitchers, teamCode) {
  const starters = pitchers.filter(p => p.isStarter);
  if (!starters.length) return pitchers[0];
  // 등판 가능한 선발 (휴식 4일 이상)
  const available = starters.filter(p => {
    const mult = getFatigueMult(p.name, teamCode, true);
    return mult < 99;
  });
  const pool = available.length ? available : starters; // 전원 피로 시 어쩔 수 없이 등판
  return pool.sort((a, b) => a.ERA - b.ERA)[Math.floor(Math.random() * Math.min(3, pool.length))];
}

/**
 * 피로도를 반영한 불펜 선택.
 * 연속 등판이 많은 투수는 ERA 보정값이 높아 자연히 후순위.
 */
function selectRelieverWithFatigue(allPitchers, currentPitcher, inning, scoreDiff, teamCode) {
  const pool = allPitchers.filter(p =>
    !p.isStarter && p.name !== currentPitcher.name && !p.usedToday
  );
  if (!pool.length) return null;

  // 피로도 반영 ERA로 정렬
  const withFatigue = pool.map(p => ({
    ...p,
    adjERAFatigue: p.ERA * getFatigueMult(p.name, teamCode, false),
  })).sort((a, b) => a.adjERAFatigue - b.adjERAFatigue);

  if (inning >= 9 && scoreDiff > 0 && scoreDiff <= 3) {
    const closer = withFatigue.filter(p => p.adjERAFatigue < 3.5);
    if (closer.length) { const p = closer[0]; p.usedToday = true; return p; }
  }
  if (inning === 8) {
    const setup = withFatigue.filter(p => p.adjERAFatigue < 4.0);
    if (setup.length) { const p = setup[0]; p.usedToday = true; return p; }
  }
  if (inning >= 6) {
    const mid = withFatigue.filter(p => p.adjERAFatigue < 5.0);
    if (mid.length) { const p = mid[0]; p.usedToday = true; return p; }
  }
  const p = withFatigue[0]; p.usedToday = true; return p;
}

// ── 일정 생성 ────────────────────────────────────────────
// KBO 정규시즌 (3연전 5번 + 1경기 1번 체제 = 144경기, 총 홈72/원정72 보장)
function buildSchedule(teams, myTeam) {
  const N = teams.length;
  const cycles = [];
  const fixedTeam = teams[0];
  const rotTeams = teams.slice(1);

  // 1. 6개의 Circle Method 사이클 생성 (사이클당 9회전)
  for (let c = 0; c < 6; c++) {
    const rounds = [];
    for (let r = 0; r < 9; r++) {
      const g = [];
      let h1 = fixedTeam, a1 = rotTeams[r];
      if (r % 2 === 1) { const tmp = h1; h1 = a1; a1 = tmp; }
      g.push({ home: h1, away: a1 });

      for (let i = 1; i <= 4; i++) {
        let t1 = rotTeams[(r + i) % 9], t2 = rotTeams[(r + 9 - i) % 9];
        if (i % 2 === 1) g.push({ home: t1, away: t2 });
        else g.push({ home: t2, away: t1 });
      }
      rounds.push(g);
    }
    cycles.push(rounds);
  }

  // 2. 1팀 당 총 16경기 시 쌍방향 홈/원정 배정을 위한 기록
  let pairHistory = {};
  for(let i = 0; i < N; i++) for(let j = 0; j < N; j++) pairHistory[`${teams[i]}_${teams[j]}`] = 0;

  const turns = [];
  // 3. 3연전 5번 = 첫 5개의 사이클은 각각 3연전으로 복제 (C0~C4)
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 9; r++) {
      const matches = cycles[c][r].map(m => {
        let h = m.home, a = m.away;
        if (pairHistory[`${h}_${a}`] > pairHistory[`${a}_${h}`]) {
          const tmp = h; h = a; a = tmp;
        } else if (pairHistory[`${h}_${a}`] === pairHistory[`${a}_${h}`] && c % 2 === 1) {
          const tmp = h; h = a; a = tmp;
        }
        pairHistory[`${h}_${a}`] += 3;
        return { home: h, away: a };
      });
      // 동일한 대진으로 3개의 턴 연속 생성 (화수목 / 금토일)
      for (let i = 0; i < 3; i++) turns.push(matches.map(m => ({...m})));
    }
  }

  // 홈 경기 횟수 체크 (잔여 1경기 1회 분배 시 전체 72경기 목표)
  let homeCount = {};
  teams.forEach(t => homeCount[t] = 0);
  turns.forEach(turn => turn.forEach(m => homeCount[m.home]++));

  // 4. 마지막 1경기 1회 (C5) 홈 분배를 잔여 할당에 역순 매칭 (Greedy)
  let c5Matches = [];
  for (let r = 0; r < 9; r++) {
    cycles[5][r].forEach(m => c5Matches.push({...m}));
  }
  
  c5Matches.forEach(m => {
     let h = m.home, a = m.away;
     if (homeCount[h] > homeCount[a]) { const tmp = h; h = a; a = tmp; }
     else if (homeCount[h] === homeCount[a] && pairHistory[`${h}_${a}`] > pairHistory[`${a}_${h}`]) { const tmp = h; h = a; a = tmp; }
     m.home = h; m.away = a;
     homeCount[h]++;
     pairHistory[`${h}_${a}`]++;
  });

  // 미세 불일치 72경기 완전 동기화 스왑 패스 (Max Flow 보정)
  let loops = 0;
  while (loops++ < 1000) {
     let over = teams.find(t => homeCount[t] > 72);
     let under = teams.find(t => homeCount[t] < 72);
     if (!over || !under) break;
     
     let parent = {}, q = [over], found = false;
     parent[over] = null;
     while(q.length > 0 && !found) {
       let curr = q.shift();
       for (let m of c5Matches) {
         if (m.home === curr) {
           let nxt = m.away;
           if (parent[nxt] === undefined) {
             parent[nxt] = { node: curr, match: m };
             if (nxt === under) { found = true; break; }
             q.push(nxt);
           }
         }
       }
     }
     if (found) {
       let curr = under;
       while(curr !== over) {
         let p = parent[curr];
         const tmp = p.match.home; p.match.home = p.match.away; p.match.away = tmp;
         curr = p.node;
       }
       homeCount[over]--;
       homeCount[under]++;
     } else break;
  }

  for (let r = 0; r < 9; r++) turns.push(c5Matches.slice(r*5, r*5+5).map(m => ({...m})));

  turns.forEach(turnGames => {
    const myIdx = turnGames.findIndex(g => g.home === myTeam || g.away === myTeam);
    if (myIdx >= 0 && myIdx < turnGames.length - 1) turnGames.push(turnGames.splice(myIdx, 1)[0]);
  });

  const schedule = [];
  let gameNo = 1;
  turns.forEach((turnArray, turnIdx) => {
    turnArray.forEach(g => {
      schedule.push({ home: g.home, away: g.away, result: null, gameNo: gameNo++, turn: turnIdx + 1 });
    });
  });

  return schedule;
}

// ── 순위표 초기화 ────────────────────────────────────────
function initStandings(teams) {
  const st = {};
  teams.forEach(t => { st[t] = { w: 0, l: 0, d: 0, rs: 0, ra: 0 }; });
  return st;
}

// ── 순위 계산 ────────────────────────────────────────────
function getSortedStandings() {
  return Object.entries(SS.standings)
    .map(([team, s]) => {
      const games = s.w + s.l + s.d;
      const pct   = games > 0 ? s.w / (s.w + s.l) : 0;
      return { team, ...s, games, pct };
    })
    .sort((a, b) => {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (a.team === SS.myTeam) return -1; // 내 팀 특혜
      if (b.team === SS.myTeam) return 1;
      // 그 외 동률이면 다승
      return b.w - a.w;
    });
}

function getGamesBehind(sorted) {
  if (!sorted.length) return [];
  const leader = sorted[0];
  return sorted.map((t, i) => {
    if (i === 0) return { ...t, gb: '-' };
    const gb = ((leader.w - t.w) + (t.l - leader.l)) / 2;
    return { ...t, gb: gb % 1 === 0 ? gb : gb.toFixed(1) };
  });
}

// ── 빠른 경기 시뮬 (타석 단위로 즉시 계산) ──────────────
function simGameFast(homeTeam, awayTeam) {
  const hH = DB.hitters.filter(r => r.team === SS.nameKor[homeTeam]).map(buildHitter).sort((a,b) => b.G - a.G);
  const hA = DB.hitters.filter(r => r.team === SS.nameKor[awayTeam]).map(buildHitter).sort((a,b) => b.G - a.G);
  const pH = DB.pitchers.filter(r => r.team === SS.nameKor[homeTeam]).map(buildPitcher);
  const pA = DB.pitchers.filter(r => r.team === SS.nameKor[awayTeam]).map(buildPitcher);

  if (!hH.length || !hA.length) return { homeScore: 0, awayScore: 0 };

  const lH = buildLineup(hH), lA = buildLineup(hA);
  let homeScore = 0, awayScore = 0;
  let curHP = pickStarterWithFatigue(pH, homeTeam),
      curAP = pickStarterWithFatigue(pA, awayTeam);
  let homeOrder = 0, awayOrder = 0;
  const innings = { home: [], away: [] };

  for (let inning = 1; inning <= 9; inning++) {
    // 말 먼저: 원정 공격 (초)
    for (const side of ['top', 'bot']) {
      const isTop   = side === 'top';
      const lineup  = isTop ? lA : lH;
      const pitcher = isTop ? curHP : curAP;
      let order     = isTop ? awayOrder : homeOrder;
      let outs = 0, bases = [null, null, null], runs = 0;

      while (outs < 3) {
        const batter = lineup[order % lineup.length];
        order++;
        const pr = decidePAResult(batter, pitcher, bases, inning, outs);
        if (pr === 'k' || pr === 'out') {
          outs++;
        } else if (pr === 'dp') {
          outs = Math.min(outs + 2, 3);
          bases = [null, bases[1], bases[2]];
        } else if (pr === 'bb') {
          const res = advRunners(bases, 'bb'); bases = res.bases; runs += res.scored;
        } else {
          const res = advRunners(bases, pr);   bases = res.bases; runs += res.scored;
        }
      }

      // 투수 구수 간이 업데이트
      pitcher.pitchCount = (pitcher.pitchCount || 0) + 15;

      if (isTop) {
        awayScore += runs; awayOrder = order;
        innings.away.push(runs);
        // 9회 말 홈팀 리드 시 콜드게임
        if (inning === 9 && homeScore > awayScore) break;
      } else {
        homeScore += runs; homeOrder = order;
        innings.home.push(runs);
        // 9회 말 진행 중 역전 시 끝내기
        if (inning === 9 && homeScore > awayScore) break;
      }
    }
    // 투수 교체 간이 처리
    if (curHP.pitchCount > 80) {
      const rel = selectRelieverWithFatigue(pH, curHP, 6, homeScore - awayScore, homeTeam);
      if (rel) { curHP = rel; curHP.pitchCount = 0; }
    }
    if (curAP.pitchCount > 80) {
      const rel = selectRelieverWithFatigue(pA, curAP, 6, awayScore - homeScore, awayTeam);
      if (rel) { curAP = rel; curAP.pitchCount = 0; }
    }
    // 연장 로직 (포스트시즌 무제한, 정규 11회까지)
    const _maxInns = (typeof SS !== 'undefined' && SS.phase === 'postseason') ? 999 : 11;
    if (inning >= 9 && homeScore === awayScore && inning < _maxInns) {
      // 계속 진행됨
    } else if (inning >= 9 && homeScore !== awayScore) {
       // 승부 결정됨 (simGameFast 특성상 이닝 단위로만 간이 체크하므로)
       break;
    } else if (inning >= _maxInns) {
       break; // 최대 연장 도달 시 종료 (무승부 가능)
    }
  }

  // 등판 투수 피로도 기록
  [curHP, ...pH.filter(p => p.usedToday)].forEach(p => {
    if (p) { p.pitchCount = p.pitchCount || 1; recordPitcherFatigue([p], homeTeam); }
  });
  [curAP, ...pA.filter(p => p.usedToday)].forEach(p => {
    if (p) { p.pitchCount = p.pitchCount || 1; recordPitcherFatigue([p], awayTeam); }
  });

  return { homeScore, awayScore, innings };
}

// ── 경기 결과를 순위표에 반영 ────────────────────────────
function applyResult(game) {
  const { home, away, result } = game;
  const hs = SS.standings[home], as = SS.standings[away];
  hs.rs += result.homeScore; hs.ra += result.awayScore;
  as.rs += result.awayScore; as.ra += result.homeScore;
  if (result.homeScore > result.awayScore)      { hs.w++; as.l++; }
  else if (result.awayScore > result.homeScore) { as.w++; hs.l++; }
  else                                          { hs.d++; as.d++; }
}

// ── 선수 누적 스탯 기록 ──────────────────────────────────
function recordPlayerStats(lineup, todayStats) {
  lineup.forEach(p => {
    const key = `${p.name}_${p.team}`;
    if (!SS.playerStats[key]) {
      SS.playerStats[key] = { name: p.name, team: p.team, PA:0,H:0,HR:0,RBI:0,K:0,BB:0,SB:0 };
    }
    const s = SS.playerStats[key];
    const ts = p.todayStats;
    s.PA  += ts.PA  || 0; s.H   += ts.H   || 0;
    s.HR  += ts.HR  || 0; s.RBI += ts.RBI || 0;
    s.K   += ts.K   || 0; s.BB  += ts.BB  || 0;
    s.SB  += ts.SB  || 0;
  });
}

// ── 포스트시즌 ───────────────────────────────────────────
// 단계별 시리즈 매치업 반환
function buildPostseason() {
  const sorted = getSortedStandings();
  return {
    wc:  { home: sorted[3].team, away: sorted[4].team, wins: [0,0], games:[], done:false, needed:1, label:'와일드카드' },
    semi:{ home: sorted[2].team, away: null,            wins: [0,0], games:[], done:false, needed:2, label:'준플레이오프' },
    play:{ home: sorted[1].team, away: null,            wins: [0,0], games:[], done:false, needed:3, label:'플레이오프'  },
    ks:  { home: sorted[0].team, away: null,            wins: [0,0], games:[], done:false, needed:4, label:'한국시리즈'  },
  };
}

// 포스트시즌 1경기 시뮬 (직접 플레이 여부 판단 포함)
function simSeriesGame(series, myTeam) {
  const result = simGameFast(series.home, series.away);
  series.games.push(result);
  if (result.homeScore > result.awayScore) series.wins[0]++;
  else if (result.awayScore > result.homeScore) series.wins[1]++;
  // 무승부는 재경기
  if (series.wins[0] >= series.needed) series.done = true;
  if (series.wins[1] >= series.needed) series.done = true;
  return result;
}

// ── 시즌 UI 렌더러 ───────────────────────────────────────
function renderStandingsTable() {
  const sorted = getGamesBehind(getSortedStandings());
  let h = `<table class="standings-table">
    <tr><th>순위</th><th>팀</th><th>승</th><th>패</th><th>무</th><th>승률</th><th>GB</th><th>득점</th><th>실점</th></tr>`;
  
  let currentRank = 1;
  let previousPct = -1;
  let displayedRank = 1;

  sorted.forEach((t, i) => {
    // 동순위 측정
    if (t.pct !== previousPct) {
      displayedRank = currentRank;
    }
    previousPct = t.pct;
    currentRank++;

    const isMine = t.team === SS.myTeam;
    h += `<tr class="${isMine ? 'my-team-row' : ''}">
      <td>${displayedRank}</td>
      <td><b>${SS.nameKor[t.team] || t.team}</b></td>
      <td>${t.w}</td><td>${t.l}</td><td>${t.d}</td>
      <td>${t.pct.toFixed(3)}</td>
      <td>${t.gb}</td>
      <td>${t.rs}</td><td>${t.ra}</td>
    </tr>`;
  });
  h += '</table>';
  return h;
}

let tempGameSetup = { myPitcher: null, myLineup: [], wizardMode: false, currentMyGameIdx: -1 };

function renderTodayGame() {
  const curGame = SS.schedule[SS.gameIdx];
  if (!curGame) return '<div style="color:var(--accent)">시즌 종료</div>';

  const turn = curGame.turn;
  let myGameIdx = -1;
  for (let i = SS.gameIdx; i < SS.schedule.length; i++) {
    if (SS.schedule[i].turn !== turn) break;
    if (SS.schedule[i].home === SS.myTeam || SS.schedule[i].away === SS.myTeam) {
      if (myGameIdx === -1) myGameIdx = i;
    }
  }

  if (myGameIdx !== -1) {
    const game = SS.schedule[myGameIdx];
    const hKor = SS.nameKor[game.home] || game.home;
    const aKor = SS.nameKor[game.away] || game.away;
    // 원정팀 vs 홈팀 순서
    const leftKor  = aKor; // 원정
    const rightKor = hKor; // 홈

    if (tempGameSetup.currentMyGameIdx !== myGameIdx) {
      tempGameSetup = { myPitcher: null, myLineup: [], wizardMode: false, currentMyGameIdx: myGameIdx };
    }

    return `
      <div class="next-game-card my-game">
        <div style="font-size:10px;color:var(--text3);letter-spacing:1px;text-align:center;margin-bottom:4px;">원정 &nbsp;····&nbsp; 홈</div>
        <div class="ng-matchup" style="text-align:center;margin-bottom:0;">${leftKor} <span style="font-size:14px;font-weight:400;color:var(--text3);margin:0 8px">vs</span> ${rightKor}</div>
      </div>`;
  } else {
    return `
      <div class="next-game-card">
        <div class="ng-matchup" style="font-size:20px;color:var(--text2);text-align:center">내 팀 경기 없음</div>
      </div>`;
  }
}

// ── 로스터 편집 로직 ──────────────────────────────────────

function openPitcherModal(isWizard = false) {
  tempGameSetup.wizardMode = isWizard;
  const korName = SS.myTeamKor;
  const pitchers = DB.pitchers.filter(p => p.team === korName).map(buildPitcher);
  
  let html = '';
  pitchers.sort((a, b) => b.isStarter - a.isStarter || a.ERA - b.ERA).forEach((p, idx) => {
     const mult = getFatigueMult(p.name, SS.myTeam, p.isStarter);
     let statusColor = 'var(--text)';
     if (mult >= 99) statusColor = 'var(--accent2)';
     else if (mult > 1) statusColor = 'var(--accent)';
     
     const isSelected = tempGameSetup.myPitcher ? (tempGameSetup.myPitcher.name === p.name) : (idx === 0);
     if (isSelected && !tempGameSetup.myPitcher) tempGameSetup.myPitcher = p;
     
     const isStarterLabel = p.isStarter ? '<span style="color:var(--accent4);border-radius:2px;background:rgba(85,0,0,0.5);font-size:9px;padding:2px 4px;margin-left:4px">선발</span>' : '';

     html += `
       <label style="display:flex;align-items:center;padding:10px;background:var(--bg2);border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'};border-radius:6px;cursor:pointer;">
         <input type="radio" name="temp-pitcher" value="${p.name}" ${isSelected ? 'checked' : ''} onchange="selectTempPitcher('${p.name}')" style="margin-right:10px;">
         <div style="flex:1;">
           <div style="font-weight:700;color:var(--text);font-size:14px;display:flex;align-items:center">${p.name} ${isStarterLabel}</div>
           <div style="font-family:'JetBrains Mono';font-size:11px;color:var(--text2)">ERA: ${p.ERA.toFixed(2)} | IP: ${p.IP.toFixed(1)}</div>
         </div>
         <div style="font-size:11px;color:${statusColor};font-weight:700">${mult >= 99 ? '등판불가' : mult > 1 ? '피로누적' : '정상'}</div>
       </label>`;
  });
  
  document.getElementById('pitcher-list-container').innerHTML = html;
  document.querySelector('#pitcher-modal .btn.primary').textContent = isWizard ? '다음 (타선 설정)' : '적용 완료';
  document.getElementById('pitcher-modal').style.display = 'flex';
}

window.selectTempPitcher = function(name) {
  const pitchers = DB.pitchers.filter(p => p.team === SS.myTeamKor).map(buildPitcher);
  tempGameSetup.myPitcher = pitchers.find(p => p.name === name);
  openPitcherModal(tempGameSetup.wizardMode);
};

window.closePitcherModal = function() {
  document.getElementById('pitcher-modal').style.display = 'none';
};

window.confirmPitcher = function() {
  closePitcherModal();
  if (tempGameSetup.wizardMode) openLineupModal(true);
};

function openLineupModal(isWizard = false) {
  tempGameSetup.wizardMode = isWizard;
  
  if (tempGameSetup.myLineup.length === 0) {
    const hH = DB.hitters.filter(r => r.team === SS.myTeamKor).map(buildHitter).sort((a,b) => b.G - a.G);
    tempGameSetup.myLineup = buildLineup(hH);
  }
  
  renderLineupList();
  document.querySelector('#lineup-modal .btn.primary').textContent = isWizard ? '경기 시작' : '적용 완료';
  document.getElementById('lineup-modal').style.display = 'flex';
}

function renderLineupList() {
  let html = '';
  tempGameSetup.myLineup.forEach((p, idx) => {
     html += `
       <div style="display:flex;align-items:center;padding:8px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;">
         <div style="width:24px;font-family:'Bebas Neue';font-size:18px;color:var(--text2);text-align:center">${idx+1}</div>
         <div style="flex:1;margin-left:8px;">
           <div style="font-weight:700;color:var(--text);font-size:13px;">${p.name} <span style="font-size:10px;color:var(--text2);margin-left:4px;">${p.pos}</span></div>
           <div style="font-family:'JetBrains Mono';font-size:10px;color:var(--text3)">AVG: ${p.AVG.toFixed(3)} | HR: ${p.HR}</div>
         </div>
         <div style="display:flex;flex-direction:column;gap:4px;">
            <button class="btn" style="padding:4px;font-size:10px;background:var(--bg3);border:none" onclick="moveUpLineup(${idx})" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn" style="padding:4px;font-size:10px;background:var(--bg3);border:none" onclick="moveDownLineup(${idx})" ${idx === tempGameSetup.myLineup.length-1 ? 'disabled' : ''}>▼</button>
         </div>
       </div>`;
  });
  document.getElementById('lineup-list-container').innerHTML = html;
}

window.moveUpLineup = function(idx) {
  if (idx <= 0) return;
  const arr = tempGameSetup.myLineup;
  const temp = arr[idx]; arr[idx] = arr[idx-1]; arr[idx-1] = temp;
  arr.forEach((p, i) => p.order = i + 1);
  renderLineupList();
};

window.moveDownLineup = function(idx) {
  const arr = tempGameSetup.myLineup;
  if (idx >= arr.length - 1) return;
  const temp = arr[idx]; arr[idx] = arr[idx+1]; arr[idx+1] = temp;
  arr.forEach((p, i) => p.order = i + 1);
  renderLineupList();
};

window.closeLineupModal = function() {
  document.getElementById('lineup-modal').style.display = 'none';
};

window.confirmLineup = function() {
  closeLineupModal();
  if (tempGameSetup.wizardMode) executeGame();
};

async function executeGame() {
  const myGameIdx = tempGameSetup.currentMyGameIdx;
  if (myGameIdx === -1) return;

  // 앞서 쌓인 해당 턴의 타팀 경기들을 시뮬레이션
  let advanced = false;
  for (let i = SS.gameIdx; i < myGameIdx; i++) {
    const game = SS.schedule[i];
    if (!game.result) {
       game.result = simGameFast(game.home, game.away);
       applyResult(game);
       advanced = true;
    }
  }
  
  SS.gameIdx = myGameIdx;
  if (advanced) {
    saveSeasonState();
  }

  startSeasonGame();
}

function autoTurnGames() {
  const turn = SS.schedule[SS.gameIdx].turn;
  for (let i = SS.gameIdx; i < SS.schedule.length; i++) {
    const game = SS.schedule[i];
    if (game.turn !== turn) break;
    if (!game.result) {
       game.result = simGameFast(game.home, game.away);
       applyResult(game);
    }
    SS.gameIdx = i + 1;
  }
  saveSeasonState();
  refreshSeasonUI();
  showTurnResultsModalForAutoSkipped(turn);
}

function showTurnResultsModalForAutoSkipped(turn) {
  // 별도의 [휴식] 버튼 클릭 시 모달
  const turnGames = SS.schedule.filter(g => g.turn === turn);
  let trs = turnGames.map(g => {
    const h = SS.nameKor[g.home] || g.home;
    const a = SS.nameKor[g.away] || g.away;
    const res = g.result || {homeScore:0, awayScore:0};
    return `<tr><td style="text-align:right">${a}</td><td style="font-weight:700;text-align:center">${res.awayScore} : ${res.homeScore}</td><td style="text-align:left">${h}</td></tr>`;
  }).join('');
  let html = `<div style="text-align:center;">
    <div style="font-size:18px;margin-bottom:12px;font-family:'Black Han Sans'">종료된 경기 결과 (${turn}턴)</div>
    <table class="standings-table" style="font-size:13px;width:100%;margin-bottom:20px;">
      ${trs}
    </table>
    <button class="btn primary" onclick="closeTurnModal()">확인</button>
  </div>`;
  const m = document.getElementById('turn-modal');
  m.querySelector('.turn-modal-inner').innerHTML = html;
  m.style.display = 'flex';
}


// ── 일정 표시 ──────────────────────────────────────────────

let listTurnOffset = 0; // 몇 번째 턴들을 보여줄지 기준

window.changeTurnView = function(delta) {
  listTurnOffset += delta;
  if (listTurnOffset < 0) listTurnOffset = 0;
  const maxTurn = 144;
  if (listTurnOffset * 3 >= maxTurn) listTurnOffset = Math.floor(maxTurn/3) - 1;
  const el = document.getElementById('season-upcoming-turns');
  if (el) el.innerHTML = renderUpcomingTurns();
};

function renderUpcomingTurns() {
  if (!SS.schedule || !SS.schedule.length) return '';
  const myTeam = SS.myTeam;

  const curGame = SS.schedule[Math.min(SS.gameIdx, SS.schedule.length - 1)];
  const actualCurTurn = curGame ? curGame.turn : 144;

  // 5칸 고정: 이전 2턴 ~ 현재 ~ 이후 2턴
  const COLS = 5;
  const half = Math.floor(COLS / 2); // 2
  const colWidthPct = Math.floor(100 / COLS);

  let html = `<div class="weekly-cal" style="margin-bottom:12px;"><div class="wc-grid" style="grid-template-columns:repeat(${COLS},1fr);border-top:none;">`;

  for (let i = -half; i <= half; i++) {
    const turnVal = actualCurTurn + i;

    if (turnVal < 1 || turnVal > 144) {
      html += `<div class="wc-cell" style="min-height:80px;background:var(--panel);"></div>`;
      continue;
    }

    const games = SS.schedule.filter(g => g.turn === turnVal);
    const isToday = turnVal === actualCurTurn;
    const cellClass = 'wc-cell' + (isToday ? ' wc-today' : '');

    html += `<div class="${cellClass}" style="min-height:80px;"><div class="wc-date">T${turnVal}</div>`;

    if (!games.length) {
      html += `<div class="wc-rest" style="font-size:9px">휴식</div></div>`;
      continue;
    }

    let gHtml = `<div style="display:flex;flex-direction:column;gap:2px;width:100%">`;
    games.sort((a,b) => {
      const aMine = (a.home===myTeam||a.away===myTeam)?1:0;
      const bMine = (b.home===myTeam||b.away===myTeam)?1:0;
      return bMine - aMine;
    }).forEach(game => {
      const isMyMatch = (game.home===myTeam||game.away===myTeam);
      const hKor = SS.nameKor[game.home]||game.home;
      const aKor = SS.nameKor[game.away]||game.away;
      const txtColor = isMyMatch ? 'var(--accent)' : 'var(--text2)';
      const bold = isMyMatch ? '700' : '400';

      if (game.result) {
        const hs = game.result.homeScore;
        const as = game.result.awayScore;
        const resultClass = isMyMatch
          ? ((game.home===myTeam&&hs>as)||(game.away===myTeam&&as>hs) ? 'wc-win'
          : (hs===as ? 'wc-draw' : 'wc-loss')) : '';
        gHtml += `<div class="wc-match" style="font-size:8px;color:${txtColor};font-weight:${bold}">${aKor} <span class="${resultClass}" style="font-family:'JetBrains Mono'">${as} vs ${hs}</span> ${hKor}</div>`;
      } else {
        gHtml += `<div class="wc-match" style="font-size:8px;color:${txtColor};font-weight:${bold}">${aKor} vs ${hKor}</div>`;
      }
    });
    gHtml += `</div>`;
    html += `${gHtml}</div>`;
  }

  html += `</div></div>`;
  return html;
}

// ── 턴 결과 모달 ─────────────────────────────────────────
async function showTurnResults(myGameIdx) {
  const myGame = SS.schedule[myGameIdx];
  const myTurn = myGame.turn;

  const turnGames = SS.schedule.filter(g =>
    g.turn === myTurn && g !== myGame
  );

  const results = [];
  for (const game of turnGames) {
    if (game.result) {
      results.push(game);
      continue;
    }
    const hKor = SS.nameKor[game.home];
    const aKor = SS.nameKor[game.away];
    const hasData = DB.hitters.some(h => h.team === hKor) &&
                    DB.hitters.some(h => h.team === aKor);
    if (hasData) {
      game.result = simGameFast(game.home, game.away);
    } else {
      const hs  = Math.floor(Math.random() * 9);
      const as2 = Math.floor(Math.random() * 9);
      game.result = { homeScore: hs, awayScore: as2 };
    }
    applyResult(game);
    results.push(game);
  }

  const myResult  = myGame.result;
  const myHKor    = SS.nameKor[myGame.home];
  const myAKor    = SS.nameKor[myGame.away];
  const myWin     = myResult.homeScore > myResult.awayScore ? myHKor
                  : myResult.awayScore > myResult.homeScore ? myAKor : '무승부';
  const myIsMine  = myGame.home === SS.myTeam ? myHKor : myAKor;

  let otherRows = '';
  results.forEach(g => {
    const hKor = SS.nameKor[g.home];
    const aKor = SS.nameKor[g.away];
    const { homeScore, awayScore } = g.result;
    otherRows += `
      <tr>
        <td style="text-align:right">${aKor}</td>
        <td style="font-weight:700;text-align:center">${awayScore} : ${homeScore}</td>
        <td style="text-align:left">${hKor}</td>
      </tr>`;
  });

  const modal = document.getElementById('turn-modal');
  let html = `<div style="text-align:center;">
    <div style="font-size:18px;margin-bottom:12px;font-family:'Black Han Sans'">종료된 경기 결과 (${myTurn}턴)</div>
    <div style="margin-bottom:8px;font-weight:700;color:var(--accent);font-size:14px;">내 팀: <span style="color:#fff">${myAKor} ${myResult.awayScore} : ${myResult.homeScore} ${myHKor}</span></div>
    <table class="standings-table" style="font-size:13px;width:100%;margin-bottom:20px;">
      ${otherRows}
    </table>
    <button class="btn primary" onclick="closeTurnModal()">확인</button>
  </div>`;
  modal.querySelector('.turn-modal-inner').innerHTML = html;

  modal.style.display = 'flex';
  saveSeasonState();
}

function closeTurnModal() {
  document.getElementById('turn-modal').style.display = 'none';
  refreshSeasonUI();
}
// ── 시즌 종료: 데이터 전체 삭제 ─────────────────────────
function exitSeasonMode() {
  if (!confirm('시즌을 종료하시겠어요?\n저장된 모든 데이터가 삭제됩니다.')) return;
  clearSeasonState();
  clearGameState();
  document.getElementById('season-screen').style.display     = 'none';
  document.getElementById('postseason-screen').style.display = 'none';
  document.getElementById('turn-modal').style.display        = 'none';
  document.getElementById('setup-screen').style.display      = 'flex';
  // 이어하기 버튼 숨기기
  document.getElementById('season-resume-btn').style.display = 'none';
}



// ── 선발 로테이션 초기화 ─────────────────────────────────────
function initStarterRotation() {
  const korName = SS.myTeamKor;
  if (!korName) return;
  const allPitchers = DB.pitchers.filter(p => p.team === korName);
  if (!allPitchers.length) return;

  // 이미 유효한 로테이션이 있으면 유지
  if (SS.starterRotation && SS.starterRotation.length > 0) {
    const validNames = new Set(allPitchers.map(p => p.name));
    SS.starterRotation = SS.starterRotation.filter(n => validNames.has(n));
    if (SS.starterRotation.length > 0) return;
  }

  // 초기화: IP/G >= 4.5 선수를 ERA 순으로 선발 로테이션에 배정
  const naturalStarters = allPitchers
    .filter(p => p.G > 0 && (p.IP / p.G) >= 4.5)
    .sort((a, b) => a.ERA - b.ERA);
  SS.starterRotation = naturalStarters.map(p => p.name);
}

// ── 투수 피로 정보 계산 헬퍼 ─────────────────────────────────
function getPitcherFatigueInfo(p, teamCode, isStarter) {
  const key       = `${p.name}_${teamCode}`;
  const f         = SS.pitcherFatigue[key];
  const mult      = getFatigueMult(p.name, teamCode, isStarter);
  const daysSince = f ? SS.gameIdx - f.lastGame : 99;

  let staminaPct = 100;
  if (mult >= 99) staminaPct = 0;
  else if (mult > 1.0) {
    if (isStarter) {
      staminaPct = daysSince === 4 ? 80 : 30;
    } else {
      if (f && f.consecDays >= 3) staminaPct = 10;
      else if (f && f.consecDays === 2) staminaPct = 50;
      else staminaPct = 80;
    }
  }

  let status = '', statusColor = 'var(--accent3)';
  if (isStarter) {
    if (staminaPct === 0)      { status = '등판불가'; statusColor = 'var(--accent2)'; }
    else if (staminaPct < 100) { status = `휴식 ${daysSince}일`; statusColor = 'var(--accent)'; }
    else                       { status = '정상';       statusColor = 'var(--accent3)'; }
  } else {
    if (staminaPct <= 10)      { status = '3연투';  statusColor = 'var(--accent2)'; }
    else if (staminaPct <= 50) { status = '2연투';  statusColor = 'var(--accent)'; }
    else if (staminaPct <= 80) { status = '1연투';  statusColor = 'var(--accent)'; }
    else                       { status = '정상';   statusColor = 'var(--accent3)'; }
  }

  const stColor = staminaPct > 50 ? 'var(--accent3)' : staminaPct > 0 ? 'var(--accent)' : 'var(--accent2)';
  return { staminaPct, status, statusColor, stColor, mult, daysSince };
}

// ── 내 팀 투수 피로도 현황 렌더 (선발/불펜 분리) ─────────────
function renderFatiguePanel() {
  const teamCode = SS.myTeam;
  const korName  = SS.myTeamKor;
  if (!korName) return '';

  initStarterRotation();

  const allPitchers = DB.pitchers.filter(p => p.team === korName);
  if (!allPitchers.length) return '';

  const rotation = SS.starterRotation || [];

  // 선발 로테이션에 있는 투수 (순서 유지)
  const starters = rotation
    .map(name => allPitchers.find(p => p.name === name))
    .filter(Boolean);

  // 불펜 투수 (로테이션 외)
  const relievers = allPitchers.filter(p => !rotation.includes(p.name));

  // 다음 경기 선발: 로테이션 순서에서 등판 가능한 첫 번째
  let nextStarterName = null;
  for (const p of starters) {
    if (getFatigueMult(p.name, teamCode, true) < 99) { nextStarterName = p.name; break; }
  }
  if (!nextStarterName && starters.length > 0) nextStarterName = starters[0].name;

  // 불펜 정렬: 상태(체력 높은 순) > 역할(마무리 우선) > ERA
  relievers.sort((a, b) => {
    const ia = getPitcherFatigueInfo(a, teamCode, false);
    const ib = getPitcherFatigueInfo(b, teamCode, false);
    if (ib.staminaPct !== ia.staminaPct) return ib.staminaPct - ia.staminaPct;
    const ra = a.ERA < 3.0 ? 0 : a.ERA < 4.0 ? 1 : 2;
    const rb = b.ERA < 3.0 ? 0 : b.ERA < 4.0 ? 1 : 2;
    if (ra !== rb) return ra - rb;
    return a.ERA - b.ERA;
  });

  // ── 선발 로테이션 행 렌더링
  let starterRows = '';
  starters.forEach((p, idx) => {
    const { staminaPct, status, statusColor, stColor } = getPitcherFatigueInfo(p, teamCode, true);
    const isNext    = p.name === nextStarterName;
    const rowBg    = isNext ? 'rgba(245,166,35,.07)' : 'transparent';
    const leftBdr  = isNext ? '3px solid var(--accent)' : '3px solid transparent';
    const nameClr  = isNext ? 'var(--accent)' : 'var(--text)';
    const nextBadge = isNext
      ? `<span style="font-size:9px;background:rgba(245,166,35,.2);color:var(--accent);border:1px solid rgba(245,166,35,.5);border-radius:8px;padding:1px 6px;white-space:nowrap;">다음 선발</span>`
      : '';

    starterRows += `
      <div class="rot-item" data-idx="${idx}"
           style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);background:${rowBg};border-left:${leftBdr};touch-action:none;">
        <div class="rot-handle" style="cursor:grab;color:var(--text3);flex-shrink:0;padding:2px 4px;display:flex;align-items:center;">
          <svg width="14" height="12" viewBox="0 0 16 14" fill="currentColor"><rect y="0" width="16" height="2" rx="1"/><rect y="6" width="16" height="2" rx="1"/><rect y="12" width="16" height="2" rx="1"/></svg>
        </div>
        <div style="font-family:'Bebas Neue';font-size:18px;color:var(--text3);min-width:18px;text-align:center;flex-shrink:0">${idx + 1}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <span style="font-weight:700;font-size:13px;color:${nameClr}">${p.name}</span>
            ${nextBadge}
          </div>
          <div style="font-family:'JetBrains Mono';font-size:10px;color:var(--text3)">ERA ${p.ERA ? p.ERA.toFixed(2) : '-'} · IP ${p.IP ? p.IP.toFixed(1) : 0}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <div style="width:56px;">
            <div style="background:rgba(255,255,255,.08);border-radius:2px;height:7px;overflow:hidden;">
              <div style="background:${stColor};width:${staminaPct}%;height:100%;border-radius:2px;"></div>
            </div>
            <div style="font-size:9px;color:${statusColor};text-align:center;margin-top:2px;">${status}</div>
          </div>
          <button onclick="fatigMoveToReliever('${p.name}')" title="불펜으로 이동"
            style="border:1px solid var(--border2);background:transparent;color:var(--text3);border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;white-space:nowrap;font-family:'Noto Sans KR';">불펜↓</button>
        </div>
      </div>`;
  });

  if (!starterRows) starterRows = `<div style="padding:14px;color:var(--text3);text-align:center;font-size:12px">선발 투수 없음</div>`;

  // ── 불펜 행 렌더링
  let relieverRows = '';
  relievers.forEach(p => {
    const { staminaPct, status, statusColor, stColor } = getPitcherFatigueInfo(p, teamCode, false);
    const roleLabel = p.ERA < 3.0 ? '마무리' : p.ERA < 4.0 ? '셋업' : '계투';
    const roleClr   = p.ERA < 3.0 ? 'var(--accent2)' : p.ERA < 4.0 ? '#f59e0b' : 'var(--text3)';

    relieverRows += `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <span style="font-weight:700;font-size:13px;color:var(--text)">${p.name}</span>
            <span style="font-size:9px;color:${roleClr};border:1px solid ${roleClr};border-radius:8px;padding:1px 5px;">${roleLabel}</span>
          </div>
          <div style="font-family:'JetBrains Mono';font-size:10px;color:var(--text3)">ERA ${p.ERA ? p.ERA.toFixed(2) : '-'} · IP ${p.IP ? p.IP.toFixed(1) : 0}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <div style="width:56px;">
            <div style="background:rgba(255,255,255,.08);border-radius:2px;height:7px;overflow:hidden;">
              <div style="background:${stColor};width:${staminaPct}%;height:100%;border-radius:2px;"></div>
            </div>
            <div style="font-size:9px;color:${statusColor};text-align:center;margin-top:2px;">${status}</div>
          </div>
          <button onclick="fatigMoveToStarter('${p.name}')" title="선발로 이동"
            style="border:1px solid var(--border2);background:transparent;color:var(--text3);border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;white-space:nowrap;font-family:'Noto Sans KR';">선발↑</button>
        </div>
      </div>`;
  });

  if (!relieverRows) relieverRows = `<div style="padding:14px;color:var(--text3);text-align:center;font-size:12px">불펜 투수 없음</div>`;

  return `
    <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px;">
      <div style="padding:9px 14px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--text2);">선발 로테이션</span>
        <span style="font-size:9px;color:var(--text3);">≡ 드래그로 순서 변경</span>
      </div>
      <div id="rotation-list">${starterRows}</div>
    </div>
    <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden;">
      <div style="padding:9px 14px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--text2);">불펜</span>
        <span style="font-size:9px;color:var(--text3);">상태 · 역할 · 체력순</span>
      </div>
      <div>${relieverRows}</div>
    </div>`;
}

// ── 선발 로테이션 드래그 셋업 ────────────────────────────────
function setupRotationDrag() {
  const list = document.getElementById('rotation-list');
  if (!list) return;
  let dragIdx = -1, overIdx = -1;

  list.querySelectorAll('.rot-item').forEach(item => {
    const handle = item.querySelector('.rot-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      dragIdx = parseInt(item.dataset.idx);
      item.style.opacity = '0.35';
      item.style.background = 'rgba(245,166,35,.1)';
      item.setPointerCapture(e.pointerId);
    });

    item.addEventListener('pointermove', e => {
      if (dragIdx === -1) return;
      overIdx = dragIdx;
      const y = e.clientY;
      list.querySelectorAll('.rot-item').forEach((el, i) => {
        el.style.outline = '';
        if (i === dragIdx) return;
        const r = el.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) { el.style.outline = '2px solid var(--accent3)'; overIdx = i; }
      });
    });

    item.addEventListener('pointerup', () => {
      if (dragIdx === -1) return;
      const _from = dragIdx, _over = overIdx;
      dragIdx = -1; overIdx = -1;
      item.style.opacity = '';
      item.style.background = '';
      list.querySelectorAll('.rot-item').forEach(el => el.style.outline = '');
      if (_over !== -1 && _over !== _from) {
        const [moved] = SS.starterRotation.splice(_from, 1);
        SS.starterRotation.splice(_over, 0, moved);
        saveSeasonState();
        const fatigueEl = document.getElementById('season-fatigue');
        if (fatigueEl) { fatigueEl.innerHTML = renderFatiguePanel(); setupRotationDrag(); }
      }
    });
  });
}

window.fatigMoveToReliever = function(name) {
  SS.starterRotation = (SS.starterRotation || []).filter(n => n !== name);
  saveSeasonState();
  const el = document.getElementById('season-fatigue');
  if (el) { el.innerHTML = renderFatiguePanel(); setupRotationDrag(); }
};

window.fatigMoveToStarter = function(name) {
  if (!SS.starterRotation) SS.starterRotation = [];
  if (!SS.starterRotation.includes(name)) SS.starterRotation.push(name);
  saveSeasonState();
  const el = document.getElementById('season-fatigue');
  if (el) { el.innerHTML = renderFatiguePanel(); setupRotationDrag(); }
};

// ── 탭 전환 로직 ────────────────────────────────────────────
let currentSeasonTab = 3;

window.switchSeasonTab = function(n) {
  if (n < 1 || n > 4) return;
  currentSeasonTab = n;
  const offset = (n - 1) * 20;
  const slides = document.getElementById('season-slides');
  if (slides) slides.style.transform = `translateX(-${offset}%)`;

  for (let i = 1; i <= 5; i++) {
    const btn = document.getElementById(`snav-btn-${i}`);
    if (btn) btn.classList.toggle('snav-active', i === n);
  }
  if (n === 4) renderLineupEditorTab();
  updatePlayBtn();
};

function updatePlayBtn() {
  const btn = document.getElementById('season-play-btn');
  if (!btn) return;

  let hasMyGame = false;
  if (currentSeasonTab === 3 && SS.schedule && SS.gameIdx < SS.schedule.length) {
    const turn = SS.schedule[SS.gameIdx].turn;
    for (let i = SS.gameIdx; i < SS.schedule.length; i++) {
      if (SS.schedule[i].turn !== turn) break;
      if (SS.schedule[i].home === SS.myTeam || SS.schedule[i].away === SS.myTeam) {
        hasMyGame = true; break;
      }
    }
  }

  if (currentSeasonTab !== 3) {
    btn.classList.remove('visible');
    return;
  }
  btn.classList.add('visible');

  if (hasMyGame) {
    // 내 경기 있음: 주황색 PLAY
    btn.style.background = 'var(--accent)';
    btn.onclick = () => executeGame();
    btn.querySelector('span').style.color = '#000';
  } else {
    // 내 경기 없음: 흰색 + 자동 진행
    btn.style.background = 'rgba(255,255,255,0.9)';
    btn.onclick = () => autoTurnGames();
    btn.querySelector('span').style.color = '#111';
  }
}

function initSeasonSwipe() {
  const wrap = document.getElementById('season-slides-wrap');
  if (!wrap || wrap._swipeInited) return;
  wrap._swipeInited = true;
  let sx = 0, sy = 0;
  wrap.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });
  wrap.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      const next = dx < 0 ? currentSeasonTab + 1 : currentSeasonTab - 1;
      if (next >= 1 && next <= 4) window.switchSeasonTab(next);
    }
  }, { passive: true });
}

// ── 타선 편집 탭 ─────────────────────────────────────────
function renderLineupEditorTab() {
  const el = document.getElementById('season-lineup-editor');
  if (!el) return;

  if (!SS.myTeamKor) { el.innerHTML = '<div style="color:var(--text3);text-align:center;padding:40px">시즌 시작 후 사용 가능합니다</div>'; return; }
  if (tempGameSetup.myLineup.length === 0) {
    const hH = DB.hitters.filter(r => r.team === SS.myTeamKor).map(buildHitter).sort((a,b) => b.G - a.G);
    tempGameSetup.myLineup = buildLineup(hH);
  }

  let html = `<div id="lineup-drag-list" style="display:flex;flex-direction:column;gap:8px;">`;

  tempGameSetup.myLineup.forEach((p, idx) => {
    html += `<div class="lnp-drag-item" data-idx="${idx}">
      <div class="drag-handle" data-idx="${idx}" style="display:flex;align-items:center;gap:6px;padding:0 6px;cursor:grab;color:var(--text3);">
        <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor">
          <rect y="0" width="16" height="2" rx="1"/>
          <rect y="6" width="16" height="2" rx="1"/>
          <rect y="12" width="16" height="2" rx="1"/>
        </svg>
        <span style="font-family:'Bebas Neue';font-size:20px;color:var(--text3);min-width:16px;text-align:center">${idx+1}</span>
      </div>
      <div style="flex:1">
        <div style="font-weight:700;color:var(--text);font-size:14px">${p.name} <span style="font-size:10px;color:var(--text2)">${p.pos}</span></div>
        <div style="font-size:11px;color:var(--text3);font-family:'JetBrains Mono'">AVG:${p.AVG.toFixed(3)} HR:${p.HR} RBI:${p.RBI}</div>
      </div>
    </div>`;
  });

  html += `</div>`;
  el.innerHTML = html;
  setupLnpPointerDrag();
}

let _lnpSelectedIdx = -1;

window.lnpMoveUp = function() {
  if (_lnpSelectedIdx <= 0) return;
  const arr = tempGameSetup.myLineup;
  [arr[_lnpSelectedIdx-1], arr[_lnpSelectedIdx]] = [arr[_lnpSelectedIdx], arr[_lnpSelectedIdx-1]];
  _lnpSelectedIdx--;
  arr.forEach((p,i) => p.order = i+1);
  renderLineupEditorTab();
  _lnpSelectedIdx = (_lnpSelectedIdx >= 0) ? _lnpSelectedIdx : 0;
  highlightLnpRow(_lnpSelectedIdx);
};
window.lnpMoveDown = function() {
  const arr = tempGameSetup.myLineup;
  if (_lnpSelectedIdx < 0 || _lnpSelectedIdx >= arr.length - 1) return;
  [arr[_lnpSelectedIdx+1], arr[_lnpSelectedIdx]] = [arr[_lnpSelectedIdx], arr[_lnpSelectedIdx+1]];
  _lnpSelectedIdx++;
  arr.forEach((p,i) => p.order = i+1);
  renderLineupEditorTab();
  highlightLnpRow(_lnpSelectedIdx);
};
window.lnpApply = function() {
  // 적용: tempGameSetup.myLineup 업데이트 콘파인
  alert('타선 순서가 저장되었습니다.');
};

function highlightLnpRow(idx) {
  document.querySelectorAll('.lnp-drag-item').forEach((el, i) => {
    el.style.borderColor = i === idx ? 'var(--accent)' : '';
    el.style.background  = i === idx ? 'rgba(245,166,35,.08)' : '';
  });
}

function setupLnpPointerDrag() {
  const list = document.getElementById('lineup-drag-list');
  if (!list) return;
  let dragEl = null, fromIdx = -1, overIdx = -1;

  list.querySelectorAll('.lnp-drag-item').forEach(item => {
    // 선택
    item.addEventListener('click', e => {
      _lnpSelectedIdx = parseInt(item.dataset.idx);
      highlightLnpRow(_lnpSelectedIdx);
    });
    // 드래그 (pointer)
    item.querySelector('.drag-handle').addEventListener('pointerdown', e => {
      e.preventDefault();
      dragEl = item; fromIdx = parseInt(item.dataset.idx);
      item.classList.add('lnp-dragging');
      item.setPointerCapture(e.pointerId);
    });
    item.addEventListener('pointermove', e => {
      if (!dragEl || dragEl !== item) return;
      const y = e.clientY;
      const allItems = [...list.querySelectorAll('.lnp-drag-item')];
      allItems.forEach(el => el.classList.remove('lnp-over'));
      overIdx = fromIdx;
      allItems.forEach((el, i) => {
        if (el === dragEl) return;
        const r = el.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom) { el.classList.add('lnp-over'); overIdx = i; }
      });
    });
    item.addEventListener('pointerup', () => {
      if (!dragEl || dragEl !== item) return;
      dragEl.classList.remove('lnp-dragging');
      list.querySelectorAll('.lnp-drag-item').forEach(el => el.classList.remove('lnp-over'));
      if (overIdx !== -1 && overIdx !== fromIdx) {
        const arr = tempGameSetup.myLineup;
        const [moved] = arr.splice(fromIdx, 1);
        arr.splice(overIdx, 0, moved);
        arr.forEach((p,i) => p.order = i+1);
        _lnpSelectedIdx = overIdx;
        renderLineupEditorTab();
        highlightLnpRow(_lnpSelectedIdx);
      }
      dragEl = null; fromIdx = -1; overIdx = -1;
    });
  });
}

// ── 시즌 화면 초기화 ─────────────────────────────────
function showSeasonScreen() {
  document.getElementById('season-screen').style.display = 'flex';
  document.getElementById('setup-screen').style.display  = 'none';
  document.getElementById('game-bottom-nav').style.display = 'none';
  initStarterRotation();  // 선발 로테이션 초기화
  currentSeasonTab = 3;
  window.switchSeasonTab(3);
  initSeasonSwipe();
  refreshSeasonUI();
}

function refreshSeasonUI() {
  document.getElementById('season-standings').innerHTML = renderStandingsTable();
  document.getElementById('season-next-game').innerHTML = renderTodayGame();

  // 헤더 팀명 미리 업데이트
  const curGame = SS.schedule[SS.gameIdx];
  if (curGame) {
    const hKor = SS.nameKor[curGame.home] || curGame.home;
    const aKor = SS.nameKor[curGame.away] || curGame.away;
    initHeaderScoreboard(aKor, hKor);
  }
  
  const trn = SS.schedule[Math.min(SS.gameIdx, SS.schedule.length - 1)];
  const curTurn = trn ? trn.turn : 144;
  const pct = Math.round(curTurn / 144 * 100);
  const progEl = document.getElementById('season-progress-bar');
  if (progEl) progEl.style.width = pct + '%';
  const labelEl = document.getElementById('season-progress-label');
  if (labelEl) labelEl.textContent = `${curTurn} / 144`;

  // 일정 표 리스트 뷰
  const turnsEl = document.getElementById('season-upcoming-turns');
  if (turnsEl) turnsEl.innerHTML = renderUpcomingTurns();

  // 내 팀 투수 피로도 패널
  const fatigueEl = document.getElementById('season-fatigue');
  if (fatigueEl) { fatigueEl.innerHTML = renderFatiguePanel(); setupRotationDrag(); }

  // 포스트시즌 체크
  if (SS.gameIdx >= SS.schedule.length && SS.phase === 'season') {
    SS.phase = 'postseason';
    saveSeasonState();
    showPostseasonScreen();
  }
  updatePlayBtn();
}

// ── 자동 1경기 진행 ──────────────────────────────────────
function autoNextGame() {
  if (SS.gameIdx >= SS.schedule.length) return;
  const game   = SS.schedule[SS.gameIdx];
  // 해당 팀 데이터가 DB에 없으면 스킵
  const hKor   = SS.nameKor[game.home];
  const aKor   = SS.nameKor[game.away];
  const hasData = DB.hitters.some(h => h.team === hKor) && DB.hitters.some(h => h.team === aKor);
  if (hasData) {
    game.result = simGameFast(game.home, game.away);
    applyResult(game);
  } else {
    // 데이터 없으면 랜덤 결과
    const hs = Math.floor(Math.random() * 8), as2 = Math.floor(Math.random() * 8);
    game.result = { homeScore: hs, awayScore: as2 };
    applyResult(game);
  }
  SS.gameIdx++;
  saveSeasonState();
  refreshSeasonUI();
}

// ── 남은 경기 전부 자동 진행 ─────────────────────────────
async function autoRemaining() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '진행 중...';
  // 내 팀 경기 직전까지만 자동 (다음 내 팀 경기 직전에서 멈춤)
  while (SS.gameIdx < SS.schedule.length) {
    const game   = SS.schedule[SS.gameIdx];
    const isMine = game.home === SS.myTeam || game.away === SS.myTeam;
    if (isMine) break;
    const hKor = SS.nameKor[game.home], aKor = SS.nameKor[game.away];
    const hasData = DB.hitters.some(h => h.team === hKor) && DB.hitters.some(h => h.team === aKor);
    if (hasData) {
      game.result = simGameFast(game.home, game.away);
      applyResult(game);
    } else {
      const hs = Math.floor(Math.random() * 8), as2 = Math.floor(Math.random() * 8);
      game.result = { homeScore: hs, awayScore: as2 };
      applyResult(game);
    }
    SS.gameIdx++;
    // 10경기마다 중간 저장
    if (SS.gameIdx % 10 === 0) saveSeasonState();
  }
  saveSeasonState();
  refreshSeasonUI();
  btn.disabled = false;
  btn.textContent = '자동 진행';
}

// ── 내 팀 경기 직접 플레이 ───────────────────────────────
async function startSeasonGame() {
  const game   = SS.schedule[SS.gameIdx];
  const hKor   = SS.nameKor[game.home];
  const aKor   = SS.nameKor[game.away];

  // 로딩
  const loadingEl = document.getElementById('loading');
  loadingEl.style.display = 'flex';
  document.getElementById('loading-text').textContent = '데이터 로딩 중...';
  document.getElementById('loading-sub').textContent  = `${aKor} vs ${hKor}`;

  // 해당 두 팀 데이터 로드 (이미 DB에 있으면 재활용)
  const homeInDB = DB.hitters.some(h => h.team === hKor);
  const awayInDB = DB.hitters.some(h => h.team === aKor);

  if (!homeInDB || !awayInDB) {
    await loadTeamData(
      SS.year, game.home, game.away,
      ({ homeKor, awayKor }) => {},
      (err) => { alert('데이터 로드 실패: ' + err); }
    );
  }

  loadingEl.style.display = 'none';
  document.getElementById('season-screen').style.display = 'none';
  document.getElementById('game-bottom-nav').style.display = 'flex';

  // 기존 게임 시작 함수 활용
  gs = initGame(hKor, aKor);
  if (!gs) return;

  // 마법사 또는 개별 편집으로 설정한 내 팀 로스터 적용
  if (tempGameSetup && tempGameSetup.myPitcher) {
    if (game.home === SS.myTeam) {
      gs.curHP = tempGameSetup.myPitcher;
      gs.curHP.pitchCount = 0;
    } else {
      gs.curAP = tempGameSetup.myPitcher;
      gs.curAP.pitchCount = 0;
    }
  }
  if (tempGameSetup && tempGameSetup.myLineup && tempGameSetup.myLineup.length > 0) {
    if (game.home === SS.myTeam) {
      gs.homeLineup = tempGameSetup.myLineup;
    } else {
      gs.awayLineup = tempGameSetup.myLineup;
    }
  }
  
  // 다음 경기를 위해 클리어
  tempGameSetup = { myPitcher: null, myLineup: [], wizardMode: false, currentMyGameIdx: -1 };

  // 게임 종료 콜백 등록 (시즌 결과 반영용)
  gs._seasonGame = { gameIdx: SS.gameIdx, home: game.home, away: game.away };

  // 헤더·UI 초기화
  const hTeamEl = document.getElementById('min-h-name');
  if (hTeamEl) hTeamEl.textContent = hKor;
  const aTeamEl = document.getElementById('min-a-name');
  if (aTeamEl) aTeamEl.textContent = aKor;
  
  const hScoreEl = document.getElementById('min-h-score');
  if (hScoreEl) hScoreEl.textContent = '0';
  const aScoreEl = document.getElementById('min-a-score');
  if (aScoreEl) aScoreEl.textContent = '0';
  
  const homeLnpTitle = document.getElementById('home-lineup-title');
  if (homeLnpTitle) homeLnpTitle.textContent = hKor + ' 라인업';
  const awayLnpTitle = document.getElementById('away-lineup-title');
  if (awayLnpTitle) awayLnpTitle.textContent = aKor + ' 라인업';
  

  document.getElementById('game-log').innerHTML             = '';
  document.getElementById('game-over').classList.remove('show');
  document.getElementById('go-ext-label').innerHTML         = '';


  // 저장된 게임 상태 복원 (중단된 경기 이어하기)
  if (hasSavedGame()) {
    const ok = restoreGameState();
    if (ok) {
      // 스코어보드·UI 복원
      document.getElementById('min-h-score').textContent = gs.homeScore;
      document.getElementById('min-a-score').textContent = gs.awayScore;
      updateGameUI(); updateLnpUI(); updateSbUI(); updateSituationBar();
      addLog(`⚾ [이어하기] ${SS.year}시즌 ${SS.gameIdx + 1}번째 경기 · ${aKor} vs ${hKor}`, '');
      startPA();
      return;
    }
  }
  updateGameUI(); updateLnpUI(); updateSbUI(); updateSituationBar();
  addLog(`⚾ ${SS.year}시즌 ${SS.gameIdx + 1}번째 경기 · ${aKor} vs ${hKor}`, '');
  startPA();
}

// ── 게임 화면에서 시즌으로 돌아가기 ─────────────────────────
window.returnToSeason = function() {
  if (gs && !gs.gameOver) {
    if (!confirm('경기를 중단하고 시즌 화면으로 돌아갈까요?\n현재까지의 진행 상황은 저장됩니다.')) return;
  }
  stopPlay();
  if (typeof saveGameState === 'function') saveGameState();
  
  document.getElementById('game-bottom-nav').style.display = 'none';
  showSeasonScreen();
};

// ── 시즌 경기 종료 후 처리 (endGame() 훅) ───────────────
function onSeasonGameEnd(homeScore, awayScore) {
  if (!gs || !gs._seasonGame) return;
  const { gameIdx, home, away } = gs._seasonGame;
  const game = SS.schedule[gameIdx];
  game.result = { homeScore, awayScore };
  applyResult(game);
  recordPlayerStats([...gs.homeLineup, ...gs.awayLineup]);

  // 직접 플레이 경기 투수 피로도 기록
  const homePitched = gs.homePitchers.filter(p => p.pitchCount > 0);
  const awayPitched = gs.awayPitchers.filter(p => p.pitchCount > 0);
  recordPitcherFatigue(homePitched, home);
  recordPitcherFatigue(awayPitched, away);

  SS.gameIdx = gameIdx + 1;
  clearGameState();   // 경기 종료 → 게임 저장 삭제
  // 턴 결과 모달 표시 (같은 턴 타 팀 경기 자동 시뮬 포함)
  showTurnResults(gameIdx);
}

// ── 포스트시즌 화면 ──────────────────────────────────────
function showPostseasonScreen() {
  const ps  = buildPostseason();
  SS._ps    = ps;
  const el  = document.getElementById('postseason-screen');
  el.style.display = 'flex';
  renderPostseasonUI();
}

function renderPostseasonUI() {
  const ps  = SS._ps;
  const el  = document.getElementById('ps-bracket');
  const stages = ['wc','semi','play','ks'];
  let h = '';
  stages.forEach(stage => {
    const s    = ps[stage];
    const hKor = s.home ? (SS.nameKor[s.home] || s.home) : '미정';
    const aKor = s.away ? (SS.nameKor[s.away] || s.away) : '미정';
    const done = s.done ? '종료' : (s.home && s.away ? '진행중' : '대기');
    h += `<div class="ps-series ${s.done ? 'ps-done' : ''}" id="ps-${stage}">
      <div class="ps-label">${s.label} (${s.needed}승제)</div>
      <div class="ps-matchup">${aKor} <span>${s.wins[1]}</span> : <span>${s.wins[0]}</span> ${hKor}</div>
      <div class="ps-status">${done}</div>
      ${(!s.done && s.home && s.away)
        ? `<button class="btn primary" onclick="playPsSeries('${stage}')">경기 진행</button>`
        : ''}
    </div>`;
  });
  el.innerHTML = h;
}

async function playPsSeries(stage) {
  const ps   = SS._ps;
  const s    = ps[stage];
  const isMine = s.home === SS.myTeam || s.away === SS.myTeam;
  if (isMine) {
    // 직접 플레이 (1경기)
    document.getElementById('postseason-screen').style.display = 'none';
    await startSeasonGame();  // 재활용 (gs._seasonGame 없이)
    // 종료 후 돌아올 때 ps 결과 반영은 endGame 훅에서
  } else {
    // 자동 진행: 시리즈 끝날 때까지
    while (!s.done) simSeriesGame(s, SS.myTeam);
    // 다음 단계 상대 결정
    const winner = s.wins[0] >= s.needed ? s.home : s.away;
    if (stage === 'wc')   { ps.semi.away = winner; }
    if (stage === 'semi') { ps.play.away = winner; }
    if (stage === 'play') { ps.ks.away   = winner; }
    renderPostseasonUI();
  }
}
