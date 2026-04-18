
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
      year:        SS.year,
      myTeam:      SS.myTeam,
      myTeamKor:   SS.myTeamKor,
      teams:       SS.teams,
      nameKor:     SS.nameKor,
      schedule:    SS.schedule,
      gameIdx:     SS.gameIdx,
      standings:   SS.standings,
      playerStats: SS.playerStats,
      phase:          SS.phase,
      pitcherFatigue: SS.pitcherFatigue,
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
// 10팀 라운드로빈: 각 상대와 홈 8 + 원정 8 = 16경기 → 144경기
// 턴(turn) 구조: 하루 5경기(10팀 전체)가 하나의 턴
// 내 팀 경기가 포함된 턴에서 내 팀 경기를 마지막에 배치
function buildSchedule(teams, myTeam) {
  // 각 팀 쌍 대전 목록 생성
  const allPairs = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      for (let g = 0; g < 8; g++) {
        allPairs.push({ home: teams[i], away: teams[j] });
        allPairs.push({ home: teams[j], away: teams[i] });
      }
    }
  }

  // 턴 단위로 묶기: 매 턴마다 각 팀이 정확히 1번씩 등장 (5경기/턴)
  // 단순화: 전체를 랜덤 섞은 뒤 5개씩 묶어 턴 구성
  for (let i = allPairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allPairs[i], allPairs[j]] = [allPairs[j], allPairs[i]];
  }

  const GAMES_PER_TURN = 5; // 10팀 → 5경기/턴
  const turns = [];
  for (let i = 0; i < allPairs.length; i += GAMES_PER_TURN) {
    turns.push(allPairs.slice(i, i + GAMES_PER_TURN));
  }

  // 각 턴에서 내 팀 경기가 있으면 마지막으로 이동 (직접 플레이가 턴 마지막)
  turns.forEach(turn => {
    const myIdx = turn.findIndex(g => g.home === myTeam || g.away === myTeam);
    if (myIdx >= 0 && myIdx < turn.length - 1) {
      const [myGame] = turn.splice(myIdx, 1);
      turn.push(myGame);
    }
  });

  // 평탄화 + 메타데이터 부여
  const schedule = [];
  let gameNo = 1;
  turns.forEach((turn, turnIdx) => {
    turn.forEach(g => {
      schedule.push({
        home:   g.home,
        away:   g.away,
        result: null,
        gameNo: gameNo++,
        turn:   turnIdx + 1,  // 1부터 시작
      });
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
    .sort((a, b) => b.pct - a.pct || b.w - a.w);
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
    // 연장 (최대 12회)
    if (inning === 9 && homeScore === awayScore && inning < 12) {
      // 연장은 단순히 2점씩 추가 후 무승부 처리 (심플)
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
    <tr><th>순위</th><th>팀</th><th>경기</th><th>승</th><th>패</th><th>무</th><th>승률</th><th>GB</th><th>득점</th><th>실점</th></tr>`;
  sorted.forEach((t, i) => {
    const isMine = t.team === SS.myTeam;
    h += `<tr class="${isMine ? 'my-team-row' : ''}">
      <td>${i + 1}</td>
      <td><b>${SS.nameKor[t.team] || t.team}</b></td>
      <td>${t.games}</td><td>${t.w}</td><td>${t.l}</td><td>${t.d}</td>
      <td>${t.pct.toFixed(3)}</td>
      <td>${t.gb}</td>
      <td>${t.rs}</td><td>${t.ra}</td>
    </tr>`;
  });
  h += '</table>';
  return h;
}

function renderNextGame() {
  const game = SS.schedule[SS.gameIdx];
  if (!game) return '<div style="color:var(--accent)">시즌 종료</div>';
  const isMine = game.home === SS.myTeam || game.away === SS.myTeam;
  const hKor   = SS.nameKor[game.home] || game.home;
  const aKor   = SS.nameKor[game.away] || game.away;
  const turn   = game.turn || '-';

  // 같은 턴의 다른 경기 미리보기
  const turnGames  = SS.schedule.filter(g => g.turn === game.turn && g !== game);
  const turnPreview = turnGames.map(g => {
    const h = SS.nameKor[g.home] || g.home;
    const a = SS.nameKor[g.away] || g.away;
    return `<div class="turn-preview-row">${a} @ ${h}</div>`;
  }).join('');

  return `
    <div class="next-game-card ${isMine ? 'my-game' : ''}">
      <div class="ng-label">${isMine ? '⚾ 내 팀 경기' : '타 팀 경기'} · ${turn}턴 · ${SS.gameIdx + 1}/${SS.schedule.length}</div>
      <div class="ng-matchup">${aKor} <span>@</span> ${hKor}</div>
      ${turnPreview ? `<div class="turn-preview">${turnPreview}</div>` : ''}
      ${isMine
        ? `<button class="btn primary ng-btn" onclick="startSeasonGame()">직접 플레이</button>`
        : `<button class="btn ng-btn" onclick="autoNextGame()">자동 진행</button>`
      }
    </div>`;
}


// ── 주간 일정 캘린더 ──────────────────────────────────────
function getGameDate(turn) {
  if (!turn) return null;
  const baseDate = new Date(2026, 2, 28); // 2026-03-28 (Sat)
  let offsetDays = 0;
  if (turn === 1) offsetDays = 0;
  else if (turn === 2) offsetDays = 1;
  else {
    const t = turn - 3;
    const weeks = Math.floor(t / 6);
    const dayOfWeek = t % 6; // 0=Tue, 1=Wed..
    offsetDays = 3 + weeks * 7 + dayOfWeek;
  }
  const d = new Date(baseDate.getTime());
  d.setDate(baseDate.getDate() + offsetDays);
  return d;
}

function renderWeeklyCalendar() {
  if (!SS.schedule || !SS.schedule.length) return '';
  const myTeam = SS.myTeam;
  const myGames = SS.schedule.filter(g => g.home === myTeam || g.away === myTeam).sort((a,b) => a.turn - b.turn);
  
  const curGame = SS.schedule[Math.min(SS.gameIdx, SS.schedule.length - 1)];
  const curTurn = curGame ? curGame.turn : 144;
  
  const d = getGameDate(curTurn);
  if (!d) return '';
  let day = d.getDay(); // 0(Sun) ~ 6(Sat)
  let diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const wd = new Date(monday);
    wd.setDate(monday.getDate() + i);
    weekDates.push(wd);
  }
  
  let html = `<div class="weekly-cal">
    <div class="weekly-cal-header">${d.getMonth()+1}월 주간 일정</div>
    <div class="wc-grid">
      <div class="wc-day-th">월</div><div class="wc-day-th">화</div><div class="wc-day-th">수</div><div class="wc-day-th">목</div><div class="wc-day-th">금</div><div class="wc-day-th">토</div><div class="wc-day-th">일</div>`;
      
  weekDates.forEach((wd) => {
    const y = wd.getFullYear(), m = wd.getMonth(), dt = wd.getDate();
    const game = myGames.find(g => {
      const gd = getGameDate(g.turn);
      return gd && gd.getFullYear() === y && gd.getMonth() === m && gd.getDate() === dt;
    });
    
    // 이 날짜가 현재 curTurn의 날짜인지
    const curGd = getGameDate(curTurn);
    const isToday = (curTurn > 0 && curGd.getFullYear() === y && curGd.getMonth() === m && curGd.getDate() === dt);
    const cellClass = "wc-cell" + (isToday ? " wc-today" : "");
    const dateStr = `${m+1}.${dt}`;
    
    html += `<div class="${cellClass}"><div class="wc-date">${dateStr}</div>`;
    
    if (game) {
      const hKor = SS.nameKor[game.home] || game.home;
      const aKor = SS.nameKor[game.away] || game.away;
      const isHome = game.home === myTeam;
      const oppKor = isHome ? aKor : hKor;
      const vsStr = isHome ? `vs ${oppKor}` : `@ ${oppKor}`;
      
      if (game.result) {
        const myScore = isHome ? game.result.homeScore : game.result.awayScore;
        const opScore = isHome ? game.result.awayScore : game.result.homeScore;
        let rClass = 'wc-draw', rText = '무';
        if (myScore > opScore) { rClass = 'wc-win'; rText = '승'; }
        else if (myScore < opScore) { rClass = 'wc-loss'; rText = '패'; }
        
        html += `<div class="wc-match" style="color:var(--text2)">${vsStr}</div>
                 <div class="wc-result ${rClass}">${myScore}:${opScore} ${rText}</div>`;
      } else {
        html += `<div class="wc-match">${vsStr}</div>`;
      }
    } else {
      html += `<div class="wc-rest">휴식</div>`;
    }
    
    html += `</div>`;
  });
  
  html += `</div></div>`;
  return html;
}

// ── 턴 결과 모달 ─────────────────────────────────────────
// 내 팀 경기 종료 후, 같은 턴의 나머지 경기 결과를 자동 시뮬 후 표시
async function showTurnResults(myGameIdx) {
  const myGame = SS.schedule[myGameIdx];
  const myTurn = myGame.turn;

  // 같은 턴의 타 팀 경기 목록
  const turnGames = SS.schedule.filter(g =>
    g.turn === myTurn && g !== myGame
  );

  // 타 팀 경기 자동 시뮬
  const results = [];
  for (const game of turnGames) {
    if (game.result) {
      results.push(game); // 이미 처리된 경우
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

  // 모달 HTML 생성
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
    const winner = homeScore > awayScore ? hKor
                 : awayScore > homeScore ? aKor : '무';
    otherRows += `
      <div class="turn-row">
        <span class="tr-team ${homeScore > awayScore ? 'tr-win' : ''}">${hKor}</span>
        <span class="tr-score">${homeScore}</span>
        <span class="tr-vs">:</span>
        <span class="tr-score">${awayScore}</span>
        <span class="tr-team ${awayScore > homeScore ? 'tr-win' : ''}">${aKor}</span>
      </div>`;
  });

  const modal = document.getElementById('turn-modal');
  document.getElementById('turn-modal-title').textContent =
    `${myTurn}턴 결과`;
  document.getElementById('turn-my-result').innerHTML = `
    <div class="turn-my-label">내 팀 경기</div>
    <div class="turn-my-score">
      <span class="${myResult.awayScore > myResult.homeScore ? 'tr-win' : ''}">${myAKor}</span>
      <b>${myResult.awayScore} : ${myResult.homeScore}</b>
      <span class="${myResult.homeScore > myResult.awayScore ? 'tr-win' : ''}">${myHKor}</span>
    </div>`;
  document.getElementById('turn-other-results').innerHTML = otherRows;

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



// ── 내 팀 투수 피로도 현황 렌더 ─────────────────────────────
function renderFatiguePanel() {
  const teamCode = SS.myTeam;
  const korName  = SS.myTeamKor;
  const pitchers = DB.pitchers.filter(p => p.team === korName);
  if (!pitchers.length) return '';

  let rows = '';
  pitchers.sort((a,b) => (b.IP/b.G) - (a.IP/a.G)).forEach(p => {
    const isStarter = (p.IP / p.G) >= 4.5;
    const key       = `${p.name}_${teamCode}`;
    const f         = SS.pitcherFatigue[key];
    const mult      = getFatigueMult(p.name, teamCode, isStarter);
    const daysSince = f ? SS.gameIdx - f.lastGame : 99;

    let status = '', statusColor = 'var(--accent3)';
    if (isStarter) {
      if (mult >= 99)       { status = '등판불가'; statusColor = 'var(--accent2)'; }
      else if (mult > 1.0)  { status = `휴식 ${daysSince}일차`; statusColor = 'var(--accent)'; }
      else if (daysSince >= 99) { status = '대기중'; statusColor = 'var(--text3)'; }
      else                  { status = `정상 (${daysSince}일 휴식)`; }
    } else {
      if (mult >= 1.5)      { status = '3연투 주의'; statusColor = 'var(--accent2)'; }
      else if (mult >= 1.3) { status = '2연투 피로'; statusColor = 'var(--accent)'; }
      else if (mult > 1.0)  { status = '1연투'; statusColor = 'var(--accent)'; }
      else if (daysSince >= 99) { status = '대기중'; statusColor = 'var(--text3)'; }
      else                  { status = '정상'; }
    }

    const role = isStarter ? '선발' : (p.ERA < 3.0 ? '마무리' : '계투');
    rows += `<tr>
      <td>${p.name}</td>
      <td style="color:var(--text3)">${role}</td>
      <td>${p.ERA.toFixed(2)}</td>
      <td style="color:${statusColor}">${status}</td>
    </tr>`;
  });

  return `<table class="standings-table" style="margin-top:8px">
    <tr><th>투수</th><th>역할</th><th>ERA</th><th>상태</th></tr>
    ${rows}
  </table>`;
}

// ── 시즌 화면 초기화 ─────────────────────────────────────
function showSeasonScreen() {
  document.getElementById('season-screen').style.display = 'flex';
  document.getElementById('setup-screen').style.display  = 'none';
  refreshSeasonUI();
}

function refreshSeasonUI() {
  document.getElementById('season-standings').innerHTML = renderStandingsTable();
  document.getElementById('season-next-game').innerHTML = renderNextGame();
  
  // 주간 일정 표
  const weeklyCalEl = document.getElementById('season-weekly-calendar');
  if (weeklyCalEl) weeklyCalEl.innerHTML = renderWeeklyCalendar();

  // 시즌 진행 바
  const pct = Math.round(SS.gameIdx / SS.schedule.length * 100);
  document.getElementById('season-progress-bar').style.width = pct + '%';
  document.getElementById('season-progress-label').textContent =
    `${SS.gameIdx}경기 완료 / ${SS.schedule.length}경기`;
  // 내 팀 투수 피로도 패널
  const fatigueEl = document.getElementById('season-fatigue');
  if (fatigueEl) fatigueEl.innerHTML = renderFatiguePanel();

  // 포스트시즌 체크
  if (SS.gameIdx >= SS.schedule.length && SS.phase === 'season') {
    SS.phase = 'postseason';
    saveSeasonState();
    showPostseasonScreen();
  }
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

  // 기존 게임 시작 함수 활용
  gs = initGame(hKor, aKor);
  if (!gs) return;

  // 게임 종료 콜백 등록 (시즌 결과 반영용)
  gs._seasonGame = { gameIdx: SS.gameIdx, home: game.home, away: game.away };

  // 헤더·UI 초기화
  document.getElementById('header-year').textContent        = SS.year + ' 시즌';
  document.getElementById('h-team-name').textContent        = hKor;
  document.getElementById('a-team-name').textContent        = aKor;
  document.getElementById('h-score').textContent            = '0';
  document.getElementById('a-score').textContent            = '0';
  document.getElementById('home-lineup-title').textContent  = hKor + ' 라인업';
  document.getElementById('away-lineup-title').textContent  = aKor + ' 라인업';
  document.getElementById('game-log').innerHTML             = '';
  document.getElementById('game-over').classList.remove('show');
  document.getElementById('go-ext-label').innerHTML         = '';
  document.getElementById('inning-display').textContent     = '1회';
  document.getElementById('half-display').textContent       = '초';

  // 저장된 게임 상태 복원 (중단된 경기 이어하기)
  if (hasSavedGame()) {
    const ok = restoreGameState();
    if (ok) {
      // 스코어보드·UI 복원
      document.getElementById('h-score').textContent = gs.homeScore;
      document.getElementById('a-score').textContent = gs.awayScore;
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
