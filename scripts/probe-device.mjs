/**
 * scripts/probe-device.mjs — 设备探测 CLI（v0.4.1 扩展）
 *
 * 用法：node scripts/probe-device.mjs
 * 输出一行 JSON：{ cpuCores, totalMemBytes, gpuName, tier, onBattery, platformInfo,
 *   benchScore, benchOpsPerSec, detectMs }。
 * 供安装脚本（install-to-web-profile.ps1）经 node 调用取得设备画像；也可被用户在
 * 终端/自检脚本直接运行。无第三方依赖（仅 src/device.js）。
 *
 * 注意：避免中文路径问题（node -e 内联与 python -c 同理），因此用独立 .mjs 文件
 * 而非 node -e 一行式；所有路径皆由本脚本内部处理。
 */

import { probeDevice, classifyTier } from '../src/device.js';

// 探测（含 GPU/电源/微基准/平台，并行，总时长实测应 ≤2s），判定档位，输出合法 JSON。
const probe = await probeDevice();
const tier = classifyTier(probe);
process.stdout.write(JSON.stringify({
  cpuCores: probe.cpuCores,
  totalMemBytes: probe.totalMemBytes,
  gpuName: probe.gpuName,
  tier,
  onBattery: probe.onBattery,
  platformInfo: probe.platformInfo, // { arch, isWsl, isContainer }
  benchScore: probe.benchScore,
  benchOpsPerSec: probe.benchOpsPerSec,
  detectMs: probe.detectMs // { gpuMs, powerMs, benchMs, platformMs, totalMs }
}) + '\n');
