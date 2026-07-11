# KBO 리그 시뮬레이터 — 프로젝트 에이전트 규칙

## 프로젝트 개요

KBO 10개 구단의 실제 스탯 데이터를 기반으로 정규시즌 144경기 + 포스트시즌을 시뮬레이션하는
**모바일 퍼스트 웹앱**. Capacitor를 통해 Android 앱으로도 배포된다.

---

## 아키텍처 원칙

### 절대 변경 금지
- **빌드 도구 없음**: Webpack, Vite, Babel 등 일절 도입하지 않는다. 순수 Vanilla JS + CSS만 사용한다.
- **프레임워크 없음**: React, Vue, Angular 등 도입 금지. DOM 조작은 직접 수행한다.
- **`'use strict'` 유지**: `engine.js`, `season.js` 최상단의 `'use strict'` 선언을 제거하지 않는다.
- **파일 분리 최소화**: JS 파일은 `engine.js`와 `season.js` 두 개만 유지한다. 추가 JS 파일 생성 시 반드시 사용자 승인을 받는다.

### 로드 순서 의존성
```
engine.js → season.js (순서 엄수)
```
`season.js`는 `engine.js`의 전역 변수(`DB`, `gs`, `buildHitter`, `buildPitcher`, `buildLineup`, `initGame` 등)에 의존한다.

### 전역 상태 구조
| 변수 | 파일 | 역할 |
|------|------|------|
| `gs` | engine.js | 현재 단일 경기 상태 |
| `SS` | season.js | 시즌 전체 상태 (일정·순위·피로도 등) |
| `DB` | engine.js | 로드된 원본 선수 데이터 |

새로운 전역 상태가 필요하면 위 객체에 속성을 추가한다. 새 전역 변수를 별도로 선언하지 않는다.

---

## 파일 구조 규칙

```
www/
├── index.html        ← UI 마크업 + 전체 CSS (인라인). 별도 .css 파일 생성 금지
├── js/
│   ├── engine.js     ← 단일 경기 엔진 (데이터 로더 포함)
│   └── season.js     ← 시즌 관리 엔진 (engine.js 이후 로드)
└── data/
    ├── _meta.json         ← 연도·팀코드·한글명 매핑
    ├── player_profile.csv ← 전 선수 공통 프로필
    └── {year}/            ← 연도별 폴더 (예: 2025/)
        ├── {year}_hitter_{팀코드}.csv
        ├── {year}_pitcher_{팀코드}.csv
        ├── {year}_run_{팀코드}.csv
        └── {year}_defense_{팀코드}.csv
```

- **팀코드**: `kia / samsung / lg / doosan / kt / ssg / lotte / hanhwa / nc / kiwoom`
- 새 연도 데이터 추가 시 `_meta.json`의 `years` 배열과 `teams` 객체만 업데이트하면 된다.

---

## 코딩 컨벤션

### 함수 노출 방식
- **내부 함수**: 일반 `function` 선언 (호이스팅 활용)
- **HTML에서 직접 호출하는 함수**: `window.functionName = function() {}` 형태로 노출
- **시즌 엔진 → 외부 노출 함수**: `window.processTurnFatigueRecovery`, `window.returnToSeason` 등 참고

### UI 업데이트 패턴
- DOM 직접 조작: `document.getElementById('id').innerHTML = html`
- 인라인 스타일은 CSS 변수 사용: `var(--accent)`, `var(--text)`, `var(--bg2)`, `var(--border)` 등
- 새 CSS 클래스가 필요하면 `index.html`의 `<style>` 태그 안에 추가한다

### 비동기 처리
- 네트워크 요청(`fetch`)은 반드시 `async/await` + `try/catch` 사용
- UI 블로킹이 없도록 로딩 오버레이(`#loading`) 표시 후 처리

---

## 저장 시스템 규칙

**로컬 스토리지 키**:
- 시즌 상태: `kbo_season_v1` (`LS_KEY`)
- 경기 진행 상태: `kbo_game_state_v1` (`LS_GAME_KEY`)

**이중 저장 필수**: 웹 환경(localStorage)과 앱 환경(Capacitor Preferences)을 동시에 저장한다.
```javascript
localStorage.setItem(key, dataStr);
if (isApp && Capacitor.Plugins.Preferences) {
  Capacitor.Plugins.Preferences.set({ key, value: dataStr });
}
```
삭제 시에도 양쪽을 모두 삭제한다(`localStorage.removeItem` + `Preferences.remove`).

---

## 데이터 모델 규칙

