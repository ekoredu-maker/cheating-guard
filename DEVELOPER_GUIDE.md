# CheatingGuard 개발 및 유지보수 설명서

## 1. 구조
빌드 도구·프레임워크·외부 라이브러리 없이 순수 HTML/CSS/ES 모듈로 작성했습니다. 모든 경로는 상대경로라 어느 하위 경로에서도 동작합니다.

```
index.html                 화면 구조(5개 탭, 하위 시트, 최초 안내, CSP)
manifest.webmanifest       PWA 설정 (id/start_url/scope = ./)
service-worker.js          오프라인 캐시·업데이트 (VERSION 상수)
assets/styles.css          검정·짙은 녹색·흰색 테마, 세로 화면, 안전 영역 대응
js/app.js                  진입점: 화면 전환, 모듈 연결, 시트, 기록, SW 등록
js/capability-check.js     29개 기능 진단 (API 존재 ↔ 실제 작동 분리)
js/bluetooth-detector.js   Web Bluetooth, RSSI 필터·추세·거리 범위
js/optical-detector.js     CameraManager, ProcessingClient(Worker), OpticalDetector, ReproTracker, 오버레이
js/vision-detector.js      LedTracker, 렌즈 형태 분석, 외형 체크리스트, ModelRegistry
js/sensor-detector.js      동작·자기장·조도 센서
js/fusion-engine.js        복합 판단 (7단계, 탐지 근거 점수)
js/database.js             DB 로드·검증·매칭·사용자 데이터 CRUD·가져오기/내보내기
js/storage.js              IndexedDB(userDevices, logs, meta) + localStorage 설정, 실패 시 메모리 대체
js/spycam-detector.js      몰래카메라: 렌즈 스윕, 적외선, Wi-Fi 이름 규칙, BLE 추적, 자기장, 점검 판단
js/notification.js         경고음·진동·화면 표시, 후보별 재경고 방지
js/image-processing.js     순수 영상처리 연산 (DOM 비의존)
js/processors.js           분석 파이프라인 (flashDiff, spots, led, dark)
js/vision-worker.js        모듈 Web Worker (processors 실행)
data/glasses-db.json       기본 스마트 글라스 데이터베이스
data/spycam-db.json        몰래카메라 Wi-Fi 이름 규칙·IoT 식별자·숨김 장소
icons/                     icon.svg(원본), 192/512/maskable/apple-touch PNG, 메뉴 아이콘
tests/unit/*.test.mjs      Node 단위 테스트 (node:test)
tests/e2e/run-e2e.mjs      Playwright 브라우저 테스트 (모의 카메라)
tests/fixtures/make-y4m.py 모의 카메라 영상 생성기
```
요구사항의 파일 목록에 더해 `processors.js`, `image-processing.js`, `vision-worker.js`, 메뉴 아이콘 SVG, `package.json`(테스트 전용)을 추가했습니다. `package.json`은 배포에 필요하지 않지만 올려도 무해합니다.

## 2. 데이터 흐름
```
카메라 프레임 ─ CameraManager.grab(ROI, 해상도 제한) ─▶ ProcessingClient ─▶ Worker(processors)
   └─ OpticalDetector._ingest → ReproTracker(재현성) ─┐
   └─ VisionDetector.ledOnce → LedTracker ───────────┤
BluetoothDetector (선택/광고) → database.match ───────┼─▶ fusion-engine.evaluate → 판단 카드·알림·기록
SensorHub (흔들림·조도) ──────────────────────────────┘
```

## 3. 판단 엔진 규칙 (`fusion-engine.js`)
| 근거 | 가중치(점) |
|---|---|
| 검증된 기기명 별칭 | 40 (미검증 15) |
| 검증된 서비스 UUID / 광고 지문 | 35 (미검증 15 / 10) |
| 제조사 ID | 25 (칩 제조사 등 특이도 낮음 8) |
| 모델명 문자열 / 브랜드 문자열 | 25 / 10 |
| 광학 재현 반사점 | 플래시 30, 일반 영상 20, 재현 미확인 8 |
| 표시등 후보 | 15 |
| 외형 육안 확인 | 항목당 5, 최대 20 |

