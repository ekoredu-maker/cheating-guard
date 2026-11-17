/** 테스트용 정적 서버: /cheating-guard/ 하위 경로로 제공 (GitHub Pages 프로젝트 경로 모사) */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown' };

export function startServer(port = 8080, base = '/cheating-guard/') {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/' || p === base.slice(0, -1)) { res.writeHead(302, { Location: base }); return res.end(); }
      if (!p.startsWith(base)) { res.writeHead(404); return res.end('not found'); }
      p = p.slice(base.length) || 'index.html';
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT) || /node_modules|tests\/e2e\/out/.test(file)) { res.writeHead(403); return res.end(); }
      await stat(file);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (_) { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] && process.argv[1].endsWith('static-server.mjs')) {
  const port = +(process.argv[2] || 8080);
  startServer(port).then(() => console.log(`http://localhost:${port}/cheating-guard/`));
}
