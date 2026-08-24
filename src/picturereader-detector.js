/**
 * picturereader-detector.js — picturereader 共存探测 + 工具分工引导（v0.4.2）
 *
 * 背景：本插件（vision-exp-tile）与上游 picturereader 常同时挂载在同一 DSH 实例。
 * 二者都做图像识别，若不分工，模型会被两套近似工具搞晕、多空转轮数。
 * 本模块：
 *   - isPicturereaderPresent()：双通道探测 picturereader 是否在场——
 *     ① dsh-tools 注册表里已有其工具（image_scan）；② 插件目录
 *        <DSH_HOME>/plugins/picturereader 存在；任一命中即在场。
 *   - collabGuideText(present)：在场时返回 ≤220 字的中文分工引导，追加到本插件
 *     三个工具的 description 尾部（省模型空转、把任务分流给更合适的插件）；
 *     不在场返回 ''（此时工具描述与 v0.4.1 逐字节一致——回归红线）。
 *
 * 设计要点：
 *  - 纯函数、可 mock：isPicturereaderPresent 接受 { toolsApi, dshHome } 注入；
 *  - 全程 try/catch：任何异常都视为"不在场"（不因探测失败影响本插件功能）；
 *  - dshHome 缺省 = process.env.DSH_HOME || join(homedir(), '.dsh')；
 *  - 不读取 picturereader 任何文件内容（仅目录存在性），零耦合。
 *
 * @module vision-exp-tile/picturereader-detector
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

/**
 * 探测 picturereader 是否在场。
 * @param {object} [opts] - { toolsApi, dshHome } 可注入（单测用）。
 * @param {object} [opts.toolsApi] - dsh-tools 服务（提供 .get(name)）。
 * @param {string} [opts.dshHome] - DSH_HOME（缺省 process.env.DSH_HOME || ~/.dsh）。
 * @returns {boolean} true=已在场。
 */
export function isPicturereaderPresent({ toolsApi, dshHome } = {}) {
  // 通道 1：dsh-tools 注册表已有 picturereader 的工具（image_scan 是其标志工具）。
  try {
    if (toolsApi && typeof toolsApi.get === 'function') {
      const t = toolsApi.get('image_scan');
      if (t) return true; // 注册表命中
    }
  } catch {
    // 异常=不在场（不因探测失败影响本插件）
  }
  // 通道 2：插件目录存在。
  try {
    const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
    return existsSync(join(home, 'plugins', 'picturereader'));
  } catch {
    return false;
  }
}

/** 与 picturereader 的分工引导文本（在场时追加）；不在此列出的工具结尾不加任何文本。 */
const COLLAB_TEXT = '【与 picturereader 分工】本插件（vision_tile_split / vision_tile_recognize / vision_region_crop）负责大图切块、批量与区域识别；小图/像素级/整页文档识别请优先用 picturereader 的 image_scan / image_ocr / image_batch / document_to_image。大图批量→本插件，小图/文档→picturereader。';

/**
 * 生成分工引导文本。
 * @param {boolean} present - picturereader 是否在场。
 * @returns {string} 在场返回 ≤220 字引导；不在场返回 ''（工具描述不变）。
 */
export function collabGuideText(present) {
  if (!present) return '';
  // 保证 ≤220 字（中文按字符计；超长会提示但仍截断到 220 防干扰模型）。
  const text = COLLAB_TEXT;
  return text.length <= 220 ? text : text.slice(0, 220);
}

/**
 * 为 tool 追加分工引导段（在场时）；不在场则原样返回（description 与基线逐字节一致）。
 * 说明：不直接改 create*Tool 的 description 数组，而是在注册入口做一次性拼接，零耦合。
 * @param {object} tool - 工具定义对象（含 description 字符串）。
 * @param {boolean} present - picturereader 是否在场。
 * @returns {object} 追加了分工段的工具对象；不在场返回原对象（不克隆）。
 */
export function withCollabIfPresent(tool, present) {
  const text = collabGuideText(present);
  if (text && tool && typeof tool.description === 'string') {
    return Object.assign({}, tool, { description: tool.description + ' ' + text });
  }
  return tool;
}
