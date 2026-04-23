# 디스코드 모의법원 — 개발 가이드

## 기술 스택
- **백엔드**: Node.js + Express + Socket.IO
- **DB**: PostgreSQL (운영) / JSON 파일 (`db.json`, 로컬)
- **프론트**: Vanilla JS + HTML/CSS (프레임워크 없음)
- **데스크탑**: Electron (`main.js`)
- **gh CLI 경로**: `C:\Program Files\GitHub CLI\gh.exe`

## Git 워크플로우 (필수)

모든 작업은 **feature 브랜치**에서 시작한다. `master`에 직접 커밋하지 않는다.

```
# 작업 시작
git checkout master && git pull origin master
git checkout -b feature/기능명

# 작업 완료 후
git add <파일>
git commit -m "설명"
git push origin feature/기능명
& "C:\Program Files\GitHub CLI\gh.exe" pr create --base master
```

브랜치 이름 규칙: `feature/설명`, `fix/설명` (영어 또는 한글 가능)

## 주요 파일
- `server.js` — API 엔드포인트 및 Socket.IO 핸들러
- `public/index.html` — 사건 목록 + 접수 모달
- `public/trial.html` — 재판 진행 페이지
- `public/verdicts.html` — 판결 아카이브
- `public/style.css` — 전체 공통 스타일 (CSS 변수 기반)
- `main.js` — Electron 진입점
