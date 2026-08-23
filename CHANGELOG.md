# 更新日志（Release Changelog）

> 全部版本记录（v0.1.0 → v0.1.4），最新在上；本文件 = GitHub Release 的 changelog 栏（由 .github/workflows/release.yml 自动读取）。
> 注：README 只展示最新一期更新内容（使用者视角）；本文件保留每期完整记录（含历史）。

## v0.1.4（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 新功能与优化

1. **本地 OCR 缓存** — 同一张图重复识别直接命中（默认 48 小时），实测 20 张批量从 10.7s 降至 15ms；`DSH_OCR_CACHE=0` 关闭。
2. **重点区域并行识别** — 兴趣点默认 2 路并发（参数 `interest_concurrency` / `DSH_INTEREST_CONCURRENCY` 调 1-4），大图整卷等待时间再减一半。
3. **置信度自适应升级** — 本地 OCR 平均置信度低于 0.85 的区域，自动改用视觉 API 转录，更快与更准自动取舍。
4. **429/5xx 指数退避重试** — 限流/服务端异常自动重试（尊重 Retry-After），识别更稳定。
5. **跨块表格/长句对齐增强** — 分块后跨块文字行、表格单元格自动按行拼接还原，不再重复或遗漏。
6. **损坏图/HEIC 友好提示** — 无法识别的图片格式给出明确转图指引，替代裸报错。
7. **Windows OCR 中文指引** — 未安装中文 OCR 语言包时提供一键安装命令提示，并自动降级为视觉 API 转录。
8. **参数暴露** — `vision_tile_recognize` 支持 `ocr_engine`（auto/paddle/rapid/windows）与 `interest_concurrency`，缺省行为不变（向后兼容）。

### 性能

- 本地识别单张：3.3s → **0.18s**（≈18×）；20 张批量：66s → **8s**（≈8×）；缓存命中后批量 ≈ **0.02s**。
- 兴趣点并行后，整卷大图（多区域）等待时间再减约 50%。

### 版本形态

- **完整版** `vision-exp-tile-v0.1.4.zip`：本地识别最强（可选 paddle/rapid Python 环境，未装自动降级）。
- **无 Python 零配置版** `vision-exp-tile-v0.1.4-nopython.zip`：无需任何 Python 环境，本地识别使用系统自带 Windows OCR（常驻池），开箱即用。

---

## v0.1.3（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

1. **本地 OCR 常驻进程池** — 模型只加载一次、多核并行（默认 4 进程 × 4 线程）：20 张批量 66s → **8s**（≈8×），单张 3.3s → 0.18s。
2. **Windows OCR 常驻池** — 免 Python 零配置形态的本地识别核心（系统自带 WinRT，单张 ≈0.45s）。
3. **默认引擎快速化** — rapid 优先（比 paddle 快约 27 倍）；`DSH_OCR_ENGINE=paddle` 切回高精度。
4. **pipeline 多区域并发** — 文字区并行（`DSH_PIPELINE_CONCURRENCY` 可调，1=旧串行）。
5. **引擎探测缓存 60s + 池崩溃自愈/超时重启/进程退出兜底清理**。
6. **双形态发布** — 完整版（venv 可选）+ 无 Python 零配置版（剔除 `ocr-worker.py`，自动降级 Windows OCR）。

---

## v0.1.2（2026-08-22）

**本次更新完全由 DeepSeek Harness 自主完成。**

1. **修复 `vision_region_crop` recognize=true 崩溃** — 未定义 `maxTokens` 引用（ReferenceError），修复后真机转录正常。
2. **预检/区域识别 maxTokens=8192 并全链透传** — 解决复杂图"思考耗尽预算 → 空正文"问题。
3. **错误信息健壮化** — 不再输出 `[object Object]`，展示真实取消/异常原因。
4. **空正文自动重试**（+4096/+8196 递增，上限 65536）。
5. **预检 JSON 失败兜底** — 退化为中文描述输出，不中断流程。
6. **测试环境修复**：CI Node 20 兼容（test 脚本）+ 测试泄漏隔离。

---

## v0.1.1（2026-08-22）

**首发纯净版：大图 800×800 无损切块识别（零依赖第三方 DSH 插件）。**

- 三个工具：`vision_tile_split`（切块）/ `vision_tile_recognize`（直连 DeepSeek 视觉 API 识别聚合）/ `vision_region_crop`（区域裁剪识别）；
- 核心思路：官方会把大图压缩到 ≈800×800 总像素 → 主动切成 800×800 无损块（每块 ≤384 token、不被二次压缩）+ 坐标标注 + 分块聚合逻辑；原图 ≤800 不切；
- 返回结构化答案；**不统计 token、不计算费用**；MIT 开源。
- 本版本由 DeepSeek Harness 全流程编写（初版需求来自用户：为 deepseek-v4-flash-vision-exp 定制）。

---

## v0.1.0（2026-08-22）

**首个草案版本（技术验证版 0.1.0）。**

- 完成可行性验证：DeepSeek 视觉 API 直连 + 分块识别方案成立；
- 确立三种策略框架：smart（模型编排）/ full（全图网格切块）/ 区域裁剪识别；
- 明确官方规则：图片仅限 user 消息、384×384 放大、≈800×800 缩放、每张 ≤384 token；
- 为后续纯净版（v0.1.1）与完整版构建奠定基础。
