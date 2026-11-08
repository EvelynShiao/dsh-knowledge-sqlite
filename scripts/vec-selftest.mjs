/**
 * 向量运行时自检：加载本地 bge-small-zh-v1.5 q8 并嵌入一条测试文本，
 * 校验 512 维 + L2 归一化 → PASS(exit 0) / FAIL(exit 1)。
 *
 * 用法：node scripts/vec-selftest.mjs [vecDir]
 *   vecDir 缺省 = $DSH_HOME/work/Evelyn/_vector（与 lib/vec.js vecDir() 同逻辑）
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = process.argv[2] || process.env.VECDIR
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'work', 'Evelyn', '_vector')

const t0 = Date.now()
try {
    const mod = await import(pathToFileURL(join(dir, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')).href)
    mod.env.allowRemoteModels = false
    mod.env.localModelPath = dir
    const t1 = Date.now()
    const p = await mod.pipeline('feature-extraction', 'model', { dtype: 'q8', device: 'cpu' })
    const t2 = Date.now()
    const out = await p('知识库向量自检：这条文本应产出 512 维归一化向量', { pooling: 'mean', normalize: true })
    const v = Float32Array.from(out.data)
    const t3 = Date.now()
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n)
    const ok = v.length === 512 && Math.abs(n - 1) < 1e-3
    console.log(`运行时 import: ${t1 - t0}ms | pipeline 加载: ${t2 - t1}ms | 推理: ${t3 - t2}ms`)
    console.log(`维度=${v.length} L2=${n.toFixed(4)} → ${ok ? 'PASS ✅ 向量层可用' : 'FAIL ❌ 输出不符预期'}`)
    process.exit(ok ? 0 : 1)
} catch (e) {
    console.error(`FAIL ❌ ${dir}`)
    console.error(String(e?.message || e).slice(0, 400))
    console.error('提示：①确认 node ≥18；②glibc 环境（proot Linux）才能加载 onnxruntime-node 预编译，Termux 原生(bionic)不支持；③重新执行 install-vec-runtime 脚本补齐文件。')
    process.exit(1)
}
