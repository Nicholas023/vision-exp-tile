// ocr-pool.test.js — 常驻 OCR 进程池单元测试（假 worker，纯协议/调度逻辑）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OcrPool, poolSizeFromEnv, _resetPoolForTest, getOcrPool } from '../src/ocr-pool.js';
import { poolTimeoutMs, skipTiming } from './helpers/suite-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = join(__dirname, 'fixtures', 'fake-ocr-worker.mjs');

async function withPool(size, fn, opts = {}) {
  // v0.4.1：默认超时用 poolTimeoutMs(2000)，按环境倍率放大，降低慢机时序抖动风险。
  const pool = new OcrPool({ size, pythonCmd: 'node', workerPath: FAKE, timeoutMs: opts.timeoutMs ?? poolTimeoutMs(2000) });
  try {
    await fn(pool);
  } finally {
    await pool.disposeAll();
  }
}

test('pool 尺寸：默认 4、显式 0 禁用、上限 8、非法回退默认', () => {
  assert.equal(poolSizeFromEnv({}), 4);
  assert.equal(poolSizeFromEnv({ DSH_OCR_POOL: '0' }), 0);
  assert.equal(poolSizeFromEnv({ DSH_OCR_POOL: '9' }), 8);
  assert.equal(poolSizeFromEnv({ DSH_OCR_POOL: 'abc' }), 4);
  assert.equal(poolSizeFromEnv({ DSH_OCR_POOL: '2' }), 2);
});

test('基本调度：单请求返回结构化结果', async () => {
  await withPool(1, async (pool) => {
    const resp = await pool.execute({ engine: 'rapid', path: 'x.png' });
    assert.equal(resp.ok, true);
    assert.ok(Array.isArray(resp.lines) && resp.lines.length >= 1);
    assert.match(resp.lines[0].text, /^fake-/);
  });
});

test('并发：3 个并发请求在 2-worker 池中全部完成', async () => {
  await withPool(2, async (pool) => {
    const results = await Promise.all([
      pool.execute({ engine: 'rapid', path: 'a.png' }),
      pool.execute({ engine: 'rapid', path: 'b.png' }),
      pool.execute({ engine: 'rapid', path: 'c.png' })
    ]);
    assert.equal(results.length, 3);
    for (const r of results) assert.equal(r.ok, true);
  });
});

test('失败响应：worker 返回 ok:false 时 reject', async () => {
  await withPool(1, async (pool) => {
    await assert.rejects(
      pool.execute({ engine: 'rapid', path: 'mode:fail.png' }),
      /intentional failure/
    );
  });
});

// v0.4.1：超时行为属「时序敏感」用例——较差机型可经 VISION_TEST_SKIP_TIMING=1
// 声明跳过（用户机器慢→避免测试因抖动失败）；跳过时打印原因与建议。
const skipTimeoutFlag = skipTiming();
if (skipTimeoutFlag) {
  console.warn('[ocr-pool] 已跳过「超时/时序窗口」用例：VISION_TEST_SKIP_TIMING=1（用户声明跳过时序敏感断言）。慢机建议在设置页调高 ocr_pool_timeout_ms 或开启 test_skip_timing。');
}
test('超时：慢请求触发 kill + 超时错误，且池能继续工作（重启恢复）', { skip: skipTimeoutFlag }, async () => {
  await withPool(1, async (pool) => {
    await assert.rejects(
      pool.execute({ engine: 'rapid', path: 'mode:slow.png' }),
      /timed out after/
    );
    // 池应重建 worker 并继续服务
    const resp = await pool.execute({ engine: 'rapid', path: 'after.png' });
    assert.equal(resp.ok, true);
  }, { timeoutMs: poolTimeoutMs(300) });
});

test('队列上限：等待队列溢出时立即拒绝（不无限堆积）', async () => {
  await withPool(1, async (pool) => {
    const p1 = pool.execute({ engine: 'rapid', path: 'q1.png' }); // 占住唯一 worker
    const many = [];
    for (let i = 0; i < 40; i++) many.push(pool.execute({ engine: 'rapid', path: 'q.png' }));
    const settled = await Promise.allSettled(many);
    const rejected = settled.filter((s) => s.status === 'rejected');
    assert.ok(rejected.length >= 1, '溢出请求应被拒绝');
    assert.ok(rejected.some((s) => /queue overflow/.test(String(s.reason))));
    await p1;
  });
});

test('getOcrPool：按解释器分池 + 禁用返回 null + 重置', () => {
  _resetPoolForTest();
  const a = getOcrPool('pythonA', 1);
  const b = getOcrPool('pythonB', 1);
  assert.ok(a && b && a !== b, '不同 python 应得到不同池');
  assert.equal(getOcrPool('pythonA', 1), a, '同解释器复用池');
  assert.equal(getOcrPool('pythonA', 0), null, '显式禁用返回 null');
  _resetPoolForTest();
  assert.notEqual(getOcrPool('pythonA', 1), a, '重置后新建（测试隔离）');
});
