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
 *  - v0.4.1 扩展：微基准分档(A)、电池省电推荐(B)、平台降级(C)、慢网推荐(D)，
 *    以及各设置开关关闭时不生效的纯逻辑断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeDevice,
  classifyTier,
  applyTierRecommendations,
  computeRecommendations,
  mergeRecs,
  isPlatformDegraded,
  detectPlatformInfo,
  runCpuBenchmark,
  cpuWorkload,
  deviceProfileText,
  DEFAULT_RECOMMENDATIONS,
  PLATFORM_RECOMMENDATIONS,
  POWER_RECOMMENDATIONS,
  SLOW_NET_RECOMMENDATIONS,
  _setProbeForTest,
  _clearProbeCache
} from '../src/device.js';
import { envFromSettings, normalizeFromSettings } from '../src/runtime.js';

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

test('applyTierRecommendations：slow 放宽超时/降并发/关 GPU/测试倍率×4', () => {
  const rec = applyTierRecommendations('slow');
  assert.equal(rec.ocrPoolTimeoutMs, 240000);
  assert.equal(rec.ocrPool, 2);
  assert.equal(rec.gpuProvider, 'off');
  assert.equal(rec.testTimeoutFactor, 4, 'slow 推荐 ×4（性能好机器 ×2 不足以体现慢机差异）');
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
  // 注入字段被采纳；v0.4.1 扩展字段给合理默认（benchScore=null/onBattery=false/platformInfo 自动探测）
  assert.equal(probe.cpuCores, 4);
  assert.equal(probe.totalMemBytes, 8 * GiB);
  assert.equal(probe.gpuName, 'AMD');
  assert.equal(probe.platform, 'win32');
  assert.equal(probe.benchScore, null, '未注入基准 → null');
  assert.equal(probe.onBattery, false, '未注入电池 → false');
  assert.ok(probe.platformInfo && typeof probe.platformInfo.arch === 'string', 'platformInfo 应有 arch');
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
    assert.equal(env.VISION_TEST_TIMEOUT_FACTOR, '4', 'slow → 测试倍率×4');
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

/* ------------------------------------------------------------------ */
/* A. 微基准分档（A）：benchScore 修正 classifyTier                      */
/* ------------------------------------------------------------------ */

test('classifyTier：基准正常时按硬指标判 fast；低于弱阈值(0.5)不判 fast', () => {
  // 基准 >=0.5 且硬指标满足 → fast
  assert.equal(classifyTier({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: 'RTX', benchScore: 0.6 }), 'fast');
  // 基准 0.4（<0.5）→ 无论核数多少不判 fast → normal（非 slow 硬指标）
  assert.equal(classifyTier({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: 'RTX', benchScore: 0.4 }), 'normal');
  // 基准 0.4 且本身 slow 硬指标 → slow
  assert.equal(classifyTier({ cpuCores: 2, totalMemBytes: 16 * GiB, gpuName: 'RTX', benchScore: 0.4 }), 'slow');
});

test('classifyTier：基准极低(<0.3)且无 GPU → slow；有 GPU 则不因基准直接 slow', () => {
  // 核多内存足但基准极低且无 GPU（云主机/VM 配额）→ slow
  assert.equal(classifyTier({ cpuCores: 16, totalMemBytes: 32 * GiB, gpuName: null, benchScore: 0.2 }), 'slow');
  // 同配置但有 GPU → 不因基准直接 slow，<0.5 故 normal
  assert.equal(classifyTier({ cpuCores: 16, totalMemBytes: 32 * GiB, gpuName: 'RTX', benchScore: 0.2 }), 'normal');
});

test('classifyTier：基准不可用(关闭/异常)→ 不影响原规则', () => {
  assert.equal(classifyTier({ cpuCores: 8, totalMemBytes: 16 * GiB, gpuName: 'RTX', benchScore: null }), 'fast');
  assert.equal(classifyTier({ cpuCores: 4, totalMemBytes: 6 * GiB, gpuName: null, benchScore: null }), 'slow');
});

test('cpuWorkload：纯函数返回可预测聚合值（防 JIT 消除）', () => {
  const a = cpuWorkload(5000);
  assert.equal(typeof a, 'number');
  assert.ok(Number.isFinite(a));
});

test('runCpuBenchmark：预算内返回 0..2 分与正 ops/s；预算 150ms 足够快', () => {
  const t0 = Date.now();
  const r = runCpuBenchmark(150);
  const el = Date.now() - t0;
  assert.ok(el <= 1500, '微基准应在预算附近快速结束（实测 ' + el + 'ms）');
  assert.ok(r.opsPerSec > 0, 'ops/s 应为正');
  assert.ok(r.score >= 0 && r.score <= 2, 'score 应落在 0..2');
});

/* ------------------------------------------------------------------ */
/* B. 电池省电推荐（B）                                                 */
/* ------------------------------------------------------------------ */

test('computeRecommendations：onBattery 且 fast/normal → 省电推荐（降并发/倍率×2/关 GPU）', () => {
  const rec = computeRecommendations({ tier: 'fast', onBattery: true, platformInfo: null, opts: {} });
  assert.equal(rec.ocrPool, 2, '省电 → 池并发 2');
  assert.equal(rec.testTimeoutFactor, 2, '省电 → 测试倍率×2');
  assert.equal(rec.gpuProvider, 'off', '省电 → 不自动开 GPU（off）');
});

test('computeRecommendations：onBattery 且 slow → 省电推荐不叠加（slow 推荐不变）', () => {
  const rec = computeRecommendations({ tier: 'slow', onBattery: true, platformInfo: null, opts: {} });
  assert.equal(rec.testTimeoutFactor, 4, 'slow 仍为 ×4（省电不覆盖）');
  assert.equal(rec.ocrPool, 2, 'slow 本就降并发 2');
});

test('computeRecommendations：device_power_probe=false 时不应用省电推荐', () => {
  const rec = computeRecommendations({ tier: 'fast', onBattery: true, platformInfo: null, opts: { usePower: false } });
  assert.equal(rec.testTimeoutFactor, 1, '关闭电源探测 → 不省电');
  assert.equal(rec.ocrPool, undefined, '关闭电源探测 → 不降并发');
});

/* ------------------------------------------------------------------ */
/* C. 平台降级（C）                                                     */
/* ------------------------------------------------------------------ */

test('isPlatformDegraded：arm64/WSL/容器 → true；x64 普通 → false；缺失 → false', () => {
  assert.equal(isPlatformDegraded({ arch: 'x64', isWsl: false, isContainer: false }), false);
  assert.equal(isPlatformDegraded({ arch: 'arm64' }), true, 'arm64');
  assert.equal(isPlatformDegraded({ isWsl: true }), true, 'WSL');
  assert.equal(isPlatformDegraded({ isContainer: true }), true, '容器');
  assert.equal(isPlatformDegraded(null), false, '缺失 → 不降级');
});

test('detectPlatformInfo：返回 arch/isWsl/isContainer 且 arch 为合法值', () => {
  const pi = detectPlatformInfo();
  assert.ok(['x64', 'arm64', 'ia32'].includes(pi.arch), 'arch 应合法：' + pi.arch);
  assert.equal(typeof pi.isWsl, 'boolean');
  assert.equal(typeof pi.isContainer, 'boolean');
});

test('computeRecommendations：platform_fallback=auto 且检测到降级 → 保守默认（jpeg/池2/关GPU）', () => {
  const pi = { arch: 'arm64', isWsl: false, isContainer: false };
  const rec = computeRecommendations({ tier: 'fast', onBattery: false, platformInfo: pi, opts: { pfMode: 'auto' } });
  assert.equal(rec.format, 'jpeg', '平台降级 → 块格式 jpeg');
  assert.equal(rec.ocrPool, 2, '平台降级 → 池并发 2');
  assert.equal(rec.gpuProvider, 'off', '平台降级 → GPU 不自动开');
});

test('computeRecommendations：platform_fallback=off 时不应用平台降级；on=强制降级', () => {
  const pi = { arch: 'arm64', isWsl: false, isContainer: false };
  const off = computeRecommendations({ tier: 'normal', onBattery: false, platformInfo: pi, opts: { pfMode: 'off' } });
  assert.equal(off.format, undefined, 'off → 不降级');
  const on = computeRecommendations({ tier: 'normal', onBattery: false, platformInfo: null, opts: { pfMode: 'on' } });
  assert.equal(on.format, 'jpeg', 'on → 强制降级（即便未检测到）');
});

/* ------------------------------------------------------------------ */
/* D. 慢网适配（D）+ 开关                                               */
/* ------------------------------------------------------------------ */

test('computeRecommendations：slow 档 → 慢网推荐（interestConcurrency=1、timeoutMs=600000）', () => {
  const rec = computeRecommendations({ tier: 'slow', onBattery: false, platformInfo: null, opts: {} });
  assert.equal(rec.interestConcurrency, 1, '慢网 → 兴趣点并发 1');
  assert.equal(rec.timeoutMs, 600000, '慢网 → API 超时 600s');
});

test('computeRecommendations：slow_net_adapt=false 时不应用慢网推荐（仅档位推荐）', () => {
  const rec = computeRecommendations({ tier: 'slow', onBattery: false, platformInfo: null, opts: { useNet: false } });
  assert.equal(rec.interestConcurrency, undefined, '关闭慢网 → 不降并发');
  assert.equal(rec.timeoutMs, undefined, '关闭慢网 → 不放大超时');
});

test('mergeRecs：overlay 中 undefined 不覆盖 base（参数 undefined 不生效）', () => {
  const out = mergeRecs({ a: 1, b: 2 }, { a: undefined, b: 9 });
  assert.equal(out.a, 1, 'undefined 不覆盖');
  assert.equal(out.b, 9, '非空覆盖');
});

/* ------------------------------------------------------------------ */
/* 运行时：新推荐落 env/配置 与开关                                     */
/* ------------------------------------------------------------------ */

test('normalizeFromSettings：慢网(slow) → timeoutMs 放大到 600s；平台降级 → format=jpeg', () => {
  // 慢网：slow 设备 → 6s... 600000
  _setProbeForTest({ cpuCores: 2, totalMemBytes: 6 * GiB, gpuName: null, benchScore: null });
  try {
    const cfg = normalizeFromSettings({});
    assert.equal(cfg.timeoutMs, 600000, 'slow → API 超时 600s');
  } finally {
    _clearProbeCache();
  }
  // 平台降级：arm64 fast 机 → format=jpeg
  _setProbeForTest({ cpuCores: 12, totalMemBytes: 24 * GiB, gpuName: 'RTX', benchScore: 1.0, platformInfo: { arch: 'arm64' } });
  try {
    const cfg = normalizeFromSettings({});
    assert.equal(cfg.format, 'jpeg', 'arm64 → 块格式 jpeg');
  } finally {
    _clearProbeCache();
  }
});

test('envFromSettings：fast+onBattery → 省电推荐落地（DSH_OCR_POOL/倍率/GPU off）', () => {
  _setProbeForTest({ cpuCores: 12, totalMemBytes: 24 * GiB, gpuName: 'RTX', benchScore: 1.0, onBattery: true });
  try {
    const env = envFromSettings({});
    assert.equal(env.DSH_OCR_POOL, '2', '省电 → 池并发 2');
    assert.equal(env.VISION_TEST_TIMEOUT_FACTOR, '2', '省电 → 测试倍率 2');
    assert.equal(env.DSH_OCR_GPU_PROVIDER, 'off', '省电 → GPU off');
  } finally {
    _clearProbeCache();
  }
});

test('envFromSettings：slow + slow_net_adapt 默认 → DSH_INTEREST_CONCURRENCY=1；关闭则不写', () => {
  _setProbeForTest({ cpuCores: 2, totalMemBytes: 6 * GiB, gpuName: null, benchScore: null });
  try {
    const env = envFromSettings({});
    assert.equal(env.DSH_INTEREST_CONCURRENCY, '1', 'slow → 慢网降并发 1');
    const envNo = envFromSettings({ slow_net_adapt: false });
    assert.equal(envNo.DSH_INTEREST_CONCURRENCY, undefined, '关闭慢网 → 不写并发');
  } finally {
    _clearProbeCache();
  }
});

test('probeDevice：注入 benchScore/onBattery/platformInfo 被采纳（不触发真实探测）', async () => {
  const probe = await probeDevice({ cpuCores: 4, totalMemBytes: 8 * GiB, gpuName: null, benchScore: 0.3, onBattery: true, platformInfo: { arch: 'x64' } });
  assert.equal(probe.benchScore, 0.3);
  assert.equal(probe.onBattery, true);
  assert.equal(probe.platformInfo.arch, 'x64');
});
