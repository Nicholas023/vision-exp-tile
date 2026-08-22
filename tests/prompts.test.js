/**
 * prompts.test.js — 针对 prompts.js 的提示文本生成单元测试
 *
 * 覆盖：
 *  - buildTileListText：坐标清单表（含行优先编号）
 *  - aggregateRulesText：聚合逻辑规则段
 *  - buildRecognizeSystem：单请求模式 system 提示（纯文本）
 *  - buildGroupUserText / buildAggregateUserText：分组与聚合用户文本
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGrid } from '../src/tile-engine.js';
import {
  buildTileListText,
  aggregateRulesText,
  buildSplitResultText,
  buildRecognizeSystem,
  buildRecognizeUserText,
  buildGroupSystem,
  buildGroupUserText,
  buildAggregateSystem,
  buildAggregateUserText
} from '../src/prompts.js';

test('buildTileListText 生成行优先坐标清单', () => {
  const grid = computeGrid(4000, 3000, 800, 0);
  const text = buildTileListText(4000, 3000, grid.tiles, grid);

  // 含首行块编号 | 0 | 与坐标 0,0 → 800,800
  assert.match(text, /\|\s*0\s*\|/);
  assert.ok(text.includes('0,0 → 800,800'));
  // 编号最大为 19（第 20 块，索引从 0 计）
  assert.ok(text.includes('| 19 |'));
  assert.match(text, /| 19 |/);
  // 标题含网格信息
  assert.match(text, /网格 4×5/);
  // 行优先编号：r1c0 出现在 r0c4 之后
  assert.ok(text.indexOf('r0c4') < text.indexOf('r1c0'));
});

test('aggregateRulesText 包含关键规则', () => {
  const text = aggregateRulesText({ width: 4000, height: 3000, blockSize: 800, overlap: 0 });
  // 识别顺序为行优先
  assert.ok(text.includes('行优先'));
  // 禁止编造
  assert.ok(text.includes('禁止编造'));
  // 块是原图 1:1 原始像素
  assert.ok(text.includes('1:1'));
  // 无交叠时说明边界需借用相邻块
  assert.ok(text.includes('借用相邻块'));
  // 有交叠的说明
  const overlapText = aggregateRulesText({ width: 4000, height: 3000, blockSize: 800, overlap: 64 });
  assert.ok(overlapText.includes('交叠'));
});

test('buildRecognizeSystem 纯文本（含 JSON 指令、不含图片块）', () => {
  const sys = buildRecognizeSystem({ json: true, width: 4000, height: 3000 });
  // 是纯字符串
  assert.equal(typeof sys, 'string');
  // 含 JSON 输出说明
  assert.ok(sys.includes('JSON'));
  // 纯文本：不含任何图片相关描述块（image_url / 图片引用块）
  assert.ok(!sys.includes('image_url'));
  assert.ok(!sys.includes('"type": "image_url"'));
  assert.ok(!sys.includes('data:image'));
});

test('buildRecognizeSystem 非 JSON 时给出文本输出格式', () => {
  const sys = buildRecognizeSystem({ json: false });
  assert.ok(sys.includes('先给一段整图全局概述'));
});

test('buildGroupUserText 与 buildAggregateUserText 含块编号与组标题', () => {
  const grid = computeGrid(1600, 1600, 800, 0); // 2x2
  const groupUser = buildGroupUserText({ width: 1600, height: 1600, tiles: grid.tiles.slice(0, 2), grid });
  // 含块编号（行优先清单）
  assert.ok(groupUser.includes('本组块清单'));
  assert.match(groupUser, /\|\s*0\s*\|/);

  const aggUser = buildAggregateUserText(
    [
      { groupIndex: 0, groupText: '[]' },
      { groupIndex: 1, groupText: '[]' }
    ],
    '描述图表内容'
  );
  // 组标题（第 1 组 / 第 2 组）
  assert.ok(aggUser.includes('第 1 组'));
  assert.ok(aggUser.includes('第 2 组'));
  // 识别目标
  assert.ok(aggUser.includes('描述图表内容'));
});

test('buildSplitResultText 汇总切块结果', () => {
  const grid = computeGrid(3200, 2000, 800, 0);
  const tiles = grid.tiles.map((t) => ({ ...t, buffer: Buffer.alloc(10), mediaType: 'image/png' }));
  const text = buildSplitResultText({
    filePath: 'big.png',
    outDir: 'out',
    width: 3200,
    height: 2000,
    tiles,
    grid,
    blockSize: 800,
    overlap: 0,
    overviewPath: 'out/overview.png'
  });
  assert.ok(text.includes('切块结果：big.png'));
  assert.ok(text.includes('全局布局参考图'));
  assert.ok(text.includes('3200×2000'));
});

test('buildGroupSystem 与 buildAggregateSystem 输出纯文本 JSON 指令', () => {
  assert.ok(buildGroupSystem().includes('JSON'));
  assert.equal(typeof buildGroupSystem(), 'string');
  const agg = buildAggregateSystem({ json: true });
  assert.ok(agg.includes('JSON'));
  assert.ok(!agg.includes('image_url'));
});

test('buildRecognizeUserText 含识别目标与坐标清单', () => {
  const grid = computeGrid(1600, 1600, 800, 0);
  const text = buildRecognizeUserText({ question: '识别表格', width: 1600, height: 1600, tiles: grid.tiles, grid });
  assert.ok(text.includes('【识别目标】识别表格'));
  assert.ok(text.includes('坐标清单'));
  assert.ok(text.includes('| 0 |'));
});
