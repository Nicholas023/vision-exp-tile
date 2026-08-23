/**
 * tests/helpers/suite-env.mjs — 测试套件「慢机自适应」环境辅助（v0.4.1）
 *
 * 目的：让测试在被较差机型（慢机）运行时不因时序抖动而偶发失败。从以下环境变量
 * 读取三个可调参数（均由设置页/自检/安装脚本/上层导出注入）：
 *  - VISION_TEST_TIMEOUT_FACTOR：超时判定倍率（1..8，默认 1；推荐 4=slow 档默认，手动最保守 8；慢机可调大）。
 *  - VISION_TEST_SKIP_TIMING：是否跳过时序敏感断言（1/true/yes/on→跳过，默认不跳）。
 *  - DSH_OCR_POOL_TIMEOUT：运行时的 OCR 池单请求超时（毫秒；由 src 模块读取，
 *    此处仅在需要「与运行时一致」时参考，单元测试的池超时用 poolTimeoutMs(base)）。
 *
 * 供全部测试文件 import 使用：把 withPool 等固定超时替换成 poolTimeoutMs(base)、
 * 把时序敏感用例用 node:test 的 { skip: skipTiming() } 声明跳过。
 *
 * 约定：所有函数均为同步纯函数，读 process.env，缺省有默认值，非法值回退默认，
 * 保证测试在任意环境下确定性。只能 import（ESM），平台无关，CI/Linux 通吃。
 */

/**
 * 读取测试超时判定倍率（1..8，非法/未设置回退 1；对 >8 的值 clamp 到 8）。
 * @returns {number} 倍率（1..8 整数）。
 */
export function timingFactor() {
  const raw = Number(process.env.VISION_TEST_TIMEOUT_FACTOR);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(8, Math.max(1, Math.floor(raw)));
  }
  return 1;
}

/**
 * 把「基准超时」乘以倍率，得到该测试实际应使用的超时（慢机放大窗口）。
 * @param {number} base - 基准超时（毫秒，如 2000 / 300）。
 * @returns {number} 放大后的整数超时（毫秒）。
 */
export function poolTimeoutMs(base) {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return base;
  return Math.round(b * timingFactor());
}

/**
 * 是否应跳过时序敏感断言。
 * @returns {boolean} true=跳过（VISION_TEST_SKIP_TIMING 为 1/true/yes/on）。
 */
export function skipTiming() {
  const raw = String(process.env.VISION_TEST_SKIP_TIMING ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
