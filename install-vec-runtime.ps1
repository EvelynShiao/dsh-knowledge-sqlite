# dsh-knowledge-sqlite — 向量运行时一键安装（Windows）
#
# 用途：$DSH_HOME/work/Evelyn/_vector 丢失（重装/清理 .dsh）后一键重建：
#   ① npm 安装 @huggingface/transformers（默认 npmmirror 源）
#   ② hf-mirror 下载 bge-small-zh-v1.5 q8 模型（~24MB）
#   ③ 根目录 model_quantized.onnx 副本（lib/vec.js vecAvailable() 的检查位）
#   ④ 跑 scripts/vec-selftest.mjs 自检（512 维、L2≈1.0 判 PASS）
# 幂等：已存在的文件/包自动跳过。DSH 无需重启——向量层惰性加载，装完即生效。
param()
$ErrorActionPreference = "Stop"

$HomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:LOCALAPPDATA "DeepSeekHarness\.dsh" }
$V = Join-Path $HomeDir "work\Evelyn\_vector"
$Registry = if ($env:NPM_REGISTRY) { $env:NPM_REGISTRY } else { "https://registry.npmmirror.com" }
$HF = if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT } else { "https://hf-mirror.com" }
$Repo = "Xenova/bge-small-zh-v1.5"

Write-Host "目标目录: $V"
foreach ($cmd in @("node", "npm", "curl.exe")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "未找到 $cmd" }
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 18) { throw "node 版本过低（需 >=18，当前 $(node --version)）" }

New-Item -ItemType Directory -Force -Path (Join-Path $V "model\onnx") | Out-Null

Write-Host ""
Write-Host "① 安装 @huggingface/transformers ..."
if (Test-Path (Join-Path $V "node_modules\@huggingface\transformers\dist\transformers.node.mjs")) {
    Write-Host "   已存在，跳过"
} else {
    if (-not (Test-Path (Join-Path $V "package.json"))) { Push-Location $V; npm init -y | Out-Null; Pop-Location }
    npm install --prefix $V --registry $Registry --no-audit --no-fund "@huggingface/transformers"
}

Write-Host ""
Write-Host "② 下载模型（$Repo q8，约 24MB）..."
# Get-Model <远程路径> <本地相对路径> <最小字节数>——min 防镜像错误页。
# 注意：远程路径按 HF 仓库真实结构（根下 config.json + onnx/），本地路径按 vec.js 的
# transformers 加载约定（localModelPath/model/...，模型名 'model'）——两者解耦，别合并。
# 2026-11-11：HF 迁移 xethub 后镜像不再兼容 model/ 前缀的远程路径（404），据此拆分。
function Get-Model([string]$remote, [string]$rel, [long]$min) {
    $f = Join-Path $V ($rel -replace "/", "\")
    if ((Test-Path $f) -and ((Get-Item $f).Length -ge $min)) { Write-Host "   已存在: $rel"; return }
    curl.exe -fsSL --retry 3 --max-time 600 -o $f "$HF/$Repo/resolve/main/$remote"
    if ($LASTEXITCODE -ne 0) { if (Test-Path $f) { Remove-Item $f -Force }; throw "下载失败: $rel" }
    $sz = (Get-Item $f).Length
    if ($sz -lt $min) { Remove-Item $f -Force; throw "大小异常: $rel（$sz B < $min B，疑似镜像错误页），已删除" }
    Write-Host ("   完成: {0} ({1}B)" -f $rel, $sz)
}
Get-Model "config.json" "model/config.json" 500
Get-Model "tokenizer.json" "model/tokenizer.json" 100000
Get-Model "tokenizer_config.json" "model/tokenizer_config.json" 100
Get-Model "onnx/model_quantized.onnx" "model/onnx/model_quantized.onnx" 20000000

Write-Host ""
Write-Host "③ 根目录权重副本（vecAvailable 检查位）..."
Copy-Item -Force (Join-Path $V "model\onnx\model_quantized.onnx") (Join-Path $V "model_quantized.onnx")
Write-Host "   OK"

Write-Host ""
Write-Host "④ 自检 ..."
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $ScriptDir "scripts\vec-selftest.mjs") $V
if ($LASTEXITCODE -ne 0) { throw "自检未通过（见上方输出）" }
Write-Host ""
Write-Host "全部完成。向量层即刻生效（DSH 无需重启）。" -ForegroundColor Green
