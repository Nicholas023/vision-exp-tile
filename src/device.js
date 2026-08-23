/**
 * device.js — 设备档案模块（v0.4.1）
 *
 * 目的：识别当前机器算力档位（slow / normal / fast），供三处共用：
 *   1. 运行时（runtime.js）：performance_tier=auto 时，若探测为 slow，自动把
 *      「未显式设置」的 OCR 池超时/池大小/GPU 关停等按其推荐值写入 env 映射，
 *      让较差机型免手动调参即可获得更宽容的超时与更省算力的配置。
 *   2. 安装脚本（scripts/install-to-web-profile.ps1）：装机即优化——slow 机自动
 *      把推荐值写入目标 profile 的 settings.yaml（未显式设置才写入）。
 *   3. 自检入口（scripts/self-check.mjs）：打印设备画像 + 将生效的推荐，并据此
 *      决定测试超时倍率 / 是否跳过时序敏感断言。
 *
 * 设计要点：
 *  - 纯 JS、平台无关（win32 / Linux / macOS 均可跑）；唯一 async 的外部调用
 *    是 GPU 名探测（spawn nvidia-smi，1.5s 超时，失败返回 null）。
 *  - 可 mock：probeDevice(overrides) 接受注入结果（单测用），不触发真实探测。
 *  - 结果带进程级缓存（60s TTL）：GPU 探测成本较高，避免重复 spawn。
 *  - 不引入任何第三方依赖（仅 node:os / node:child_process）。
 *
 * @module vision-exp-tile/device
 */

import { cpus, totalmem, platform } from 'node:os';
import { spawn } from 'node:child_process';

/** 1 GiB 字节数（内存档位判定用）。 */
const GiB = 1024 ** 3;

/** 探测结果缓存 TTL（毫秒）；GPU 探测成本高，60s 内复用。 */
const PROBE_TTL_MS = 60_000;

/** GPU 名探测超时（毫秒）；太慢则视为无 GPU。 */
const GPU_PROBE_TIMEOUT_MS = 1500;

/**
 * 各档位「推荐覆盖」的默认值（normal 档，即「不额外干预」）。
 * 说明：ocrPool/gpuProvider 为 undefined 表示「不强制、走模块默认（DSH_OCR_POOL=4、
 * DSH_OCR_GPU_PROVIDER 自动探测）」；这与 slow 档显式给值的语义形成对照。
 */
export const DEFAULT_RECOMMENDATIONS = Object.freeze({
  ocrPoolTimeoutMs: 120_000, // OCR 池单请求超时（毫秒）
  ocrPool: undefined,        // 池大小；undefined=不覆盖（默认 4）
  gpuProvider: undefined,    // GPU provider；undefined=不覆盖（默认 auto 探测）
  testTimeoutFactor: 1       // 测试超时判定倍率
});

/* ------------------------------------------------------------------ */
/* 探测结果缓存                                                         */
/* ------------------------------------------------------------------ */

/** 进程级缓存：最近一次真实探测结果（probeDevice 无 overrides 时写入）。 */
let cachedProbe = null;
/** 缓存时间戳（毫秒）。 */
let cachedAt = 0;

/**
 * 读取缓存的探测结果（可能为 null——尚未探测或无缓存）。
 * 供 runtime.js 在 envFromSettings 同步环境里做 auto 档位判定（不触发异步探测）。
 * @returns {object|null} 探测结果 {cpuCores,totalMemBytes,gpuName,platform} 或 null。
 */
export function getCachedProbe() {
  return cachedProbe;
}

/**
 * 手动写入/替换缓存探测结果（测试注入用，不经真实探测）。
 * @param {object|null} probe - 探测结果；传 null 清空。
 */
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
/* 设备探测                                                             */
/* ------------------------------------------------------------------ */

/**
 * 探测本机设备档案。
 *
 * @param {object} [overrides] - 注入结果（单测用）。若提供 cpuCores/totalMemBytes/
 *   gpuName/platform 中任一，则把它当作「已探测」结果返回（gpu 不触发真实探测）；
 *   缺省字段用真实值补齐（cpu/mem 同步取，gpu 默认为 null）。
 * @returns {Promise<{cpuCores:number, totalMemBytes:number, gpuName:string|null, platform:string}>}
 *   设备档案。
 */
export async function probeDevice(overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const hasOverride = ov.cpuCores !== undefined
    || ov.totalMemBytes !== undefined
    || ov.gpuName !== undefined
    || ov.platform !== undefined;

  if (hasOverride) {
    // 注入模式：缺省字段用真实值补齐（cpu/mem 同步取；gpuName 缺省视为无 GPU）。
    return {
      cpuCores: ov.cpuCores ?? cpus().length,
      totalMemBytes: ov.totalMemBytes ?? totalmem(),
      gpuName: ov.gpuName === undefined ? null : ov.gpuName,
      platform: ov.platform ?? platform()
    };
  }

  // 缓存新鲜 → 直接复用（避免重复 GPU 探测）。
  if (cachedProbe && Date.now() - cachedAt < PROBE_TTL_MS) return cachedProbe;

  // 真实探测：cpu/mem 同步、gpu 异步（1.5s 超时，失败=null）。
  const probe = {
    cpuCores: cpus().length,
    totalMemBytes: totalmem(),
    gpuName: await detectGpuName(),
    platform: platform()
  };
  cachedProbe = probe;
  cachedAt = Date.now();
  return probe;
}

