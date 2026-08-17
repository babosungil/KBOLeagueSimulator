
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
  teamColors:{},     // { doosan:{ primary:'#C8102E', secondary:'#131230' }, ... }
  schedule:  [],     // 144경기 배열
  gameIdx:   0,      // 현재 경기 인덱스
  standings: {},     // { doosan:{ w,l,d,rs,ra }, ... }
  playerStats:{},    // { '선수명_팀': { PA,H,HR,RBI,... } }
  matchupHistory:{}, // { '투수명_투수팀__타자명_타자팀': { PA,AB,H,HR,BB,K,RBI } } (시즌 누적 맞대결)
  phase:     'season', // 'season' | 'postseason' | 'done'
  // 투수 피로도: { '선수명_팀': { lastGame, consecDays, type } }
  // lastGame: 마지막 등판 경기 인덱스
  // consecDays: 연속 등판 일수 (불펜)
  // type: 'starter' | 'reliever'
  pitcherFatigue: {},
  starterRotation: [],
  starterRotationIndex: 0,
  champion: null,        // 한국시리즈 우승 팀 코드 (시즌 종료 후)
  championShown: false,  // 우승 팝업을 이미 띄웠는지 (재접속 시 재생 방지)
};

// ── localStorage 키 ──────────────────────────────────────
const LS_KEY      = 'kbo_season_v1';
const LS_GAME_KEY = 'kbo_game_state_v1';   // 게임 진행 중 저장용

// Capacitor Preferences & App 헬퍼
const isApp = window.Capacitor !== undefined && Capacitor.Plugins;

// 앱 시작 시 Preferences -> localStorage 동기화 함수
window.syncPreferencesToLocalStorage = async function() {
  if (!isApp || !Capacitor.Plugins.Preferences) return;
  try {
    const { Preferences } = Capacitor.Plugins;
    const resSeason = await Preferences.get({ key: LS_KEY });
    if (resSeason.value) {
      localStorage.setItem(LS_KEY, resSeason.value);
    }
    const resGame = await Preferences.get({ key: LS_GAME_KEY });
    if (resGame.value) {
      localStorage.setItem(LS_GAME_KEY, resGame.value);
    }
  } catch(e) {
    console.warn('Preferences -> localStorage 동기화 실패', e);
  }
};

// 안드로이드 뒤로가기 핸들러 설정
window.setupAndroidBackButton = function() {
  if (!isApp || !Capacitor.Plugins.App) return;
  const { App } = Capacitor.Plugins;
  App.addListener('backButton', () => {
    const inGameSubModal = document.getElementById('in-game-sub-modal');
    const pitcherModal = document.getElementById('pitcher-modal');
    const lineupModal = document.getElementById('lineup-modal');
    const mobileLineupSheet = document.getElementById('mobile-lineup-sheet');
    const turnModal = document.getElementById('turn-modal');

    // 1. 모달 및 시트 닫기
    if (inGameSubModal && inGameSubModal.style.display === 'block') {
      if (typeof closeSubModal === 'function') closeSubModal();
    } else if (pitcherModal && pitcherModal.style.display === 'flex') {
      if (typeof closePitcherModal === 'function') closePitcherModal();
    } else if (lineupModal && lineupModal.style.display === 'flex') {
      if (typeof closeLineupModal === 'function') closeLineupModal();
    } else if (mobileLineupSheet && mobileLineupSheet.classList.contains('open')) {
      if (typeof closeMobileLineupSheet === 'function') closeMobileLineupSheet();
    } else if (turnModal && turnModal.style.display === 'flex') {
      if (typeof closeTurnModal === 'function') closeTurnModal();
    } else {
      // 2. 화면 상태 판단
      const gameOverScreen = document.getElementById('game-over');
      const gameBottomNav = document.getElementById('game-bottom-nav');
      const seasonScreen = document.getElementById('season-screen');
      const setupScreen = document.getElementById('setup-screen');

      if (gameOverScreen && gameOverScreen.style.display === 'flex') {
        if (typeof returnToSeason === 'function') returnToSeason();
      } else if (gameBottomNav && gameBottomNav.style.display === 'flex') {
        if (typeof returnToSeason === 'function') returnToSeason();
      } else if (seasonScreen && seasonScreen.style.display === 'flex') {
        // 메인 탭(3)이 아닌 경우 메인 탭으로 복귀, 메인이면 종료
        if (typeof currentSeasonTab !== 'undefined' && currentSeasonTab !== 3) {
          if (typeof switchSeasonTab === 'function') switchSeasonTab(3);
        } else {
          App.exitApp();
        }
      } else if (setupScreen && setupScreen.style.display === 'flex') {
        App.exitApp();
      } else {
        App.exitApp();
      }
    }
  });
};

// 게임 진행 중 상태 저장 (gs 전체 + 시즌 컨텍스트)
// 이미 끝난 경기는 저장하지 않는다. returnToSeason()이 stopPlay()와 함께 이 함수를 부르는데,
// 종료된 경기까지 다시 써버리면 포스트시즌에서 같은 시리즈의 다음 경기를 시작할 때
// hasSavedGame()이 그 잔여 데이터를 "진행 중인 경기"로 오인해 끝난 경기를 복원한다.
// (정규시즌은 gameIdx가 증가해 우연히 걸러졌을 뿐, 포스트시즌은 psStage가 시리즈 내내 같아 그대로 노출된다)
function saveGameState() {
  if (!gs || !gs._seasonGame || gs.gameOver) return;
  try {
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
      homeLineupStats: gs.homeLineup.map(p => ({ name: p.name, todayStats: p.todayStats, pitchCount: p.pitchCount || 0 })),
      awayLineupStats: gs.awayLineup.map(p => ({ name: p.name, todayStats: p.todayStats, pitchCount: p.pitchCount || 0 })),
      homePitcherStats: gs.homePitchers.map(p => ({ name: p.name, pitchCount: p.pitchCount || 0, usedToday: p.usedToday || false })),
      awayPitcherStats: gs.awayPitchers.map(p => ({ name: p.name, pitchCount: p.pitchCount || 0, usedToday: p.usedToday || false })),
      curHPName: gs.curHP ? gs.curHP.name : null,
      curAPName: gs.curAP ? gs.curAP.name : null,
    };
    const dataStr = JSON.stringify(snapshot);
    localStorage.setItem(LS_GAME_KEY, dataStr);

    if (isApp && Capacitor.Plugins.Preferences) {
      Capacitor.Plugins.Preferences.set({ key: LS_GAME_KEY, value: dataStr })
        .catch(e => console.warn('Preferences 게임 이중 저장 실패', e));
    }
  } catch(e) { console.warn('게임 저장 실패', e); }
}

// 저장된 게임 상태가 지금 진행하려는 경기와 일치하는지 확인
// currentGame을 넘기면 그 대진과 비교한다(포스트시즌용).
function hasSavedGame(currentGame) {
  try {
    const raw = localStorage.getItem(LS_GAME_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const saved = data._seasonGame;
    const game = currentGame || SS.schedule[SS.gameIdx];
    if (!game || !saved) return false;

    // 종료된 경기 스냅샷은 "이어하기" 대상이 아니다.
    // (구버전에서 저장된 잔여 데이터가 남아 있어도 여기서 걸러진다)
    if (data.gameOver) return false;

    // 다른 시즌(다른 내 팀)의 잔여 저장 데이터가 우연히 대진이 일치해
    // 엉뚱하게 복원되는 것을 방지
    if (saved.myTeam !== SS.myTeam) return false;
    if (saved.home !== game.home || saved.away !== game.away) return false;

    // 포스트시즌은 일정 인덱스가 없으므로 시리즈 단계로 대조한다
    if (game.psStage || saved.psStage) return saved.psStage === game.psStage;
    return saved.gameIdx === SS.gameIdx;
  } catch(e) { return false; }
}

// 게임 저장 상태 복원 (gs에 todayStats·pitchCount 덮어쓰기)
function restoreGameState() {
  try {
    const raw = localStorage.getItem(LS_GAME_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);

    // gs 기본 필드 복원 (숫자 타입 강제)
    gs.homeScore   = Number(snap.homeScore)   || 0;
    gs.awayScore   = Number(snap.awayScore)   || 0;
    gs.inning      = Number(snap.inning)      || 1;
    gs.isTop       = !!snap.isTop;
    gs.isExtra     = !!snap.isExtra;
    gs.outs        = Number(snap.outs)        || 0;
    gs.bases       = snap.bases;
    gs.homeOrder   = Number(snap.homeOrder)   || 0;
    gs.awayOrder   = Number(snap.awayOrder)   || 0;
    gs.innings     = snap.innings;
    gs.gamePitches = Number(snap.gamePitches) || 0;
    gs.totalAB     = Number(snap.totalAB)     || 0;
    gs.gameOver    = !!snap.gameOver;
    gs._seasonGame = snap._seasonGame;

    // 라인업 todayStats 복원 (데이터 존재 여부 확인 추가)
    if (snap.homeLineupStats) {
      snap.homeLineupStats.forEach(s => {
        const p = gs.homeLineup.find(p => p.name === s.name);
        if (p) { p.todayStats = s.todayStats; p.pitchCount = s.pitchCount; }
      });
    }
    if (snap.awayLineupStats) {
      snap.awayLineupStats.forEach(s => {
        const p = gs.awayLineup.find(p => p.name === s.name);
        if (p) { p.todayStats = s.todayStats; p.pitchCount = s.pitchCount; }
      });
    }

    // 투수 pitchCount·usedToday 복원
    if (snap.homePitcherStats) {
      snap.homePitcherStats.forEach(s => {
        const p = gs.homePitchers.find(p => p.name === s.name);
        if (p) { p.pitchCount = s.pitchCount; p.usedToday = s.usedToday; }
      });
    }
    if (snap.awayPitcherStats) {
      snap.awayPitcherStats.forEach(s => {
        const p = gs.awayPitchers.find(p => p.name === s.name);
        if (p) { p.pitchCount = s.pitchCount; p.usedToday = s.usedToday; }
      });
    }

    // 현재 투수 복원
    if (snap.curHPName) gs.curHP = gs.homePitchers.find(p => p.name === snap.curHPName) || gs.curHP;
    if (snap.curAPName) gs.curAP = gs.awayPitchers.find(p => p.name === snap.curAPName) || gs.curAP;

    return true;
  } catch(e) { console.error('게임 복원 중 오류 발생:', e); return false; }
}

// 게임 저장 삭제 (경기 종료 시)
function clearGameState() {
  try {
    localStorage.removeItem(LS_GAME_KEY);
    if (isApp && Capacitor.Plugins.Preferences) {
      Capacitor.Plugins.Preferences.remove({ key: LS_GAME_KEY })
        .catch(e => console.warn('Preferences 게임 저장 삭제 실패', e));
    }
  } catch(e) {}
}

function saveSeasonState() {
  try {
    const dataStr = JSON.stringify({
      year:            SS.year,
      myTeam:          SS.myTeam,
      myTeamKor:       SS.myTeamKor,
      teams:           SS.teams,
      nameKor:         SS.nameKor,
      schedule:        SS.schedule,
      gameIdx:         SS.gameIdx,
      standings:       SS.standings,
      playerStats:     SS.playerStats,
      matchupHistory:  SS.matchupHistory || {},
      phase:           SS.phase,
      pitcherFatigue:  SS.pitcherFatigue,
      starterRotation: SS.starterRotation,
      starterRotationIndex: SS.starterRotationIndex,
      catcherFatigue:  SS.catcherFatigue || {},
      _ps:             SS._ps || null,   // 포스트시즌 대진표(시리즈 전적 포함)
      champion:        SS.champion || null,
      championShown:   !!SS.championShown,
    });
    localStorage.setItem(LS_KEY, dataStr);

    if (isApp && Capacitor.Plugins.Preferences) {
      Capacitor.Plugins.Preferences.set({ key: LS_KEY, value: dataStr })
        .catch(e => console.warn('Preferences 시즌 이중 저장 실패', e));
    }
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
  try {
    localStorage.removeItem(LS_KEY);
    if (isApp && Capacitor.Plugins.Preferences) {
      Capacitor.Plugins.Preferences.remove({ key: LS_KEY })
        .catch(e => console.warn('Preferences 시즌 저장 삭제 실패', e));
    }
  } catch(e) {}
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
    const prev = SS.pitcherFatigue[key] || { 
      stamina: 100, 
      lastGame: -99, 
      consecDays: 0, 
      type: p.isStarter ? 'starter' : 'reliever' 
    };
    const lastGame = prev.lastGame;
    
    // 차감량 = 투구 수 * 1%
    prev.stamina = Math.max(0, prev.stamina - p.pitchCount);
    
    // 연투 기록 (당일 여러 번 호출 방지용 방어 로직 포함)
    if (lastGame !== SS.gameIdx) {
      prev.consecDays = (SS.gameIdx - lastGame <= 1) ? prev.consecDays + 1 : 1;
    }
    
    prev.lastGame = SS.gameIdx;
    prev.type = p.isStarter ? 'starter' : 'reliever';
    SS.pitcherFatigue[key] = prev;
  });
}

