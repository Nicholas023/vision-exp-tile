// 假 OCR worker：模拟 ocr-worker.py 的行协议（stdio JSON in/out），
// 默认每条请求延迟 80ms 后回复 {ok:true, lines:[{text:'fake'}]}，供池逻辑测试。
// path 前缀控制行为：mode:slow（5s 后回复，触发超时）/ mode:fail（固定失败）。
// 用法：node tests/fixtures/fake-ocr-worker.mjs
let seq = 0;
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ id: -1, ok: false, error: 'bad' }) + '\n'); continue; }
    const p = String(req.path ?? '');
    const mode = p.startsWith('mode:slow') ? 'slow' : p.startsWith('mode:fail') ? 'fail' : 'ok';
    const send = () => process.stdout.write(JSON.stringify(
      mode === 'fail'
        ? { id: req.id, ok: false, error: 'intentional failure' }
        : { id: req.id, ok: true, lines: [{ text: 'fake-' + (++seq), x: 0, y: 0, width: 10, height: 10, score: 0.99 }], elapsed_ms: 80 }
    ) + '\n');
    if (mode === 'slow') setTimeout(send, 5000); // 触发超时
    else setTimeout(send, 80);
  }
});
process.stdin.on('end', () => process.exit(0));
