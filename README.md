# 2026 프로리그 144

## 폴더 구조
```
/
├── index.html
├── js/
│   ├── engine.js      ← 게임 엔진
│   └── season.js      ← 시즌 모드 엔진
└── data/
    ├── _meta.json          ← 연도·팀 목록
    ├── player_profile.csv  ← 전 선수 프로필 (별도 준비)
    └── 2025/
        ├── 2025_hitter_{팀코드}.csv
        ├── 2025_pitcher_{팀코드}.csv
        ├── 2025_run_{팀코드}.csv
        └── 2025_defense_{팀코드}.csv
```

## 팀 코드 (파일명에 사용)
kia / samsung / lg / doosan / kt / ssg / lotte / hanhwa / nc / kiwoom

## 로컬 실행
```
cd 프로젝트폴더
python -m http.server 8000
→ http://localhost:8000
```

## GitHub Pages
https://{유저명}.github.io/{저장소명}/