/**
 * 경기 종료 후 해당 경기에 수비로 출장한 포수의 피로도를 기록.
 */
function recordCatcherFatigue(hitters, teamCode, innings) {
  if (!SS.catcherFatigue) SS.catcherFatigue = {};
  const inningCount = typeof innings === 'number'
    ? innings
    : Math.max((innings && innings.home && innings.home.length) || 0, (innings && innings.away && innings.away.length) || 0);
  hitters.forEach(h => {
    const key = `${h.name}_${teamCode}`;
    const prev = SS.catcherFatigue[key] || { stamina: 100, lastDefGame: -99 };
    
    // 이닝당 5% 차감
    prev.stamina = Math.max(0, prev.stamina - (inningCount * 5));
    prev.lastDefGame = SS.gameIdx;
    
    SS.catcherFatigue[key] = prev;
  });
}

/**
 * 턴 단위 글로벌 체력 회복 프로세스
 * (모든 팀의 턴 종료 시점에서 호출됨)
 */
window.processTurnFatigueRecovery = function() {
  if (!SS.pitcherFatigue) SS.pitcherFatigue = {};
  if (!SS.catcherFatigue) SS.catcherFatigue = {};

  // 방금 시뮬레이션 된 턴(어제 턴) 확인
  const justFinishedTurn = SS.schedule[SS.gameIdx - 1] ? SS.schedule[SS.gameIdx - 1].turn : -1;

  // 1. 투수 회복
  DB.pitchers.forEach(p => {
    const teamCode = getTeamCode(p.team);
    if (!teamCode) return;
    const key = `${p.name}_${teamCode}`;
    const f = SS.pitcherFatigue[key] || { stamina: 100, consecDays: 0, lastGame: -99, type: p.isStarter ? 'starter' : 'reliever' };
    
    const lastPitchedTurn = (f.lastGame >= 0 && SS.schedule[f.lastGame]) ? SS.schedule[f.lastGame].turn : -99;

    if (lastPitchedTurn === justFinishedTurn) {
      // 방금 끝난 턴에 등판했으면 회복 없음
    } else {
      // 휴식일: 회복 및 연투 초기화
      f.consecDays = 0;
      
      let modifier = 1.0;
      const age = p.age || 28;
      if (age <= 25) modifier += 0.1;
      else if (age >= 33) modifier -= 0.1;

      if (f.type === 'starter') {
        const avgIP = p.avgIP || 5;
        if (avgIP >= 6.0) modifier += 0.05;
        else if (avgIP < 4.0) modifier -= 0.05;
        
        const baseRec = 20;
        const rand = (Math.random() * 10 - 5);
        f.stamina = Math.min(100, f.stamina + (baseRec * modifier) + rand);
      } else {
        const baseRec = 35;
        const rand = (Math.random() * 10 - 5);
        f.stamina = Math.min(100, f.stamina + (baseRec * modifier) + rand);
      }
    }
    SS.pitcherFatigue[key] = f;
  });

  // 2. 포수 회복
  DB.hitters.forEach(c => {
    if (c.position !== 'C' && c.position !== '포수' && c.defPos !== '포수') return;
    const teamCode = getTeamCode(c.team);
    if (!teamCode) return;
    const key = `${c.name}_${teamCode}`;
    const f = SS.catcherFatigue[key] || { stamina: 100, lastDefGame: -99 };
    
    const lastDefTurn = (f.lastDefGame >= 0 && SS.schedule[f.lastDefGame]) ? SS.schedule[f.lastDefGame].turn : -99;

    if (lastDefTurn !== justFinishedTurn) {
      // 휴식일 -> 60% 회복 + 난수
      const rand = (Math.random() * 10 - 5);
      f.stamina = Math.min(100, f.stamina + 60 + rand);
    }
    SS.catcherFatigue[key] = f;
  });
};

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
  if (!f) return 1.0; // 피로도 기록 없음 = 정상 (스태미너 100%)

  // 이제 연투일(daysSince)이 아닌 실제 계산된 stamina 값을 기반으로 작동합니다.
  const st = f.stamina;

  if (st >= 80) return 1.0;
  if (st >= 50) return 1.15;
  if (st >= 30) return 1.3;
  
  // 30 미만인 경우
  if (isStarter) {
    return 99; // 등판 불가
  } else {
    return 1.5; // 방어율 대폭 하락
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

function normalizeStarterRotationIndex() {
  if (!SS.starterRotation || SS.starterRotation.length === 0) {
    SS.starterRotationIndex = 0;
    return 0;
  }
  const len = SS.starterRotation.length;
  SS.starterRotationIndex = Number(SS.starterRotationIndex) || 0;
  SS.starterRotationIndex = ((SS.starterRotationIndex % len) + len) % len;
  return SS.starterRotationIndex;
}

function getNextRotationStarterName(pitchers, teamCode) {
  initStarterRotation();
  const rotation = SS.starterRotation || [];
  if (!rotation.length) return null;
  const byName = new Map(pitchers.map(p => [p.name, p]));
  const startIdx = normalizeStarterRotationIndex();

  for (let offset = 0; offset < rotation.length; offset++) {
    const name = rotation[(startIdx + offset) % rotation.length];
    const p = byName.get(name);
    if (p && getFatigueMult(p.name, teamCode, true) < 99) return p.name;
  }

  return rotation[startIdx] || null;
}

function advanceStarterRotationAfter(name) {
  const rotation = SS.starterRotation || [];
  if (!rotation.length || !name) return;
  const idx = rotation.indexOf(name);
  if (idx === -1) return;
  SS.starterRotationIndex = (idx + 1) % rotation.length;
  saveSeasonState();
}

function pickStarterFromRotation(pitchers, teamCode) {
  initStarterRotation();
  const rotation = SS.starterRotation || [];
  if (!rotation.length) return pickStarterWithFatigue(pitchers, teamCode);

  const byName = new Map(pitchers.map(p => [p.name, p]));
  const nextName = getNextRotationStarterName(pitchers, teamCode);
  const picked = nextName ? byName.get(nextName) : null;
  if (picked) return picked;

  return pickStarterWithFatigue(pitchers, teamCode);
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

  // 피로도 반영 ERA로 정렬.
  // 주의: 여기서 객체를 복사하면({...p}) 호출 측이 원본이 아닌 사본을 받게 되어
  // usedToday·pitchCount가 실제 투수 배열에 반영되지 않는다(같은 투수 재등판·기록 유실).
  // 따라서 정렬 키만 Map에 따로 두고 원본 참조를 그대로 반환한다.
  const fatigueERA = new Map(pool.map(p => [p, p.ERA * getFatigueMult(p.name, teamCode, false)]));
  const withFatigue = [...pool].sort((a, b) => fatigueERA.get(a) - fatigueERA.get(b));

  if (inning >= 9 && scoreDiff > 0 && scoreDiff <= 3) {
    const closer = withFatigue.filter(p => fatigueERA.get(p) < 3.5);
    if (closer.length) { const p = closer[0]; p.usedToday = true; return p; }
  }
  if (inning === 8) {
    const setup = withFatigue.filter(p => fatigueERA.get(p) < 4.0);
    if (setup.length) { const p = setup[0]; p.usedToday = true; return p; }
  }
  if (inning >= 6) {
    const mid = withFatigue.filter(p => fatigueERA.get(p) < 5.0);
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
  teams.forEach(t => { st[t] = { w: 0, l: 0, d: 0, rs: 0, ra: 0, streak: 0 }; });
  return st;
}

// ── 순위 계산 ────────────────────────────────────────────
function getSortedStandings() {
  return Object.entries(SS.standings)
    .map(([team, s]) => {
      const games = s.w + s.l + s.d;
      const pct   = (s.w + s.l) > 0 ? s.w / (s.w + s.l) : 0;
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
  const pH = buildTeamPitchers(DB.pitchers.filter(r => r.team === SS.nameKor[homeTeam]));
  const pA = buildTeamPitchers(DB.pitchers.filter(r => r.team === SS.nameKor[awayTeam]));

  if (!hH.length || !hA.length) return { homeScore: 0, awayScore: 0 };

  const lH = buildLineup(hH), lA = buildLineup(hA);
  let homeScore = 0, awayScore = 0;
  let curHP = pickStarterWithFatigue(pH, homeTeam),
      curAP = pickStarterWithFatigue(pA, awayTeam);
  let homeOrder = 0, awayOrder = 0;
  const innings = { home: [], away: [] };

  // 연장 상한 (포스트시즌 무제한, 정규 11회까지).
  // 기존에는 for문이 inning <= 9로 묶여 있어 아래 연장 로직이 실행되지 못하고 동점이 그대로 무승부가 됐다.
  const maxInns = (typeof SS !== 'undefined' && SS.phase === 'postseason') ? 999 : 11;

  for (let inning = 1; ; inning++) {
    // 말 먼저: 원정 공격 (초)
    for (const side of ['top', 'bot']) {
      const isTop   = side === 'top';
      // 9회 이후 홈팀이 앞서 있으면 말 공격은 치르지 않음
      if (!isTop && inning >= 9 && homeScore > awayScore) break;

      const lineup  = isTop ? lA : lH;
      const teamCode = isTop ? homeTeam : awayTeam;
      const allP     = isTop ? pH : pA;
      let pitcher   = isTop ? curHP : curAP;
      let order     = isTop ? awayOrder : homeOrder;
      let outs = 0, bases = [null, null, null], runs = 0;

      while (outs < 3) {
        const batter = lineup[order % lineup.length];
        order++;
        const prRes = decidePAResult(batter, pitcher, bases, inning, outs, lineup);
        const pr = typeof prRes === 'object' ? prRes.type : prRes;
        // 실제 투구 시퀀스 길이만큼 투구수를 누적 → calcStamina의 입력이 됨.
        // (기존에는 반이닝당 +15구 고정이라 체력이 경기 내용과 무관했다)
        pitcher.pitchCount = (pitcher.pitchCount || 0) + buildSeq(prRes).length;
        if (pr === 'k' || pr === 'out' || pr === 'fine_play') {
          outs++;
        } else if (pr === 'dp') {
          outs = Math.min(outs + 2, 3);
          bases = [null, bases[1], bases[2]];
        } else if (pr === 'bb') {
          const res = advRunners(bases, 'bb', batter.name); bases = res.bases; runs += res.scored;
        } else if (pr === 'error') {
          const res = advRunners(bases, '1b', batter.name); bases = res.bases; runs += res.scored;
        } else {
          const res = advRunners(bases, pr, batter.name);   bases = res.bases; runs += res.scored;
        }
        // 끝내기: 9회 이후 말 공격 중 역전하면 즉시 종료 (실제 엔진과 동일)
        if (!isTop && inning >= 9 && homeScore + runs > awayScore) break;

        // 이닝 중 강판 (실제 엔진 checkChange(midInning=true)와 동일 기준)
        if (calcStamina(pitcher) < 15 || pitcher.pitchCount > 110) {
          // 진행 중인 이닝의 득점(runs)은 아직 팀 점수에 반영 전이므로 여기서 빼준다
          const lead = (isTop ? homeScore - awayScore : awayScore - homeScore) - runs;
          const rel = selectRelieverWithFatigue(allP, pitcher, inning, lead, teamCode);
          if (rel) {
            rel.pitchCount = 0;
            pitcher = rel;
            if (isTop) curHP = rel; else curAP = rel;
          }
        }
      }

      if (isTop) {
        awayScore += runs; awayOrder = order;
        innings.away.push(runs);
      } else {
        homeScore += runs; homeOrder = order;
        innings.home.push(runs);
      }

      // ── 이닝 종료 시 투수 교체 판정 (실제 엔진 checkChange와 동일 기준) ──
      const lead = isTop ? (homeScore - awayScore) : (awayScore - homeScore);
      const needChange = calcStamina(pitcher) < 30
        || (inning >= 6 && pitcher.pitchCount > 80)
        || (inning >= 9 && pitcher.isStarter);
      if (needChange) {
        if (inning > 9) allP.forEach(pp => { if (!pp.isStarter) pp.usedToday = false; });
        const rel = selectRelieverWithFatigue(allP, pitcher, inning, lead, teamCode);
        if (rel) { rel.pitchCount = 0; if (isTop) curHP = rel; else curAP = rel; }
      }
    }

    if (inning >= 9 && homeScore !== awayScore) break; // 승부 결정
    if (inning >= maxInns) break;                      // 최대 연장 도달 (무승부 가능)
  }

  // 등판 투수 피로도 기록.
  // recordPitcherFatigue가 pitchCount만큼 체력을 차감하고 미등판(pitchCount 0)은 알아서 건너뛰므로
  // 팀 투수 배열을 통째로 넘긴다. 같은 투수를 두 번 넘기면 체력이 이중 차감되니 주의.
  recordPitcherFatigue(pH, homeTeam);
  recordPitcherFatigue(pA, awayTeam);

  // 포수 피로도 기록 (라인업의 첫 번째 포수를 찾아서 차감)
  const homeCatcher = hH.find(h => h.position === 'C' || h.position === '포수' || h.defPos === '포수');
  if (homeCatcher) recordCatcherFatigue([homeCatcher], homeTeam, innings);
  
  const awayCatcher = hA.find(h => h.position === 'C' || h.position === '포수' || h.defPos === '포수');
  if (awayCatcher) recordCatcherFatigue([awayCatcher], awayTeam, innings);

  return { homeScore, awayScore, innings };
}

// ── 경기 결과를 순위표에 반영 ────────────────────────────
function applyResult(game) {
  const { home, away, result } = game;
  const hs = SS.standings[home], as = SS.standings[away];
  hs.rs += result.homeScore; hs.ra += result.awayScore;
  as.rs += result.awayScore; as.ra += result.homeScore;
  
  if (result.homeScore > result.awayScore) {
    hs.w++; as.l++;
    hs.streak = hs.streak > 0 ? hs.streak + 1 : 1;
    as.streak = as.streak < 0 ? as.streak - 1 : -1;
  } else if (result.awayScore > result.homeScore) {
    as.w++; hs.l++;
    as.streak = as.streak > 0 ? as.streak + 1 : 1;
    hs.streak = hs.streak < 0 ? hs.streak - 1 : -1;
  } else {
    hs.d++; as.d++;
    hs.streak = 0; as.streak = 0;
  }
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

// ── 투수-타자 맞대결 기록 (시즌 누적) ─────────────────────
// result: decidePAResult가 반환한 결과 코드 ('k','bb','hr','1b','2b','3b','out','dp','error','fine_play')
function recordMatchupHistory(pitcher, batter, result, rbi) {
  if (!SS.matchupHistory) SS.matchupHistory = {};
  const key = `${pitcher.name}_${pitcher.team}__${batter.name}_${batter.team}`;
  if (!SS.matchupHistory[key]) {
    SS.matchupHistory[key] = { PA: 0, AB: 0, H: 0, HR: 0, BB: 0, K: 0, RBI: 0 };
  }
  const m = SS.matchupHistory[key];
  m.PA++;
  if (result !== 'bb') m.AB++;
  if (result === '1b' || result === '2b' || result === '3b' || result === 'hr') m.H++;
  if (result === 'hr') m.HR++;
  if (result === 'bb') m.BB++;
  if (result === 'k') m.K++;
  if (rbi) m.RBI += rbi;
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
    <thead>
      <tr>
        <th class="col-rank">순위</th>
        <th class="u-left">팀명</th>
        <th>경기</th>
        <th>승</th>
        <th>패</th>
        <th>무</th>
        <th>승률</th>
        <th>GB</th>
        <th>연속</th>
      </tr>
    </thead>
    <tbody>`;
  
  let currentRank = 1;
  let previousPct = -1;
  let displayedRank = 1;

  sorted.forEach((t, i) => {
    if (t.pct !== previousPct) {
      displayedRank = currentRank;
    }
    previousPct = t.pct;
    currentRank++;

    const isMine = t.team === SS.myTeam;
    const streak = t.streak || 0;
    const streakTxt = streak === 0 ? '-' : (streak > 0 ? `${streak}승` : `${Math.abs(streak)}패`);
    const streakClass = streak > 0 ? 'streak-win' : (streak < 0 ? 'streak-loss' : '');

    h += `<tr class="${isMine ? 'my-team-row' : ''}">
      <td class="rank-cell">${displayedRank}</td>
      <td class="u-left">
        <b>${SS.nameKor[t.team] || t.team}</b>
      </td>
      <td>${t.games || (t.w+t.l+t.d)}</td>
      <td>${t.w}</td>
      <td>${t.l}</td>
      <td>${t.d}</td>
      <td>${t.pct.toFixed(3)}</td>
      <td>${t.gb}</td>
      <td class="${streakClass}">${streakTxt}</td>
    </tr>`;
  });
  h += '</tbody></table>';
  return h;
}

let tempGameSetup = { myPitcher: null, myLineup: [], wizardMode: false, currentMyGameIdx: -1 };

function renderTodayGame() {
  const curGame = SS.schedule[SS.gameIdx];
  if (!curGame) return '<div class="u-accent">시즌 종료</div>';

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
        <div class="ng-sidenote">원정 &nbsp;····&nbsp; 홈</div>
        <div class="ng-matchup ng-matchup-center">${leftKor} <span class="ng-vs">vs</span> ${rightKor}</div>
      </div>`;
  } else {
    return `
      <div class="next-game-card">
        <div class="ng-matchup ng-matchup-empty">내 팀 경기 없음</div>
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
     
     const isStarterLabel = p.isStarter ? '<span class="pick-starter-tag">선발</span>' : '';

     html += `
       <label class="pick-row${isSelected ? ' is-selected' : ''}">
         <input type="radio" name="temp-pitcher" value="${p.name}" ${isSelected ? 'checked' : ''} onchange="selectTempPitcher('${p.name}')" class="pick-radio">
         <div class="pick-main">
           <div class="pick-name pick-name-row">${formatPlayerName(p.name)} ${isStarterLabel}</div>
           <div class="pick-sub">ERA: ${p.ERA.toFixed(2)} | IP: ${p.IP.toFixed(1)}</div>
         </div>
         <div class="pick-status" style="color:${statusColor}">${mult >= 99 ? '등판불가' : mult > 1 ? '피로누적' : '정상'}</div>
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

window.confirmPitcher = async function confirmPitcher() {
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
       <div class="lnp-row">
         <div class="lnp-order">${idx+1}</div>
         <div class="lnp-main">
           <div class="lnp-name">${formatPlayerName(p.name)} <span class="lnp-pos">${p.pos}</span></div>
           <div class="lnp-sub">AVG: ${p.AVG.toFixed(3)} | HR: ${p.HR}</div>
         </div>
         <div class="lnp-move">
            <button class="btn lnp-move-btn" onclick="moveUpLineup(${idx})" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="btn lnp-move-btn" onclick="moveDownLineup(${idx})" ${idx === tempGameSetup.myLineup.length-1 ? 'disabled' : ''}>▼</button>
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

// ── 개발자 모드 전용: 내 경기 즉시 시뮬레이션 준비 ──
// executeGame()과 동일하게 앞선 타팀 경기를 먼저 처리한 뒤,
// 실제 게임 화면으로 넘어가는 대신 instantSimSeasonGame()으로 바로 진행한다.
async function executeInstantSim() {
  if (typeof isDevMode !== 'function' || !isDevMode()) return;
  const myGameIdx = tempGameSetup.currentMyGameIdx;
  if (myGameIdx === -1) return;

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
  if (advanced) saveSeasonState();

  await instantSimSeasonGame();
}

// ── 개발자 모드 전용: 내 경기를 실제 엔진으로 즉시 시뮬레이션 ──
// startSeasonGame()과 동일한 로직(투구별 판정, 라인업/투수 로테이션, 시즌 반영 훅)을
// 그대로 사용하되, 연출용 sleep()만 스킵해서 결과를 즉시 낸다.
// 게임 화면으로 전환하지 않으므로 시즌 화면에 그대로 머문 채
// 기존 GAME OVER / 턴 결과 모달이 위에 오버레이로 표시된다.
async function instantSimSeasonGame() {
  if (typeof isDevMode !== 'function' || !isDevMode()) return;
  if (!SS.schedule || SS.gameIdx >= SS.schedule.length) return;

  const game = SS.schedule[SS.gameIdx];
  const hKor = SS.nameKor[game.home];
  const aKor = SS.nameKor[game.away];

  if (!DB.hitters || DB.hitters.length === 0) {
    await loadYearData(SS.year || '2026');
  }

  // 이전에 진행 중이던 저장 게임은 무시하고 항상 새로 시작
  clearGameState();

  gs = initGame(hKor, aKor);
  if (!gs) return;
  gs._seasonGame = { gameIdx: SS.gameIdx, home: game.home, away: game.away, myTeam: SS.myTeam };

  if (typeof advanceStarterRotationAfter === 'function') {
    const myStarter = game.home === SS.myTeam ? gs.curHP : game.away === SS.myTeam ? gs.curAP : null;
    if (myStarter) advanceStarterRotationAfter(myStarter.name);
  }
  tempGameSetup = { myPitcher: null, myLineup: [], wizardMode: false, currentMyGameIdx: -1 };

  simTurbo = true;
  try {
    while (gs && !gs.gameOver) {
      await processOnePitch();
    }
  } finally {
    simTurbo = false;
  }
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
  const turnGames = SS.schedule.filter(g => g.turn === turn && g.result);
  const myTeamKor = SS.myTeamKor;
  let trs = turnGames.map(g => {
    const aName = SS.nameKor[g.away] || g.away;
    const hName = SS.nameKor[g.home] || g.home;
    const aStyled = (aName === myTeamKor) ? `<span class="u-accent">${aName}</span>` : aName;
    const hStyled = (hName === myTeamKor) ? `<span class="u-accent">${hName}</span>` : hName;
    return `<tr><td class="u-right">${aStyled}</td><td class="u-bold u-center">${g.result.awayScore} : ${g.result.homeScore}</td><td class="u-left">${hStyled}</td></tr>`;
  }).join('');
  let html = `<div class="u-center">
    <div class="turn-skip-title">종료된 경기 결과</div>
    <table class="standings-table turn-skip-table">
      ${trs}
    </table>
    <button class="btn primary btn-block" onclick="closeTurnModal()">확인</button>
  </div>`;
  const m = document.getElementById('turn-modal');
  m.querySelector('.turn-modal-inner').innerHTML = html;
  m.style.display = 'flex';

  // 턴 내 모든 경기가 종료되었으므로 글로벌 회복 로직 실행 (showTurnResults와 동일)
  if (typeof processTurnFatigueRecovery === 'function') {
    processTurnFatigueRecovery();
  }
  saveSeasonState();
}


// ── 일정 표시 ──────────────────────────────────────────────

function renderUpcomingTurns() {
  if (!SS.schedule || !SS.schedule.length) return '';
  const myTeam = SS.myTeam;

  const curGame = SS.schedule[Math.min(SS.gameIdx, SS.schedule.length - 1)];
  const actualCurTurn = curGame ? curGame.turn : 144;

  // 5칸 고정: 이전 2턴 ~ 현재 ~ 이후 2턴
  const COLS = 5;
  const half = Math.floor(COLS / 2); // 2
  const colWidthPct = Math.floor(100 / COLS);

  let html = `<div class="weekly-cal"><div class="wc-grid wc-grid-turns" style="grid-template-columns:repeat(${COLS},1fr)">`;

  for (let i = -half; i <= half; i++) {
    const turnVal = actualCurTurn + i;

    if (turnVal < 1 || turnVal > 144) {
      html += `<div class="wc-cell wc-cell-turn wc-cell-blank"></div>`;
      continue;
    }

    const games = SS.schedule.filter(g => g.turn === turnVal);
    const isToday = turnVal === actualCurTurn;
    const cellClass = 'wc-cell' + (isToday ? ' wc-today' : '');

    html += `<div class="${cellClass} wc-cell-turn"><div class="wc-date">T${turnVal}</div>`;

    if (!games.length) {
      html += `<div class="wc-rest wc-rest-sm">휴식</div></div>`;
      continue;
    }

    let gHtml = `<div class="wc-games">`;
    games.sort((a,b) => {
      const aMine = (a.home===myTeam||a.away===myTeam)?1:0;
      const bMine = (b.home===myTeam||b.away===myTeam)?1:0;
      return bMine - aMine;
    }).forEach(game => {
      const isMyMatch = (game.home===myTeam||game.away===myTeam);
      const hKor = SS.nameKor[game.home]||game.home;
      const aKor = SS.nameKor[game.away]||game.away;
      const matchCls = 'wc-match wc-match-mini' + (isMyMatch ? ' wc-match-mine' : '');

      if (game.result) {
        const hs = game.result.homeScore;
        const as = game.result.awayScore;
        const resultClass = isMyMatch
          ? ((game.home===myTeam&&hs>as)||(game.away===myTeam&&as>hs) ? 'wc-win'
          : (hs===as ? 'wc-draw' : 'wc-loss')) : '';
        gHtml += `<div class="${matchCls}">${aKor} <span class="wc-score ${resultClass}">${as} vs ${hs}</span> ${hKor}</div>`;
      } else {
        gHtml += `<div class="${matchCls}">${aKor} vs ${hKor}</div>`;
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

  const turnGames = SS.schedule.filter(g => g.turn === myTurn);

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
    const hName = SS.nameKor[g.home] || g.home;
    const aName = SS.nameKor[g.away] || g.away;
    const myTeamKor = SS.myTeamKor;
    const aStyled = (aName === myTeamKor) ? `<span class="u-accent">${aName}</span>` : aName;
    const hStyled = (hName === myTeamKor) ? `<span class="u-accent">${hName}</span>` : hName;

    otherRows += `
      <tr>
        <td class="u-right">${aStyled}</td>
        <td class="u-bold u-center">${g.result.awayScore} : ${g.result.homeScore}</td>
        <td class="u-left">${hStyled}</td>
      </tr>`;
  });

  const modal = document.getElementById('turn-modal');
  let html = `<div class="u-center">
    <div class="turn-skip-title">종료된 경기 결과</div>
    <table class="standings-table turn-skip-table">
      ${otherRows}
    </table>
    <button class="btn primary btn-block" onclick="closeTurnModal()">확인</button>
  </div>`;
  modal.querySelector('.turn-modal-inner').innerHTML = html;

  modal.style.display = 'flex';
  
  // 턴 내 모든 경기가 종료(시뮬)되었으므로 여기서 글로벌 회복 로직 실행
  if (typeof processTurnFatigueRecovery === 'function') {
    processTurnFatigueRecovery();
  }
  
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
  document.getElementById('champion-modal').classList.remove('show');
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
    if (SS.starterRotation.length > 0) {
      normalizeStarterRotationIndex();
      return;
    }
  }

  // 초기화: 선발 판정·최소 인원 보장을 buildTeamPitchers와 동일한 규칙으로 처리한 뒤 ERA 순 배정.
  // (직접 IP/G를 계산하면 경기 엔진의 isStarter 판정과 어긋나므로 반드시 같은 경로를 쓴다)
  SS.starterRotation = buildTeamPitchers(allPitchers)
    .filter(p => p.isStarter)
    .sort((a, b) => a.ERA - b.ERA)
    .map(p => p.name);
  normalizeStarterRotationIndex();
}

// ── 투수 피로 정보 계산 헬퍼 ─────────────────────────────────
function getPitcherFatigueInfo(p, teamCode, isStarter) {
  const key       = `${p.name}_${teamCode}`;
  const f         = SS.pitcherFatigue[key];
  const mult      = getFatigueMult(p.name, teamCode, isStarter);
  const daysSince = f ? SS.gameIdx - f.lastGame : 99;
  
  // 실제 추적 중인 스태미너 사용
  let staminaPct = f ? Math.round(f.stamina) : 100;

  let status = '', statusColor = 'var(--accent3)';
  if (isStarter) {
    if (staminaPct < 30)       { status = '등판불가'; statusColor = 'var(--accent2)'; }
    else if (staminaPct < 100) { status = `체력 ${staminaPct}%`; statusColor = 'var(--accent)'; }
    else                       { status = '정상';       statusColor = 'var(--accent3)'; }
  } else {
    // 연투일은 단순 표시용으로 사용
    if (staminaPct < 50)       { status = (f && f.consecDays >= 2) ? `${f.consecDays}연투` : '체력 저하'; statusColor = 'var(--accent2)'; }
    else if (staminaPct < 80)  { status = (f && f.consecDays >= 1) ? `${f.consecDays}연투` : '보통'; statusColor = 'var(--accent)'; }
    else                       { status = '정상';   statusColor = 'var(--accent3)'; }
  }

  const stColor = staminaPct >= 80 ? 'var(--accent3)' : staminaPct >= 50 ? 'var(--accent)' : 'var(--accent2)';
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

  // 다음 경기 선발: 로테이션 포인터부터 등판 가능한 첫 번째
  const nextStarterName = getNextRotationStarterName(starters, teamCode) || (starters[0] && starters[0].name);

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
    const isNext = p.name === nextStarterName;
    const nextBadge = isNext ? `<span class="fatig-badge-next">다음 선발</span>` : '';

    starterRows += `
      <div class="fatig-row rot-item${isNext ? ' is-next' : ''}" data-idx="${idx}">
        <div class="rot-handle">
          <svg width="14" height="12" viewBox="0 0 16 14" fill="currentColor"><rect y="0" width="16" height="2" rx="1"/><rect y="6" width="16" height="2" rx="1"/><rect y="12" width="16" height="2" rx="1"/></svg>
        </div>
        <div class="fatig-rank">${idx + 1}</div>
        <div class="fatig-main">
          <div class="fatig-name-row">
            <span class="fatig-name">${formatPlayerName(p.name)}</span>
            ${nextBadge}
          </div>
          <div class="fatig-era">ERA ${p.ERA ? p.ERA.toFixed(2) : '-'} · IP ${p.IP ? p.IP.toFixed(1) : 0}</div>
        </div>
        <div class="fatig-right">
          <div class="fatig-gauge-col">
            <div class="fatig-gauge">
              <div class="fatig-gauge-fill" style="background:${stColor};width:${staminaPct}%"></div>
            </div>
            <div class="fatig-status" style="color:${statusColor}">${status}</div>
          </div>
          <button class="fatig-move-btn" onclick="fatigMoveToReliever('${p.name}')" title="불펜으로 이동">불펜↓</button>
        </div>
      </div>`;
  });

  if (!starterRows) starterRows = `<div class="fatig-empty">선발 투수 없음</div>`;

  // ── 불펜 행 렌더링
  let relieverRows = '';
  relievers.forEach(p => {
    const { staminaPct, status, statusColor, stColor } = getPitcherFatigueInfo(p, teamCode, false);
    const roleLabel = p.ERA < 3.0 ? '마무리' : p.ERA < 4.0 ? '셋업' : '계투';
    const roleCls   = p.ERA < 3.0 ? 'role-closer' : p.ERA < 4.0 ? 'role-setup' : 'role-mid';

    relieverRows += `
      <div class="fatig-row">
        <div class="fatig-main">
          <div class="fatig-name-row">
            <span class="fatig-name">${formatPlayerName(p.name)}</span>
            <span class="fatig-role ${roleCls}">${roleLabel}</span>
          </div>
          <div class="fatig-era">ERA ${p.ERA ? p.ERA.toFixed(2) : '-'} · IP ${p.IP ? p.IP.toFixed(1) : 0}</div>
        </div>
        <div class="fatig-right">
          <div class="fatig-gauge-col">
            <div class="fatig-gauge">
              <div class="fatig-gauge-fill" style="background:${stColor};width:${staminaPct}%"></div>
            </div>
            <div class="fatig-status" style="color:${statusColor}">${status}</div>
          </div>
          <button class="fatig-move-btn" onclick="fatigMoveToStarter('${p.name}')" title="선발로 이동">선발↑</button>
        </div>
      </div>`;
  });

  if (!relieverRows) relieverRows = `<div class="fatig-empty">불펜 투수 없음</div>`;

  return `
    <div class="fatig-card">
      <div class="fatig-head">
        <span class="fatig-head-title">선발 로테이션</span>
        <span class="fatig-head-hint">≡ 드래그로 순서 변경</span>
      </div>
      <div id="rotation-list">${starterRows}</div>
    </div>
    <div class="fatig-card">
      <div class="fatig-head">
        <span class="fatig-head-title">불펜</span>
        <span class="fatig-head-hint">상태 · 역할 · 체력순</span>
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
        normalizeStarterRotationIndex();
        saveSeasonState();
        const fatigueEl = document.getElementById('season-fatigue');
        if (fatigueEl) { fatigueEl.innerHTML = renderFatiguePanel(); setupRotationDrag(); }
      }
    });
  });
}

window.fatigMoveToReliever = function(name) {
  SS.starterRotation = (SS.starterRotation || []).filter(n => n !== name);
  normalizeStarterRotationIndex();
  saveSeasonState();
  const el = document.getElementById('season-fatigue');
  if (el) { el.innerHTML = renderFatiguePanel(); setupRotationDrag(); }
};

window.fatigMoveToStarter = function(name) {
  if (!SS.starterRotation) SS.starterRotation = [];
  if (!SS.starterRotation.includes(name)) SS.starterRotation.push(name);
  normalizeStarterRotationIndex();
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
  const simBtn = document.getElementById('season-instant-sim-btn');
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
    if (simBtn) simBtn.classList.remove('visible');
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

  // 개발자 모드 + 내 경기가 있을 때만 즉시 시뮬레이션 버튼 노출
  if (simBtn) {
    const showSimBtn = hasMyGame && typeof isDevMode === 'function' && isDevMode();
    simBtn.classList.toggle('visible', showSimBtn);
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

  if (!SS.myTeamKor) { el.innerHTML = '<div class="lnp-editor-empty">시즌 시작 후 사용 가능합니다</div>'; return; }
  if (tempGameSetup.myLineup.length === 0) {
    const hH = DB.hitters.filter(r => r.team === SS.myTeamKor).map(buildHitter).sort((a,b) => b.G - a.G);
    tempGameSetup.myLineup = buildLineup(hH);
  }

  let html = `<div id="lineup-drag-list">`;

  tempGameSetup.myLineup.forEach((p, idx) => {
    html += `<div class="lnp-drag-item" data-idx="${idx}">
      <div class="drag-handle drag-handle-row" data-idx="${idx}">
        <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor">
          <rect y="0" width="16" height="2" rx="1"/>
          <rect y="6" width="16" height="2" rx="1"/>
          <rect y="12" width="16" height="2" rx="1"/>
        </svg>
        <span class="lnp-edit-order">${idx+1}</span>
      </div>
      <div class="lnp-edit-main">
        <div class="lnp-edit-name">${formatPlayerName(p.name)} <span class="lnp-edit-pos">${p.pos}</span></div>
        <div class="lnp-edit-sub">AVG:${p.AVG.toFixed(3)} HR:${p.HR} RBI:${p.RBI}</div>
      </div>
    </div>`;
  });

  html += `</div>`;
  el.innerHTML = html;
  setupLnpPointerDrag();
}

let _lnpSelectedIdx = -1;

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

  const devEl = document.getElementById('season-dev-panel');
  if (devEl) devEl.innerHTML = renderDevPanel('season');

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

// ── 내 팀 경기 직접 플레이 ───────────────────────────────
// matchup을 넘기면 그 대진으로 진행한다(포스트시즌용).
// 생략하면 기존처럼 정규시즌 일정에서 현재 경기를 읽는다.
// 포스트시즌에는 SS.gameIdx가 일정 배열 끝을 가리키므로 반드시 matchup을 넘겨야 한다.
async function startSeasonGame(matchup) {
  const game = matchup || SS.schedule[SS.gameIdx];
  if (!game || !game.home || !game.away) {
    alert('진행할 경기 정보를 찾을 수 없습니다.');
    return;
  }
  const hKor   = SS.nameKor[game.home];
  const aKor   = SS.nameKor[game.away];

  // 로딩
  const loadingEl = document.getElementById('loading');
  loadingEl.style.display = 'flex';
  document.getElementById('loading-text').textContent = '데이터 로딩 중...';
  document.getElementById('loading-sub').textContent  = `${aKor} vs ${hKor}`;

  if (!DB.hitters || DB.hitters.length === 0) {
    await loadYearData(SS.year || '2026');
  }

  loadingEl.style.display = 'none';
  document.getElementById('season-screen').style.display = 'none';
  document.getElementById('game-bottom-nav').style.display = 'flex';

  // 기존 게임 시작 함수 활용
  gs = initGame(hKor, aKor);
  if (!gs) return;
  const hadSavedGame = hasSavedGame(game);

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

  if (!hadSavedGame && typeof advanceStarterRotationAfter === 'function') {
    const myStarter = game.home === SS.myTeam ? gs.curHP : game.away === SS.myTeam ? gs.curAP : null;
    if (myStarter) advanceStarterRotationAfter(myStarter.name);
  }

  // 게임 종료 콜백 등록 (시즌 결과 반영용).
  // 포스트시즌은 일정 인덱스가 없으므로 psStage로 어느 시리즈인지 표시한다.
  gs._seasonGame = game.psStage
    ? { psStage: game.psStage, home: game.home, away: game.away, myTeam: SS.myTeam }
    : { gameIdx: SS.gameIdx, home: game.home, away: game.away, myTeam: SS.myTeam };

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
  const mobileHomeLnpTab = document.getElementById('mobile-home-lineup-tab');
  if (mobileHomeLnpTab) mobileHomeLnpTab.textContent = hKor;
  const mobileAwayLnpTab = document.getElementById('mobile-away-lineup-tab');
  if (mobileAwayLnpTab) mobileAwayLnpTab.textContent = aKor;
  if (typeof setTeamColorVars === 'function') {
    setTeamColorVars(homeLnpTitle, hKor);
    setTeamColorVars(awayLnpTitle, aKor);
    setTeamColorVars(mobileHomeLnpTab, hKor);
    setTeamColorVars(mobileAwayLnpTab, aKor);
  }
  

  document.getElementById('game-log').innerHTML             = '';
  document.getElementById('game-over').classList.remove('show');
  document.getElementById('go-ext-label').innerHTML         = '';


  // 저장된 게임 상태 복원 (중단된 경기 이어하기)
  if (hasSavedGame(game)) {
    if (confirm('진행 중인 경기가 있습니다. 이어서 하시겠습니까?\n취소하면 새로 시작합니다.')) {
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
}
  updateGameUI(); updateLnpUI(); updateSbUI(); updateSituationBar();
  addLog(`⚾ ${SS.year}시즌 ${SS.gameIdx + 1}번째 경기 · ${aKor} vs ${hKor}`, '');

  // 경기 시작 VS 연출
  const isPost = typeof SS !== 'undefined' && SS.phase === 'postseason';
  const subTag = isPost ? 'POSTSEASON' : `${SS.year || ''} REGULAR SEASON`;
  if (typeof doGameStartEffect === 'function') {
    await doGameStartEffect(aKor, hKor, subTag);
  }
  startPA();
}

// ── 게임 화면에서 시즌으로 돌아가기 ─────────────────────────
window.returnToSeason = function() {
  if (gs && !gs.gameOver) {
    if (!confirm('경기를 중단하고 시즌 화면으로 돌아갈까요?\n현재까지의 진행 상황은 저장됩니다.')) return;
  }
  stopPlay();
  if (typeof saveGameState === 'function') saveGameState();
  
  document.getElementById('game-over').classList.remove('show');
  document.getElementById('game-bottom-nav').style.display = 'none';
  if (typeof closeMobileLineupSheet === 'function') closeMobileLineupSheet();
  showSeasonScreen();

  // 전면 광고 노출
  if (typeof AdManager !== 'undefined') {
    AdManager.showInterstitial();
  }
};

// ── 시즌 경기 종료 후 처리 (endGame() 훅) ───────────────
function onSeasonGameEnd(homeScore, awayScore) {
  if (!gs || !gs._seasonGame) return;
  const { gameIdx, home, away, psStage } = gs._seasonGame;

  // 선수 기록·투수 피로도는 정규시즌/포스트시즌 공통
  recordPlayerStats([...gs.homeLineup, ...gs.awayLineup]);
  const homePitched = gs.homePitchers.filter(p => p.pitchCount > 0);
  const awayPitched = gs.awayPitchers.filter(p => p.pitchCount > 0);
  recordPitcherFatigue(homePitched, home);
  recordPitcherFatigue(awayPitched, away);

  // 포스트시즌은 일정·순위표를 건드리지 않고 시리즈 전적만 갱신한다
  if (psStage) {
    onPostseasonGameEnd(psStage, homeScore, awayScore);
    return;
  }

  const game = SS.schedule[gameIdx];
  game.result = { homeScore, awayScore };
  applyResult(game);

  // 턴 내의 모든 경기 완료 처리 및 인덱스 이동
  const currentTurn = game.turn;
  for (let i = gameIdx; i < SS.schedule.length; i++) {
    if (SS.schedule[i].turn === currentTurn) {
      SS.gameIdx = i + 1;
    } else {
      break;
    }
  }

  clearGameState();   // 경기 종료 → 게임 저장 확실히 삭제
  saveSeasonState();  // 시즌 데이터 즉시 저장
  
  // 턴 결과 모달 표시 (같은 턴 타 팀 경기 자동 시뮬 포함)
  showTurnResults(gameIdx);
}

// 시리즈 승자로 다음 단계 상대를 채운다
function advancePostseasonBracket(stage) {
  const ps = SS._ps;
  const s = ps[stage];
  if (!s || !s.done) return;
  const winner = s.wins[0] >= s.needed ? s.home : s.away;
  if (stage === 'wc')   ps.semi.away = winner;
  if (stage === 'semi') ps.play.away = winner;
  if (stage === 'play') ps.ks.away   = winner;
}

// ── 내 팀 포스트시즌 경기 종료 처리 ──────────────────────
function onPostseasonGameEnd(stage, homeScore, awayScore) {
  const s = SS._ps && SS._ps[stage];
  if (!s) return;

  s.games.push({ homeScore, awayScore });
  if (homeScore > awayScore) s.wins[0]++;
  else if (awayScore > homeScore) s.wins[1]++;   // 무승부는 재경기
  if (s.wins[0] >= s.needed || s.wins[1] >= s.needed) s.done = true;
  advancePostseasonBracket(stage);

  clearGameState();
  saveSeasonState();

  document.getElementById('game-over').classList.remove('show');
  document.getElementById('game-bottom-nav').style.display = 'none';
  if (typeof closeMobileLineupSheet === 'function') closeMobileLineupSheet();

  showPostseasonScreen();
  // 한국시리즈가 끝났다면 그 위에 우승 팝업을 띄운다
  if (stage === 'ks' && s.done) checkSeasonChampion();
}

// ── 포스트시즌 화면 ──────────────────────────────────────
// 이미 진행 중인 대진표가 있으면 유지한다.
// (매번 buildPostseason으로 새로 만들면 시리즈 전적이 초기화된다)
function showPostseasonScreen() {
  if (!SS._ps) SS._ps = buildPostseason();
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
    // 우승이 확정된 한국시리즈는 흐리게 처리하지 않고 강조한다
    const champ = stage === 'ks' && s.done ? getSeriesWinner(s) : null;
    const cls = champ ? 'ps-champ' : (s.done ? 'ps-done' : '');
    h += `<div class="ps-series ${cls}" id="ps-${stage}">
      <div class="ps-label">${s.label} (${s.needed}승제)</div>
      <div class="ps-matchup">${aKor} <span>${s.wins[1]}</span> : <span>${s.wins[0]}</span> ${hKor}</div>
      <div class="ps-status">${done}</div>
      ${(!s.done && s.home && s.away)
        ? `<button class="btn primary" onclick="playPsSeries('${stage}')">경기 진행</button>`
        : ''}
      ${champ ? `<div class="ps-champ-tag">🏆 ${SS.nameKor[champ] || champ} 우승</div>` : ''}
    </div>`;
  });
  el.innerHTML = h;

  const devEl = document.getElementById('ps-dev-panel');
  if (devEl) devEl.innerHTML = renderDevPanel('postseason');
}

async function playPsSeries(stage) {
  const ps   = SS._ps;
  const s    = ps[stage];
  const isMine = s.home === SS.myTeam || s.away === SS.myTeam;
  if (!s || s.done || !s.home || !s.away) return;

  if (isMine) {
    // 직접 플레이 (1경기). 대진을 명시적으로 넘겨야 한다 —
    // 포스트시즌에는 SS.gameIdx가 일정 배열 범위를 벗어나 있다.
    document.getElementById('postseason-screen').style.display = 'none';
    await startSeasonGame({ home: s.home, away: s.away, psStage: stage });
    // 결과 반영은 onSeasonGameEnd → onPostseasonGameEnd에서
  } else {
    // 자동 진행: 시리즈 끝날 때까지
    while (!s.done) simSeriesGame(s, SS.myTeam);
    advancePostseasonBracket(stage);
    checkSeasonChampion();
    saveSeasonState();
    renderPostseasonUI();
  }
}

// ═══════════════════════════════════════════════════════
//  시즌 종료 — 우승 판정 및 이벤트 팝업
// ═══════════════════════════════════════════════════════

// 시리즈 승자 팀 코드. 아직 안 끝났으면 null.
function getSeriesWinner(s) {
  if (!s || !s.done) return null;
  return s.wins[0] >= s.needed ? s.home : s.away;
}

// 한국시리즈가 끝났으면 우승팀을 확정하고 팝업을 띄운다.
// 자동 진행/직접 플레이 양쪽 경로에서 모두 호출된다.
function checkSeasonChampion() {
  if (!SS._ps || !SS._ps.ks) return null;
  const winner = getSeriesWinner(SS._ps.ks);
  if (!winner) return null;

  if (SS.champion !== winner) {
    SS.champion = winner;
    SS.championShown = false;
  }
  SS.phase = 'done';

  if (!SS.championShown) {
    SS.championShown = true;
    saveSeasonState();
    showChampionModal(winner);
  }
  return winner;
}

// 우승팀의 정규시즌 성적 + 한국시리즈 전적을 모아 팝업에 넘길 값으로 만든다.
function buildChampionSummary(teamCode) {
  const st = (SS.standings && SS.standings[teamCode]) || { w: 0, l: 0, d: 0, rs: 0, ra: 0 };
  const ks = (SS._ps && SS._ps.ks) || { wins: [0, 0], games: [], home: null };
  const isHome = ks.home === teamCode;
  const seriesW = isHome ? ks.wins[0] : ks.wins[1];
  const seriesL = isHome ? ks.wins[1] : ks.wins[0];

  const ranked = getSortedStandings();
  const seed = ranked.findIndex(t => t.team === teamCode) + 1;

  return {
    teamCode,
    teamKor: (SS.nameKor && SS.nameKor[teamCode]) || teamCode,
    year: SS.year || '',
    w: st.w, l: st.l, d: st.d,
    pct: (st.w + st.l) > 0 ? st.w / (st.w + st.l) : 0,
    seed: seed > 0 ? seed : '-',
    seriesW, seriesL,
    seriesGames: ks.games ? ks.games.length : 0,
  };
}

// 우승팀에서 시즌 누적 성적이 가장 좋은 타자를 뽑는다 (SS.playerStats 기반).
// playerStats는 한국어 팀명으로 저장되므로 nameKor로 맞춘다.
function pickChampionMVP(teamCode) {
  const teamKor = (SS.nameKor && SS.nameKor[teamCode]) || teamCode;
  const rows = Object.values(SS.playerStats || {})
    .filter(p => p.team === teamKor && (p.PA || 0) >= 30);
  if (!rows.length) return null;
  // 간이 지표: 안타 + 홈런*3 + 타점*1.2
  rows.sort((a, b) =>
    ((b.H || 0) + (b.HR || 0) * 3 + (b.RBI || 0) * 1.2) -
    ((a.H || 0) + (a.HR || 0) * 3 + (a.RBI || 0) * 1.2));
  const p = rows[0];
  const ab = Math.max((p.PA || 0) - (p.BB || 0), 1);
  return { name: p.name, avg: ((p.H || 0) / ab).toFixed(3).replace(/^0/, ''), HR: p.HR || 0, RBI: p.RBI || 0 };
}

function showChampionModal(teamCode) {
  const modal = document.getElementById('champion-modal');
  const inner = document.getElementById('champion-inner');
  if (!modal || !inner) return;

  const c = buildChampionSummary(teamCode);
  const isMine = teamCode === SS.myTeam;
  const mvp = pickChampionMVP(teamCode);

  inner.className = 'champ-inner' + (isMine ? ' champ-mine' : '');
  inner.innerHTML = `
    <div class="champ-year">${c.year} SEASON</div>
    <div class="champ-label">한국시리즈 우승</div>
    <div class="champ-trophy">🏆</div>
    <div class="champ-team">${c.teamKor}</div>
    <div class="champ-sub">${isMine
      ? '우리 팀이 정상에 올랐습니다!'
      : `${c.teamKor}가 올 시즌 정상에 올랐습니다.`}</div>
    <div class="champ-stats">
      <div class="champ-stat"><div class="champ-stat-v">${c.seed}</div><div class="champ-stat-l">정규시즌</div></div>
      <div class="champ-stat"><div class="champ-stat-v">${c.w}-${c.l}-${c.d}</div><div class="champ-stat-l">정규 전적</div></div>
      <div class="champ-stat"><div class="champ-stat-v">${c.seriesW}-${c.seriesL}</div><div class="champ-stat-l">KS 전적</div></div>
    </div>
    ${mvp ? `<div class="champ-mvp">
      <div class="champ-mvp-l">시즌 최고 타자</div>
      <div class="champ-mvp-n">${mvp.name}</div>
      <div class="champ-mvp-s">타율 ${mvp.avg} · ${mvp.HR}홈런 · ${mvp.RBI}타점</div>
    </div>` : ''}
    <div class="champ-btns">
      <button class="btn primary" onclick="closeChampionModal()">확인</button>
    </div>`;

  modal.classList.add('show');
  if (isMine) playChampionEffects();
}

// 내 팀 우승 전용 연출: 회전 광선 + 중앙 폭발 + 색종이
function playChampionEffects() {
  const fx = document.getElementById('champion-fx');
  if (!fx) return;
  fx.innerHTML = '';

  if (typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const burst = document.createElement('div');
  burst.className = 'champ-burst';
  fx.appendChild(burst);

  for (let i = 0; i < 10; i++) {
    const ray = document.createElement('div');
    ray.className = 'champ-ray';
    ray.style.transform = `translate(-50%,0) rotate(${i * 36}deg)`;
    ray.style.animationDelay = `${-i * 1.4}s`;
    fx.appendChild(ray);
  }

  // 색상은 .confetti-c1 ~ c6 클래스로 정의되어 있다 (season.css)
  const COLOR_VARIANTS = 6;
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('div');
    p.className = `confetti confetti-c${(i % COLOR_VARIANTS) + 1}`;
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (2.4 + Math.random() * 2.2) + 's';
    p.style.animationDelay = (Math.random() * 2.4) + 's';
    p.style.width = (6 + Math.random() * 6) + 'px';
    p.style.height = (10 + Math.random() * 10) + 'px';
    fx.appendChild(p);
  }
}

window.closeChampionModal = function() {
  const modal = document.getElementById('champion-modal');
  if (!modal) return;
  modal.classList.remove('show');
  const fx = document.getElementById('champion-fx');
  if (fx) fx.innerHTML = '';   // 애니메이션 노드 정리
  showPostseasonScreen();
};

// ═══════════════════════════════════════════════════════
//  개발자 모드 전용 — 시즌 막바지 테스트 도구
// ═══════════════════════════════════════════════════════

function devEnabled() {
  return typeof isDevMode === 'function' && isDevMode();
}

// 내 팀의 마지막 정규시즌 경기가 속한 턴의 시작 인덱스.
// 그 턴 앞까지만 시뮬레이션하면 "최종전 1경기 전" 상태가 된다.
function findFinalGameTurnStart() {
  if (!SS.schedule || !SS.schedule.length) return -1;
  let lastMyIdx = -1;
  for (let i = SS.schedule.length - 1; i >= 0; i--) {
    const g = SS.schedule[i];
    if (g.home === SS.myTeam || g.away === SS.myTeam) { lastMyIdx = i; break; }
  }
  if (lastMyIdx < 0) return -1;
  const targetTurn = SS.schedule[lastMyIdx].turn;
  let start = lastMyIdx;
  while (start > 0 && SS.schedule[start - 1].turn === targetTurn) start--;
  return start;
}

// 시즌 종료 1경기 전(내 팀 최종전 턴)까지 한 번에 진행한다.
window.devFastForwardToFinalGame = function() {
  if (!devEnabled()) return;
  const stopIdx = findFinalGameTurnStart();
  if (stopIdx < 0) { alert('일정을 찾을 수 없습니다.'); return; }
  if (SS.gameIdx >= stopIdx) { alert('이미 최종전 턴입니다.'); return; }

  const games = stopIdx - SS.gameIdx;
  const turns = SS.schedule[stopIdx].turn - SS.schedule[SS.gameIdx].turn;
  if (!confirm(`남은 ${turns}턴 (${games}경기)을 한 번에 시뮬레이션합니다.\n내 팀 최종전 직전에서 멈춥니다.\n\n계속할까요?`)) return;

  const t0 = Date.now();
  let curTurn = SS.schedule[SS.gameIdx].turn;
  for (let i = SS.gameIdx; i < stopIdx; i++) {
    const g = SS.schedule[i];
    // 턴이 바뀌는 순간 직전 턴 기준으로 피로도를 회복시킨다
    // (processTurnFatigueRecovery는 SS.gameIdx-1의 턴을 "방금 끝난 턴"으로 본다)
    if (g.turn !== curTurn) {
      SS.gameIdx = i;
      if (typeof processTurnFatigueRecovery === 'function') processTurnFatigueRecovery();
      curTurn = g.turn;
    }
    if (!g.result) {
      g.result = simGameFast(g.home, g.away);
      applyResult(g);
    }
  }
  SS.gameIdx = stopIdx;
  if (typeof processTurnFatigueRecovery === 'function') processTurnFatigueRecovery();

  clearGameState();
  saveSeasonState();
  refreshSeasonUI();
  alert(`${games}경기 시뮬레이션 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초)\n` +
        `이제 ${SS.schedule[stopIdx].turn}턴 — 내 팀 최종전입니다.`);
};

// 내 팀이 우승할 수 있는 데이터를 만든다.
// 정규시즌 전 경기를 내 팀 우위로 재작성하고, 한국시리즈 3승 0패까지 채워
// 1경기만 이기면 우승이 확정되는 상태로 만든다.
window.devSetupChampionshipRun = function() {
  if (!devEnabled()) return;
  if (!SS.schedule || !SS.schedule.length) { alert('시즌 데이터가 없습니다.'); return; }
  if (!confirm(
    '내 팀이 "우승 직전"인 상태로 시즌 데이터를 덮어씁니다.\n\n' +
    '· 정규시즌 144경기 결과를 내 팀 우위로 재작성 (1위 확정)\n' +
    '· 하위 시리즈는 자동 소화\n' +
    '· 한국시리즈 3승 0패 — 1승만 남은 상태\n\n' +
    '현재 시즌 기록은 사라집니다. 계속할까요?')) return;

  // 1) 팀별 전력 순서: 내 팀이 최상위
  const order = [SS.myTeam, ...SS.teams.filter(t => t !== SS.myTeam)];
  const strength = {};
  order.forEach((t, i) => { strength[t] = order.length - i; });

  // 2) 정규시즌 전 경기 재작성 (7경기마다 이변을 넣어 전적이 극단으로 가지 않게 한다)
  SS.standings = initStandings(SS.teams);
  SS.schedule.forEach((g, i) => {
    const favHome = strength[g.home] > strength[g.away];
    const homeWin = (i % 7 === 0) ? !favHome : favHome;
    g.result = homeWin ? { homeScore: 5, awayScore: 3 } : { homeScore: 2, awayScore: 6 };
    applyResult(g);
  });
  SS.gameIdx = SS.schedule.length;
  SS.phase   = 'postseason';

  // 3) 대진표를 새로 만들고 하위 시리즈를 홈 팀 승리로 소화
  SS.champion = null;
  SS.championShown = false;
  SS._ps = buildPostseason();
  ['wc', 'semi', 'play'].forEach(stage => {
    const s = SS._ps[stage];
    while (!s.done) {
      s.games.push({ homeScore: 4, awayScore: 2 });
      s.wins[0]++;
      if (s.wins[0] >= s.needed) s.done = true;
    }
    advancePostseasonBracket(stage);
  });

  // 4) 한국시리즈: 1위(=내 팀)가 홈이므로 wins[0]이 내 팀 승수
  const ks = SS._ps.ks;
  ks.wins = [3, 0];
  ks.games = [
    { homeScore: 5, awayScore: 2 },
    { homeScore: 3, awayScore: 1 },
    { homeScore: 7, awayScore: 4 },
  ];

  clearGameState();
  saveSeasonState();

  document.getElementById('season-screen').style.display = 'none';
  showPostseasonScreen();

  const st = SS.standings[SS.myTeam];
  alert(`준비 완료.\n\n정규시즌 ${st.w}승 ${st.l}패 ${st.d}무 → 1위\n` +
        `한국시리즈 3승 0패 — [경기 진행]으로 1승만 더 하면 우승입니다.`);
};

// 우승 팝업만 미리 확인 (시즌 데이터는 건드리지 않는다)
window.devPreviewChampion = function(which) {
  if (!devEnabled()) return;
  if (!SS._ps) SS._ps = buildPostseason();
  const team = which === 'other'
    ? (SS.teams.find(t => t !== SS.myTeam) || SS.myTeam)
    : SS.myTeam;
  showChampionModal(team);
};

function renderDevPanel(context) {
  if (!devEnabled()) return '';

  if (context === 'postseason') {
    return `<div class="dev-panel dev-panel-ps">
      <div class="dev-panel-title">DEBUG</div>
      <div class="dev-panel-btns">
        <button class="dev-btn" onclick="devSetupChampionshipRun()">🏆 우승 직전 상태</button>
        <button class="dev-btn alt" onclick="devPreviewChampion('mine')">팝업(내 팀)</button>
        <button class="dev-btn alt" onclick="devPreviewChampion('other')">팝업(타 팀)</button>
      </div>
    </div>`;
  }

  const stopIdx = findFinalGameTurnStart();
  const canFF = stopIdx >= 0 && SS.gameIdx < stopIdx;
  const left  = canFF ? (stopIdx - SS.gameIdx) : 0;

  return `<div class="dev-panel">
    <div class="dev-panel-title">DEBUG — 시즌 막바지 테스트</div>
    <div class="dev-panel-btns">
      <button class="dev-btn" onclick="devFastForwardToFinalGame()" ${canFF ? '' : 'disabled'}>
        ⏭ 최종전까지 (${left}경기)
      </button>
      <button class="dev-btn" onclick="devSetupChampionshipRun()">🏆 우승 직전 상태</button>
    </div>
    <div class="dev-panel-btns">
      <button class="dev-btn alt" onclick="devPreviewChampion('mine')">팝업(내 팀)</button>
      <button class="dev-btn alt" onclick="devPreviewChampion('other')">팝업(타 팀)</button>
    </div>
    <div class="dev-note">개발자 모드에서만 보입니다. 우승 직전 상태는 시즌 기록을 덮어씁니다.</div>
  </div>`;
}

// ── AdMob 광고 매니저 ──────────────────────────────────────
const AdManager = {
  isInitialized: false,
  hasInterstitial: false,
  hasRewarded: false,
  rewardCallback: null,

  async initialize() {
    if (!isApp || !window.Capacitor || !Capacitor.Plugins || !Capacitor.Plugins.AdMob) {
      console.log('[AdManager] 앱 환경이 아니거나 AdMob 플러그인이 없습니다. 웹 시뮬레이션 모드로 작동합니다.');
      return;
    }
    try {
      const { AdMob } = Capacitor.Plugins;
      await AdMob.initialize({ requestTrackingAuthorization: true });
      this.isInitialized = true;
      console.log('[AdManager] AdMob 초기화 완료');

      // 리스너 등록
      AdMob.addListener('interstitialAdDismissed', () => {
        console.log('[AdManager] 전면 광고 닫힘');
        this.hasInterstitial = false;
        this.loadInterstitial(); // 다음 광고 로드
      });

      AdMob.addListener('interstitialAdFailedToLoad', (info) => {
        console.warn('[AdManager] 전면 광고 로드 실패', info);
        this.hasInterstitial = false;
      });

      AdMob.addListener('rewardedAdReceivedReward', () => {
        console.log('[AdManager] 보상형 광고 시청 완료, 보상 지급');
        if (typeof this.rewardCallback === 'function') {
          this.rewardCallback();
          this.rewardCallback = null;
        }
      });

      AdMob.addListener('rewardedAdDismissed', () => {
        console.log('[AdManager] 보상형 광고 닫힘');
        this.hasRewarded = false;
        this.loadRewarded(); // 다음 광고 로드
      });

      AdMob.addListener('rewardedAdFailedToLoad', (info) => {
        console.warn('[AdManager] 보상형 광고 로드 실패', info);
        this.hasRewarded = false;
      });

      // 최초 광고 로드
      await this.loadInterstitial();
      await this.loadRewarded();
    } catch (e) {
      console.error('[AdManager] AdMob 초기화 실패', e);
    }
  },

  async loadInterstitial() {
    if (!this.isInitialized) return;
    try {
      const { AdMob } = Capacitor.Plugins;
      await AdMob.prepareInterstitial({
        adId: 'ca-app-pub-3940256099942544/1033173712', // Android Test Interstitial ID
        isTesting: true
      });
      this.hasInterstitial = true;
      console.log('[AdManager] 전면 광고 로드 완료');
    } catch (e) {
      console.warn('[AdManager] 전면 광고 로드 에러', e);
      this.hasInterstitial = false;
    }
  },

  async showInterstitial() {
    if (!isApp || !this.isInitialized) {
      console.log('[AdManager] 웹 환경 또는 미초기화 상태입니다. 전면 광고 노출을 건너뜁니다.');
      return;
    }
    if (!this.hasInterstitial) {
      console.log('[AdManager] 로드된 전면 광고가 없습니다. 새로 로드를 시도합니다.');
      this.loadInterstitial();
      return;
    }
    try {
      const { AdMob } = Capacitor.Plugins;
      await AdMob.showInterstitial();
    } catch (e) {
      console.error('[AdManager] 전면 광고 노출 실패', e);
    }
  },

  async loadRewarded() {
    if (!this.isInitialized) return;
    try {
      const { AdMob } = Capacitor.Plugins;
      await AdMob.prepareRewardVideoAd({
        adId: 'ca-app-pub-3940256099942544/5224354917', // Android Test Rewarded ID
        isTesting: true
      });
      this.hasRewarded = true;
      console.log('[AdManager] 보상형 광고 로드 완료');
    } catch (e) {
      console.warn('[AdManager] 보상형 광고 로드 에러', e);
      this.hasRewarded = false;
    }
  },

  async showRewarded(onRewardSuccess) {
    if (!isApp || !this.isInitialized) {
      // 웹 환경 시뮬레이션
      const confirmWeb = confirm('[웹 시뮬레이션] 광고를 끝까지 시청한 것으로 처리하고 모든 선수의 피로도를 회복하시겠습니까?');
      if (confirmWeb) {
        onRewardSuccess();
      }
      return;
    }
    
    if (!this.hasRewarded) {
      alert('광고가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      this.loadRewarded();
      return;
    }

    try {
      const { AdMob } = Capacitor.Plugins;
      this.rewardCallback = onRewardSuccess;
      await AdMob.showRewardVideoAd();
    } catch (e) {
      console.error('[AdManager] 보상형 광고 노출 실패', e);
      alert('광고 실행 중 오류가 발생했습니다.');
    }
  }
};

window.showRewardAdAndRecover = function() {
  AdManager.showRewarded(() => {
    // 투수 체력 회복
    if (SS.pitcherFatigue) {
      Object.keys(SS.pitcherFatigue).forEach(key => {
        SS.pitcherFatigue[key].stamina = 100;
        SS.pitcherFatigue[key].consecDays = 0; // 연투 초기화
      });
    }
    // 포수 체력 회복
    if (SS.catcherFatigue) {
      Object.keys(SS.catcherFatigue).forEach(key => {
        SS.catcherFatigue[key].stamina = 100;
      });
    }
    saveSeasonState();
    refreshSeasonUI();
  });
};

if (typeof globalThis !== 'undefined') {
  globalThis.__KBO_TEST__ = Object.assign(globalThis.__KBO_TEST__ || {}, {
    SS,
    buildSchedule,
    initStandings,
    applyResult,
    recordPitcherFatigue,
    recordCatcherFatigue,
    getSortedStandings,
    buildPostseason,
    advancePostseasonBracket,
    getSeriesWinner,
    checkSeasonChampion,
    buildChampionSummary,
    pickChampionMVP,
    findFinalGameTurnStart,
    renderDevPanel,
  });
}

// AdMob 초기화 실행 (Capacitor 플러그인 로드를 기다리기 위해 500ms 지연 실행)
setTimeout(() => {
  if (typeof AdManager !== 'undefined') {
    AdManager.initialize();
  }
}, 500);