같은 대상 확인(체크박스)이 없으면 점수 = max(블루투스, 영상), 있으면 합(최대 100). 가중치는 경험적 초기값이며 **확률이 아닙니다**. 실사용 기록이 쌓이면 보정하세요.

## 3-1. 몰래카메라 점검 규칙 (`spycam-detector.js`)
| 근거 | 가중치 |
|---|---|
| 확인된 카메라 Wi-Fi 이름 규칙 일치 | 40 (미검증 규칙 15) |
| 손전등 스윕 반복 반사점 | 30 (손전등 없이 20) |
| 적외선 후보 | 20 (이 카메라의 적외선 감지 미확인 시 10) |
| BLE IoT 식별자 | 기기당 최대 10 |
| 자기장 | 0 (참고) |
‘의심 지점 있음’은 강한 근거(확인된 Wi-Fi 규칙 또는 손전등 스윕 반사점)가 있고 점수 30 이상일 때만 표시합니다. Wi-Fi 이름 규칙을 추가할 때는 `wifiSsidPatterns`에 정규식·예시·출처 id를 넣고 `npm test`로 오탐(예: `MVGUEST`)을 확인하세요.

## 4. 데이터베이스 갱신
1. `data/glasses-db.json` 수정 → `dbVersion`, `updated` 변경
2. 새 식별자는 **공식 문서나 실측으로 확인한 경우에만** `verified: true`. 모르면 빈 목록/`unknown`
3. 검증 수준: A(복수 자료) / B(오픈소스 도구 문서) / C(제조사 수준) / U(미확인)
4. `npm test`로 형식 검증 (중복 id, 잘못된 ID·UUID 검출)
5. 사용자 데이터는 IndexedDB `userDevices`에 `user-` 접두 id로 분리 저장되므로 기본 DB를 갱신해도 지워지지 않습니다.

## 5. AI 모델 추가 방법 (향후)
```js
// 예: js/app.js 초기화 후
models.register({
  id: 'glasses-cls-v1', kind: 'glasses', name: '스마트 글라스 분류기', version: '1.0',
  validated: true,               // 검증 보고서가 있을 때만 true
  license: 'Apache-2.0 / 자체 학습',
  run: async (imageData) => ({ label: 'smart-glasses', score: 0.0 }),
});
```
모델 파일·런타임(ONNX Runtime Web 등)은 저장소에 함께 두고 `service-worker.js`의 `ASSETS`에 추가해 오프라인에서도 동작하게 하세요. 외부 CDN 호출은 CSP(`connect-src 'self'`)에 의해 차단됩니다.

## 6. 개발·테스트
```bash
npm test                              # 단위 테스트 52개
python3 tests/fixtures/make-y4m.py /tmp/mock.y4m
npm i -D playwright && npx playwright install chromium
MOCK_Y4M=/tmp/mock.y4m npm run test:e2e   # 브라우저 테스트 24개
npm run serve                         # http://localhost:8080/cheating-guard/
```
스마트폰 실기기 테스트: 같은 Wi-Fi의 PC에서 `npm run serve` 후 Chrome 원격 디버깅(`chrome://inspect`)의 포트 포워딩을 쓰면 `localhost`(보안 컨텍스트)로 접속할 수 있습니다. 또는 GitHub Pages에 올려 HTTPS로 시험하세요.

## 7. 유지보수 원칙
- 브라우저가 지원하지 않는 기능을 지원하는 것처럼 표시하지 않기 (`capability-check.js`에서 실제 실행 확인 후 `works: true`)
- 측정값은 실제 계산 결과만 표시, 테스트용 합성 데이터는 `tests/`에만 둘 것
- 정상 기능을 삭제하지 말 것, 변경 시 `CHANGELOG.md` 기록
- 버전 변경 시 `service-worker.js`·`js/app.js`·`index.html`·`manifest`·`package.json` 버전을 함께 수정
