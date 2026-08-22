/**
 * grid.test.js — 针对 tile-engine.js 的纯几何逻辑单元测试
 *
 * 覆盖：
 *  - shouldSplit：长边是否超过阈值
 *  - computeGrid：行/列数、边缘块实际尺寸、overlap 步长、非法参数报错
 *  - tileFileName：自含坐标的文件名
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSplit, computeGrid, tileFileName, MIN_BLOCK_SIZE } from '../src/tile-engine.js';

test('shouldSplit 判断长边是否超过阈值', () => {
  // 800×800 → 长边 800，不大于 800 → 不切
  assert.equal(shouldSplit(800, 800), false);
  // 801×800 → 长边 801 > 800 → 切
  assert.equal(shouldSplit(801, 800), true);
  // 800×801 → 长边 801 > 800 → 切
  assert.equal(shouldSplit(800, 801), true);
  // 自定义阈值：长边 500 不大于 1000 → 不切
  assert.equal(shouldSplit(500, 400, 1000), false);
});

test('computeGrid 4000×3000、块 800、无 overlap 的完整网格', () => {
  const grid = computeGrid(4000, 3000, 800, 0);
  // 高度 3000 / 800：y = 0,800,1600,2400（第 4 行 h=600 到底终止）→ 4 行
  assert.equal(grid.rows, 4);
  // 宽度 4000 / 800：x = 0,800,1600,2400,3200 → 5 列
  assert.equal(grid.cols, 5);
  assert.equal(grid.tiles.length, 20);

  // tiles[0]：左上角（row0 col0）
  assert.deepEqual(
    { row: grid.tiles[0].row, col: grid.tiles[0].col, x: grid.tiles[0].x, y: grid.tiles[0].y, w: grid.tiles[0].w, h: grid.tiles[0].h },
    { row: 0, col: 0, x: 0, y: 0, w: 800, h: 800 }
  );

  // tiles[4]：第 0 行最右（col4，x=3200）
  assert.deepEqual(
    { row: grid.tiles[4].row, col: grid.tiles[4].col, x: grid.tiles[4].x, y: grid.tiles[4].y, w: grid.tiles[4].w, h: grid.tiles[4].h },
    { row: 0, col: 4, x: 3200, y: 0, w: 800, h: 800 }
  );

  // tiles[19]：最后一行（row3）最右（col4），边缘块 h=600
  assert.deepEqual(
    { row: grid.tiles[19].row, col: grid.tiles[19].col, x: grid.tiles[19].x, y: grid.tiles[19].y, w: grid.tiles[19].w, h: grid.tiles[19].h },
    { row: 3, col: 4, x: 3200, y: 2400, w: 800, h: 600 }
  );
});

test('computeGrid 1000×1000、块 800 的边缘宽度', () => {
  const grid = computeGrid(1000, 1000, 800, 0);
  // tiles[1]：row0 col1（x=800），边缘块 w=200
  assert.deepEqual(
    { row: grid.tiles[1].row, col: grid.tiles[1].col, x: grid.tiles[1].x, y: grid.tiles[1].y, w: grid.tiles[1].w, h: grid.tiles[1].h },
    { row: 0, col: 1, x: 800, y: 0, w: 200, h: 800 }
  );
  // 2 行 × 2 列 = 4 块
  assert.equal(grid.tiles.length, 4);
  assert.equal(grid.rows, 2);
  assert.equal(grid.cols, 2);
});

test('computeGrid 2000×2000、块 800、overlap 64 的步长与边缘', () => {
  const grid = computeGrid(2000, 2000, 800, 64);
  // 步长 = 800 - 64 = 736
  const step = 800 - 64;
  // x: 0,736,1472（w=800,800,528）→ 3 列；y 同理 3 行 → 9 块
  assert.equal(grid.rows, 3);
  assert.equal(grid.cols, 3);
  assert.equal(grid.tiles.length, 9);

  // tiles[1] 起点 x = step
  assert.equal(grid.tiles[1].x, step);
  assert.equal(grid.tiles[1].col, 1);
  assert.equal(grid.tiles[1].row, 0);

  // 每个非边缘块 w/h 应为 blockSize；边缘块取剩余实际尺寸
  for (const t of grid.tiles) {
    assert.equal(t.w, Math.min(800, 2000 - t.x), `tile w@(${t.x},${t.y})`);
    assert.equal(t.h, Math.min(800, 2000 - t.y), `tile h@(${t.x},${t.y})`);
  }
});

test('computeGrid 非法参数抛出错误', () => {
  // blockSize 小于最小块边长（64）
  assert.throws(() => computeGrid(1000, 1000, 32), /blockSize/);
  assert.throws(() => computeGrid(1000, 1000, MIN_BLOCK_SIZE - 1), /blockSize/);
  // overlap 负数
  assert.throws(() => computeGrid(1000, 1000, 800, -1), /overlap/);
  // overlap 不小于块的一半（800*0.5=400 → 400 触发）
  assert.throws(() => computeGrid(1000, 1000, 800, 400), /overlap/);
  // 非有限尺寸
  assert.throws(() => computeGrid(0, 100, 800, 0), /invalid image size/);
  assert.throws(() => computeGrid(100, -5, 800, 0), /invalid image size/);
  assert.throws(() => computeGrid(NaN, 100, 800, 0), /invalid image size/);
});

test('tileFileName 生成自含坐标的文件名', () => {
  const tile = { row: 1, col: 2, x: 800, y: 1600, w: 800, h: 600 };
  const name = tileFileName('photo', tile, 'png');
  assert.equal(name, 'photo_r1_c2_x800_y1600_800x600.png');
  // 默认扩展名 png
  assert.equal(tileFileName('photo', tile), 'photo_r1_c2_x800_y1600_800x600.png');
});
