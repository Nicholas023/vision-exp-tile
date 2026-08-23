/**
 * device.js — 设备档案模块（v0.4.1 扩展：低性能设备适配增强）
 *
 * 目的：识别当前机器算力档位（slow / normal / fast），并收集低性能/低功耗/降级
 * 环境信息，供四处共用（运行时自动推荐 / 安装脚本 / 自检入口 / 设置页只读画像）。
 * 本轮新增四项（用户已确认）：
 *   A. 微基准算力评级：runCpuBenchmark() —— 纯 JS 轻量基准，解决"只看核数不准"
 *      （小核/降频/云主机/VM 配额），benchScore 归一化到 0..2（1.0=参考机基线）；
 *   B. 电池/低功耗探测：detectPowerState() —— win32 CIM / linux sysfs / mac pmset；
 *   C. ARM/WSL/容器降级：detectPlatformInfo() —— arch + WSL + container 判定；
 *   D. 慢网适配：slow 档联动 interest_concurrency（推荐 1）与 timeout_ms（推荐 600s）。
 *
 * 设计要点：
 *  - 纯 JS、平台无关；外部异步探测（GPU nvidia-smi / 电源）与 CPU 微基准尽量并行，
 *    总时长控制在 ~2s 内（微基准 ≤500ms）。
 *  - 可 mock：probeDevice(overrides, opts) 接受注入结果（单测用），不触发真实探测。
 *  - 结果带进程级缓存（60s TTL），避免重复 spawn / 重复跑基准。
 *  - 精度"适当"即可（定性分档，不追求精确）；不引入任何第三方依赖。
 *
 * @module vision-exp-tile/device
 */

import { cpus, totalmem, platform, arch } from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

/** 1 GiB 字节数（内存档位判定用）。 */
const GiB = 1024 ** 3;

/** 探测结果缓存 TTL（毫秒）；GPU/电源/基准成本较高，60s 内复用。 */
const PROBE_TTL_MS = 60_000;

/** GPU 名探测超时（毫秒）；太慢则视为无 GPU。 */
const GPU_PROBE_TIMEOUT_MS = 1500;

/** 电源状态探测超时（毫秒，win32/mac 用 spawn）；省时上限。 */
const POWER_PROBE_TIMEOUT_MS = 1000;

/** 微基准预算（毫秒）；默认 400ms，保证 ≤500ms 内结束、且足够稳定。 */
const BENCHMARK_BUDGET_MS = 400;

/**
 * 基准参考值（ops/sec）。校准依据：本机为 16 核（normal 档），预热后实测约
 * 3.1e8 ops/s，故以此作为 1.0 基线——本机分档时 benchScore≈1.0。
 * 弱阈值经验分档（见 classifyTier 注释）：<0.5 不判 fast；<0.3 且无 GPU 判 slow。
 */
export const REFERENCE_OPS_PER_SEC = 310_000_000;

/* ------------------------------------------------------------------ */
/* 各档位/场景「推荐覆盖」常量                                          */
/* ------------------------------------------------------------------ */

/**
 * 各档位「推荐覆盖」的默认值（normal 档，即「不额外干预」）。
 * 说明：值为 undefined 表示「不强制、走模块默认」；这与 slow 档显式给值的语义
 * 形成对照。扩展了 format / interestConcurrency / timeoutMs（供平台/慢网推荐复用）。
 */
export const DEFAULT_RECOMMENDATIONS = Object.freeze({
  ocrPoolTimeoutMs: 120_000,   // OCR 池单请求超时（毫秒）
  ocrPool: undefined,          // 池大小；undefined=不覆盖（默认 4）
  gpuProvider: undefined,      // GPU provider；undefined=不覆盖（默认 auto 探测）
  testTimeoutFactor: 1,        // 测试超时判定倍率
  format: undefined,           // 块格式；undefined=不覆盖（默认 png）
  interestConcurrency: undefined, // 兴趣点并发；undefined=不覆盖（默认 2）
  timeoutMs: undefined         // 视觉 API 单请求超时；undefined=不覆盖（默认 300000）
});

/**
 * C. 平台降级推荐（arm64/WSL/容器）：保守默认——块格式用 jpeg（省 IO/内存）、
 * OCR 池并发降到 2、GPU 不自动开（gpuProvider=off，避免容器/降级环境 GPU 初始化
 * 失败或拖慢）。用户可经 platform_fallback=off 或显式设置覆盖。
 */
