# install-to-web-profile.ps1 — 测试通过后，把 vision-exp-tile 正式挂载到 web profile
#
# 说明：本脚本默认【只准备不执行】（-Apply 参数才真正修改正式 profile）。
#   1) 备份 profiles/web/package.json → package.json.bak-vision-exp-tile
#   2) 在 dsh.profile.bundles 中追加 "vision-exp-tile"（若不存在）
#   3) 在 dependencies 中追加 link: 依赖（若不存在）
#   4) 创建 profiles/web/node_modules/vision-exp-tile junction
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-to-web-profile.ps1            # 预览
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-to-web-profile.ps1 -Apply      # 执行
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-to-web-profile.ps1 -Rollback   # 回滚
# ---------------------------------------------------------------------------

param(
    [switch]$Apply,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dshHome     = Join-Path $env:USERPROFILE '.dsh'
$webPkg      = Join-Path $dshHome 'profiles\web\package.json'
$bakPkg      = "$webPkg.bak-vision-exp-tile"
$pluginJunction = Join-Path $dshHome 'plugins\vision-exp-tile'

function Get-WebProfile() {
    if (-not (Test-Path $webPkg)) { throw "未找到 $webPkg" }
    Get-Content $webPkg -Raw | ConvertFrom-Json
}

if ($Rollback) {
    # —— 回滚：从备份还原 package.json 并删除 junction ——
    if (Test-Path $bakPkg) {
        Copy-Item $bakPkg $webPkg -Force
        Write-Host "[OK] 已从备份还原 package.json" -ForegroundColor Green
    } else {
        Write-Host "[WARN] 无备份文件，未还原 package.json" -ForegroundColor Yellow
    }
    $nmLink = Join-Path (Join-Path $dshHome 'profiles\web\node_modules') 'vision-exp-tile'
    if (Test-Path $nmLink) { Remove-Item $nmLink -Recurse -Force; Write-Host "[OK] 已删除 node_modules\vision-exp-tile" }
    Write-Host "回滚完成。请重启 DSH 生效。"
    exit 0
}

$profile = Get-WebProfile
$bundles = @($profile.dsh.profile.bundles)
$deps = @{}
$profile.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value }
$changed = $false

if ($bundles -notcontains 'vision-exp-tile') {
    $bundles += 'vision-exp-tile'
    Write-Host "[预览] bundles 将追加 vision-exp-tile" -ForegroundColor Cyan
    $changed = $true
} else { Write-Host "[OK] bundles 已包含 vision-exp-tile" }

if (-not $deps.ContainsKey('vision-exp-tile')) {
    $deps['vision-exp-tile'] = 'link:C:/Users/HP/.dsh/plugins/vision-exp-tile'
    Write-Host "[预览] dependencies 将追加 vision-exp-tile -> link:C:/Users/HP/.dsh/plugins/vision-exp-tile" -ForegroundColor Cyan
    $changed = $true
} else { Write-Host "[OK] dependencies 已包含 vision-exp-tile" }

if (-not (Test-Path $pluginJunction)) {
    Write-Host "[预览] 将创建插件 junction: $pluginJunction" -ForegroundColor Cyan
}

if (-not $Apply) {
    Write-Host "`n（预览模式：加 -Apply 执行；加 -Rollback 回滚）"
    exit 0
}

# —— 执行 ——
Copy-Item $webPkg $bakPkg -Force
$newPkg = [ordered]@{
    name = $profile.name
    private = $profile.private
    dsh = [ordered]@{ profile = [ordered]@{ bundles = $bundles } }
    dependencies = $deps
}
$newPkg | ConvertTo-Json -Depth 10 | Set-Content $webPkg -Encoding UTF8
Write-Host "[OK] 已备份原 package.json -> $bakPkg"
Write-Host "[OK] 已写入新 package.json"

if (-not (Test-Path $pluginJunction)) {
    New-Item -ItemType Junction -Path $pluginJunction -Target $projectRoot | Out-Null
    Write-Host "[OK] 插件 junction 已创建"
}
New-Item -ItemType Directory -Path (Join-Path $dshHome 'profiles\web\node_modules') -Force | Out-Null
$nmLink = Join-Path (Join-Path $dshHome 'profiles\web\node_modules') 'vision-exp-tile'
if (-not (Test-Path $nmLink)) {
    New-Item -ItemType Junction -Path $nmLink -Target $projectRoot | Out-Null
    Write-Host "[OK] node_modules\vision-exp-tile junction 已创建"
}
Write-Host "`n完成。重启 DSH 后生效。回滚：-Rollback"
