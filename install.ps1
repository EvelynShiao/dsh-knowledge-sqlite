param([string]$DshHome = (Join-Path $env:LOCALAPPDATA "DeepSeekHarness\.dsh"))
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$dst = Join-Path $DshHome "profiles\web\node_modules\dsh-knowledge-sqlite"
if (-not (Test-Path $dst)) { throw "找不到插件目录: $dst" }

$bak = "$dst.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
Copy-Item -Recurse -Force $dst $bak
Write-Host "已备份 -> $bak"

foreach ($item in @("lib","package.json","cordis.patch.yml","README.md","CHANGELOG.md","LICENSE")) {
  $s = Join-Path $src $item
  if (Test-Path $s) {
    Copy-Item -Recurse -Force $s (Join-Path $dst $item)
    Write-Host "已更新 -> $item"
  }
}

if (-not (Test-Path (Join-Path $dst "lib\index.js"))) { throw "lib/index.js 缺失，安装未完成" }
Write-Host ""
Write-Host "完成。请重启 DSH 使插件重载。" -ForegroundColor Green
