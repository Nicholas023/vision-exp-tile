# run-test-profile.ps1 — 隔离测试环境一键脚本（vision-test profile，端口 3081）
#
# 作用：
#   1) 校验/重建 ~/.dsh/profiles/vision-test 与插件 junction（幂等）
#   2) dump-config 验证方案挂载
#   3) 启动隔离 GUI 实例（默认 http://127.0.0.1:3081，与正式 3080 无冲突）
#   4) 退出时提示如何清理测试环境（不影响正式 web profile）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\run-test-profile.ps1
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

# 项目根（本脚本位于项目 scripts/ 目录下）
$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginDir   = $projectRoot
$dshHome     = Join-Path $env:USERPROFILE '.dsh'
$profileDir  = Join-Path $dshHome 'profiles\vision-test'
$port        = 3081

Write-Host "== [1/4] 插件 junction: $dshHome\plugins\vision-exp-tile" -ForegroundColor Cyan
$pluginJunction = Join-Path $dshHome 'plugins\vision-exp-tile'
if (-not (Test-Path $pluginJunction)) {
    New-Item -ItemType Junction -Path $pluginJunction -Target $pluginDir | Out-Null
    Write-Host "  创建 junction -> $pluginDir"
} else {
    Write-Host "  已存在"
}

Write-Host "== [2/4] profile: $profileDir" -ForegroundColor Cyan
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Write-Host "  目录已创建（插件通过 package.json 的 dsh.bundle.patch 指向 cordis.patch.yml 挂载，请确认该 patch 已被 profile 加载）"
} else {
    Write-Host "  已存在"
}
$nmLink = Join-Path $profileDir 'node_modules\vision-exp-tile'
if (-not (Test-Path $nmLink)) {
    New-Item -ItemType Directory -Path (Join-Path $profileDir 'node_modules') -Force | Out-Null
    New-Item -ItemType Junction -Path $nmLink -Target $pluginDir | Out-Null
    Write-Host "  node_modules\vision-exp-tile junction -> $pluginDir"
}

Write-Host "== [3/4] dump-config 验证挂载（应出现 vision-exp-tile 行）" -ForegroundColor Cyan
$dump = dsh --profile vision-test --dump-config 2>&1 | Out-String
if ($dump -match 'id: vision-exp-tile') {
    Write-Host "  [OK] vision-exp-tile 已挂载" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] 未发现 vision-exp-tile 行，请检查 cordis.patch.yml / bundles" -ForegroundColor Red
    exit 1
}

Write-Host "== [4/4] 启动隔离实例：http://127.0.0.1:$port" -ForegroundColor Cyan
Write-Host "  （Ctrl+C 停止；正式 web profile 不受影响）"
# 正确形态：--profile 是 dsh 父级选项，web 别名不可与 --profile 混用；--port 作为参数随 profile 启动传给 app。
dsh --profile vision-test --port $port

# 清理说明（脚本结束后向用户展示）
Write-Host ""
Write-Host "隔离测试环境说明：
- 测试会话与正式会话共用 ~/.dsh（模型配置/密钥直接可用）
- 彻底清理：删除 $profileDir 与 $pluginJunction 即可，正式 web profile 零改动"
