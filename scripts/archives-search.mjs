/**
 * 档案深搜脚本（第二层·对话档案的向量+词法混合检索）。
 *
 * 历史：原版 2026-10-06 随 archives_search 工具（commit 221d4d2）落地于
 * .dsh/archives-search/search.mjs，但该目录不随 dsh-sync 备份组走，机器上丢失后
 * 检索静默降级纯词法（2026-11-10 由会话 transcript + lib/vec.js 嵌入口径 + lib/tools.js
 * 输出契约重建）。权威副本存本仓 scripts/archives-search.mjs，装机位置
 * $DSH_HOME/archives-search/search.mjs（lib/tools.js spawn 调用）。
 *
 * 用法: node search.mjs <query>
 *   env: ARCH_TOPK  返回条数（默认 5，1-20）
 *        ARCH_BRIEF 1=只回坐标+120字预览（省上下文）
 * 输出: stdout 单个 JSON：
 *   { query, mode:'hybrid'|'lexical-fallback', hits, results:[{score,semantic,conv,file,
 *     path,title,part,msgs,lines,speakers,text}], degraded? }
 * 口径（与插件 lib/vec.js、arch_meta 完全一致）：
 *   bge-small-zh-v1.5-q8 · 512 维 · pooling=mean · normalize=true · RRF K=60
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DSH = process.env.DSH_HOME || 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh';
const DB = join(DSH, 'knowledge.sqlite');
const VEC = join(DSH, 'work', 'Evelyn', '_vector');
const q = String(process.argv[2] ?? '').trim();
const topk = Math.min(Math.max(Number(process.env.ARCH_TOPK) || 5, 1), 20);
const brief = process.env.ARCH_BRIEF === '1';

const db = new DatabaseSync(DB, { readOnly: true });

/* —— 词法榜：FTS5 trigram（先精确短语，再分词 AND，最后 LIKE 兜底）—— */
function lexical() {
  let rows = [];
  try {
    rows = db.prepare('SELECT rowid AS id FROM arch_fts WHERE arch_fts MATCH ? LIMIT ?')
      .all(`"${q.replaceAll('"', ' ')}"`, topk * 4);
  } catch { /* 查询不合 FTS 语法 → 走 LIKE */ }
  if (!rows.length) {
    try {
      rows = db.prepare('SELECT rowid AS id FROM arch_fts WHERE arch_fts MATCH ? LIMIT ?')
        .all(q.replaceAll('"', ' '), topk * 4);
    } catch { /* 仍不合语法 → LIKE */ }
  }
  if (!rows.length) {
    rows = db.prepare('SELECT id FROM arch_chunks WHERE text LIKE ? LIMIT ?').all(`%${q}%`, topk * 4);
  }
  return rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
}

/* —— 向量榜：查询向量 × arch_vec 全表余弦（向量已归一化，点积即余弦）—— */
async function vector() {
  const mod = await import(pathToFileURL(join(VEC, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')).href);
  mod.env.allowRemoteModels = false;
  mod.env.localModelPath = VEC;
  const pipe = await mod.pipeline('feature-extraction', 'model', { dtype: 'q8', device: 'cpu' });
  const out = await pipe(q, { pooling: 'mean', normalize: true });
  const qv = Float32Array.from(out.data);
  const rows = db.prepare('SELECT id, vec FROM arch_vec').all();
  const scored = [];
  for (const r of rows) {
    const ab = r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength);
    const v = new Float32Array(ab);
    let s = 0;
    const n = Math.min(qv.length, v.length);
    for (let i = 0; i < n; i++) s += qv[i] * v[i];
    scored.push({ id: r.id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topk * 4).map((r, i) => ({ id: r.id, rank: i + 1, score: r.score }));
}

/* —— RRF 融合（K=60，与 lib/vec.js rrfFuse 同参）—— */
function rrfFuse(lists) {
  const agg = new Map();
  for (const list of lists) {
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      const { id } = list[i];
      agg.set(id, (agg.get(id) || 0) + 1 / (60 + i + 1));
    }
  }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, topk).map(([id, score]) => ({ id, score }));
}

const sel = db.prepare('SELECT conv, file, title, partner, part, msg_from, msg_to, line_from, line_to, speakers, text FROM arch_chunks WHERE id = ?');
function hydrate(id, score, semantic) {
  const c = sel.get(id);
  if (!c) return null;
  return {
    score: Number(score.toFixed(5)),
    semantic: Number((semantic ?? 0).toFixed(4)),
    conv: c.conv,
    file: c.file,
    path: '聊天记录/' + c.file,
    title: c.title,
    part: c.part,
    msgs: `${c.msg_from}-${c.msg_to}`,
    lines: `${c.line_from}-${c.line_to}`,
    speakers: c.speakers,
    text: brief ? c.text.slice(0, 120) + '…' : (c.text.length > 900 ? c.text.slice(0, 900) + '…' : c.text),
  };
}

let mode = 'hybrid';
let degraded;
let ranked;
try {
  const lex = q ? lexical() : [];
  const vec = q ? await vector() : [];
  ranked = rrfFuse([lex, vec]);
  const semById = new Map(vec.map((v) => [v.id, v.score]));
  const results = ranked
    .map((r) => hydrate(r.id, r.score, semById.get(r.id) ?? 0))
    .filter(Boolean);
  console.log(JSON.stringify({ query: q, mode, hits: results.length, results }));
} catch (error) {
  /* 向量侧任何失败（运行时缺失/加载失败/手机端）→ 静默退纯词法，degraded 注明原因 */
  mode = 'lexical-fallback';
  degraded = String(error?.message ?? error).slice(0, 200);
  const results = (q ? rrfFuse([lexical()]) : [])
    .map((r) => hydrate(r.id, r.score, 0))
    .filter(Boolean);
  console.log(JSON.stringify({ query: q, mode, hits: results.length, results, degraded }));
}
