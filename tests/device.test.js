/**
 * device.test.js — v0.4.1 设备档案模块 纯逻辑/注入 单元测试
 *
 * 不依赖真实硬件（probeDevice 用 overrides 注入），平台无关、CI/Linux 通吃。覆盖：
 *  - classifyTier：slow/normal/fast 规则（含边界与缺失探测）。
 *  - applyTierRecommendations：各档位推荐（slow 放宽/降并发/关 GPU；normal/fast 默认）。
 *  - deviceProfileText：画像摘要文案。
 *  - probeDevice(overrides)：注入结果被采纳，不触发真实 GPU 探测。
 *  - runtime.envFromSettings：performance_tier=auto 且设备为 slow 时，对未显式设置
 *    的 OCR 池超时/池大小/GPU 关停自动应用推荐，且用户显式值优先。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeDevice,
  classifyTier,
  applyTierRecommendations,
  deviceProfileText,
  DEFAULT_RECOMMENDATIONS,
  _setProbeForTest,
  _clearProbeCache
} from '../src/device.js';
import { envFromSettings } from '../src/runtime.js';

/* 常量简化：1 GiB */
const GiB = 1024 ** 3;

/* ------------------------------------------------------------------ */
/* classifyTier                                                        */
/* ------------------------------------------------------------------ */

test('classifyTier：cpuCores<=4 或 内存<8GiB → slow', () => {
  assert.equal(classifyTier({ cpuCores: 4, totalMemBytes: 8 * GiB, gpuName: 'NVIDIA' }), 'slow', '4 核 → slow');
  assert.equal(classifyTier({ cpuCores: 8, totalMemBytes: 6 * GiB, gpuName: null }), 'slow', '<8GiB → slow');
  assert.equal(classifyTier({ cpuCores: 2, totalMemBytes: 32 * GiB, gpuName: null }), 'slow', '2 核 → slow');
});

test('classifyTier：cpuCores>=8 且 内存>=16GiB 且有 GPU → fast', () => {
  assert.equal(classifyTier({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: 'RTX' }), 'fast');
  assert.equal(classifyTier({ cpuCores: 16, totalMemBytes: 64 * GiB, gpuName: 'RTX 4090' }), 'fast');
});

test('classifyTier：其余 → normal（含无 GPU 的 8 核 16GiB）', () => {
  assert.equal(classifyTier({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: null }), 'normal', '多核多内存但无独显 → normal');
  assert.equal(classifyTier({ cpuCores: 6, totalMemBytes: 12 * GiB, gpuName: 'X' }), 'normal');
});

test('classifyTier：探测缺失/非法 → 按 normal（保守），不因数据缺失误判 slow', () => {
  assert.equal(classifyTier(undefined), 'normal');
  assert.equal(classifyTier(null), 'normal');
  assert.equal(classifyTier({}), 'normal');
});

/* ------------------------------------------------------------------ */
/* applyTierRecommendations                                             */
/* ------------------------------------------------------------------ */

test('applyTierRecommendations：slow 放宽超时/降并发/关 GPU/测试倍率×2', () => {
  const rec = applyTierRecommendations('slow');
  assert.equal(rec.ocrPoolTimeoutMs, 240000);
  assert.equal(rec.ocrPool, 2);
  assert.equal(rec.gpuProvider, 'off');
  assert.equal(rec.testTimeoutFactor, 2);
});

test('applyTierRecommendations：normal 用默认（不覆盖池/GPU）、fast 保持默认', () => {
  const normal = applyTierRecommendations('normal');
  assert.equal(normal.ocrPoolTimeoutMs, DEFAULT_RECOMMENDATIONS.ocrPoolTimeoutMs);
  assert.equal(normal.ocrPool, DEFAULT_RECOMMENDATIONS.ocrPool); // undefined
  assert.equal(normal.gpuProvider, DEFAULT_RECOMMENDATIONS.gpuProvider); // undefined
  assert.equal(normal.testTimeoutFactor, 1);

  const fast = applyTierRecommendations('fast');
  assert.equal(fast.ocrPoolTimeoutMs, 120000);
  assert.equal(fast.testTimeoutFactor, 1);
  assert.equal(fast.ocrPool, undefined);
  assert.equal(fast.gpuProvider, undefined);
});

test('DEFAULT_RECOMMENDATIONS 为冻结默认（normal 语义）', () => {
  assert.ok(Object.isFrozen(DEFAULT_RECOMMENDATIONS));
  assert.equal(DEFAULT_RECOMMENDATIONS.ocrPoolTimeoutMs, 120000);
  assert.equal(DEFAULT_RECOMMENDATIONS.testTimeoutFactor, 1);
});

