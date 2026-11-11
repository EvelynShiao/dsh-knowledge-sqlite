#!/usr/bin/env bash
# dsh-knowledge-sqlite — 向量运行时一键安装（Linux / Android proot / PC Linux）
#
# 装什么：$DSH_HOME/work/Evelyn/_vector 下
#   ① @huggingface/transformers（npm，默认 npmmirror 源）
#   ② bge-small-zh-v1.5 q8 模型（hf-mirror，~24MB）
#   ③ 根目录 model_quantized.onnx 副本（lib/vec.js vecAvailable() 的检查位）
# 然后跑 scripts/vec-selftest.mjs 自检（512 维、L2≈1.0 判 PASS）。
#
# 幂等：已存在的文件/包自动跳过，可重复执行。
# 环境变量：DSH_HOME（默认 ~/.dsh）、NPM_REGISTRY（默认 npmmirror）、HF_ENDPOINT（默认 hf-mirror）。
#
# 已知边界：onnxruntime-node 预编译二进制为 glibc Linux arm64/x64——
#   Termux 原生环境（bionic libc）加载不了，请在 proot-distro（Ubuntu/Debian 等）内运行本脚本；
#   自检 FAIL 时脚本会如实报告，词法检索不受影响。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
V="$DSH_HOME/work/Evelyn/_vector"
REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
HF="${HF_ENDPOINT:-https://hf-mirror.com}"
REPO="Xenova/bge-small-zh-v1.5"

echo "目标目录: $V"
command -v node >/dev/null 2>&1 || { echo "❌ 未找到 node（向量运行时需要 Node.js ≥ 18）"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "❌ 未找到 npm"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ 未找到 curl"; exit 1; }
echo "node $(node --version) / npm $(npm --version)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "❌ node 版本过低（需 ≥18，当前 $(node --version)）"; exit 1; }

mkdir -p "$V/model/onnx"

echo ""
echo "① 安装 @huggingface/transformers ..."
if [ -f "$V/node_modules/@huggingface/transformers/dist/transformers.node.mjs" ]; then
    echo "   已存在，跳过"
else
    [ -f "$V/package.json" ] || (cd "$V" && npm init -y >/dev/null)
    npm install --prefix "$V" --registry="$REGISTRY" --no-audit --no-fund @huggingface/transformers
fi

echo ""
echo "② 下载模型（$REPO q8，约 24MB）..."
# dl <远程路径> <本地相对路径> <最小字节数>——min 防镜像错误页。
# 注意：远程路径按 HF 仓库真实结构（根下 config.json + onnx/），本地路径按 vec.js 的
# transformers 加载约定（localModelPath/model/...，模型名 'model'）——两者解耦，别合并。
# 2026-11-11：HF 迁移 xethub 后镜像不再兼容 model/ 前缀的远程路径（404），据此拆分。
dl() {
    local remote="$1" rel="$2" min="$3" f="$V/$rel"
    if [ -s "$f" ] && { [ "$min" -le 0 ] || [ "$(wc -c < "$f")" -ge "$min" ]; }; then
        echo "   已存在: $rel"; return 0
    fi
    curl -fsSL --retry 3 --max-time 600 -o "$f" "$HF/$REPO/resolve/main/$remote"
    local sz; sz=$(wc -c < "$f")
    if [ "$min" -gt 0 ] && [ "$sz" -lt "$min" ]; then
        rm -f "$f"
        echo "   ❌ $rel 大小异常（${sz}B < ${min}B，疑似镜像错误页），已删除"; return 1
    fi
    echo "   完成: $rel (${sz}B)"
}
dl config.json model/config.json 500
dl tokenizer.json model/tokenizer.json 100000
dl tokenizer_config.json model/tokenizer_config.json 100
dl onnx/model_quantized.onnx model/onnx/model_quantized.onnx 20000000

echo ""
echo "③ 根目录权重副本（vecAvailable 检查位）..."
cp -f "$V/model/onnx/model_quantized.onnx" "$V/model_quantized.onnx"
echo "   OK"

echo ""
echo "④ 自检 ..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/scripts/vec-selftest.mjs" "$V"
