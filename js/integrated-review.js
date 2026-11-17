/**
 * 칫팅가드 통합 종합 점검 (v1.3.0)
 * 스마트 글라스 판단 + 몰래카메라 점검 + 전파 분석 + 빛 탐지 + 측정 환경을 한 표로 묶고,
 * 전파 방향과 빛 후보 발견 방향이 일치하는지 확인하며, 다음에 할 일을 안내한다.
 * 모든 점수·판정은 규칙 기반이며 확률이 아니다.
 */
import { angleDiff, compassName, CONFIDENCE_LABEL } from './radio-analyzer.js';

export const OVERALL = [
  { rank: 0, label: '점검 전', tone: 'muted' },
  { rank: 1, label: '현재 근거 없음', tone: 'muted' },
  { rank: 2, label: '측정 환경 불량', tone: 'warn' },
  { rank: 3, label: '추가 확인 필요', tone: 'warn' },
  { rank: 4, label: '의심 대상 있음', tone: 'alert' },
  { rank: 5, label: '강한 의심 근거', tone: 'alert' },
  { rank: 6, label: '복수 근거 일치', tone: 'alert' },
];
const SPY_RANK = { unavailable: 0, none: 1, review: 3, suspect: 5 };

export const ST = { found: '근거 있음', clear: '근거 없음', notrun: '미실행', unsupported: '미지원', partial: '확인 중' };

function f(group, name, status, detail, action) { return { group, name, status, label: ST[status], detail, action: action || null }; }

/**
 * input = {
 *   glasses: evaluate() 결과, spy: evaluateSpycam() 결과,
 *   support: { camera, ble, bleRssi, torch, heading },
 *   optical: optical.evidence(), vision: vision.evidence(), spyEv: spycam.evidence(),
 *   radio: { ran, items:[{name, category, priority, rssiFiltered}], direction: DirectionFinder.result()|null, targetName },
 *   env: { issues:[] }
 * }
 */