export const PLATFORM_RECOMMENDATIONS = Object.freeze({
  format: 'jpeg',
  ocrPool: 2,
  gpuProvider: 'off'
});

/**
 * B. 省电推荐（电池/放电中，且档位为 fast/normal）：OCR 池并发降到 2、测试倍率 ×2、
 * GPU 不自动开（off，省电降热）。slow 档推荐保持不变（已有更保守值）。
 */
export const POWER_RECOMMENDATIONS = Object.freeze({
  ocrPool: 2,
  testTimeoutFactor: 2,
  gpuProvider: 'off'
});

/**
 * D. 慢网推荐（slow 档）：兴趣点并发降到 1（更稳、省 API 并发）、视觉 API 单请求
 * 超时放大到 600s（默认 300s ×2），应对慢网下大图识别易超时。
 */
export const SLOW_NET_RECOMMENDATIONS = Object.freeze({
  interestConcurrency: 1,
  timeoutMs: 600_000
});

/* ------------------------------------------------------------------ */
/* 探测结果缓存                                                         */
/* ------------------------------------------------------------------ */

/** 进程级缓存：最近一次真实探测结果（probeDevice 无 overrides 时写入）。 */
let cachedProbe = null;
/** 缓存时间戳（毫秒）。 */
let cachedAt = 0;

/** 读取缓存的探测结果（可能为 null——尚未探测或无缓存）。 */
export function getCachedProbe() {
  return cachedProbe;
}

/** 手动写入/替换缓存探测结果（测试注入用，不经真实探测）。 */
export function _setProbeForTest(probe) {
  cachedProbe = probe;
  cachedAt = probe ? Date.now() : 0;
}

/** 清空缓存（测试隔离用）。 */
export function _clearProbeCache() {
  cachedProbe = null;
  cachedAt = 0;
}

/* ------------------------------------------------------------------ */
/* A. 微基准算力评级                                                    */
/* ------------------------------------------------------------------ */

/**
 * 轻量 CPU 基准负载（纯 JS，Node 内置，无第三方）。混合整数运算 + 数组写读 +
 * 字符串操作若干轮，单次 workload(iterations) 内部迭代 iterations 次。
 * 返回值做「防被 JIT 消除」处理（结果累积到数组/字符串并返回），保证真实执行。
 * @param {number} iterations - 内部迭代次数。
 * @returns {number} 伪随机聚合值（用不到，仅防优化）。
 */
export function cpuWorkload(iterations) {
  let x = 0x12345678;
  for (let i = 0; i < iterations; i++) {
    x = ((x * 31) ^ (x << 5) ^ (x >>> 7)) + 0x9e3779b9;
    x = (x >>> 0) | 0; // 保持 32 位（防精度漂移）
  }
  const arr = new Array(512);
  for (let i = 0; i < iterations; i++) arr[i & 511] = (arr[i & 511] + i) & 0xffff;
  let str = '';
  const base = '0123456789abcdef';
  for (let i = 0; i < (iterations % 64); i++) str += base[i & 15];
  const count = str.split('0').length + arr.reduce((a, b) => a + b, 0);
  return (x >>> 0) + count;
}

/**
 * 微基准：在预算时间（默认 400ms）内尽可能多地跑 cpuWorkload，返回归一化评分。
 * @param {number} [budgetMs] - 预算毫秒（默认 400；限制 50..2000）。
 * @returns {{score:number, opsPerSec:number}} score 归一化到 0..2（1.0=参考机，
 *   见 REFERENCE_OPS_PER_SEC）；opsPerSec 为原始 ops/s。
 */
export function runCpuBenchmark(budgetMs = BENCHMARK_BUDGET_MS) {
  const budget = Math.max(50, Math.min(2000, Number(budgetMs) || BENCHMARK_BUDGET_MS));
  cpuWorkload(20000); // 预热（JIT 编译后更稳）
  const chunk = 20000;
  let total = 0;
  const start = process.hrtime.bigint();
  let elapsed = 0n;
  const budgetNs = BigInt(Math.floor(budget)) * 1000000n;
  while (elapsed < budgetNs) {
    cpuWorkload(chunk);
    total += chunk;
    elapsed = process.hrtime.bigint() - start;
  }
  const opsPerSec = (elapsed > 0n) ? (total / (Number(elapsed) / 1e9)) : 0;
  const score = opsPerSec > 0 ? Math.max(0, Math.min(2, opsPerSec / REFERENCE_OPS_PER_SEC)) : 0;
  return { score: Math.round(score * 1000) / 1000, opsPerSec: Math.round(opsPerSec) };
}

