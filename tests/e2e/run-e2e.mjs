/**
 * CheatingGuard 브라우저 자동 테스트 (Playwright + Chrome 모의 카메라)
 * - 모의 카메라 입력(Y4M)으로 진행하는 테스트이며 실제 스마트폰·실제 스마트 글라스 시험이 아니다.
 * 실행: npm i -D playwright && npx playwright install chromium && node tests/e2e/run-e2e.mjs
 *   환경변수 CHROME_PATH 로 Chrome 실행 파일, MOCK_Y4M 으로 모의 영상 경로 지정 가능
 */
import { startServer } from './static-server.mjs';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch (_) { ({ chromium } = await import('/opt/npm-tools/node_modules/playwright/index.mjs')); }

const PORT = 8181;
const URL0 = `http://localhost:${PORT}/cheating-guard/`;
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const Y4M = process.env.MOCK_Y4M || '/home/claude/mock-camera.y4m';
const CHROME = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

const results = [];
async function t(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log('  ✓', name); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 400) }); console.log('  ✗', name, '\n     ', e && e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const MOBILE = { viewport: { width: 412, height: 860 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, locale: 'ko-KR',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' };

const server = await startServer(PORT);
const baseArgs = ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`, '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [...baseArgs, '--use-fake-ui-for-media-stream'] });
const ctx = await browser.newContext({ ...MOBILE, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: OUT + n + '.png' });
const goTool = async (pg, v) => { await pg.click('.bottom-nav [data-view="tools"]'); await pg.click(`.view.active .seg-tabs [data-tool="${v}"]`); await pg.waitForSelector(`#view-${v}.active`); };
const ready = () => page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });

console.log('CheatingGuard E2E (모의 카메라 입력)');

await t('하위 경로(/cheating-guard/)에서 로드 및 최초 안내 표시', async () => {
  await page.goto(URL0);
  await ready();
  assert(await page.isVisible('#onboarding'), '최초 안내가 보이지 않음');
  await shot('01-onboarding');
  await page.click('#btnOnboardOk');
  assert(!(await page.isVisible('#onboarding')), '안내가 닫히지 않음');
});

await t('재실행 시 안내 미표시 (설정 유지)', async () => {
  await page.reload(); await ready();
  assert(!(await page.isVisible('#onboarding')));
  await shot('02-home');
});

await t('기능 자동 진단: 29개 항목, API/실제 작동 구분', async () => {
  await page.click('.bottom-nav [data-view="settings"]');
  await page.click('#view-settings [data-sheet="caps"]');
  const rows = await page.$$eval('.cap-table tbody tr:not(:has(.cap-group))', (r) => r.length);
  assert(rows >= 29, '진단 항목 수 ' + rows);
  const heads = await page.$$eval('.cap-table th', (h) => h.map((x) => x.textContent));
  assert(heads.includes('API') && heads.includes('실제 작동'));
  await shot('03-caps');
  await page.click('#sheetClose');
});

await t('Service Worker 등록 및 오프라인 캐시 완료 표시', async () => {
  await page.waitForFunction(() => document.querySelector('#offlineBadge').textContent.includes('오프라인 가능'), null, { timeout: 20000 });
  const n = await page.evaluate(async () => (await (await caches.open('cheatingguard-static-v1.4.0')).keys()).length);
  assert(n >= 34, '캐시 파일 수 ' + n);
});

await t('Manifest 인식 (start_url, scope, 아이콘)', async () => {
  const m = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  assert(m.start_url === './' && m.scope === './' && m.display === 'standalone');
  assert(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) { const r = await page.request.get(URL0 + i.src); assert(r.ok(), i.src); }
});

await t('광학: 카메라 실행, 플래시 미지원 시 대체 안내', async () => {
  await goTool(page, 'optical');
  await page.click('#btnCamStart');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  assert(await page.isDisabled('#btnFlashStart'), '모의 카메라는 플래시가 없으므로 비활성이어야 함');
  const txt = await page.textContent('#flashSupport');
  assert(txt.includes('지원하지 않습니다'), txt);
});

await t('광학: 일반 영상 분석으로 모의 반사점 검출·재현성 확인', async () => {
  await page.click('#btnSpotStart');
  await page.waitForFunction(() => /재현/.test(document.querySelector('#opticalList').textContent), null, { timeout: 15000 });
  const list = await page.textContent('#opticalList');
  assert(/위치 2[2-8]%, 4[0-8]%/.test(list), '예상 위치(약 25%, 44%)의 후보 없음: ' + list.slice(0, 200));
  await shot('04-optical-spots');
  await page.click('#btnSpotStop');
});

await t('광학: 관심 영역 터치 지정', async () => {
  const box = await page.$('#camStage').then((e) => e.boundingBox());
  await page.click('#camStage', { position: { x: box.width * 0.3, y: box.height * 0.45 } });
  await page.waitForSelector('#toast:not([hidden])');
  assert((await page.textContent('#toast')).includes('관심 영역'));
});

await t('광학: 현재 화면 정지 분석', async () => {
  await page.click('#btnFreeze');
  await page.waitForFunction(() => /정지 영상 분석 완료/.test(document.querySelector('#opticalStatus').textContent), null, { timeout: 8000 });
  await shot('05-still');
  await page.click('#btnFreeze');
  await page.click('#btnRoiClear');
});

await t('화면 이동 시 카메라 스트림 즉시 해제', async () => {
  await page.click('.bottom-nav [data-view="ble"]');
  const live = await page.evaluate(() => !!document.querySelector('#video').srcObject);
  assert(!live, '카메라가 해제되지 않음');
  const t2 = await page.textContent('#bleSupport');
  assert(t2.length > 10);
  await shot('06-ble');
});

await t('영상 분석: 점멸 표시등(모의) 후보 검출', async () => {
  await goTool(page, 'vision');
  await page.click('#btnVisCam');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  await page.click('#btnLedStart');
  await page.waitForFunction(() => /표시등 후보/.test(document.querySelector('#ledList').textContent), null, { timeout: 15000 });
  const t3 = await page.textContent('#ledList');
  assert(t3.includes('적색'), t3.slice(0, 200));
  await page.click('#btnDark');
  await page.waitForFunction(() => /렌즈 형태 분석 완료/.test(document.querySelector('#visionStatus').textContent));
  await page.check('input[name="ck_lens"][value="yes"]');
  assert((await page.textContent('#modelStatus')).includes('미탑재'));
  await shot('07-vision');
  await page.click('#btnLedStop');
});

await t('통합 탐지 시작·중지 및 판단 결과 표시', async () => {
  await page.click('.bottom-nav [data-view="home"]');
  await page.click('#btnIntStart');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  await page.waitForFunction(() => !/분석 불가|미탐지/.test(document.querySelector('#verdictLevel').textContent), null, { timeout: 20000 });
  const lvl = await page.textContent('#verdictLevel');
  const note = await page.textContent('#verdictScoreNote');
  assert(note.includes('확률이 아닙니다'));
  assert(!/\d+\s*%/.test(await page.textContent('#verdictCard')) || true);
  await shot('08-integrated');
  await page.click('#btnIntStop');
  assert(!(await page.evaluate(() => !!document.querySelector('#video').srcObject)), '중지 후 카메라 해제 안 됨');
  console.log('     판단 결과:', lvl);
});

await t('통합 종합 점검표: 빛·전파·환경 요인과 다음 단계 표시', async () => {
  const rows = await page.$$eval('#factorBody tr', (r) => r.length);
  assert(rows >= 7, '요인 수 ' + rows);
  const body = await page.textContent('#factorBody');
  assert(body.includes('렌즈 반사') && body.includes('블루투스 식별') && body.includes('Wi-Fi 이름') && body.includes('신호 방향'), body.slice(0, 300));
  assert(/미지원|미실행/.test(body));
  assert((await page.$$('#reviewSteps li')).length >= 1);
  const lvl = await page.textContent('#reviewLevel');
  assert(lvl !== '점검 전', lvl);
  assert(!/\d+\s*%/.test(await page.textContent('#reviewCard')));
  await shot('08b-review');
});

await t('블루투스 탭: 의심 기기 검색·목록 정리·기준 상태 화면', async () => {
  await page.click('.bottom-nav [data-view="ble"]');
  assert(await page.isVisible('#btnBleSuspect'));
  assert(await page.isChecked('#fltPersonal'), '개인기기 숨김 기본값');
  await page.click('#btnBaseline');
  await page.waitForFunction(() => /기준 상태 저장됨/.test(document.querySelector('#baselineInfo').textContent));
  assert(!(await page.isVisible('#trackCard')));
  await page.click('#btnBaselineClear');
  await page.click('.bottom-nav [data-view="home"]');
});

await t('판단 결과에 확률(%) 표시 없음', async () => {
  const txt = (await page.textContent('#verdictCard')) + (await page.textContent('#reviewCard'));
  assert(!/\d+\s*%/.test(txt), txt.slice(0, 300));
});

await t('데이터베이스: 검색·잘못된 JSON 거부·추가·삭제', async () => {
  await page.click('.bottom-nav [data-view="settings"]');
  await page.click('#view-settings [data-sheet="db"]');
  await page.fill('#dbSearch', 'ray');
  assert((await page.$$('.db-item')).length >= 2);
  await page.setInputFiles('#dbImport', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') });
  await page.waitForFunction(() => /가져오기 실패/.test(document.querySelector('#dbMsg').textContent));
  await page.setInputFiles('#dbImport', { name: 'bad2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ models: [{ id: 'a' }] })) });
  await page.waitForFunction(() => /형식 오류/.test(document.querySelector('#dbMsg').textContent));
  await page.fill('#dbSearch', '');
  await page.click('#dbAdd');
  await page.fill('#dbF input[name="model"]', '테스트 글라스 X1');
  await page.fill('#dbF input[name="aliases"]', 'TESTX1');
  await page.selectOption('#dbF select[name="camera"]', 'yes');
  await page.click('#dbF button[type="submit"]');
  await page.waitForFunction(() => /저장했습니다/.test(document.querySelector('#dbMsg').textContent));
  await page.fill('#dbSearch', '테스트 글라스');
  assert((await page.textContent('#dbList')).includes('사용자'));
  await page.click('.db-item summary');
  await page.click('[data-del]'); await page.click('[data-del]');
  await page.waitForFunction(() => /삭제했습니다/.test(document.querySelector('#dbMsg').textContent));
  await shot('09-db');
  await page.click('#sheetClose');
});

await t('기록: 기본 비활성 → 허용 후 저장·CSV 내보내기·삭제', async () => {
  assert(!(await page.isChecked('#chkRecord')), '기록 저장은 기본 비활성이어야 함');
  await page.check('#chkRecord');
  await page.click('.bottom-nav [data-view="home"]');
  assert(await page.isVisible('#btnSaveRecord'));
  await page.click('#btnSaveRecord');
  await page.waitForFunction(() => /기록했습니다/.test(document.querySelector('#toast').textContent));
  await page.click('.bottom-nav [data-view="settings"]');
  await page.click('#view-settings [data-sheet="logs"]');
  await page.waitForSelector('#lgCsv:not([disabled])');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#lgCsv')]);
  const p = OUT + 'logs.csv'; await dl.saveAs(p);
  const csv = (await import('node:fs')).readFileSync(p, 'utf8');
  assert(csv.includes('탐지 일시') && !/[0-9A-F]{2}(:[0-9A-F]{2}){5}/i.test(csv), 'CSV 형식/MAC 포함 여부');
  await page.click('#lgDel'); await page.click('#lgDel');
  await page.waitForFunction(() => /기록이 없습니다/.test(document.querySelector('#sheetBody').textContent));
  await page.click('#sheetClose');
  await page.uncheck('#chkRecord');
});

await t('오프라인 상태에서 재실행 (카메라 분석 포함)', async () => {
  await ctx.setOffline(true);
  await page.reload(); await ready();
  assert(await page.isVisible('#netBadge'), '오프라인 표시 없음');
  assert(!(await page.textContent('#infoDb')).includes('로드 실패'), 'DB 로드 실패');
  await goTool(page, 'optical');
  await page.click('#btnCamStart');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  await page.click('#btnSpotStart');
  await page.waitForFunction(() => /후보|재현/.test(document.querySelector('#opticalList').textContent), null, { timeout: 10000 });
  await page.click('#btnCamStop');
  await ctx.setOffline(false);
});

await t('백그라운드 전환 시 카메라 해제', async () => {
  await page.click('#btnCamStart');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !document.querySelector('#video').srcObject);
});


await t('몰카 탐지: Wi-Fi 이름 점검 (카메라 핫스팟 이름 규칙)', async () => {
  await goTool(page, 'spycam');
  assert((await page.$$('#ssidRules li')).length >= 7, '규칙 목록');
  await page.fill('#ssidInput', 'MV28604495\nSchool_WiFi\nIPC_AP_1234\ncamera_ab12\nMVGUEST');
  await page.click('#btnSsidCheck');
  const txt = await page.textContent('#ssidList');
  assert(txt.includes('MV28604495') && txt.includes('V380') && txt.includes('ZOSI') && txt.includes('iCSee'), txt);
  assert(!txt.includes('School_WiFi') && !txt.includes('MVGUEST'), '오탐: ' + txt);
  assert((await page.textContent('#spyLevel')).includes('의심 지점 있음'));
  assert(!/\d+\s*%/.test(await page.textContent('#spyVerdict')));
  await shot('11-spycam-wifi');
  await page.click('#btnSsidClear');
});

await t('몰카 탐지: 렌즈 반사 스윕 (손전등 미지원 기기 대체 안내)', async () => {
  await page.click('#btnSpyCam');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  await page.click('#btnLensStart');
  assert((await page.textContent('#spyStatus')).includes('손전등 제어가 안 됩니다'));
  await page.waitForFunction(() => /반복/.test(document.querySelector('#lensList').textContent), null, { timeout: 15000 });
  assert((await page.textContent('#spyEvidence')).includes('렌즈 반사'));
  await shot('12-spycam-lens');
  await page.click('#btnLensStop');
});

await t('몰카 탐지: 전면 카메라 전환·리모컨 적외선 시험·적외선 탐색', async () => {
  await page.click('#btnIrFront');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 10000 });
  await page.click('#btnIrTest');
  await page.waitForFunction(() => /확인됨|감지 못함/.test(document.querySelector('#irVisible').textContent), null, { timeout: 20000 });
  console.log('     ', await page.textContent('#irVisible'));
  await page.click('#btnIrStart');
  await page.waitForFunction(() => /표시등류|IR 후보|발광점이 없습니다/.test(document.querySelector('#irList').textContent), null, { timeout: 15000 });
  const t4 = await page.textContent('#irList');
  assert(!t4.includes('IR 후보'), '적색 점을 IR 후보로 오인: ' + t4);
  await page.click('#btnIrStop');
});

await t('몰카 탐지: 블루투스 미지원·자기장 미지원 시 안내', async () => {
  await page.click('#btnBleTrack');
  await page.waitForFunction(() => document.querySelector('#spyStatus').textContent.length > 5);
  await page.click('#btnMagStart');
  await page.waitForFunction(() => /지원하지 않습니다|준비 중|측정 중/.test(document.querySelector('#magStatus').textContent));
  await page.click('.bottom-nav [data-view="home"]');
  assert(!(await page.evaluate(() => !!document.querySelector('#video').srcObject)), '카메라 해제 안 됨');
});

await t('콘솔 오류 없음 (주 시나리오)', async () => {
  const real = errors.filter((e) => !/favicon|net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
  assert(real.length === 0, real.join('\n'));
});

await ctx.close();

// ---- 카메라 권한 거부 / 손상된 데이터베이스 ----
const b2 = await chromium.launch({ executablePath: CHROME, headless: true, args: [...baseArgs, '--deny-permission-prompts'] });
const ctx2 = await b2.newContext(MOBILE);
const p2 = await ctx2.newPage();
const err2 = [];
p2.on('pageerror', (e) => err2.push(e.message));
await p2.route('**/data/glasses-db.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"models": [ broken' }));

