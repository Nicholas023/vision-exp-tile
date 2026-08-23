// preprocess.test.js — v0.2.0 前处理管线单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { autoPreprocess, toGray, statsOf, otsuThreshold } from '../src/preprocess.js';

/** 合成 PNG：填充基色 + 若干"笔画"像素（用于深底/手写/印刷体模拟） */
function synthPng(width, height, { base = [255, 255, 255], strokes = [], strokeColor = [0, 0, 0] } = {}) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = base[0];
    png.data[i * 4 + 1] = base[1];
    png.data[i * 4 + 2] = base[2];
    png.data[i * 4 + 3] = 255;
  }
  for (const [x, y] of strokes) {
    if (x >= 0 && y >= 0 && x < width && y < height) {
      const i = y * width + x;
      png.data[i * 4] = strokeColor[0];
      png.data[i * 4 + 1] = strokeColor[1];
      png.data[i * 4 + 2] = strokeColor[2];
    }
  }
  return PNG.sync.write(png);
}

/** 生成一组笔画像素（模拟笔迹行） */
function strokeLine(width, y, from = 0.2, to = 0.8, step = 6) {
  const out = [];
  for (let x = Math.floor(width * from); x < width * to; x += step) out.push([x, y]);
  return out;
}

test('基础算子：toGray/statsOf/otsuThreshold', () => {
  const strokes = [];
  for (let y = 20; y < 24; y += 1) strokes.push(...strokeLine(40, y, 0.2, 0.8, 2));
  const png = PNG.sync.read(synthPng(40, 40, { base: [255, 255, 255], strokes, strokeColor: [0, 0, 0] }));
  const gray = toGray(png);
  assert.equal(gray.length, 1600);
  const st = statsOf(gray);
  assert.ok(st.mean > 200, '白底均值应高');
  assert.ok(st.std > 10, '有笔迹应有波动');
  const t = otsuThreshold(gray);
  assert.ok(t > 80 && t < 180, `Otsu 应居中分割（got ${t}）`);
});

test('深底图：自动反色+二值化（invert/otsu）', async () => {
  const strokes = [];
  // 多行白字（brightShare >2%）
  for (let y = 40; y < 170; y += 12) strokes.push(...strokeLine(300, y, 0.2, 0.8, 4));
  const buf = synthPng(300, 200, {
    base: [30, 26, 60], // 深蓝底
    strokes,
    strokeColor: [255, 255, 255] // 白字
  });
  const r = await autoPreprocess(buf);
  assert.ok(r.applied.includes('invert'), `应反色，applied=${JSON.stringify(r.applied)}`);
  assert.equal(r.isDark, true);
  assert.ok(r.enhanced);
  assert.equal(r.width, 600, '深底小图应 2× 放大');
  assert.equal(r.height, 400);
});

test('手写候选：白底笔画密度适中 → 触发放大', async () => {
  // 白底 + 稀疏笔画（darkShare 约 10%）+ 中等 std
  const strokes = [];
  for (let y = 30; y < 250; y += 8) strokes.push(...strokeLine(320, y, 0.2, 0.75, 7));
  const buf = synthPng(320, 280, { base: [255, 255, 255], strokes });
  const r = await autoPreprocess(buf);
  assert.ok(r.applied.includes('enlarge'), `手写候选应放大，applied=${JSON.stringify(r.applied)}`);
  assert.equal(r.width, 640, '2× 放大');
  assert.equal(r.height, 560);
});

test('高对比/纯色图：自动跳过（applied=[]）', async () => {
  // 纯白底（std≈8）：应完全跳过（无文本信号）
  const r = await autoPreprocess(synthPng(64, 64, { base: [255, 255, 255] }));
  assert.deepEqual(r.applied, [], `纯色应跳过（applied=${JSON.stringify(r.applied)}）`);
  assert.equal(r.enhanced, false);
});

test('force=none / 非 PNG：原样返回', async () => {
  const buf = synthPng(64, 64, { base: [255, 255, 255] });
  const r = await autoPreprocess(buf, { force: 'none' });
  assert.deepEqual(r.applied, []);
  assert.equal(r.enhanced, false);
  const bad = await autoPreprocess(Buffer.from('not-png'));
  assert.deepEqual(bad.applied, []);
  assert.equal(bad.enhanced, false);
});
