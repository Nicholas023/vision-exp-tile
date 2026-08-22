/**
 * engine.test.js — 针对 tile-engine.js 真实切图的集成式单元测试
 *
 * 用 pngjs 自生成测试图，不依赖外部文件，确保在 sharp 缺失时（fallback 引擎）同样可跑。
 * 依赖：pngjs（npm install 已安装）。sharp 若可用则测 WebP 分支，否则跳过。
 *
 * 注意：本项目另一个任务可能在改动 src/index.js / src/config.js。本测试只 import
 * tile-engine.js，不 import index/config，避免与其并发写冲突。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { splitImage, decodeFallback, computeGrid } from '../src/tile-engine.js';

const require2 = createRequire(import.meta.url);

// 判断 sharp 是否可用（tile-engine 内部用 createRequire 加载 sharp）
let hasSharp = false;
try {
  require2('sharp');
  hasSharp = true;
} catch {
  hasSharp = false;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 用 pngjs 生成一张 宽×高、四象限不同色的 PNG */
function makeQuadImage(width, height) {
  const { PNG } = require2('pngjs');
  const data = Buffer.alloc(width * height * 4);
  const hw = Math.floor(width / 2);
  const hh = Math.floor(height / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const off = (y * width + x) * 4;
      let r = 0, g = 0, b = 0;
      if (x < hw && y < hh) { r = 255; g = 0; b = 0; }        // 左上 红
      else if (x >= hw && y < hh) { r = 0; g = 255; b = 0; }  // 右上 绿
      else if (x < hw && y >= hh) { r = 255; g = 255; b = 0; }// 左下 黄
      else { r = 0; g = 0; b = 255; }                          // 右下 蓝
      data[off] = r;
      data[off + 1] = g;
      data[off + 2] = b;
      data[off + 3] = 255;
    }
  }
  const png = new PNG({ width, height });
  png.data = data;
  return Buffer.from(PNG.sync.write(png));
}

/** 读取一块 RGBA 图中心像素 */
function centerPixel(pngBuf) {
  const img = decodeFallback(pngBuf, '.png');
  const cx = Math.floor(img.width / 2);
  const cy = Math.floor(img.height / 2);
  const off = (cy * img.width + cx) * 4;
  return { r: img.data[off], g: img.data[off + 1], b: img.data[off + 2] };
}

test('splitImage 1600×1600 → 4 块，边缘块 1:1 无损（右下≈蓝）', async () => {
  const pngBuf = makeQuadImage(1600, 1600);
  const res = await splitImage(pngBuf, '.png', { blockSize: 800, threshold: 800 });

  assert.equal(res.splits, true);
  assert.equal(res.width, 1600);
  assert.equal(res.height, 1600);
  assert.equal(res.tiles.length, 4);
  // engine 为 sharp 或 fallback 都算通过
  assert.ok(res.engine === 'sharp' || res.engine === 'fallback', `engine=${res.engine}`);

  // 每块 buffer 是 PNG（magic 89 50 4E 47）
  for (const t of res.tiles) {
    assert.equal(t.buffer[0], 0x89);
    assert.equal(t.buffer[1], 0x50);
    assert.equal(t.buffer[2], 0x4e);
    assert.equal(t.buffer[3], 0x47);
    assert.equal(t.w, 800);
    assert.equal(t.h, 800);
  }

  // tiles[3]（row1 col1，右下象限）中心像素 ≈ 蓝
  const px = centerPixel(res.tiles[3].buffer);
  assert.ok(px.b > 200, `block3 center blue=${px.b}`);
  assert.ok(px.r < 80, `block3 center red=${px.r}`);
  assert.ok(px.g < 80, `block3 center green=${px.g}`);

  // tiles[0]（左上）中心 ≈ 红
  const px0 = centerPixel(res.tiles[0].buffer);
  assert.ok(px0.r > 200, `block0 center red=${px0.r}`);
  assert.ok(px0.b < 80, `block0 center blue=${px0.b}`);
});

test('splitImage 800×800 → 不切分', async () => {
  const pngBuf = makeQuadImage(800, 800);
  const res = await splitImage(pngBuf, '.png', { blockSize: 800, threshold: 800 });
  assert.equal(res.splits, false);
  assert.equal(res.tiles.length, 0);
  assert.equal(res.width, 800);
  assert.equal(res.height, 800);
});

