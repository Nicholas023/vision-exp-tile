/**
 * client.js — vision-exp-tile「图像识别」Web 设置卡（浏览器半侧）
 *
 * v0.3.0：在 DSH Web 设置页注册一个「图像识别」分区，可编辑插件全部配置，
 * 保存后写入 DSH settings.yaml（经宿主机设置的命名空间），运行时热生效。
 *
 * 手写 ModuleLoader bundle —— 无构建步骤。复刻 picturereader/client.js 的格式：
 *  window.__ModuleLoader__.load({ id, factory })；factory 里 require('react）,
 *  CSS 注入、zh/en 字典、ctx.slots.inject("settings.section", ...) 注册分区
 *  （id/order/label）、ctx.settingsScope.bind({namespace}) 读写。
 *
 * 字段渲染：
 *  - enum    → select（按 SETTINGS_FIELDS.options）
 *  - boolean → checkbox
 *  - number  → number input
 *  - string  → text input
 * 分组：基础（advanced=false）在上，高级（advanced=true）折叠进 details「高级设置」。
 *
 * 保存=全部写入 scope（数值转 number、布尔保留、空字符串 unset 走默认）；
 * 重置=全部 unset。
 */

window.__ModuleLoader__.load({
  id: "vision-exp-tile",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS（theme tokens，前缀 __vt_ 避免与其他插件冲突）──────────────────
    var CSS =
      ".__vt_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__vt_field{display:flex;flex-direction:column;gap:4px}" +
      ".__vt_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__vt_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__vt_row{display:flex;align-items:center;gap:8px}" +
      ".__vt_check{accent-color:var(--dsw-alias-state-business-primary)}" +
      ".__vt_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__vt_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 8px;font-size:13px}" +
      ".__vt_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__vt_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__vt_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__vt_btn:disabled{opacity:.5;cursor:default}" +
      ".__vt_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__vt_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__vt_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__vt_advanced{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}" +
      ".__vt_advancedSummary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);user-select:none;display:flex;align-items:center;gap:5px}" +
      ".__vt_advancedArrow{display:inline-block;transition:transform .18s ease;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);transform:rotate(0)}" +
      ".__vt_advanced[open] .__vt_advancedArrow{transform:rotate(90deg)}" +
      ".__vt_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "vision-exp-tile/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "vision-exp-tile";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ──────────────────────────────────────────────────────────────
    var NS = "vision-exp-tile";
    var inject = ["slots", "locale", "settingsScope"];
    var zh = {
      nav: "图像识别",
      intro: "图像分块识别插件（vision-exp-tile）：配置识别入口、视觉 API 端点与切图参数。设置项即时生效；进程池参数（OCR 引擎/池大小）在下次工具调用时生效。",
      ocrEngine: "本地 OCR 引擎",
      preprocess: "OCR 前处理",
      handwriteRoute: "手写路由",
      upgrade: "自动升级",
      baseUrl: "视觉 API Base URL",
      model: "视觉模型",
      apiKeyEnv: "API key 环境变量",
      blockSize: "块边长（px）",
      cutThreshold: "切分阈值（px）",
      overlap: "交叠像素",
      groupSize: "分层聚合组大小",
      maxTokens: "最大输出 Tokens",
      timeoutMs: "请求超时（毫秒）",
      format: "块格式",
      quality: "JPEG 质量",
      mode: "识别模式",
      json: "输出 JSON 对象",
      withOverview: "生成 overview 缩略图",
      outDir: "块输出目录",
      rotate: "旋转角度",
      interestConcurrency: "兴趣点并行数",
      ocrPool: "OCR 池大小",
      ocrCache: "OCR 结果缓存",
      ocrPreproc: "OCR 前处理开关",
      debug: "调试日志",
      advanced: "高级设置",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 vision-exp-tile 命名空间？）",
      loading: "加载中…",
      // 枚举选项
      ocrEngineAuto: "auto（优先 rapid 自动降级，默认）",
      ocrEngineWindows: "windows（系统内置，无需安装）",
      ocrEnginePaddle: "paddle（PaddleOCR，对发光/弯曲/游戏文字更好）",
      ocrEngineRapid: "rapid（RapidOCR，轻量快速）",
      ocrEngineGpu: "gpu（RapidOCR + GPU 多设备加速，需 rapid_gpu_venv）",
      gpuProvider: "GPU Provider",
      gpuProviderAuto: "auto（按探测设备自动选择，默认）",
      gpuProviderCuda: "cuda（NVIDIA，需 onnxruntime-gpu）",
      gpuProviderDml: "dml（DirectML，NVIDIA/AMD/Intel 全厂商）",
      gpuProviderOpenvino: "openvino（Intel 核显/Arc）",
      gpuProviderOff: "off（强制 CPU）",
      gpuPython: "GPU venv 解释器路径",
      gpuDevice: "GPU 设备索引",
      gpuFallback: "GPU 失败时回退 CPU",
      preprocessAuto: "auto（深底自动反色/低对比二值化/手写放大，默认）",
      preprocessOff: "off（关闭前处理）",
      preprocessAutoEnlargeOff: "auto-enlarge-off（自动 + 禁用手写放大）",
      handwriteSmart: "smart（自动判定，默认）",
      handwriteVisual: "visual（转视觉 API 转录）",
      handwriteLocal: "local（本地识别）",
      handwriteOff: "off（关闭手写增强）",
      upgradeFull: "full（低置信/手写/深底失败转视觉 API，默认）",
      upgradeLow: "low（仅低置信才升级）",
      upgradeOff: "off（关闭自动升级）",
      formatPng: "png（无损保真，默认）",
      formatJpeg: "jpeg（更省请求体）",
      modeAuto: "auto（自动，默认）",
      modeSingle: "single（单请求）",
      modeLayered: "layered（分层聚合）",
      rotate0: "0°",
      rotate90: "90°",
      rotate180: "180°",
      rotate270: "270°",
    };
    var en = {
      nav: "Image Recognition",
      intro: "vision-exp-tile: configure recognition entry, vision API endpoint and tile params. Settings hot-apply; pool params (OCR engine/pool size) apply on the next tool call.",
      ocrEngine: "Local OCR Engine",
      preprocess: "OCR Preprocess",
      handwriteRoute: "Handwrite Route",
      upgrade: "Auto Upgrade",
      baseUrl: "Vision API Base URL",
      model: "Vision Model",
      apiKeyEnv: "API key env var",
      blockSize: "Block size (px)",
      cutThreshold: "Split threshold (px)",
      overlap: "Overlap (px)",
      groupSize: "Group size (layered)",
      maxTokens: "Max output tokens",
      timeoutMs: "Request timeout (ms)",
      format: "Block format",
      quality: "JPEG quality",
      mode: "Mode",
      json: "Output JSON object",
      withOverview: "Generate overview thumbnail",
      outDir: "Block output dir",
      rotate: "Rotate",
      interestConcurrency: "Interest concurrency",
      ocrPool: "OCR pool size",
      ocrCache: "OCR result cache",
      ocrPreproc: "OCR preprocess switch",
      debug: "Debug logging",
      advanced: "Advanced",
      save: "Save",
      reset: "Reset",
      saved: "Saved",
      saving: "Saving…",
      error: "Save failed",
      unavailable: "Settings namespace unavailable (vision-exp-tile not registered server-side?)",
      loading: "Loading…",
      ocrEngineAuto: "auto (prefer rapid, auto-degrade; default)",
      ocrEngineWindows: "windows (built-in, no install)",
      ocrEnginePaddle: "paddle (PaddleOCR, best for glowing/curved/game text)",
      ocrEngineRapid: "rapid (RapidOCR, lightweight)",
      ocrEngineGpu: "gpu (RapidOCR + GPU multi-device; needs rapid_gpu_venv)",
      gpuProvider: "GPU Provider",
      gpuProviderAuto: "auto (auto-select by device; default)",
      gpuProviderCuda: "cuda (NVIDIA, needs onnxruntime-gpu)",
      gpuProviderDml: "dml (DirectML, all vendors)",
      gpuProviderOpenvino: "openvino (Intel iGPU/Arc)",
      gpuProviderOff: "off (force CPU)",
      gpuPython: "GPU venv interpreter path",
      gpuDevice: "GPU device index",
      gpuFallback: "Fallback to CPU on GPU failure",
      preprocessAuto: "auto (dark-invert/binarize/handwrite enlarge; default)",
      preprocessOff: "off (disable preprocess)",
      preprocessAutoEnlargeOff: "auto-enlarge-off (auto + disable handwrite enlarge)",
      handwriteSmart: "smart (auto-detect; default)",
      handwriteVisual: "visual (route to vision API)",
      handwriteLocal: "local (on-device)",
      handwriteOff: "off (disable handwrite)",
      upgradeFull: "full (upgrade on low-conf/handwrite/dark; default)",
      upgradeLow: "low (upgrade only on low confidence)",
      upgradeOff: "off (disable auto upgrade)",
      formatPng: "png (lossless; default)",
      formatJpeg: "jpeg (smaller request body)",
      modeAuto: "auto (default)",
      modeSingle: "single (one request)",
      modeLayered: "layered (layered aggregation)",
      rotate0: "0°",
      rotate90: "90°",
      rotate180: "180°",
      rotate270: "270°",
    };

    // ── field spec（与 src/settings-schema.js 的 SETTINGS_FIELDS 一一对应）────
    // 每个字段：key / type / labelKey / advanced / options(可选)。options 里
    // 每项的 value=设置值、labelKey=字典键。
    var OPT = function (values, prefix) {
      return values.map(function (v) {
        return { value: v, labelKey: prefix + v };
      });
    };
    var FIELDS = [
      { key: "ocr_engine", type: "enum", labelKey: "ocrEngine", advanced: false, options: OPT(["Auto", "Windows", "Paddle", "Rapid", "Gpu"], "ocrEngine"), mapOptions: ["auto", "windows", "paddle", "rapid", "gpu"] },
      { key: "preprocess", type: "enum", labelKey: "preprocess", advanced: false, options: OPT(["Auto", "Off", "AutoEnlargeOff"], "preprocess"), mapOptions: ["auto", "off", "auto-enlarge-off"] },
      { key: "handwrite_route", type: "enum", labelKey: "handwriteRoute", advanced: false, options: OPT(["Smart", "Visual", "Local", "Off"], "handwrite"), mapOptions: ["smart", "visual", "local", "off"] },
      { key: "upgrade", type: "enum", labelKey: "upgrade", advanced: false, options: OPT(["Full", "Low", "Off"], "upgrade"), mapOptions: ["full", "low", "off"] },
      { key: "base_url", type: "text", labelKey: "baseUrl", advanced: false },
      { key: "model", type: "text", labelKey: "model", advanced: false },
      { key: "api_key_env", type: "text", labelKey: "apiKeyEnv", advanced: false },
      { key: "block_size", type: "number", labelKey: "blockSize", advanced: true },
      { key: "cut_threshold", type: "number", labelKey: "cutThreshold", advanced: true },
      { key: "overlap", type: "number", labelKey: "overlap", advanced: true },
      { key: "group_size", type: "number", labelKey: "groupSize", advanced: true },
      { key: "max_tokens", type: "number", labelKey: "maxTokens", advanced: true },
      { key: "timeout_ms", type: "number", labelKey: "timeoutMs", advanced: true },
      { key: "format", type: "enum", labelKey: "format", advanced: true, options: OPT(["Png", "Jpeg"], "format"), mapOptions: ["png", "jpeg"] },
      { key: "quality", type: "number", labelKey: "quality", advanced: true },
      { key: "mode", type: "enum", labelKey: "mode", advanced: true, options: OPT(["Auto", "Single", "Layered"], "mode"), mapOptions: ["auto", "single", "layered"] },
      { key: "json", type: "boolean", labelKey: "json", advanced: true },
      { key: "with_overview", type: "boolean", labelKey: "withOverview", advanced: true },
      { key: "out_dir", type: "text", labelKey: "outDir", advanced: true },
      { key: "rotate", type: "enum", labelKey: "rotate", advanced: true, options: OPT(["0", "90", "180", "270"], "rotate"), mapOptions: ["0", "90", "180", "270"] },
      { key: "interest_concurrency", type: "number", labelKey: "interestConcurrency", advanced: true },
      { key: "ocr_pool", type: "number", labelKey: "ocrPool", advanced: true },
      { key: "ocr_cache", type: "boolean", labelKey: "ocrCache", advanced: true },
      { key: "ocr_preproc", type: "boolean", labelKey: "ocrPreproc", advanced: true },
      // v0.4.0：GPU 多设备加速
      { key: "gpu_provider", type: "enum", labelKey: "gpuProvider", advanced: true, options: OPT(["Auto", "Cuda", "Dml", "Openvino", "Off"], "gpuProvider"), mapOptions: ["auto", "cuda", "dml", "openvino", "off"] },
      { key: "gpu_python", type: "text", labelKey: "gpuPython", advanced: true },
      { key: "gpu_device", type: "text", labelKey: "gpuDevice", advanced: true },
      { key: "gpu_fallback", type: "boolean", labelKey: "gpuFallback", advanced: true },
      { key: "debug", type: "boolean", labelKey: "debug", advanced: true },
    ];

    var FIELD_LABELS = {};
    FIELDS.forEach(function (f) { FIELD_LABELS[f.key] = f.labelKey; });

    // ── enum 显示值 ↔ 真实值 映射 ──────────────────────────────────────────
    // 字段里 options[i].value 是「显示值」（大写展示，如 "Auto"/"Paddle"），
    // mapOptions[i] 才是「真实值」（小写落盘，如 "auto"/"paddle"）。二者按下标一一对应。
    // 展示：给定存储/草稿里的真实值，反查显示选项下标；找不到回退第一项。
    function enumIndexForReal(f, realValue) {
      var rv = String(realValue ?? "");
      if (f.mapOptions) {
        for (var i = 0; i < f.mapOptions.length; i += 1) {
          if (String(f.mapOptions[i]) === rv) return i;
        }
      }
      if (f.options) {
        for (var j = 0; j < f.options.length; j += 1) {
          if (String(f.options[j].value) === rv) return j;
        }
      }
      return 0;
    }
    // 保存/onChange：显示值 → 真实值（找不到则原样返回，兼容自定义值）。
    function enumRealFromDisplay(f, displayValue) {
      var dv = String(displayValue ?? "");
      if (f.mapOptions && f.options) {
        for (var i = 0; i < f.options.length; i += 1) {
          if (String(f.options[i].value) === dv) return f.mapOptions[i];
        }
      }
      return dv;
    }
    // 保存：把真实值转成落盘值（数字枚举如 rotate 0/90/180/270 → number；其余字符串）。
    function enumSaveValue(f, realValue) {
      var rv = String(realValue ?? "");
      return /^\d+$/.test(rv) ? Number(rv) : rv;
    }

    function tOf(props) { return props.t; }

    // ── Section component ─────────────────────────────────────────────────
    function Section(props) {
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);

      react.useEffect(function () {
        // 兼容性：rc.2 的客户端 settingsScope 可能没有 load()（picturereader 3.0.6 同款防御）
        if (typeof scope.load === "function") scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); if (scope.dispose) scope.dispose(); };
      }, [scope]);
      react.useEffect(function () {
        if (ready) setDraft(function (prev) {
          var base = valueToDraft(snapshot.value);
          var merged = Object.assign({}, base);
          for (var k in prev) merged[k] = prev[k];
          return merged;
        });
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__vt_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__vt_status" }, t("loading"));

      var value = snapshot.value;

      function fieldDraft(f) {
        if (f.type === "boolean") return draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[f.key]);
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var n = Object.assign({}, prev); n[f.key] = v; return n; });
        setNotice(null); setError(null);
      }
      function fieldValue(f) {
        return draft[f.key] !== void 0 ? draft[f.key] : String(value[f.key] ?? "");
      }

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var ops = [];
        FIELDS.forEach(function (f) {
          if (f.type === "boolean") {
            ops.push({ op: "set", key: f.key, value: draft[f.key] !== void 0 ? !!draft[f.key] : Boolean(value[f.key]) });
            return;
          }
          var dv = fieldValue(f);
          if (f.type === "number") {
            var num = Number(dv);
            if (Number.isFinite(num)) ops.push({ op: "set", key: f.key, value: num });
            return;
          }
          var str = String(dv).trim();
          // enum：先把「显示值」归一化为「真实值」（小写落盘），再交给 enumSaveValue
          // 做数字枚举（rotate）的 number 化与字符串原样保留。
          if (f.type === "enum") {
            var realVal = enumRealFromDisplay(f, str);
            ops.push({ op: "set", key: f.key, value: enumSaveValue(f, realVal) });
            return;
          }
          if (str === "") { ops.push({ op: "unset", key: f.key }); return; }
          ops.push({ op: "set", key: f.key, value: str });
        });
        var writes = ops.map(function (o) {
          return o.op === "set" ? scope.set(o.key, o.value) : scope.unset(o.key);
        });
        Promise.all(writes).then(function () {
          setBusy(false); setNotice(t("saved"));
          if (scope.load) scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }
      function onReset() {
        setBusy(true);
        Promise.all(FIELDS.map(function (f) { return scope.unset(f.key); })).then(function () {
          setBusy(false); setNotice(t("saved"));
          setTimeout(function () {
            var fresh = scope.getSnapshot();
            if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
          }, 120);
        }).catch(function (e) { setBusy(false); setError(t("error") + ": " + String(e && e.message || e)); });
      }

      function renderField(f) {
        if (f.type === "boolean") {
          var checked = !!fieldDraft(f);
          return h("label", { key: f.key, className: "__vt_field" },
            h("span", { className: "__vt_row" },
              h("input", { className: "__vt_check", type: "checkbox", checked: checked, onChange: function (e) { setField(f, e.target.checked); } }),
              h("span", { className: "__vt_label" }, t(FIELD_LABELS[f.key]))
            )
          );
        }
        if (f.type === "enum") {
          // 用「真实值」反查显示下标：读到的存量配置是小写（如 'auto'），
          // 要显示对应的大写展示项（如 'Auto'）；无匹配时回退第一项。
          var idx = enumIndexForReal(f, fieldDraft(f));
          return h("label", { key: f.key, className: "__vt_field" },
            h("span", { className: "__vt_label" }, t(FIELD_LABELS[f.key])),
            h("select", {
              className: "__vt_select",
              value: String(f.options[idx].value),
              onChange: function (e) { setField(f, enumRealFromDisplay(f, e.target.value)); },
            }, f.options.map(function (o) {
              return h("option", { key: o.value, value: o.value }, t(o.labelKey));
            }))
          );
        }
        return h("label", { key: f.key, className: "__vt_field" },
          h("span", { className: "__vt_label" }, t(FIELD_LABELS[f.key])),
          h("input", {
            className: "__vt_input",
            type: f.type === "number" ? "number" : "text",
            value: fieldDraft(f),
            onChange: function (e) { setField(f, e.target.value); },
          })
        );
      }

      var primary = FIELDS.filter(function (f) { return !f.advanced; });
      var advanced = FIELDS.filter(function (f) { return f.advanced; });
      return h("div", { className: "__vt_root" },
        h("p", { className: "__vt_hint", style: { margin: "0 0 4px" } }, t("intro")),
        primary.map(renderField),
        advanced.length ? h("details", { className: "__vt_advanced" },
          h("summary", { className: "__vt_advancedSummary" },
            h("span", null, t("advanced")),
            h("span", { className: "__vt_advancedArrow" }, "\u25b8")
          ),
          advanced.map(renderField)
        ) : null,
        h("div", { className: "__vt_actions" },
          h("button", { type: "button", className: "__vt_btn __vt_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__vt_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__vt_status" }, notice) : null,
          busy ? h("span", { className: "__vt_status" }, t("saving")) : null,
          error ? h("span", { className: "__vt_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var ft = FIELDS[i];
        out[ft.key] = ft.type === "boolean" ? Boolean(value[ft.key]) : String(value[ft.key] ?? "");
      }
      return out;
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "vision-exp-tile: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "vision-exp-tile",
          order: 35,
          label: function () { return t("nav"); },
          locale: NS,
        }, function (props) {
          return h(Section, Object.assign({}, props, { scope: scope }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
