/**
 * items 层向量检索（第一层知识库语义化）。
 *
 * 模型/维度与构建脚本 `_vector/build-items.mjs` 完全一致：
 *   bge-small-zh-v1.5-q8 · 512 维 · pooling=mean · normalize=true
 * 嵌入口径同为 content + keywords + synonyms + questions + tags（向量空间必须与
 * items_vec 里已建好的向量同分布，改口径必须重建索引）。
 *
 * 降级策略（与附件层 arch 同款）：模型或运行时缺失/加载失败 → 调用方静默退回
 * 纯词法（FTS5 trigram + LIKE），手机/PC 未装模型的环境不受影响。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

let _pipe = null
let _pending = null
let _lastError = null

/** 模型目录：$DSH_HOME/work/Evelyn/_vector（与 build-items.mjs 同位置）。 */
export function vecDir() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'work', 'Evelyn', '_vector');
}

/** 模型与运行时是否齐备（任一缺失即不可用，调用方降级纯词法）。 */
export function vecAvailable() {
    try {
        const d = vecDir();
        return existsSync(join(d, 'model_quantized.onnx'))
            && existsSync(join(d, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'));
    }
    catch {
        return false;
    }
}

/** tags 列（JSON 数组字符串）→ 空格分隔文本。 */
export function tagsText(t) {
    if (!t)
        return '';
    try {
        const a = JSON.parse(t);
        return Array.isArray(a) ? a.join(' ') : String(t);
    }
    catch {
        return String(t);
    }
}

/** 嵌入口径：content + keywords + synonyms + questions + tags（与 build-items.mjs 一致）。 */
export function embedTextOf(item) {
    return [item.content, item.keywords, item.synonyms, item.questions, tagsText(item.tags)]
        .filter(Boolean).join(' | ');
}

/** 惰性加载并缓存 pipeline（模型加载 ~0.9s，每进程只发生一次）。 */
export async function extractor() {
    if (_pipe)
        return _pipe;
    if (_pending)
        return _pending;
    const d = vecDir();
    _pending = (async () => {
        const mod = await import(pathToFileURL(join(d, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')).href);
        mod.env.allowRemoteModels = false;
        mod.env.localModelPath = d;
        const p = await mod.pipeline('feature-extraction', 'model', { dtype: 'q8', device: 'cpu' });
        _pipe = p;
        return p;
    })().catch((e) => { _pending = null; _lastError = e; throw e; });
    return _pending;
}

/** 最近一次加载失败原因（降级时可写日志）。 */
export function lastError() { return _lastError; }

/** 文本 → 归一化 512 维向量。 */
export async function embed(text) {
    const p = await extractor();
    const out = await p(String(text), { pooling: 'mean', normalize: true });
    return Float32Array.from(out.data);
}

/** BLOB → Float32Array。 */
export function toVec(buf) {
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** 点积（向量已归一化 → 即余弦相似度）。 */
export function dot(a, b) {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        s += a[i] * b[i];
    return s;
}

/** RRF 融合多榜（每榜 [{id, rank}]，rank 从 1 起）；K=60 与 _vector/search.mjs 同参。 */
export function rrfFuse(lists, K = 60) {
    const agg = new Map();
    for (const list of lists) {
        if (!list)
            continue;
        for (let i = 0; i < list.length; i++) {
            const { id } = list[i];
            agg.set(id, (agg.get(id) || 0) + 1 / (K + i + 1));
        }
    }
    return [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
}