/* ------------------------------------------------------------------ */
/* deviceProfileText / probeDevice(overrides)                          */
/* ------------------------------------------------------------------ */

test('deviceProfileText：格式 CPU n核 / 内存 nGB / GPU 有或无 → 档位', () => {
  const text = deviceProfileText({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: 'RTX 3060' });
  assert.match(text, /CPU 8核/);
  assert.match(text, /内存 16.0GB/);
  assert.match(text, /GPU RTX 3060/);
  assert.match(text, /→ fast/);
  const noGpu = deviceProfileText({ cpuCores: 2, totalMemBytes: 6 * GiB, gpuName: null });
  assert.match(noGpu, /GPU 无/);
  assert.match(noGpu, /→ slow/);
});

test('probeDevice(overrides)：采纳注入结果且不触发真实 GPU 探测', async () => {
  const probe = await probeDevice({ cpuCores: 4, totalMemBytes: 8 * GiB, gpuName: 'AMD', platform: 'win32' });
  assert.deepEqual(probe, { cpuCores: 4, totalMemBytes: 8 * GiB, gpuName: 'AMD', platform: 'win32' });
  // 部分注入：缺失字段用真实值补齐（cpu/mem 同步取；gpuName 缺省=null）
  const partial = await probeDevice({ gpuName: null });
  assert.equal(partial.gpuName, null);
  assert.ok(Number.isInteger(partial.cpuCores) && partial.cpuCores > 0);
  assert.ok(Number.isInteger(partial.totalMemBytes) && partial.totalMemBytes > 0);
  assert.equal(typeof partial.platform, 'string');
});

/* ------------------------------------------------------------------ */
/* runtime envFromSettings：auto 档位应用 slow 推荐                      */
/* ------------------------------------------------------------------ */

test('envFromSettings：performance_tier=auto + slow 设备 → 自动应用推荐（未显式设置）', () => {
  _setProbeForTest({ cpuCores: 4, totalMemBytes: 6 * GiB, gpuName: null, platform: 'win32' });
  try {
    const env = envFromSettings({}); // 全部默认/未显式
    assert.equal(env.DSH_OCR_POOL_TIMEOUT, '240000', 'slow → 放宽池超时');
    assert.equal(env.DSH_OCR_POOL, '2', 'slow → 降池并发');
    assert.equal(env.DSH_OCR_GPU_PROVIDER, 'off', 'slow → 关 GPU');
    assert.equal(env.VISION_TEST_TIMEOUT_FACTOR, '2', 'slow → 测试倍率×2');
  } finally {
    _clearProbeCache();
  }
});

test('envFromSettings：auto + 非 slow（normal/fast）→ 不应用推荐（不设置这些键）', () => {
  _setProbeForTest({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: 'RTX', platform: 'win32' }); // fast
  try {
    const env = envFromSettings({});
    assert.equal(env.DSH_OCR_POOL_TIMEOUT, undefined, 'fast 不放宽池超时');
    assert.equal(env.DSH_OCR_POOL, undefined, 'fast 不降并发');
    assert.equal(env.DSH_OCR_GPU_PROVIDER, undefined, 'fast 不关 GPU');
  } finally {
    _clearProbeCache();
  }
});

test('envFromSettings：用户显式值 > tier 推荐（slow 设备仍尊重显式配置）', () => {
  _setProbeForTest({ cpuCores: 4, totalMemBytes: 6 * GiB, gpuName: null, platform: 'win32' });
  try {
    const env = envFromSettings({ ocr_pool: 5, ocr_pool_timeout_ms: 180000, gpu_provider: 'cuda' });
    assert.equal(env.DSH_OCR_POOL, '5', '显式 ocr_pool 优先于 slow 推荐');
    assert.equal(env.DSH_OCR_POOL_TIMEOUT, '180000', '显式超时优先于 slow 推荐');
    assert.equal(env.DSH_OCR_GPU_PROVIDER, 'cuda', '显式 gpu_provider 优先于 slow 推荐（off）');
  } finally {
    _clearProbeCache();
  }
});

test('envFromSettings：performance_tier 显式档位时，不依赖设备探测（强制档位）', () => {
  _clearProbeCache(); // 无探测缓存 → 若 auto 会按 normal；显式 slow 则直接 slow
  try {
    const env = envFromSettings({ performance_tier: 'slow' });
    assert.equal(env.DSH_OCR_POOL_TIMEOUT, '240000', '显式 slow 强制应用推荐');
    assert.equal(env.DSH_OCR_PERF_TIER, 'slow');
  } finally {
    _clearProbeCache();
  }
});