/**
 * GPU 名探测：跨平台尝试 nvidia-smi --query-gpu=name --format=csv,noheader。
 * - win32 / Linux / macOS 统一走 nvidia-smi（NVIDIA 驱动自带）；
 * - 1.5s 超时、spawn 失败或输出为空 → 返回 null（视为无独显）。
 * @returns {Promise<string|null>} 第一块 GPU 名，或 null。
 */
async function detectGpuName() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (name) => {
      if (settled) return;
      settled = true;
      resolve(name);
    };
    try {
      const child = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let stdout = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        done(null);
      }, GPU_PROBE_TIMEOUT_MS);
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
 * 规则（依据：核数与内存是"识别任务能否并跑/是否卡顿"的最直接指标，GPU 只在
 * 大图/OCR 时加分）：
 *  - slow：cpuCores <= 4，或物理内存 < 8 GiB —— 线程少/内存小，OCR 池并发易超时，
 *    需要放宽超时并降低并发、优先 CPU；
 *  - fast：cpuCores >= 8 且内存 >= 16 GiB 且有独立 GPU —— 硬件充足，可放开 GPU；
 *  - normal：其余（介于两者之间）。
 *
 * @param {object} [probe] - 设备档案 {cpuCores,totalMemBytes,gpuName,platform}。
 * @returns {'slow'|'normal'|'fast'} 档位。
 */
export function classifyTier(probe) {
  const p = probe && typeof probe === 'object' ? probe : {};
  const cpuCores = Number.isFinite(Number(p.cpuCores)) ? Number(p.cpuCores) : 0;
  const memBytes = Number.isFinite(Number(p.totalMemBytes)) ? Number(p.totalMemBytes) : 0;
  // 数据缺失/非法（cpu 或 内存 <=0，如传入 null/undefined/空对象）视为「未探测」，
  // 保守按 normal——避免把一次失败的探测误判为 slow 而错误放宽超时/降配置。
  if (cpuCores <= 0 || memBytes <= 0) return 'normal';
  const memGiB = memBytes / GiB;
  const hasGpu = Boolean(p.gpuName);

  if (cpuCores <= 4 || memGiB < 8) return 'slow';
  if (cpuCores >= 8 && memGiB >= 16 && hasGpu) return 'fast';
  return 'normal';
}

/**
 * 按档位返回「推荐覆盖」对象（纯函数）。
 *
 * - slow：放宽 OCR 池单请求超时（240s）、降 OCR 池并发（2，更省资源/防盗崩）、
 *   关停 GPU（gpuProvider='off'，避免慢机 GPU 反而拖慢/不稳定），测试超时倍率 ×2
 *   （降低慢机时序抖动导致的偶发超时）；
 * - normal：默认（用 DEFAULT_RECOMMENDATIONS，即不额外覆盖）；
 * - fast：保持默认（testTimeoutFactor=1），不影响现有行为。
 *
 * @param {'slow'|'normal'|'fast'} tier
 * @returns {{ocrPoolTimeoutMs:number, ocrPool?:number, gpuProvider?:string, testTimeoutFactor:number}}
 */
export function applyTierRecommendations(tier) {
  if (tier === 'slow') {
    return {
      ocrPoolTimeoutMs: 240_000,
      ocrPool: 2,
      gpuProvider: 'off',
      testTimeoutFactor: 2
    };
  }
  if (tier === 'fast') {
    return { ocrPoolTimeoutMs: 120_000, testTimeoutFactor: 1 };
  }
  return { ...DEFAULT_RECOMMENDATIONS };
}

/**
 * 计算设备画像摘要文本（供设置页只读字段 / 自检 / 安装脚本展示）。
 * @param {object} [probe] - 设备档案。
 * @returns {string} 形如 "CPU 8核 / 内存 16.0GB / GPU NVIDIA GeForce RTX 3060 → fast"。
 */
export function deviceProfileText(probe) {
  const p = probe && typeof probe === 'object' ? probe : {};
  const cpu = Number.isFinite(Number(p.cpuCores)) ? Number(p.cpuCores) : '?';
  const mem = Number.isFinite(Number(p.totalMemBytes)) ? (Number(p.totalMemBytes) / GiB).toFixed(1) : '?';
  const gpu = p.gpuName ? String(p.gpuName) : '无';
  const tier = classifyTier(probe);
  return 'CPU ' + cpu + '核 / 内存 ' + mem + 'GB / GPU ' + gpu + ' → ' + tier;
}