test('splitFallback 在无 sharp 时也应可用（镜像 splitImage 结果）', async () => {
  // 直接调用 splitFallback（不依赖 sharp），验证纯 JS 引擎的切图与色块
  const { splitFallback } = await import('../src/tile-engine.js');
  const pngBuf = makeQuadImage(1600, 1600);
  const res = await splitFallback(pngBuf, '.png', { blockSize: 800, threshold: 800 });
  assert.equal(res.splits, true);
  assert.equal(res.tiles.length, 4);
  const px = centerPixel(res.tiles[3].buffer);
  assert.ok(px.b > 200);
});

test('computeGrid 与 tiles 顺序在 engine 里一致（行优先）', () => {
  const grid = computeGrid(1600, 1600, 800, 0);
  assert.equal(grid.tiles.length, 4);
  assert.equal(grid.tiles[3].row, 1);
  assert.equal(grid.tiles[3].col, 1);
});

// 若 sharp 可用：进一步验证 WebP 分支（engine === sharp）
test('sharp 分支：WebP 输入可切且 engine===sharp', { skip: hasSharp ? false : 'sharp 未安装，跳过 WebP 分支' }, async () => {
  const sharp = require2('sharp');
  // 用 sharp 生成一张蓝色 WebP
  const webpBuf = await sharp({
    create: { width: 1600, height: 1600, channels: 3, background: { r: 0, g: 0, b: 255 } }
  }).webp().toBuffer();
  assert.ok(webpBuf[0] === 0x52 && webpBuf[1] === 0x49 && webpBuf[2] === 0x46); // RIFF

  const res = await splitImage(webpBuf, '.webp', { blockSize: 800, threshold: 800 });
  assert.equal(res.engine, 'sharp');
  assert.equal(res.splits, true);
  assert.equal(res.tiles.length, 4);
});

// 若脚本生成的 3200×2000 夹具存在，进一步验证跨网格切分
const fixturePath = join(__dirname, 'fixtures', 'test-3200x2000.png');
test('splitImage 3200×2000 夹具存在时按 4×3 网格切分', { skip: existsSync(fixturePath) ? false : '夹具未生成，跳过' }, async () => {
  const { readFileSync } = await import('node:fs');
  const pngBuf = readFileSync(fixturePath);
  const res = await splitImage(pngBuf, '.png', { blockSize: 800, threshold: 800 });
  assert.equal(res.splits, true);
  assert.equal(res.width, 3200);
  assert.equal(res.height, 2000);
  const grid = computeGrid(3200, 2000, 800, 0);
  assert.equal(res.tiles.length, grid.tiles.length);
  assert.equal(res.tiles.length, 12); // 4 列 × 3 行
  assert.ok(res.engine === 'sharp' || res.engine === 'fallback');
});

// rotate 参数：识别前先旋转整图（宽高互换），坐标与块数应基于旋转后的图像
test('splitImage rotate=90：宽高互换，网格基于旋转后图像', { skip: hasSharp ? false : 'rotate 需要 sharp，跳过' }, async () => {
  const { readFileSync } = await import('node:fs');
  const pngBuf = readFileSync(fixturePath); // 3200×2000
  const res = await splitImage(pngBuf, '.png', { blockSize: 800, threshold: 800, rotate: 90 });
  assert.equal(res.engine, 'sharp');
  assert.equal(res.splits, true);
  assert.equal(res.width, 2000); // 旋转后宽高互换
  assert.equal(res.height, 3200);
  assert.equal(res.tiles.length, 12); // 2000/800=3 列 × 3200/800=4 行 = 12
  assert.ok(res.tiles[0].x === 0 && res.tiles[0].y === 0);
  // 第一行应只有 3 块（宽 2000 → 3 列）
  assert.ok(res.tiles[2].col === 2);
});

// rotate 非法值：应抛出明确错误（由调用方校验，引擎层静默视为 0 时结构不被破坏）
test('splitImage rotate 非法视角：引擎安全降级为不旋转', { skip: hasSharp ? false : '需要 sharp，跳过' }, async () => {
  const { readFileSync } = await import('node:fs');
  const pngBuf = readFileSync(fixturePath);
  const res = await splitImage(pngBuf, '.png', { blockSize: 800, threshold: 800, rotate: 45 });
  assert.equal(res.engine, 'sharp');
  assert.equal(res.splits, true);
  assert.equal(res.width, 3200); // 45° 被当作 0°（引擎层安全降级；工具层在参数校验处已拦截）
  assert.equal(res.height, 2000);
});

// 生成夹具目录（供后续测试使用，若已存在则跳过）
if (!existsSync(join(__dirname, 'fixtures'))) {
  mkdirSync(join(__dirname, 'fixtures'), { recursive: true });
}
