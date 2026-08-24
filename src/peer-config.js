/**
 * peer-config.js — picturereader 配置复用（v0.4.2）
 *
 * 目的：本插件与 picturereader 常共存。picturereader 在 settings.yaml 的
 * 'picturereader:' 分区已配了视觉端点（vlm_base）与模型（vlm_model）等；
 * 本插件把它复用为"默认"（仅当本插件未显式设置 baseURL/model 时），免重复配置。
 *
 * 本模块纯 JS、文本行匹配（禁止引入第三方 YAML 解析）。提供：
 *   - readPeerSettings(configPath?)：读 settings.yaml 的 picturereader 分区，
 *     返回 { vlm_base, vlm_model, vlm_key_env, ocr_engine }（缺键为 undefined）；
 *     文件不存在/无分区/畸形 → null（不抛错）。
 *   - applyPeerDefaults(config, peer)：把 peer 值应用到 config 的 baseURL/model——
 *     仅当 config 对应值等于默认（未显式）时覆盖；用户显式 > peer > 默认。
 *
 * @module vision-exp-tile/peer-config
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_CONFIG } from './config.js';

/** 目标分区名（settings.yaml 顶层 key）。 */
const PEER_NS = 'picturereader';

/** 需要读取的 peer 键（snake_case，与 picturereader 设置命名空间一致）。 */
const PEER_KEYS = ['vlm_base', 'vlm_model', 'vlm_key_env', 'ocr_engine'];

/**
 * 读取 settings.yaml 中 picturereader 分区的键值。
 * @param {string} [configPath] - settings.yaml 路径；缺省 process.env.DSH_HOME || ~/.dsh。
 * @returns {object|null} {vlm_base?,vlm_model?,vlm_key_env?,ocr_engine?}；文件或分区不存在返回 null。
 */
export function readPeerSettings(configPath) {
  let path = configPath;
  if (!path) {
    try {
      path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings.yaml');
    } catch {
      return null;
    }
  }
  // 文件不存在 → null。
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);

  // 定位 picturereader 分区行（缩进不定，允许前导空白）。
  let pidx = -1;
  let pindent = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*picturereader:\s*$/.test(lines[i])) {
      pidx = i;
      pindent = (/^\s*/.exec(lines[i]) || [''])[0].length;
      break;
    }
  }
  if (pidx < 0) return null; // 无分区 → null

  // 收集分区内的键（缩进 > 分区缩进；遇到第一个同级或更浅缩进即止）。
  const peer = {
    vlm_base: undefined,
    vlm_model: undefined,
    vlm_key_env: undefined,
    ocr_engine: undefined
  };
  for (let i = pidx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue; // 注释/空行跳过
    const indent = (/^\s*/.exec(line) || [''])[0].length;
    if (indent <= pindent) break; // 跳出本分区
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!PEER_KEYS.includes(key)) continue;
    peer[key] = cleanValue(m[2]);
  }
  return peer;
}

/**
 * 清理 settings.yaml 值：去行内注释（' #'），去引号（' 或 "），去首尾空白。
 * @param {string} raw - 原始值串。
 * @returns {string|undefined} 清洗后的值；空串/空 → undefined。
 */
function cleanValue(raw) {
  let v = String(raw ?? '');
  if (v === '') return undefined;
  // 去行内注释：找到 ' #'（前置空格 + #）。
  const hash = v.indexOf(' #');
  if (hash >= 0) v = v.slice(0, hash);
  v = v.trim();
  // 去成对引号。
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v.length > 0 ? v : undefined;
}

/**
 * 把 peer 的视觉端点/模型复用为 config 的"默认"（仅当 config 等于默认时覆盖）。
 * 优先级：用户显式值（config 非默认）> peer > 默认。返回 config（原地修改）。
 * @param {object} config - 归一化配置对象（含 baseURL/model）。
 * @param {object|null} peer - readPeerSettings 结果；null 则不覆盖。
 * @returns {object} 处理后的 config。
 */
export function applyPeerDefaults(config, peer) {
  if (!peer || !config || typeof config !== 'object') return config;
  if (peer.vlm_base && config.baseURL === DEFAULT_CONFIG.baseURL) {
    config.baseURL = String(peer.vlm_base); // 本插件未显式设视觉端点 → 复用 peer
  }
  if (peer.vlm_model && config.model === DEFAULT_CONFIG.model) {
    config.model = String(peer.vlm_model); // 本插件未显式设模型 → 复用 peer
  }
  return config;
}
