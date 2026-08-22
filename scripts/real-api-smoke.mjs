#!/usr/bin/env node
/**
 * real-api-smoke.mjs — 真实 API 冒烟测试（会调用 DeepSeek 视觉 API，产生少量费用）
 *
 * 功能：用真实 key 走一遍「切图 → DeepSeek 视觉 API 识别 → 真实 usage 计费」完整链路。
 *  - key 来源：环境变量 DEEPSEEK_API_KEY，其次 ~/.dsh/.credentials.yaml（仅本机测试用）
 *  - 输入：tests/fixtures/test-3200x2000.png（3200×2000 → 12 块 → single 模式 1 次请求）
 *  - 为控制成本：max_tokens=2048，输出前 300 字符
 *
 * 运行：node scripts/real-api-smoke.mjs
 */

import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

// ---------- 1. 读取 API key（不打印明文） ----------
async function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const credFile = join(homedir(), '.dsh', '.credentials.yaml');
  if (existsSync(credFile)) {
    const text = await readFile(credFile, 'utf-8');
    const m = text.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/);
    if (m) return m[1];
  }
  throw new Error('未找到 API key（环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml）');
}
const apiKey = await resolveApiKey();
console.log(`[1] API key 已就位（${apiKey.slice(0, 8)}...，不显示明文）`);

// ---------- 2. 模拟 ctx，加载插件，取 vision_tile_recognize ----------
const tools = [];
const fsShim = {
  async resolve(path, opts) {
    const cwd = opts?.cwd ?? process.cwd();
    const abs = resolve(cwd, path);
    return { displayPath: abs, targetKey: abs };
  },
  processPath: (target) => target.displayPath,
  fileUrl: (target) => `file://${target.displayPath.replace(/\\/g, '/')}`,
  async stat() { return { type: 'file', version: 1 }; },
  async readBytes(target) { return readFileSync(fsShim.processPath(target)); }
};
const ctx = {
  tools: { register: (t) => tools.push(t) },
  fs: fsShim,
  emit: () => {},
  effect: (fn) => fn(),
  logger: { warn: () => {}, info: () => {} }
};
const plugin = await import('../src/index.js');
plugin.apply(ctx, {}); // 默认配置（apiKeyEnv=DEEPSEEK_API_KEY 等）
const recognizeTool = tools.find((t) => t.name === 'vision_tile_recognize');
if (!recognizeTool) throw new Error('未注册 vision_tile_recognize');
console.log(`[2] 插件已加载（${tools.map((t) => t.name).join(' / ')}）`);

// ---------- 3. 设置进程环境变量（插件从 process.env 读 key） ----------
process.env.DEEPSEEK_API_KEY = apiKey; // 仅本进程，测试后即消失

// ---------- 4. 真实识别（3200×2000 → 12 块，single 模式） ----------
const fixture = resolve(process.cwd(), 'tests/fixtures/test-3200x2000.png');
if (!existsSync(fixture)) throw new Error(`夹具不存在：${fixture}`);
const outDir = mkdtempSync(join(tmpdir(), 'vision-real-api-'));
const exec = { signal: undefined, agent: { session: { header: { cwd: process.cwd() } } } };
console.log(`[3] 开始真实识别：${fixture}（max_tokens=2048）...`);
const t0 = Date.now();
const result = await recognizeTool.execute(
  { file_path: fixture, max_tokens: 2048, out_dir: outDir, json: false },
  exec
);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ---------- 5. 汇总输出 ----------
console.log(`[4] 识别完成（耗时 ${elapsed}s）`);
console.log(`    模式=${result.mode} 块数=${result.imageCount} 请求数=${result.stages.length}`);
console.log('    ── 识别答案（前 300 字符）──');
console.log('    ' + result.answer.replace(/\n/g, '\n    ').slice(0, 300));
// 按需求：插件不统计 token、不计算费用（计费由 DeepSeek API 平台侧统一完成）
console.log('\n✅ 真实 API 链路测试完成（本插件不计算 token/费用，计费由 DeepSeek API 平台侧完成）');
