# 외부 자료 및 라이선스 고지

## 포함된 외부 코드·라이브러리·모델
**없음.** CheatingGuard v1.0.0은 외부 JavaScript 라이브러리, CDN, 폰트, AI 모델을 포함하거나 불러오지 않습니다. 모든 영상처리 코드(가우시안 블러, 정합, 적응형 임계값, 모폴로지, 연결 성분 분석 등)는 이 프로젝트에서 직접 작성했습니다. OpenCV.js, TensorFlow.js, ONNX Runtime Web, MediaPipe는 검토했으나 v1.0.0에는 사용하지 않았습니다(용량·검증된 모델 부재).

## 참고한 사실 정보
| 자료 | 라이선스 | 사용 방식 |
|---|---|---|
| Nearby Glasses — Yves Jeanrenaud, https://github.com/yjeanrenaud/yj_nearbyglasses | AGPL-3.0 | README에 공개된 **사실 정보**(블루투스 제조사 식별번호 0x01AB·0x058E·0x0D53·0x03C2·0x05D6, 서비스 UUID 7905FFF0-B5CE-4E99-A40F-4B1E122D00D0, 기기명 문자열 ‘rayban’·‘ray-ban’·‘HeyCyan’, 예시 광고 데이터)만 참고. 소스코드는 복사·사용하지 않음 |
| Help Net Security 기사 (2026-02-27) | 기사 저작권 | 위 식별번호의 교차 확인 |
| Bluetooth SIG Assigned Numbers | Bluetooth SIG | 제조사 식별번호 체계 (원문 직접 대조는 미실시) |

제조사 식별번호·UUID는 표준 기구가 할당한 사실 정보이며, 출처를 데이터베이스(`data/glasses-db.json`의 `sources`)에 기록했습니다.

## 몰래카메라 점검 데이터 출처 (v1.1.0)
`data/spycam-db.json`의 Wi-Fi 이름 규칙은 공개된 제품 설명서·지원 문서에서 사실 정보(핫스팟 이름 형식)만 참고했으며, 각 규칙에 출처 URL과 확인 날짜를 기록했습니다: AGPTEK V380 설명서(manualslib), Orient CCTV, V380Pro 분석 글(camdsmith.github.io), A9 Mini WiFi Camera 설명서(manuals.plus), Green Feathers 지원 문서, iCSee 카메라 빠른 설명서(manuals.plus), ZOSI 지원 문서, Zetronix LookCam 설명서, Scribd 사용자 업로드 설명서(미검증), Tuya BLE SDK 안내서.

## 상표
Ray-Ban, Oakley, Meta, Snap, Spectacles, Xiaomi, Solos, Brilliant Labs, Even Realities, Rokid, XREAL, Vuzix, Amazon, Echo Frames, V380, iCSee, ZOSI, LookCam, JXLCAM, Tuya 등은 각 소유자의 상표이며, 제품 식별 목적으로만 이름을 사용합니다. 이 프로그램은 해당 회사들과 관련이 없습니다.
