**本次更新（v0.1.2）完全由 DeepSeek Harness 自主完成** —— 从问题诊断、代码修复、单元/集成测试、跨场景稳定性验证，到版本打包与发布流程，全部由 DeepSeek Harness 自主执行。

写在前面：这个插件是我用Deepseek Harness写的，我本人没有写代码有关的知识，这个插件只是提供一个思路外加自用。Deepseek-v4-flash-vision-exp发布后由于其会把大图压缩到800*800的特性，为了不丢失图片细节就让Deepseek写了这个插件，各位随意取用，有问题的话可以提交issue（如果能自己改的话就更好了，你提交了issue我也只能给Deepseek看然后让他自己改，我本人尝试过多次均为学会任何写代码的能力，也是乘上ai的东风了让我有了开发插件的能力）

# vision-exp-tile ◆ DeepSeek Harness 大图分块识别插件（为 deepseek-v4-flash-vision-exp 定制）

> **简介**：DSH（DeepSeek Harness）插件——把大图切成 **800×800 无损小块**（官方缩放规则的"甜蜜点"：块在模型侧**不被降采样**、每块 **≤384 token**），携带**坐标标注 + 分块聚合逻辑**直连 DeepSeek 视觉 API 逐块识别与聚合，输出结构化答案。仅使用**纯官方 DSH 功能**，零依赖任何第三方 DSH 插件；不统计 token、不计算费用。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-purple.svg)](#)

## 一、为什么切 800×800

官方文档（api-docs.deepseek.com/guides/vision）规定：每张图进模型前自动缩放——总像素 < ~384×384 放大，更大的图按长宽比缩小到 **≈800×800 总像素**，**每张图 token 封顶 384**。

- 块边长 800 → 处于"不缩放"边界：**细节零损失**，每块恰好 ≤384 token；
- 原图 ≤800×800 → 不切分，原样识别；
- 原图更大 → 切成 800×800 网格（边缘块取实际尺寸，不补白不放大），全部 1:1 进模型。

## 二、安装与挂载

```powershell
# 1. 解压/放置插件到 DSH 插件目录（推荐与 picturereader 等并列）
#    目录：C:\Users\HP\.dsh\plugins\vision-exp-tile（或任意位置，用 junction 链接亦可）

# 2. 安装依赖
cd <插件目录>; npm install

# 3. 在目标 profile 的 package.json 中：
#    "dsh": { "profile": { "bundles": [ ..., "vision-exp-tile" ] } }
#    "dependencies": { "vision-exp-tile": "link:C:/Users/HP/.dsh/plugins/vision-exp-tile" }

# 4. 重启 DSH 生效
```

**纯净 DSH 快速上手**（无任何其它插件，纯官方 DSH）：

```powershell
npm install                                    # ① 安装依赖
setx DEEPSEEK_API_KEY "sk-你的key"              # ② 配置 API key（从系统环境变量读取）
# ③ 新开终端重启 DSH（新终端才会加载环境变量）
dsh web
```

## 三、工具用法（模型调用）

### 1. `vision_tile_split` —— 切图 + 坐标标注 + 聚合逻辑

```json
{ "file_path": "D:\\img\\截图.png", "block_size": 800, "cut_threshold": 800, "overlap": 0, "out_dir": "" }
```

- `cut_threshold=800`：长边 ≤800 不切（小图不裁）；
- `overlap=64`：推荐用于文字/表格密集图（防跨块切断）；
- `rotate=0/90/180/270`：图片横倒/倒置时先转正（切图/坐标/overview 基于旋转后图像）；
- 输出：块文件（文件名自带坐标 `截图_r0_c1_x800_y0_800x800.png`）+ 坐标清单（编号/行列/原图坐标）+ overview（整图缩略+网格+块号）→ **分块聚合逻辑**（识别顺序、坐标定位、跨块合并、禁止编造）。

### 2. `vision_tile_recognize` —— 全网格识别（一条龙）

```json
{ "file_path": "D:\\img\\大图.png", "question": "完整识别大图内容", "mode": "auto", "block_size": 800 }
```

- `mode=auto`：块数 ≤60 → 单请求"逐块识别 + 全局聚合"；否则**分层聚合**（每组 ≤40 块 → 带坐标 JSON → 文本聚合）；
- `mode=single/layered`：强制单请求/分层聚合；
- `json=true`：输出结构化 JSON（summary / regions / crossBoundary / uncertain）；
- `max_tokens`/`group_size`/`overlap`/`rotate`/`format`/`quality`/`out_dir`/`with_overview` 可选；
- **健壮性**：模型只思考未输出正文（content 为空）时自动放大 max_tokens 重试一次；仍为空则报 finish_reason 与思考摘要；
- 返回：识别答案 + 统计（模式/块数/请求数）+ 块清单；**不统计 token、不计算费用**。

### 3. `vision_region_crop` —— 指定矩形区域裁剪识别

```json
{ "file_path": "D:\\img\\大图.png", "rect": [0.25, 0.1, 0.75, 0.9], "recognize": true, "max_edge": 800 }
```

- `rect`：`[x0,y0,x1,y1]`，支持 0..1 相对坐标或原图像素坐标（自动识别）；
- `max_edge`：输出最长边（默认 800 保比例，4:3 → 800×600；`0`=1:1 不缩放）；
- `recognize=true`（默认）：直连视觉 API 返回该区域描述；`false`：仅落盘 PNG（供本地 OCR 等工具处理）；
- 返回：区域图路径、输出尺寸、原图裁剪矩形（像素）、（recognize 时）区域描述。

## 四、成本参考（仅供了解，插件本身不计算）

每块 800×800 = 384 token（封顶，官方规则）。按官方价（输入命中 0.1 / 未命中 3 / 输出 9 元·百万 tokens）估算，**实际计费以 DeepSeek API 平台账单为准**：

| 原图尺寸 | 网格 | 块数 | 图片输入 token | 输出 token(估) | **费用(约)** |
|---|---|---|---|---|---|
| ≤800×800 | 1×1 | 1 | 384 | 400 | **≈0.005 元** |
| 1600×1600 | 2×2 | 4 | 1,536 | 700 | **≈0.011 元** |
| 2400×1600 | 3×2 | 6 | 2,304 | 900 | **≈0.015 元** |
| 4000×3000 | 5×4 | 20 | 7,680 | 1,600 | **≈0.035 元** |
| 8000×6000 | 10×8 | 80 | 30,720 | 3,200 | **≈0.12 元** |

## 五、验证（开发自检）

```powershell
npm test          # 44 个单元测试（网格/坐标/计费校验/提示模板/mock API/真实切图）
node scripts/smoke-tool.mjs   # 端到端冒烟（切块/坐标/渲染/报错）
```

## 六、边界

- 直连官方 API，不受 DSH 内置 deepseek 适配器 text-only 限制；结果以文本回流会话；
- 官方限制：图片仅可在 user 消息（已遵守）；单请求 ≤600 图（默认 ≤240 更保守）；base64 请求体 ≤48MiB（超预算自动提示分批/转 JPEG）；
- "完美识别"是质量目标：块数越多难度越高，分层聚合显著缓解；跨块细线级元素建议 `overlap=64`。

## 七、维护者发布更新流程（每次发布新版本）

1. 修改源码后运行 `npm test`（44 用例全绿）与 `node scripts/smoke-tool.mjs`（冒烟通过）；
2. 修改 `package.json` 的 `version`（如 `0.1.1`）；
3. 执行 `powershell -ExecutionPolicy Bypass -File scripts\release-pack.ps1` → 生成 `dist\vision-exp-tile-v<新版本>.zip`；
4. GitHub 仓库：提交改动 → 点 Releases → **Create a new tag**（如 `v0.1.1`）→ 附上新的 zip → Publish；
5. 用户使用：下载 zip 解压到 `~/.dsh/plugins/vision-exp-tile` → `npm install` → profile 挂 `link:` → 重启 DSH。

> 更快的方式：仓库已带 `.github/workflows/release.yml` —— 推送 `v*` 标签即自动：`npm ci && npm test` → 打包 zip → 创建 Release 并挂上 zip（无需手动打包/传附件）。

### 版本约定

- 本发布版为**纯净原创版**：只含"切块识别 + 坐标标注 + 分块聚合逻辑"，不含整图预检/本地 OCR/像素网格等内容（为避免与其它项目功能混淆）；
- 社区用户若要"预检 + 本地 OCR"流程可自行安装相应工具（本插件不依赖、也不调用它们）。

## 八、v0.1.1 更新内容（本版新增，旧功能不变）

**修复目标**：在复杂图形（如图形推理题）场景下，预检/区域识别偶发"模型只思考未输出正文"（`finish_reason=length`），导致识别失败。

1. **输出预算修正**：区域识别等直读请求的 `max_tokens` 默认由 2048 提升为 **8192**，并透传用户配置的参数；
2. **关闭思考模式**：结构化/短任务请求携带官方 `{"thinking":{"type":"disabled"}}`——模型直接输出结果，不再把预算耗在思考上（官方 api-docs.deepseek.com/guides/thinking_mode 支持）；
3. **空正文自动重试升级**：内容为空时最多重试 **2 次**（依次 +4096 / +8192），仅在仍为空时给出明确报错；
4. **报错信息可读化**：中止/网络错误不再显示 `[object Object]`，改为输出真实取消原因（`signal.reason`）与错误详情；
5. **健壮性兜底**：（本地扩展版）预检提示词增加兜底句——无法输出结构化 JSON 时可退化为中文概括，避免空回复。

## 许可

MIT © vision-exp-tile contributors