/* ------------------------------------------------------------------ */
/* B. 电池/低功耗探测                                                    */
/* ------------------------------------------------------------------ */

/**
 * 探测当前是否处于电池/放电状态（与 GPU 探测并行；1s 超时上限）。
 * - win32：一次性 PowerShell CIM（Get-CimInstance Win32_Battery，读 BatteryStatus：
 *   1=放电中；无电池=空/失败 → 视为交流电/未知）。spawn 1s 超时。
 * - linux：遍历 /sys/class/power_supply 下 type 为 Battery 的条目，status==Discharging 即放电中。
 * - mac：pmset -g batt 输出含 'discharging'。
 * @param {boolean} [runProbe=true] - false=跳过（onBattery=null，不判省电）。
 * @returns {Promise<{onBattery:boolean|null}>}
 */
export async function detectPowerState(runProbe = true) {
  if (!runProbe) return { onBattery: null };
  const osPlatform = platform();
  if (osPlatform === 'win32') return detectWinPower();
  if (osPlatform === 'linux') return detectLinuxPower();
  if (osPlatform === 'darwin') return detectMacPower();
  return { onBattery: false }; // 其他平台未知，视为不省电
}

/** win32：CIM 一次查询 BatteryStatus（1=放电中）。 */
function detectWinPower() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (onBattery) => { if (settled) return; settled = true; resolve({ onBattery }); };
    try {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-Command', 'try { (Get-CimInstance Win32_Battery).BatteryStatus } catch { }'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, POWER_PROBE_TIMEOUT_MS);
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('error', () => { clearTimeout(timer); done(false); });
      child.on('close', () => {
        clearTimeout(timer);
        const status = parseInt(stdout.trim(), 10);
        // 1=放电中；2=交流电；无电池/读取失败→NaN→false
        done(Number.isFinite(status) && status === 1);
      });
    } catch {
      done(false);
    }
  });
}

/** linux：读 sysfs 电池类型与状态。 */
function detectLinuxPower() {
  try {
    const base = '/sys/class/power_supply';
    let discharging = false;
    // 遍历 power_supply 子目录：type 为 Battery 且 status 为 Discharging → 放电中。
    // 该目录通常含 1~2 个 Battery；读取失败跳过（不因个别条目异常而放弃）。
    const entries = readdirSync(base);
    for (const e of entries) {
      try {
        const type = readFileSync(base + '/' + e + '/type', 'utf8').trim();
        if (type !== 'Battery') continue;
        const status = readFileSync(base + '/' + e + '/status', 'utf8').trim();
        if (status === 'Discharging') discharging = true;
        // 若为 Charging/Full 且没有其他放电源，则视为交流电（保持 false）
      } catch { /* 该条目读取失败跳过 */ }
    }
    return { onBattery: discharging };
  } catch {
    return { onBattery: false };
  }
}

