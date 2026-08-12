# 개발자 모드 / 치트키 정리

KBO 리그 시뮬레이터의 디버그 전용 기능 모음입니다.
**모든 기능은 개발자 모드가 켜져 있을 때만 동작하며, 일반 사용자에게는 노출되지 않습니다.**

---

## 1. 개발자 모드 켜고 끄기

브라우저 콘솔(F12 → Console)에서 실행합니다.

| 명령 | 동작 |
| --- | --- |
| `enableDevMode()` | 개발자 모드 ON → 자동으로 페이지 새로고침 |
| `disableDevMode()` | 개발자 모드 OFF → 자동으로 페이지 새로고침 |
| `isDevMode()` | 현재 상태 확인 (`true` / `false`) |

* 저장 위치: `localStorage`의 **`kbo_dev_mode`** 키 (`'1'`이면 ON)
* 기본값은 **항상 꺼짐**. 브라우저 저장소를 지우면 초기화됩니다.
* 정의: [engine.js:2426-2445](www/js/engine.js#L2426-L2445)

> 안드로이드 앱(Capacitor)에서는 콘솔 접근이 어려우므로, Chrome 원격 디버깅(`chrome://inspect`)으로 접속해 실행해야 합니다.

---

## 2. 개발자 모드에서 열리는 기능

### 2-1. 계산식 탭 (경기 화면)

* 경기 화면 하단 로그 영역의 **`계산식`** 탭이 나타납니다.
* 타석 결과 판정에 사용된 확률 계산 과정(`lastCalcTrace`)을 실시간으로 확인할 수 있습니다.
* 관련: `applyDevModeVisibility()` — [engine.js:2438](www/js/engine.js#L2438)

### 2-2. 즉시 시뮬레이션 버튼 (시즌 화면)

* 위치: 시즌 화면 하단, **보라색 반원 버튼** (`SIM`)
* 노출 조건: 개발자 모드 **AND** 이번 턴에 내 팀 경기가 있을 때
* 동작: 앞선 타팀 경기를 먼저 처리한 뒤, 내 경기를 **실제 엔진 그대로** 돌립니다.
  연출용 `sleep()`만 건너뛰므로 투구별 판정·라인업·투수 로테이션·시즌 반영이 모두 정상 적용됩니다.
  화면 전환 없이 시즌 화면 위에 GAME OVER / 턴 결과 모달만 표시됩니다.
* 관련: `executeInstantSim()` / `instantSimSeasonGame()` — [season.js:1106-1131](www/js/season.js#L1106-L1131)

### 2-3. 디버그 패널 (시즌 화면 / 포스트시즌 화면)

개발자 모드일 때 화면 상단(포스트시즌은 하단)에 **보라색 점선 패널**이 나타납니다.
`renderDevPanel()` — [season.js:2389](www/js/season.js#L2389)

| 버튼 | 함수 | 동작 |
| --- | --- | --- |
| ⏭ **최종전까지 (N경기)** | `devFastForwardToFinalGame()` | 내 팀 **정규시즌 최종전 턴 직전**까지 남은 경기를 한 번에 시뮬. 턴 경계마다 피로도 회복을 정상 처리합니다. 이미 최종전 턴이면 비활성화됩니다. |
| 🏆 **우승 직전 상태** | `devSetupChampionshipRun()` | 내 팀이 **1승만 더 하면 우승**인 상태를 강제로 만듭니다. (아래 ⚠️ 주의) |
| **팝업(내 팀)** | `devPreviewChampion('mine')` | 내 팀 우승 팝업만 미리보기 (색종이·광선 연출 포함) |
| **팝업(타 팀)** | `devPreviewChampion('other')` | 타 팀 우승 팝업 미리보기 (연출 없는 기본 버전) |

* **시즌 화면**: 4개 버튼 모두 표시
* **포스트시즌 화면**: `우승 직전 상태` + 팝업 미리보기 2종만 표시 (최종전 스킵은 정규시즌 전용)
* 팝업 미리보기는 **시즌 데이터를 전혀 건드리지 않습니다.** 안전하게 눌러도 됩니다.

---

## ⚠️ `devSetupChampionshipRun()` 주의사항

이 버튼은 **현재 시즌 기록을 되돌릴 수 없게 덮어씁니다.**

실행 시 벌어지는 일:

1. 정규시즌 전 경기 결과를 **내 팀 우위로 재작성** → 내 팀 1위 확정
   (7경기마다 이변을 섞어 전적이 극단으로 가지 않게 조정)
2. 순위표(`SS.standings`) 완전 초기화 후 재집계
3. 포스트시즌 대진표 재생성 → 와일드카드·준PO·PO를 홈 팀 승리로 자동 소화
4. 한국시리즈를 **3승 0패** 상태로 세팅 (`[경기 진행]` 1번이면 우승)
5. `localStorage` 저장 후 포스트시즌 화면으로 이동

`confirm()` 경고창이 뜨므로 실수로 눌러도 취소할 수 있지만, **한 번 확인을 누르면 기존 시즌 기록은 복구 불가**입니다.

---

## 3. 콘솔에서 직접 호출

디버그 패널 없이 콘솔에서 바로 실행할 수 있습니다. (개발자 모드 ON 상태 필요)

```js
enableDevMode();              // 먼저 켜기 (새로고침됨)

devFastForwardToFinalGame();  // 최종전 직전까지 스킵
devSetupChampionshipRun();    // 우승 직전 상태 만들기
devPreviewChampion('mine');   // 내 팀 우승 팝업
devPreviewChampion('other');  // 타 팀 우승 팝업
```

### 테스트용 내부 함수

`globalThis.__KBO_TEST__`에 엔진·시즌 내부 함수가 노출되어 있습니다.
개발자 모드와 **무관하게 항상 접근 가능**하며, 단위 테스트 및 콘솔 디버깅용입니다.

```js
__KBO_TEST__.getSortedStandings();   // 현재 순위표
__KBO_TEST__.buildPostseason();      // 대진표 생성
__KBO_TEST__.getSeriesWinner(SS._ps.ks);
__KBO_TEST__.pickChampionMVP(SS.myTeam);
__KBO_TEST__.decidePAResult(...);    // 타석 판정 엔진
```

* 엔진 쪽 목록: [engine.js:2447-2467](www/js/engine.js#L2447-L2467)
* 시즌 쪽 목록: [season.js:2578-2594](www/js/season.js#L2578-L2594)

---

## 4. 관련 localStorage 키

| 키 | 용도 | 삭제 시 |
| --- | --- | --- |
| `kbo_dev_mode` | 개발자 모드 ON/OFF | 개발자 모드 꺼짐 |
| `kbo_season_v1` | 시즌 진행 상황 전체 (`LS_KEY`) | 시즌 데이터 소멸 (이어하기 불가) |

콘솔에서 전체 초기화:

```js
localStorage.clear();  // 개발자 모드 + 시즌 데이터 모두 삭제
location.reload();
```
