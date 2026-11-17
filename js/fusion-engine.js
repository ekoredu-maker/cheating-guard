/**
 * CheatingGuard 복합 탐지 판단 엔진
 * - 각 모듈의 실제 측정 결과를 종합해 판단 근거를 제시한다.
 * - '탐지 근거 점수'는 규칙 기반 가중치 합이며 확률이 아니다.
 * - 무선 결과와 광학 결과는 사용자가 '같은 대상'임을 확인한 경우에만 합산한다.
 */
export const LEVELS = {
  unavailable: { key: 'unavailable', label: '분석 불가', rank: 0, tone: 'muted' },
  none:        { key: 'none',        label: '미탐지', rank: 1, tone: 'muted' },
  poor:        { key: 'poor',        label: '측정 환경 불량', rank: 2, tone: 'warn' },
  review:      { key: 'review',      label: '추가 확인 필요', rank: 3, tone: 'warn' },
  candidate:   { key: 'candidate',   label: '스마트 글라스 후보', rank: 4, tone: 'alert' },
  camera:      { key: 'camera',      label: '카메라 탑재형 스마트 글라스 의심', rank: 5, tone: 'alert' },
  combined:    { key: 'combined',    label: '복합 탐지 근거 일치', rank: 6, tone: 'alert' },
};

export const SCORE_NOTE = '탐지 근거 점수는 규칙 기반 가중치의 합으로, 실제 확률이 아닙니다.';

const STRONG_BLE = new Set(['alias', 'uuid', 'fingerprint']);

/**
 * input = {
 *   support: { ble, camera, torch, sensors },
 *   ble: { ran, scanning, devices:[{name, matches:[...]}] },
 *   optical: { ran, mode, cycles, reproducible:[], pending:[], stillCount, env:{state, issues} },
 *   vision: { ledRan, ledCandidates:[], darkRan, darkCount, visual:{yesCount, yes:[]} },
 *   sensors: { motion, light, issues:[] },
 *   sameTarget: boolean
 * }
 */
