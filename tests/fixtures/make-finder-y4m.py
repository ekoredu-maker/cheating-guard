"""찾기 모드 테스트용 모의 카메라 영상(Y4M) — 자동 테스트 전용, 실제 탐지 데이터 아님.
어두운 질감 배경을 카메라가 천천히 옆으로 훑는 장면 + 큰 조명(제외 대상) + 지름 약 3픽셀의 작은 렌즈 반사."""
import sys, numpy as np
W, H, N, FPS = 1280, 720, 30, 10
rng = np.random.default_rng(7)
world = (30 + 25 * np.kron(rng.random((H // 8 + 1, (W + 400) // 8 + 1)), np.ones((8, 8)))[:H, :W + 400] + 10 * rng.random((H, W + 400))).astype(np.uint8)
yy, xx = np.mgrid[0:H, 0:W + 400]
world[(yy - 360) ** 2 + (xx - 900) ** 2 <= 2.3] = 255     # 렌즈 반사
world[100:160, 300:360] = 255                              # 조명
with open(sys.argv[1], 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
    for k in range(N):
        ox = k * 6
        Y = world[:, ox:ox + W]
        f.write(b'FRAME\n'); f.write(Y.tobytes()); f.write(bytes([128]) * (W * H // 2))
print('wrote', sys.argv[1])
