# GitHub Pages 배포 방법

빌드 과정이 필요 없습니다. 파일을 그대로 올리면 됩니다. 기존 저장소에는 영향을 주지 않도록 **새 저장소**를 사용합니다.

## A. 웹 브라우저로 배포 (권장, 명령어 없이)
1. https://github.com 에 `ekoredu-maker` 계정으로 로그인합니다.
2. 오른쪽 위 **+ → New repository**
   - Repository name: `cheating-guard`
   - **Public** 선택 (무료 GitHub Pages는 공개 저장소 필요)
   - README 추가 등은 선택하지 않음 → **Create repository**
3. 새 저장소 화면에서 **uploading an existing file** 링크를 누릅니다.
4. 컴퓨터에서 `cheatingguard-v1.2.0.zip`의 압축을 풉니다. 압축을 푼 폴더 **안의 모든 파일과 폴더**(`index.html`, `js`, `assets`, `icons`, `data`, `.nojekyll` 등)를 업로드 화면으로 끌어다 놓습니다.
   - `index.html`이 저장소 **최상위**에 있어야 합니다. `cheating-guard/index.html`처럼 한 단계 안에 들어가면 안 됩니다.
   - `.nojekyll`은 숨김 파일이라 보이지 않을 수 있습니다. 없어도 동작하지만, 보이면 함께 올리세요.
5. **Commit changes**를 누릅니다.
6. 저장소의 **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: **main**, 폴더: **/ (root)** → **Save**
7. 1~3분 뒤 Pages 화면 위쪽에 주소가 표시됩니다: **https://ekoredu-maker.github.io/cheating-guard/**

## B. 명령어로 배포 (git 사용 시)
```bash
unzip cheatingguard-v1.2.0.zip -d cheating-guard && cd cheating-guard
git init && git add . && git commit -m "CheatingGuard v1.1.0"
git branch -M main
git remote add origin https://github.com/ekoredu-maker/cheating-guard.git
git push -u origin main
# 이후 GitHub 웹에서 Settings → Pages → main / (root) 설정
```

## 배포 후 확인 목록
| 항목 | 확인 방법 |
|---|---|
| HTTPS 적용 | 주소가 `https://`로 시작 (Settings → Pages → Enforce HTTPS 체크) |
| 하위 경로 접근 | `…/cheating-guard/`에서 화면이 정상 표시되고 아이콘이 깨지지 않음 |
| Service Worker 등록 | 몇 초 후 위쪽 배지가 ‘오프라인 가능’으로 바뀜 |
| Manifest 인식 | Android Chrome 메뉴에 ‘앱 설치’가 나타남 |
| 안드로이드 홈 화면 설치 | 설치 후 아이콘(녹색 안경+레이더)으로 실행 |
| 아이폰 홈 화면 추가 | Safari 공유 → 홈 화면에 추가 |
| 오프라인 실행 | 비행기 모드에서 앱 실행 → 카메라·광학 분석 동작 |
| 기능 진단 | 설정 → 스마트폰 기능 진단에서 실제 기기 결과 확인 |

## 이미 `glassguard` 저장소로 배포한 경우 (이름 변경)
1. 기존 저장소 **Settings → General → Repository name**을 `cheating-guard`로 바꾸고 **Rename**
2. 저장소 파일을 이 ZIP의 파일로 모두 덮어써 올립니다.
3. Settings → Pages 설정이 그대로인지 확인합니다. 1~3분 뒤 https://ekoredu-maker.github.io/cheating-guard/ 로 접속됩니다.
- **예전 주소(`…/glassguard/`)는 더 이상 열리지 않습니다** (GitHub는 저장소 페이지는 자동 이동시키지만 Pages 주소는 이동시키지 않음). 이미 공유한 곳에 새 주소를 다시 알려 주세요.
- 이름이 바뀌면서 앱 내부 저장소도 새로 시작합니다. 예전 주소에서 저장한 탐지 기록·사용자 DB가 필요하면 바꾸기 **전에** 예전 앱에서 JSON으로 내보낸 뒤 새 앱에서 가져오세요(사용자 DB). 홈 화면에 설치한 예전 앱 아이콘은 삭제하고 새로 설치하세요.

## 새 버전 배포 (업데이트)
1. 바뀐 파일을 저장소에 다시 업로드(같은 이름이면 덮어쓰기)합니다.
2. **반드시** `service-worker.js`의 `VERSION`과 `js/app.js`의 `VERSION`, `manifest`·`index.html`의 버전 표기를 함께 올립니다 (예: `1.0.1`).
   서비스 워커 파일이 바뀌어야 사용자 기기에서 새 버전을 감지합니다.
3. 사용자 화면에 ‘새 버전이 있습니다 → 지금 적용’이 표시됩니다. 사용자 기록·사용자 DB·설정은 유지됩니다.
4. 데이터베이스(`data/glasses-db.json`)만 고칠 때는 `dbVersion`을 올려 주세요. 다음 실행 시 자동 갱신됩니다.

## 문제 해결
- **404**: Pages 설정 후 몇 분 기다리기, `index.html`이 최상위인지 확인
- **화면이 예전 버전**: 서비스 워커 `VERSION`을 올렸는지 확인, 또는 앱 설정 → 업데이트 확인
- **카메라가 안 켜짐**: `http://`가 아닌 `https://` 주소로 접속했는지 확인