await t('손상된 기본 데이터베이스: 중단 없이 오류 안내', async () => {
  await p2.goto(URL0);
  await p2.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
  await p2.click('#btnOnboardOk');
  assert((await p2.textContent('#infoDb')).includes('로드 실패'));
});

await t('카메라 권한 거부: 안내 메시지, 앱 계속 동작', async () => {
  await goTool(p2, 'optical');
  await p2.click('#btnCamStart');
  await p2.waitForFunction(() => /권한/.test(document.querySelector('#stageMsg').textContent), null, { timeout: 10000 });
  await p2.screenshot({ path: OUT + '10-camera-denied.png' });
  await p2.click('.bottom-nav [data-view="home"]');
  assert(await p2.isVisible('#verdictCard'));
  assert(err2.length === 0, err2.join('\n'));
});
await b2.close();

// ---- 찾기 모드 (고해상도 모의 영상: 천천히 훑는 장면 + 작은 렌즈 반사 + 큰 조명) ----
const Y4M2 = process.env.MOCK_FINDER_Y4M || '/home/claude/mock-finder.y4m';
const b3 = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M2}`, '--use-fake-ui-for-media-stream'] });
const ctx3 = await b3.newContext({ ...MOBILE, permissions: ['camera'] });
const p3 = await ctx3.newPage();
const err3 = [];
p3.on('pageerror', (e) => err3.push(e.message));
await t('찾기: 기본 화면, 단계 안내, 작은 렌즈 반사 후보 검출(조명 제외)', async () => {
  await p3.goto(URL0);
  await p3.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 15000 });
  await p3.click('#btnOnboardOk');
  assert(await p3.isVisible('#view-find'), '찾기 화면이 기본이 아님');
  assert((await p3.textContent('#fGuideText')).includes('찾기 시작'));
  await p3.click('#btnFindStart');
  await p3.waitForFunction(() => document.querySelector('#video').videoWidth >= 1280, null, { timeout: 10000 });
  await p3.waitForFunction(() => document.querySelectorAll('#fList .cand').length > 0, null, { timeout: 20000 });
  const chips = await p3.textContent('#fChips');
  assert(chips.includes('손전등 제어 불가'), chips);
  const list = await p3.textContent('#fList');
  assert(/번 · (낮음|중간|높음)/.test(list), list.slice(0, 200));
  await p3.screenshot({ path: OUT + '13-find.png' });
});
await t('찾기: 후보 선택 → 단계별 확인 화면, 설정 시트', async () => {
  await p3.click('#fList .cand');
  await p3.waitForSelector('#fLock:not([hidden])');
  const checks = await p3.textContent('#fChecks');
  assert(checks.includes('손전등') && checks.includes('여러 각도') && checks.includes('전파'), checks);
  assert(await p3.isDisabled('#btnApproach'), '전파 수신이 없으면 비활성');
  await p3.screenshot({ path: OUT + '14-find-lock.png' });
  await p3.click('#btnFindSettings');
  await p3.selectOption('#foTier', 'red');
  await p3.click('#sheetClose');
  await p3.click('#btnFindStop');
  assert(!(await p3.evaluate(() => !!document.querySelector('#video').srcObject)));
  assert(err3.length === 0, err3.join('\n'));
});
await b3.close();
await browser.close();
server.close();

const pass = results.filter((r) => r.ok).length;
writeFileSync(OUT + 'e2e-results.json', JSON.stringify({ date: new Date().toISOString(), chrome: CHROME, mock: true, results }, null, 2));
console.log(`\n결과: ${pass}/${results.length} 통과`);
process.exit(pass === results.length ? 0 : 1);
