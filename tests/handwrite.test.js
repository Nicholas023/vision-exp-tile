// handwrite.test.js — v0.2.0 手写判别器 + preprocess enlarge-off 单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { detectHandwrite } from '../src/handwrite.js';
import { autoPreprocess } from '../src/preprocess.js';

function synthPng(width, height, { base = [255, 255, 255], strokes = [], strokeColor = [0, 0, 0] } = {}) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = base[0]; png.data[i * 4 + 1] = base[1]; png.data[i * 4 + 2] = base[2]; png.data[i * 4 + 3] = 255;
  }
  for (const [x, y] of strokes) {
    if (x >= 0 && y >= 0 && x < width && y < height) {
      const i = y * width + x;
      png.data[i * 4] = strokeColor[0]; png.data[i * 4 + 1] = strokeColor[1]; png.data[i * 4 + 2] = strokeColor[2];
    }
  }
  return PNG.sync.write(png);
}

/** 手写行模拟：若干行内左右摆动的连续笔画（字迹波状、行内起伏、笔画连通） */
function scribbleLines(width, height, seed = 1) {
  const out = [];
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const rows = 7;
  const rowH = Math.floor(height / (rows + 1));
  for (let r = 0; r < rows; r += 1) {
    const baseY = 20 + r * rowH;
    let x = 24;
    while (x < width - 30) {
      const dx = 3 + Math.floor(rand() * 9);
      const dy = Math.round((rand() - 0.5) * 14);
      // 连续笔画段（保持连通性：与前一点相邻）
      for (let k = 0; k < 12; k += 1) {
        out.push([x, baseY + dy + Math.round(Math.sin(k / 2) * 4)], [x + 1, baseY + dy]);
      }
      x += dx;
    }
  }
  return out;
}

/** 整齐横线行（模拟印刷：行距均匀、连通域高度集中） */
function printLines(width, height) {
  const out = [];
  for (let y = 30; y < height - 10; y += 34) {
    for (let x = 20; x < width - 20; x += 3) out.push([x, y]);
  }
  return out;
}

test('判别器：杂乱斜线（手写模拟）判为手写', () => {
  const buf = synthPng(400, 300, { base: [255, 255, 255], strokes: scribbleLines(400, 300, 7) });
  const r = detectHandwrite(buf);
  assert.equal(r.isHandwrite, true, `score=${r.score} ${JSON.stringify(r.features)}`);
});

test('判别器：整齐行线（印刷模拟）判为非手写', () => {
  const buf = synthPng(400, 300, { base: [255, 255, 255], strokes: printLines(400, 300) });
  const r = detectHandwrite(buf);
  assert.equal(r.isHandwrite, false, `score=${r.score} ${JSON.stringify(r.features)}`);
});

test('判别器：非 PNG 容错（不抛错）', () => {
  const r = detectHandwrite(Buffer.from('not-png'));
  assert.equal(r.isHandwrite, false);
  assert.ok(r.error);
});

test('preprocess enlarge=off：只增强不放大（applied 不含 enlarge）', async () => {
  const strokes = scribbleLines(300, 220, 3);
  const buf = synthPng(300, 220, { base: [255, 255, 255], strokes });
  const r = await autoPreprocess(buf, { enlarge: 'off' });
  assert.ok(!r.applied.includes('enlarge'), `不应放大，applied=${JSON.stringify(r.applied)}`);
  assert.equal(r.width, 300, '尺寸不变');
});