### 타자 객체 (`buildHitter` 출력)
핵심 계산 필드: `k_rate`, `hr_rate`, `hit_rate`, `bb_rate`, `ops`, `obp`, `slg`, `speedScore`
시즌 누적용: `todayStats: { PA, H, HR, RBI, K, BB, SB, CS, SAC }`

### 투수 객체 (`buildPitcher` 출력)
핵심 필드: `ERA`, `IP`, `avgIP`, `K9`, `BB9`, `isStarter`, `role`, `pitchCount`, `usedToday`
시즌 누적용: `todayStats: { IP_out, H, R, ER, BB, K }`

### 선수 식별 키
피로도·누적 스탯 조회 시 `${선수명}_${팀코드}` 형태의 복합 키를 사용한다.
```javascript
const key = `${p.name}_${teamCode}`; // 예: "양현종_kia"
```

---

## 피로도 시스템 규칙

- **투수 스태미너**: 0~100, 투구 수 1구당 1% 차감, 휴식 시 선발 +20%, 불펜 +35% 회복
- **포수 스태미너**: 0~100, 이닝당 5% 차감, 휴식 시 60% 회복
- **등판 불가 기준**: 선발 스태미너 30 미만 (`getFatigueMult` 반환값 99)
- 피로도 회복은 **턴 단위**(`processTurnFatigueRecovery`)로 처리한다. 경기 단위로 직접 회복시키지 않는다.

---

## 시즌 일정 규칙

- 총 144경기 (10팀, 홈 72 / 원정 72 균등 보장)
- 일정 단위: **턴(turn)** — 같은 턴 번호의 경기들은 동시에 치러진다
- 총 144턴 (1팀당 1경기/턴, 쉬는 턴 포함)
- 일정은 시즌 시작 시 1회 생성 후 `SS.schedule`에 고정된다

---

## UI/UX 원칙

- **모바일 퍼스트**: 모든 UI는 세로 375px 기준으로 설계한다
- **다크 테마 유지**: 라이트 모드 전환 기능을 추가하지 않는다
- **탭 구조**: 시즌 화면은 4개 탭 슬라이드 (`season-slides`), swipe 지원
- **Android 뒤로가기**: 모달 → 화면 순서로 닫힌다 (`setupAndroidBackButton` 참고)
- **폰트**: Black Han Sans (제목), Bebas Neue (숫자/순위), JetBrains Mono (스탯 수치), Noto Sans KR (본문)

---

## 포스트시즌 구조

```
와일드카드 (1승제) → 준플레이오프 (2승제) → 플레이오프 (3승제) → 한국시리즈 (4승제)
```
- 5위 vs 4위 → 승자가 3위와 준PO → 승자가 2위와 PO → 승자가 1위와 KS
- 내 팀이 포함된 시리즈는 직접 플레이, 아니면 자동 시뮬

---

## 알려진 버그 / 주의사항

- **`showTurnResultsModalForAutoSkipped()` 버그**: `season.js` 약 L1076의 `map` 콜백에서 `a`, `h`, `res` 변수가 미선언 상태로 참조됨. 자동 턴 스킵 시 결과 모달이 빈 내용으로 표시될 수 있음.
- **`simGameFast()` 데이터 의존성**: `DB.hitters`에서 팀 필터링하므로, 해당 팀이 미로드 상태면 랜덤 점수로 대체됨. 시즌 시작 전 모든 팀 데이터를 로드하지 않는 현재 구조(2팀씩 로드)의 한계.
- **`README.md` 하단 오염**: README.md 하단에 한글 자음·모음 변환 코드가 잘못 포함되어 있음. 수정 필요.

---

## 작업 시 체크리스트

### 새 기능 추가 전
- [ ] `engine.js`와 `season.js` 중 어느 파일에 넣을지 결정 (단일 경기 vs 시즌 관련)
- [ ] 새 전역 변수 대신 `gs` 또는 `SS` 객체에 속성 추가
- [ ] `saveSeasonState()` 직렬화 대상에 새 속성 포함 필요 여부 확인

### 저장 관련 변경 전
- [ ] localStorage와 Capacitor Preferences 양쪽 모두 처리하는지 확인
- [ ] 저장 키(`LS_KEY`, `LS_GAME_KEY`) 변경 시 기존 저장 데이터 마이그레이션 고려

### UI 변경 전
- [ ] `index.html`의 `<style>` 태그에 CSS 변수 활용
- [ ] 모바일(375px) 기준 레이아웃 확인
- [ ] 새 ID 추가 시 Android 뒤로가기 핸들러(`setupAndroidBackButton`) 영향 여부 확인
