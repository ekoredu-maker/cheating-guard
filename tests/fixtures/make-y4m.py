"""모의 카메라 입력(Y4M) 생성기 — 자동 테스트 전용. 실제 탐지 데이터가 아님.
장면: 회색 배경 + 어두운 안경테 윤곽 + 안경테 모서리의 작은 밝은 점(렌즈 반사 모사) + 1초 주기로 점멸하는 적색 점(표시등 모사)
"""
import sys
W, H, FPS, N = 640, 480, 10, 20
out = sys.argv[1]

def yuv(r, g, b):
    y = 0.299*r + 0.587*g + 0.114*b
    u = -0.169*r - 0.331*g + 0.5*b + 128
    v = 0.5*r - 0.419*g - 0.081*b + 128
    c = lambda x: max(0, min(255, int(round(x))))
    return c(y), c(u), c(v)

def frame(i):
    px = [[(95 + (x * 25) // W, 128, 128) for x in range(W)] for y in range(H)]
    def fill(x0, y0, x1, y1, rgb):
        Y, U, V = yuv(*rgb)
        for y in range(max(0, y0), min(H, y1)):
            row = px[y]
            for x in range(max(0, x0), min(W, x1)):
                row[x] = (Y, U, V)
    def disk(cx, cy, r, rgb):
        Y, U, V = yuv(*rgb)
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    px[y][x] = (Y, U, V)
    # 안경테 (두 개의 사각 프레임)
    for (x0, y0) in [(150, 200), (350, 200)]:
        fill(x0, y0, x0 + 140, y0 + 8, (25, 25, 25)); fill(x0, y0 + 92, x0 + 140, y0 + 100, (25, 25, 25))
        fill(x0, y0, x0 + 8, y0 + 100, (25, 25, 25)); fill(x0 + 132, y0, x0 + 140, y0 + 100, (25, 25, 25))
    fill(290, 215, 350, 222, (25, 25, 25))
    # 렌즈 반사 모사 (작은 밝은 점)
    disk(162, 212, 3, (255, 255, 255))
    # 표시등 모사 (적색, 0.5초 켜짐/0.5초 꺼짐)
    if (i // 5) % 2 == 0:
        disk(478, 212, 3, (255, 20, 20))
    Yp = bytearray(W * H); Up = bytearray((W // 2) * (H // 2)); Vp = bytearray((W // 2) * (H // 2))
    for y in range(H):
        for x in range(W):
            Yp[y * W + x] = px[y][x][0]
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            Up[(y // 2) * (W // 2) + x // 2] = px[y][x][1]; Vp[(y // 2) * (W // 2) + x // 2] = px[y][x][2]
    return bytes(Yp) + bytes(Up) + bytes(Vp)

with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
    frames = [frame(i) for i in range(10)]
    for i in range(N):
        f.write(b'FRAME\n'); f.write(frames[i % 10])
print('wrote', out)
