/* CheatingGuard 영상 분석 Web Worker (모듈 워커) */
import { run } from './processors.js';

self.onmessage = (e) => {
  const { id, cmd, payload } = e.data || {};
  try {
    const result = run(cmd, payload);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
