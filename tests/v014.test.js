// v014.test.js — v0.1.4 优化项单元测试
// 覆盖：OCR 内容缓存（命中/过期/损坏）、runConcurrent 并发限流、
//       interestConcurrencyOf 解析、callChat 429 指数退避、聚合提示词跨块行对齐
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ocrCacheEnabled, ocrCacheKey, ocrCacheGet, ocrCacheSet
} from '../src/ocr-local.js';
import { runConcurrent, interestConcurrencyOf } from '../src/pipeline.js';
import { callChat } from '../src/vision-client.js';
import { aggregateRulesText } from '../src/prompts.js';

test('OCR 缓存：开关/键稳定/命中/过期/损坏容错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-v014-cache-'));
  const oldDir = process.env.DSH_OCR_CACHE_DIR;
  const oldOn = process.env.DSH_OCR_CACHE;
  try {
    process.env.DSH_OCR_CACHE_DIR = dir;
    delete process.env.DSH_OCR_CACHE; // 默认启用
    assert.equal(ocrCacheEnabled(), true);
    assert.equal(ocrCacheEnabled(), true); // 幂等
    const buf = Buffer.from('demo-png-bytes-123');
    const key = ocrCacheKey(buf);
    assert.equal(key.length, 32, '键为 32 hex');
    // 未命中
    assert.equal(await ocrCacheGet(key), null);
    // 写入后命中
    await ocrCacheSet(key, { engine: 'rapid', text: '第五章', lines: [{ text: '第五章', x: 0, y: 0, width: 10, height: 10, score: 0.9 }] });
    const hit = await ocrCacheGet(key);
    assert.ok(hit && hit.cached === true && hit.text === '第五章' && hit.engine === 'rapid');
    // 过期 → 未命中（TTL 设为负小时）
    const oldTtl = process.env.DSH_OCR_CACHE_TTL_HOURS;
    process.env.DSH_OCR_CACHE_TTL_HOURS = '-1';
    assert.equal(await ocrCacheGet(key), null, '过期条目应未命中');
    process.env.DSH_OCR_CACHE_TTL_HOURS = oldTtl;
    // 损坏条目 → 容错 null
    await writeFile(join(dir, `${key}.json`), '{broken', 'utf8');
    assert.equal(await ocrCacheGet(key), null, '损坏缓存应容错');
    // 禁用（=0）→ 永不查询命中（返回 null）
    process.env.DSH_OCR_CACHE = '0';
    assert.equal(await ocrCacheGet(key), null, '禁用时不应命中');
  } finally {
    if (oldDir === undefined) delete process.env.DSH_OCR_CACHE_DIR; else process.env.DSH_OCR_CACHE_DIR = oldDir;
    if (oldOn === undefined) delete process.env.DSH_OCR_CACHE; else process.env.DSH_OCR_CACHE = oldOn;
    await rm(dir, { recursive: true, force: true });
  }
});

test('runConcurrent：并发数不超过 limit，且结果顺序与输入一致', async () => {
  let concurrently = 0;
  let maxSeen = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const results = await runConcurrent(items, 3, async (v) => {
    concurrently += 1;
    maxSeen = Math.max(maxSeen, concurrently);
    await new Promise((r) => setTimeout(r, 5));
    concurrently -= 1;
    return v * 2;
  });
  assert.deepEqual(results, items.map((v) => v * 2), '结果按输入顺序');
  assert.ok(maxSeen <= 3, `并发上限 3（实际 ${maxSeen}）`);
});

test('interestConcurrencyOf：参数 > 环境 > 默认 2，上限 4', () => {
  assert.equal(interestConcurrencyOf(undefined), 2);
  assert.equal(interestConcurrencyOf(1), 1);
  assert.equal(interestConcurrencyOf(9), 4, '上限 4');
  const old = process.env.DSH_INTEREST_CONCURRENCY;
  process.env.DSH_INTEREST_CONCURRENCY = '3';
  assert.equal(interestConcurrencyOf(undefined), 3, '环境变量生效');
  process.env.DSH_INTEREST_CONCURRENCY = '0';
  assert.equal(interestConcurrencyOf(undefined), 2, '非法环境值回退默认');
  if (old === undefined) delete process.env.DSH_INTEREST_CONCURRENCY; else process.env.DSH_INTEREST_CONCURRENCY = old;
});

test('callChat：429 指数退避后成功（注入短节奏；计 2 次重试）', async () => {
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited', code: '429' } }), {
        status: 429, headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK-CONTENT' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const res = await callChat({
    apiKey: 'k-test', model: 'deepseek-v4-flash-vision-exp',
    userText: 'hi', fetchImpl, retryDelays: [1, 1, 1]
  });
  assert.equal(res.content, 'OK-CONTENT');
  assert.equal(calls, 2, '第一次 429 后重试一次成功');
});

test('聚合提示词包含跨块行对齐规则', () => {
  const text = aggregateRulesText({ width: 1600, height: 900, blockSize: 800 });
  assert.match(text, /跨块行对齐/);
  assert.match(text, /表格/);
});