export function buildReview(input) {
  const I = Object.assign({ support: {}, optical: {}, vision: {}, spyEv: { lens: {}, ir: {}, wifi: {}, ble: {} }, radio: { items: [] }, env: { issues: [] } }, input || {});
  const S = I.support, O = I.optical, V = I.vision, P = I.spyEv, R = I.radio;
  const factors = [], matches = [], steps = [];

  // ---------------- 빛 (찾기 모드)
  const F = I.finder || {};
  if (S.camera !== false) {
    const c = F.counts || {};
    if (!F.ran) factors.push(f('빛', '찾기 (렌즈 후보 등급)', 'notrun', '찾기 모드를 실행하지 않았습니다.', '찾기 탭에서 불을 끄고 ‘찾기 시작’으로 방을 훑으세요.'));
    else if (c.red || c.orange) factors.push(f('빛', '찾기 (렌즈 후보 등급)', 'found', `높음 ${c.red || 0} · 중간 ${c.orange || 0} · 낮음 ${c.yellow || 0}${F.best ? ` — 최고 ${F.best.id}번(${F.best.tier.label}, 손전등 반응 ${F.best.torchYes}회, 각도 ${Math.round(F.best.spanDeg)}°${F.best.radio && F.best.radio.linked ? `, 전파 +${F.best.radio.delta} dB` : ''})` : ''}`));
    else if (c.yellow) factors.push(f('빛', '찾기 (렌즈 후보 등급)', 'partial', `낮음 등급 후보 ${c.yellow}개`, '노랑 후보를 선택해 손전등 반응과 여러 각도 확인을 진행하세요.'));
    else factors.push(f('빛', '찾기 (렌즈 후보 등급)', 'clear', `후보 없음 (분석 ${F.frames}프레임)`));
  }

  // ---------------- 빛
  const lensRep = (O.reproducible || []).length;
  const spyLens = (P.lens && P.lens.reproducible) || [];
  const spyConf = spyLens.filter((t) => t.confirm && t.confirm.responsive);
  const lensRan = O.ran || (P.lens && P.lens.ran);
  if (!S.camera) factors.push(f('빛', '렌즈 반사', 'unsupported', '카메라를 사용할 수 없습니다.'));
  else if (!lensRan) factors.push(f('빛', '렌즈 반사', 'notrun', '플래시 차분 분석 또는 렌즈 반사 스윕을 하지 않았습니다.', '몰카 탐지 탭의 렌즈 반사 스윕 또는 광학 탐지를 실행하세요.'));
  else if (spyConf.length || lensRep) factors.push(f('빛', '렌즈 반사', 'found', `반복 반사점 ${lensRep + spyLens.length}개${spyConf.length ? ` · 손전등 반응 확인 ${spyConf.length}개` : ''}`));
  else if (spyLens.length) factors.push(f('빛', '렌즈 반사', 'partial', `반복 반사점 ${spyLens.length}개 · 손전등 반응 미확인`, '휴대폰을 고정하면 손전등 반응 확인이 자동으로 진행됩니다.'));
  else factors.push(f('빛', '렌즈 반사', 'clear', '반복되는 작은 반사점 없음'));

  const leds = (V.ledCandidates || []).length, irs = ((P.ir && P.ir.candidates) || []).length;
  const ledRan = V.ledRan || (P.ir && P.ir.ran);
  if (!S.camera) factors.push(f('빛', '표시등·적외선 LED', 'unsupported', '카메라를 사용할 수 없습니다.'));
  else if (!ledRan) factors.push(f('빛', '표시등·적외선 LED', 'notrun', '표시등 추적이나 적외선 탐색을 하지 않았습니다.', '방을 어둡게 하고 몰카 탐지 탭의 적외선 탐색을 실행하세요.'));
  else factors.push(f('빛', '표시등·적외선 LED', leds + irs ? 'found' : 'clear', leds + irs ? `표시등 후보 ${leds}개 · 적외선 후보 ${irs}개` : '지속·점멸하는 발광점 없음'));

  const yes = (V.visual && V.visual.yesCount) || 0;
  factors.push(f('빛', '외형 육안 확인', yes ? 'found' : (V.visual && V.visual.answered) ? 'clear' : 'notrun', yes ? `외형 특징 ${yes}개 확인` : (V.visual && V.visual.answered) ? '해당 특징 없음' : '체크리스트 미작성', yes || (V.visual && V.visual.answered) ? null : '영상 분석 탭에서 외형 특징을 확인하세요.'));

  // ---------------- 전파
  const items = R.items || [];
  const glassesDev = items.filter((d) => d.category.key === 'glasses');
  const suspect = items.filter((d) => d.category.key !== 'personal' && d.priority.score >= 25);
  const personal = items.filter((d) => d.category.key === 'personal').length;
  if (!S.ble) factors.push(f('전파', '블루투스 식별', 'unsupported', '이 브라우저는 블루투스 탐지를 지원하지 않습니다.'));
  else if (!R.ran) factors.push(f('전파', '블루투스 식별', 'notrun', '블루투스 검색을 하지 않았습니다.', '블루투스 탭에서 ‘의심 기기만 검색’을 실행하세요.'));
  else factors.push(f('전파', '블루투스 식별', glassesDev.length ? 'found' : 'clear', glassesDev.length ? `스마트 글라스 식별정보 일치 ${glassesDev.length}대` : `일치 없음 (확인한 기기 ${items.length}대, 개인 휴대기기 ${personal}대 제외)`));

  if (S.ble && R.ran) {
    factors.push(f('전파', '의심 우선 기기', suspect.length ? 'found' : 'clear', suspect.length
      ? suspect.slice(0, 3).map((d) => `${d.name}(${d.category.label}, 우선순위 ${d.priority.score})`).join(', ')
      : '미확인·신규·고정 신호 기기 없음', suspect.length ? '의심 기기를 선택해 ‘방향 찾기’로 위치를 좁히세요.' : null));
  }

  const D = R.direction;
  if (!S.bleRssi) factors.push(f('전파', '신호 방향', 'unsupported', '이 브라우저는 블루투스 신호 세기를 제공하지 않습니다 (Chrome 실험 기능 필요).'));
  else if (!S.heading) factors.push(f('전파', '신호 방향', 'unsupported', '나침반(방향 센서)을 사용할 수 없어 걸어 다니며 신호가 커지는 쪽을 찾아야 합니다.'));
  else if (!D || !D.ready) factors.push(f('전파', '신호 방향', 'notrun', '방향 찾기를 하지 않았습니다.', suspect.length ? '블루투스 탭에서 의심 기기의 ‘방향 찾기’를 실행하세요.' : null));
  else factors.push(f('전파', '신호 방향', D.confidence === 'low' ? 'partial' : 'found', `${R.targetName || '선택 기기'}: 약 ${D.compass}쪽 (방위 ${D.bearing}°, ±${D.spread / 2}°, 신호 차이 ${D.contrast} dB, ${CONFIDENCE_LABEL[D.confidence]})`));

  const wifi = P.wifi || {};
  factors.push(f('전파', 'Wi-Fi 이름', !wifi.ran ? 'notrun' : (wifi.matches || []).length ? 'found' : 'clear',
    !wifi.ran ? '휴대폰 Wi-Fi 목록 이름을 점검하지 않았습니다.' : (wifi.matches || []).length ? wifi.matches.map((m) => `${m.ssid}(${m.app})`).join(', ') : `카메라 이름 규칙 일치 없음 (${wifi.count}개 점검)`,
    !wifi.ran ? '몰카 탐지 탭에서 Wi-Fi 이름을 점검하세요.' : null));

  // ---------------- 환경
  const issues = [...new Set(I.env.issues || [])];
  factors.push(f('환경', '측정 환경', issues.length ? 'partial' : (lensRan || ledRan) ? 'clear' : 'notrun', issues.length ? issues.join(' / ') : (lensRan || ledRan) ? '양호' : '카메라 측정 전', issues.length ? '휴대폰을 고정하고 조명을 조절한 뒤 다시 측정하세요.' : null));

  // ---------------- 방향 일치 (전파 방향 ↔ 빛 후보 발견 방향)
  if (D && D.ready && D.confidence !== 'low') {
    const lightHeads = [
      ...spyLens.filter((t) => t.heading != null && (!t.confirm || t.confirm.responsive)).map((t) => ({ kind: '렌즈 반사', h: t.heading })),
      ...((P.ir && P.ir.candidates) || []).filter((l) => l.heading != null).map((l) => ({ kind: '적외선 LED', h: l.heading })),
    ];
    for (const L of lightHeads) {
      const diff = angleDiff(L.h, D.bearing);
      if (diff <= D.spread / 2 + 15) matches.push({ text: `${R.targetName || '전파원'} 방향(${D.compass}, ${D.bearing}°)과 ${L.kind} 후보 발견 방향(${compassName(L.h)}, ${L.h}°)이 ${diff}° 차이로 일치`, diff });
    }
  }

  // ---------------- 종합
  const gRank = I.glasses ? I.glasses.rank : 0;
  const sRank = I.spy ? (SPY_RANK[I.spy.levelKey] || 0) : 0;
  let rank = Math.max(gRank === 6 ? 6 : Math.min(5, gRank), sRank);
  if (gRank === 0 && sRank === 0 && (R.ran || lensRan || ledRan || wifi.ran)) rank = 1;
  if (rank <= 1 && issues.length && (lensRan || ledRan)) rank = 2;
  if (rank < 3 && suspect.length) rank = 3;
  const lightFound = factors.some((x) => x.group === '빛' && x.status === 'found' && x.name !== '외형 육안 확인');
  const radioFound = factors.some((x) => x.group === '전파' && x.status === 'found');
  const fc = F.counts || {};
  if (fc.red) rank = Math.max(rank, F.best && F.best.radio && F.best.radio.linked ? 6 : 5);
  else if (fc.orange) rank = Math.max(rank, 4);
  else if (fc.yellow) rank = Math.max(rank, 3);
  if (matches.length || (I.glasses && I.glasses.levelKey === 'combined')) rank = 6;
  else if (lightFound && radioFound && rank < 4) rank = 4;
  const overall = OVERALL[rank];

  // ---------------- 다음 단계
  for (const x of factors) if (x.action && steps.length < 5 && !steps.includes(x.action)) steps.push(x.action);
  if (D && D.ready && !lightFound && steps.length < 5) steps.unshift(`전파 방향(${D.compass}쪽)에 있는 물건을 렌즈 반사 스윕과 적외선 탐색으로 집중 점검하세요.`);
  if (rank >= 4) steps.push('의심 물건은 분해·훼손하지 말고 사진으로 기록한 뒤 관리자 또는 경찰(112)에 알리세요.');

  const counts = { found: factors.filter((x) => x.status === 'found').length, notrun: factors.filter((x) => x.status === 'notrun').length, total: factors.length };
  const notes = ['종합 판단은 각 요인의 규칙 기반 근거를 묶은 것으로, 확률이 아닙니다.'];
  if (rank <= 1) notes.push('근거가 없다는 것이 스마트 글라스나 몰래카메라가 없다는 뜻은 아닙니다.');
  if (rank >= 4) notes.push('이 결과만으로 촬영 여부나 부정행위를 단정할 수 없습니다.');
  return { overall: overall.label, rank, tone: overall.tone, factors, matches, steps: steps.slice(0, 6), counts, notes };
}