export function evaluate(input) {
  const I = Object.assign({ support: {}, ble: {}, optical: {}, vision: {}, sensors: {} }, input || {});
  const evidence = [], reviewItems = [], modules = [];

  // ---- 블루투스 ----
  let bleScore = 0, bleAny = false, bleCamera = false, bleStrongCamera = false;
  if (!I.support.ble) modules.push({ name: '블루투스', state: '미지원', detail: '이 브라우저는 Web Bluetooth를 지원하지 않습니다.' });
  else if (!I.ble.ran) modules.push({ name: '블루투스', state: '미실행', detail: '블루투스 탭에서 기기 선택 검색을 실행할 수 있습니다.' });
  else {
    const devs = I.ble.devices || [];
    modules.push({ name: '블루투스', state: '측정함', detail: devs.length ? `데이터베이스 일치 기기 ${devs.length}대` : '데이터베이스와 일치하는 기기 없음' });
    let best = 0;
    for (const d of devs) {
      const seen = new Set();
      let s = 0;
      for (const m of d.matches) {
        if (seen.has(m.type)) continue;
        seen.add(m.type);
        s += m.weight;
        const safe = d.name ? m.label.split(d.name).join('(기기명)') : m.label;
        evidence.push({ source: '블루투스', text: `${d.name}: ${m.label}`, safeText: safe, points: m.weight, verified: m.verified, models: m.models, note: m.note || (m.camera === 'no' ? '카메라가 없는 모델과 일치' : null) });
        if (m.camera === 'yes' || m.camera === 'mixed') bleCamera = true;
        if (STRONG_BLE.has(m.type) && m.verified && m.camera === 'yes') bleStrongCamera = true;
      }
      best = Math.max(best, Math.min(60, s));
      bleAny = bleAny || d.matches.length > 0;
    }
    bleScore = best;
    if (bleAny && !bleStrongCamera) reviewItems.push('블루투스 일치 항목은 같은 제조사의 다른 기기(VR 헤드셋, 이어폰 등)일 수 있습니다. 대상 기기를 직접 확인하세요.');
  }

  // ---- 광학 ----
  let optScore = 0, optRep = false, optPending = false;
  const O = I.optical || {};
  if (!I.support.camera) modules.push({ name: '광학 탐지', state: '미지원', detail: '카메라를 사용할 수 없습니다.' });
  else if (!O.ran) modules.push({ name: '광학 탐지', state: '미실행', detail: '광학 탐지 또는 통합 탐지를 시작하세요.' });
  else {
    const rep = O.reproducible || [], pend = O.pending || [];
    optRep = rep.length > 0; optPending = pend.length > 0 || (O.stillCount || 0) > 0;
    const modeName = O.mode === 'flash' || O.mode === 'flash-diff' ? '플래시 차분' : O.mode === 'spots' ? '일반 영상' : '정지 영상';
    modules.push({ name: '광학 탐지', state: '측정함', detail: `${modeName} 분석 ${O.cycles || 0}회 · 재현 반사점 ${rep.length}개` });
    if (optRep) {
      const b = rep[0];
      optScore = O.mode === 'flash' || O.mode === 'flash-diff' ? 30 : 20;
      evidence.push({ source: '광학', text: `반복 측정에서 재현된 반사점 ${rep.length}개 (최고 ${b.hits}/${b.observed}회, 반사 특징 점수 ${b.featureScore})`, points: optScore, verified: false, note: '안경알·금속 나사·장식품 반사일 수도 있습니다.' });
      reviewItems.push('표시된 반사점 위치가 안경테 모서리(카메라 위치)인지 직접 확인하세요.');
    } else if (optPending) {
      optScore = 8;
      evidence.push({ source: '광학', text: `재현성 미확인 반사점 후보 ${pend.length || O.stillCount}개`, points: 8, verified: false, note: '측정을 반복해 재현성을 확인하세요.' });
    }
  }

  // ---- 표시등 · 외형 ----
  const V = I.vision || {};
  let visScore = 0;
  const leds = V.ledCandidates || [];
  if (V.ledRan) {
    modules.push({ name: '표시등 분석', state: '측정함', detail: `표시등 후보 ${leds.length}개` });
    if (leds.length) {
      visScore += 15;
      evidence.push({ source: '표시등', text: `지속 또는 점멸하는 발광점 후보 ${leds.length}개 (${leds.slice(0, 3).map((l) => l.colorName).join(', ')})`, points: 15, verified: false, note: '표시등 후보일 뿐 촬영 여부를 확정하지 않습니다.' });
      reviewItems.push('발광점이 안경테의 표시등 위치에 있는지 확인하세요.');
    }
  }
  if (V.darkRan && V.darkCount) {
    evidence.push({ source: '영상 특징', text: `규칙 기반 렌즈 형태(어두운 원형점) 후보 ${V.darkCount}개`, points: 0, verified: false, note: '참고 정보 — 점수에 반영하지 않음' });
  }
  const yes = (V.visual && V.visual.yesCount) || 0;
  if (yes) {
    const p = Math.min(20, yes * 5);
    visScore += p;
    evidence.push({ source: '육안 확인', text: `외형 특징 ${yes}개 확인: ${(V.visual.yes || []).slice(0, 3).join(' / ')}`, points: p, verified: false, note: '사용자 확인 결과' });
  }

  // ---- 센서 · 환경 ----
  const envIssues = [...((O.env && O.env.issues) || []), ...((I.sensors && I.sensors.issues) || [])];
  const envPoor = envIssues.length > 0;
  if (I.sensors && I.sensors.motion && I.sensors.motion !== 'unknown') modules.push({ name: '동작 센서', state: '측정함', detail: I.sensors.motion === 'stable' ? '안정' : '흔들림' });

  const anyRan = !!(I.ble.ran || O.ran || V.ledRan || V.darkRan || yes);
  const nonBle = Math.min(100, optScore + visScore);
  const score = I.sameTarget ? Math.min(100, bleScore + nonBle) : Math.max(bleScore, nonBle);

  let level;
  if (!anyRan) level = LEVELS.unavailable;
  else if (bleAny && optRep && I.sameTarget) level = LEVELS.combined;
  else if (bleStrongCamera) level = LEVELS.camera;
  else if (optRep && yes >= 2) level = LEVELS.camera;
  else if (bleAny) level = LEVELS.candidate;
  else if (optRep || optPending || leds.length || yes) level = LEVELS.review;
  else if (envPoor) level = LEVELS.poor;
  else level = LEVELS.none;

  const notes = [SCORE_NOTE];
  if (bleAny && (optRep || leds.length) && !I.sameTarget) notes.push('블루투스 결과와 영상 결과가 같은 대상에서 나왔는지 확인되지 않아 합산하지 않았습니다.');
  if (level === LEVELS.none) notes.push('미탐지는 스마트 글라스가 없다는 뜻이 아닙니다. 블루투스가 꺼져 있거나 측정 조건이 맞지 않으면 탐지되지 않습니다.');
  if (level.rank >= LEVELS.candidate.rank) notes.push('이 결과만으로 촬영 여부나 부정행위를 판단할 수 없습니다. 당사자에게 정중히 확인하는 절차를 따르세요.');
  if (bleCamera && !bleStrongCamera && bleAny) notes.push('카메라 탑재 모델과 연관된 식별자이지만 모델을 특정할 수 있는 검증된 근거는 아닙니다.');

  const candidateCount = (I.ble.devices || []).length + (O.reproducible || []).length + leds.length;
  return {
    level: level.label, levelKey: level.key, tone: level.tone, rank: level.rank,
    score, scoreParts: { ble: bleScore, optical: optScore, visual: visScore }, scoreNote: SCORE_NOTE,
    evidence, reviewItems: [...new Set(reviewItems)], envIssues: [...new Set(envIssues)], envPoor,
    modules, notes, candidateCount, reviewCount: reviewItems.length,
  };
}