/** mac：pmset -g batt 输出含 'discharging'。 */
function detectMacPower() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (onBattery) => { if (settled) return; settled = true; resolve({ onBattery }); };
    try {
      const child = spawn('pmset', ['-g', 'batt'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, POWER_PROBE_TIMEOUT_MS);
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('error', () => { clearTimeout(timer); done(false); });
      child.on('close', () => {
        clearTimeout(timer);
        done(/discharging/i.test(stdout));
      });
    } catch {
      done(false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* C. 平台信息（ARM/WSL/容器降级）                                       */
/* ------------------------------------------------------------------ */

/**
 * 平台探测（全同步、即时）：os.arch() + WSL 检测 + 容器检测。
 * @returns {{arch:string, isWsl:boolean, isContainer:boolean}}
 */
export function detectPlatformInfo() {
  return {
    arch: arch(),
    isWsl: (() => {
      try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
    })(),
    isContainer: (() => {
      try {
        if (existsSync('/.dockerenv')) return true;
        return /docker|kubepods/i.test(readFileSync('/proc/1/cgroup', 'utf8'));
      } catch { return false; }
    })()
  };
}

/**
 * 判定是否应走「平台降级」（保守默认）。
 * 依据：arm64（含 Apple Silicon / 低功耗 ARM）、WSL、容器（.dockerenv/cgroup）都
 * 属于"环境受限/可能缺 GPU/IO 受限"，统一按保守处理（用户可 platform_fallback=off/on 覆盖）。
 * @param {object|null} [platformInfo] - detectPlatformInfo() 结果。
 * @returns {boolean}
 */
export function isPlatformDegraded(platformInfo) {
  const p = platformInfo && typeof platformInfo === 'object' ? platformInfo : {};
  return p.arch === 'arm64' || p.isWsl === true || p.isContainer === true;
}

/* ------------------------------------------------------------------ */
/* 设备探测（并行）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 探测本机设备档案。
 * @param {object} [overrides] - 注入结果（单测用）。提供任一字段即视为"已探测"，
 *   不触发真实探测；缺省字段用真实值补齐。
 * @param {object} [opts] - { runBenchmark=true, runPowerProbe=true }（设置开关控制）。
 * @returns {Promise<object>} 设备档案（含 cpuCores/totalMemBytes/gpuName/platform/
 *   onBattery/platformInfo/benchScore/detectMs）。
 */
export async function probeDevice(overrides, opts = {}) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const runBenchmark = opts.runBenchmark !== false;
  const runPowerProbe = opts.runPowerProbe !== false;
  const hasOverride = ov.cpuCores !== undefined || ov.totalMemBytes !== undefined
    || ov.gpuName !== undefined || ov.platform !== undefined
    || ov.benchScore !== undefined || ov.onBattery !== undefined || ov.platformInfo !== undefined;

  if (hasOverride) {
    // 注入模式：缺省字段用真实值补齐；benchScore/onBattery/platformInfo 缺省给合理默认。
    return {
      cpuCores: ov.cpuCores ?? cpus().length,
      totalMemBytes: ov.totalMemBytes ?? totalmem(),
      gpuName: ov.gpuName === undefined ? null : ov.gpuName,
      platform: ov.platform ?? platform(),
      benchScore: ov.benchScore ?? null,
      onBattery: ov.onBattery ?? false,
      platformInfo: ov.platformInfo ?? detectPlatformInfo()
    };
  }

  // 缓存新鲜 → 直接复用（避免重复探测/基准）。
  if (cachedProbe && Date.now() - cachedAt < PROBE_TTL_MS) return cachedProbe;

  // 并行发起：GPU(nvidia-smi spawn) / 电源(spawn 或 read) / 微基准(同步 0.4s) / 平台(同步即时)。
  // 先发起 GPU/电源（异步 spawn，OS 进程并发执行），再同步跑微基准（本次阻塞事件循环 ~0.4s，
  // 期间 GPU/电源进程仍在后台并发），最后 await 让二者结算。总时长 ≈ max(gpu 1.5s, power 1s,
  // bench 0.4s)，实测本机 <1s（≤2s 预算内）。
  const t0 = performance.now();
  const gpuStart = performance.now();
  const gpuPromise = detectGpuName();
  const powerStart = performance.now();
  const powerPromise = detectPowerState(runPowerProbe);
  // 微基准：同步执行；benchMs 为真实墙钟（避免经 Promise 包装导致计时被跳过）。
  const benchStart = performance.now();
  const benchRes = runBenchmark ? runCpuBenchmark(BENCHMARK_BUDGET_MS) : { score: null, opsPerSec: null };
  const benchMs = performance.now() - benchStart;
  // 平台：同步即时。
  const platStart = performance.now();
  const platformInfo = detectPlatformInfo();
  const platMs = performance.now() - platStart;
  const [gpuName, powerRes] = await Promise.all([gpuPromise, powerPromise]);
  const gpuMs = performance.now() - gpuStart;   // 墙钟（含基准阻塞），如实反映端到端
  const powerMs = performance.now() - powerStart;

  const probe = {
    cpuCores: cpus().length,
    totalMemBytes: totalmem(),
    gpuName,
    platform: platform(),
    onBattery: powerRes.onBattery,
    platformInfo,
    benchScore: benchRes.score,
    benchOpsPerSec: benchRes.opsPerSec,
    detectMs: {
      gpuMs: Math.round(gpuMs),
      powerMs: Math.round(powerMs),
      benchMs: Math.round(benchMs),
      platformMs: Math.round(platMs),
      totalMs: Math.round(performance.now() - t0)
    }
  };
  cachedProbe = probe;
  cachedAt = Date.now();
  return probe;
}

/**
 * GPU 名探测：跨平台尝试 nvidia-smi --query-gpu=name --format=csv,noheader。
 * 1.5s 超时、spawn 失败或输出为空 → 返回 null（视为无独显）。
 */
async function detectGpuName() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (name) => { if (settled) return; settled = true; resolve(name); };
    try {
      const child = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
      let stdout = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, GPU_PROBE_TIMEOUT_MS);
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', () => {
        clearTimeout(timer);
        const first = stdout.trim().split(/\r?\n/)[0]?.trim();
        done(first && first.length > 0 ? first : null);
      });
    } catch {
      done(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 档位判定与推荐                                                       */
/* ------------------------------------------------------------------ */

/**
 * 按设备档案判定算力档位（纯函数，平台无关）。
 *
 * 规则（依据：核数/内存是"识别任务能否并跑"的最直接指标；GPU 在大图/OCR 时加分；
 * 微基准 benchScore 捕捉"核多但单核弱/降频/云主机/VM 配额"）：
 *  - slow：cpuCores <= 4，或物理内存 < 8 GiB；或基准极低（<0.3）且无 GPU；
 *  - fast：cpuCores >= 8 且内存 >= 16 GiB 且有独立 GPU，且基准不低于弱阈值（<0.5
 *    不判 fast——即使核多也说明单核弱/云配额）；
 *  - normal：其余。
 *  基准不可用（关闭/异常，benchScore=null）不影响原规则。
 *
 * @param {object} [probe] - 设备档案 {cpuCores,totalMemBytes,gpuName,benchScore,onBattery,platformInfo}。
 * @returns {'slow'|'normal'|'fast'} 档位。
 */
export function classifyTier(probe) {
  const p = probe && typeof probe === 'object' ? probe : {};
  const cpuCores = Number.isFinite(Number(p.cpuCores)) ? Number(p.cpuCores) : 0;
  const memBytes = Number.isFinite(Number(p.totalMemBytes)) ? Number(p.totalMemBytes) : 0;
  if (cpuCores <= 0 || memBytes <= 0) return 'normal'; // 数据缺失 → 保守 normal
  const memGiB = memBytes / GiB;
  const hasGpu = Boolean(p.gpuName);
  // benchScore 须为显式有限数才算"可用"；null/undefined/''/非法 都视为"未探测"（bench=null）。
  // 注意：Number(null) 为 0 会被误判为"可用且极低"，故须先判 null/undefined/''。
  const benchRaw = p.benchScore;
  const bench = (benchRaw === null || benchRaw === undefined || benchRaw === '')
    ? null
    : (Number.isFinite(Number(benchRaw)) ? Number(benchRaw) : null);
  const baseSlow = (cpuCores <= 4 || memGiB < 8);
  const baseFast = (cpuCores >= 8 && memGiB >= 16 && hasGpu);

  if (bench !== null) {
    // 基准极低且无 GPU → 直接 slow（即使核数多/内存足：单核弱/云配额/降频）
    if (bench < 0.3 && !hasGpu) return 'slow';
    // 基准低于弱阈值 → 无论核数多少不判 fast（降到 normal，除非本身 slow）
    if (bench < 0.5) return baseSlow ? 'slow' : 'normal';
  }
  if (baseSlow) return 'slow';
  if (baseFast) return 'fast';
  return 'normal';
}

/**
 * 按档位返回「档位推荐」对象（纯函数）。
 * - slow：放宽 OCR 池单请求超时（240s）、降池并发（2）、关 GPU、测试倍率 ×4
 *   （性能较好机 ×2 不足以体现慢机差异；×4 留足余量，手动可到最保守的 ×8）；
 * - normal：默认（DEFAULT_RECOMMENDATIONS，即不额外覆盖）；
 * - fast：保持默认（testTimeoutFactor=1），不强行开 GPU（是否用 GPU 由 gpu_provider 决定）。
 */
export function applyTierRecommendations(tier) {
  if (tier === 'slow') {
    return { ...DEFAULT_RECOMMENDATIONS, ocrPoolTimeoutMs: 240_000, ocrPool: 2, gpuProvider: 'off', testTimeoutFactor: 4 };
  }
  if (tier === 'fast') {
    return { ...DEFAULT_RECOMMENDATIONS, ocrPoolTimeoutMs: 120_000 };
  }
  return { ...DEFAULT_RECOMMENDATIONS };
}

/**
 * 合并推荐：以 base 为底，overlay 中「值 !== undefined」的键覆盖 base（后者优先）。
 * 用于把 平台降级 / 省电 / 慢网 推荐叠加到档位推荐上。
 * @param {object} base - 底（如 applyTierRecommendations 结果）。
 * @param {object} overlay - 叠加层。
 * @returns {object} 合并后的新对象。
 */
export function mergeRecs(base, overlay) {
  const out = { ...base };
  for (const k of Object.keys(overlay)) {
    if (overlay[k] !== undefined) out[k] = overlay[k];
  }
  return out;
}

/**
 * 计算「单一生效推荐」：档位推荐 + 平台降级(C) + 省电(B) + 慢网(D) 依序合并。
 * 仅返回推荐值；"用户显式 > 推荐 > 默认" 的优先级由调用方（runtime）应用。
 * @param {object} state - { tier, onBattery, platformInfo, opts:{usePower,pfMode,useNet} }
 * @returns {object} 合并后的推荐对象。
 */
export function computeRecommendations(state) {
  const s = state || {};
  const tier = s.tier || 'normal';
  const opts = s.opts || {};
  const usePower = opts.usePower !== false;
  const pfMode = String(opts.pfMode ?? 'auto');
  const useNet = opts.useNet !== false;

  let rec = applyTierRecommendations(tier);

  // C. 平台降级：auto=仅检测到降级才应用；on=强制降级；off=关闭。
  if (pfMode !== 'off' && (pfMode === 'on' || isPlatformDegraded(s.platformInfo))) {
    rec = mergeRecs(rec, PLATFORM_RECOMMENDATIONS);
  }

  // B. 省电：仅电池放电中且档位非 slow（slow 已有更保守值，保持"slow 推荐不变"）。
  if (usePower && s.onBattery === true && tier !== 'slow') {
    rec = mergeRecs(rec, POWER_RECOMMENDATIONS);
  }

  // D. 慢网：仅 slow 档（用户可 slow_net_adapt=false 关闭）。
  if (useNet && tier === 'slow') {
    rec = mergeRecs(rec, SLOW_NET_RECOMMENDATIONS);
  }

  return rec;
}

/**
 * 计算设备画像摘要文本（供设置页只读字段 / 自检 / 安装脚本展示）。
 * 本轮扩展：追加 电池 / 平台(arch/WSL/容器) / 基准评分 三段。
 * @param {object} [probe] - 设备档案。
 * @returns {string} 形如 "CPU 16核 / 内存 15.6GB / GPU NVIDIA... → normal；电池 交流 / 平台 x64 / 基准 1.00"。
 */
export function deviceProfileText(probe) {
  const p = probe && typeof probe === 'object' ? probe : {};
  const cpu = Number.isFinite(Number(p.cpuCores)) ? Number(p.cpuCores) : '?';
  const mem = Number.isFinite(Number(p.totalMemBytes)) ? (Number(p.totalMemBytes) / GiB).toFixed(1) : '?';
  const gpu = p.gpuName ? String(p.gpuName) : '无';
  const tier = classifyTier(probe);
  // 电池
  const batt = p.onBattery === true ? '电池' : (p.onBattery === false ? '交流' : '未知');
  // 平台
  const pi = p.platformInfo && typeof p.platformInfo === 'object' ? p.platformInfo : {};
  const pf = [pi.arch, pi.isWsl ? 'WSL' : null, pi.isContainer ? '容器' : null].filter(Boolean).join('/') || 'unknown';
  // 基准
  const bench = Number.isFinite(Number(p.benchScore)) ? Number(p.benchScore).toFixed(2) : '未测';
  return 'CPU ' + cpu + '核 / 内存 ' + mem + 'GB / GPU ' + gpu + ' → ' + tier
    + '；电池 ' + batt + ' / 平台 ' + pf + ' / 基准 ' + bench;
}
