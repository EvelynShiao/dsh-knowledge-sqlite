/**
 * dsh-knowledge-sqlite — model-facing tools（knowledge_*）+ 验证工具（knowledge_probe）。
 *
 * 契约与 V1.11 一致：
 *  - 打标字段不在参数里（工具层所有权：服务从执行上下文派生）
 *  - write/delete 的 ask 门控在 index.ts（tools/pre-execute）
 *  - knowledge_probe 为实验套件 e2e 载体（阶段 3 验收门禁）
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const execFileAsync = promisify(execFile);
const renderJson = (_args, value) => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
];
export function registerKnowledgeTools(ctx, service) {
    ctx.tools.register(defineTool({
        name: 'knowledge_write',
        description: '写入一条跨会话知识（V1.11 契约）。写入即入 SQLite FTS5 trigram 词法索引 + 向量索引，零 LLM，立即可检索。'
            + '跨会话持久变更：受 ask 门控（需要用户确认）。dedupeKey 相同则 upsert（id 不变）。'
            + 'scope=global 需要 allowedGlobalWriters 成员资格；scope=session 为会话私有草稿。'
            + '回执带 vectorized：true=词法+向量都已入索引；false=仅词法（向量层不可用，属正常降级，可用 knowledge_vec 复查）。',
        parameters: {
            content: { type: 'string', required: true, description: '知识正文（maxContentTokens 超限 write-rejected）' },
            scope: { type: 'string', enum: ['workspace', 'session', 'global'], description: '默认 workspace' },
            dedupeKey: { type: 'string', description: 'upsert 键；唯一性 (workspace, scope, dedupeKey)；写后不可变' },
            importance: { type: 'number', description: '1-10，默认 5' },
            tags: { type: 'json', description: '标签数组' },
            ttl: { type: 'number', description: 'TTL 秒数；过期条目从检索过滤，list 标记 expired' },
            source: { type: 'json', description: '溯源 { sessionId, seq }' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            return service.write({
                content: args.content,
                scope: args.scope,
                dedupeKey: args.dedupeKey,
                importance: args.importance,
                ttl: args.ttl,
                tags: Array.isArray(args.tags) ? args.tags : undefined,
                source: args.source,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_update',
        description: '修正一条知识的内容/字段（V1.11 契约）。保留 id/溯源/打标；scope 与 dedupeKey 写后不可变。',
        parameters: {
            id: { type: 'string', required: true, description: '知识条目 id' },
            content: { type: 'string', description: '新正文（更新后标记 needsEnrichment）' },
            importance: { type: 'number', description: '1-10' },
            tags: { type: 'json', description: '标签数组' },
            ttl: { type: 'number', description: 'TTL 秒数；null 清除' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            return service.update({
                id: args.id,
                content: args.content,
                importance: args.importance,
                ttl: args.ttl,
                tags: Array.isArray(args.tags) ? args.tags : undefined,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_search',
        description: '检索跨会话知识（V1.11 契约）。SQLite FTS5 trigram（中文子串）+ BM25；默认 L1 查询扩展'
            + '（一次小模型调用，按归一化查询缓存，超时降级 degraded:"lexical" 而非报错）。'
            + 'expand:false 或传 variants 跳过扩展调用。命中带 provenance（original/enriched）与 authorTier。',
        parameters: {
            query: { type: 'string', required: true, description: '查询文本（中文子串 ≥3 字符可命中）' },
            scope: { type: 'string', enum: ['workspace', 'session', 'global', 'all'], description: '过滤范围' },
            expand: { type: 'boolean', description: 'L1 查询扩展，默认 true' },
            variants: { type: 'json', description: '调用方提供的扩展变体（跳过扩展调用）' },
            tags: { type: 'json', description: '按标签过滤的数组（任一命中即通过），如 ["自然科学/物理"]' },
            budget: { type: 'json', description: '{ maxItems?, maxTokens? } 预算截断' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args, exec) {
            const result = await service.search(args.query, {
                scope: args.scope,
                expand: args.expand,
                variants: Array.isArray(args.variants) ? args.variants : undefined,
                tags: Array.isArray(args.tags) ? args.tags : undefined,
                budget: args.budget,
                signal: exec.signal,
            });
            return result;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_list',
        description: '列出/审计知识条目（V1.11 契约）。游标分页（新条目在前）；过期条目带 expired:true；'
            + '删除条目需要 includeDeleted。',
        parameters: {
            scope: { type: 'string', enum: ['workspace', 'session', 'global', 'all'], description: '过滤范围，默认 all' },
            cursor: { type: 'string', description: '分页游标' },
            limit: { type: 'number', description: '每页条数，默认 50，上限 200' },
            includeDeleted: { type: 'boolean', description: '包含已删除条目' },
            includeExpired: { type: 'boolean', description: '包含过期条目（默认不含）' },
            tags: { type: 'json', description: '按标签过滤的数组（任一命中即通过）' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            const result = await service.list((args.scope ?? 'all'), args);
            return result;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_delete',
        description: '删除一条知识（V1.11 契约）。tombstone（搜索过滤、list 可见带 deleted:true）。'
            + '跨会话持久变更：受 ask 门控。过期条目 delete 返回 false。',
        parameters: {
            id: { type: 'string', required: true, description: '知识条目 id' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            return service.delete(args.id);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_tags',
        description: '浏览知识库的标签目录树（图书馆式逐层翻阅）。标签按 "/" 作为路径分隔符，'
            + '如 "自然科学/物理/量子科学"。prefix 空串 = 顶层；传上一层路径即列出其下一层。'
            + '返回每个节点的条目数（count）与本节点直接条目数（items）。平时不占上下文，需要翻目录时才调。',
        parameters: {
            prefix: { type: 'string', description: '上一层路径，空串或不传 = 顶层' },
            scope: { type: 'string', enum: ['workspace', 'session', 'global', 'all'], description: '过滤范围，默认 all' },
            limit: { type: 'number', description: '最多返回节点数，默认 200' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            return service.listTags({
                prefix: args.prefix,
                scope: args.scope,
                limit: args.limit,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_vec',
        description: '知识库向量层自检与回填。mode=check 只列出「有词法、无向量」的条目（可语义检索的缺口）；'
            + 'mode=backfill 逐个重嵌补齐。向量层不可用时（无模型/无表）返回 available:false —— 此时整库走纯词法，'
            + '属正常降级，不是错误。写入已保证「写完即向量化」，此工具用于历史遗留缺口的发现与修复。',
        parameters: {
            mode: { type: 'string', required: true, enum: ['check', 'backfill'], description: 'check=只查缺口；backfill=修复缺口' },
            limit: { type: 'number', description: '最多处理条数，默认 500，上限 5000' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            return service.vecMaintenance(args.mode, { limit: args.limit });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'knowledge_probe',
        description: '实验套件验证工具（阶段 3 门禁）：seed 装载 memory-experiment 语料，评估 hard/human 查询集'
            + ' A/C/D/L1-live 臂 recall@1 与 precision@1（信息性），human 套件含 none 查询无误报检查，跑契约检查。'
            + 'suite: seed|hard|human|contract|all',
        parameters: {
            suite: { type: 'string', required: true, enum: ['seed', 'hard', 'human', 'contract', 'latency', 'variance', 'all'], description: '验证阶段' },
            fresh: { type: 'boolean', description: '清空 L1 扩展缓存后执行（单轮独立扩展）' },
            runs: { type: 'number', description: 'variance 套件的运行轮数，默认 10（每轮清缓存独立扩展）' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            const result = await service.probe(args.suite, { fresh: args.fresh === true, runs: typeof args.runs === 'number' ? args.runs : 10 });
            return result;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'archives_search',
        description: '完整版聊天档案深搜（词法 trigram + 本地向量语义混合，RRF 融合）。knowledge_search 返回的是蒸馏卡片（"大概"）；'
            + '当需要原始对话的细节、原话、上下文时用本工具——查询换一种说法也能命中（向量语义）。'
            + '返回原文段落 + 出处（对话/文件/消息范围/说话人）。仅 PC 端有向量能力，其他端自动降级词法。',
        parameters: {
            query: { type: 'string', required: true, description: '查询（自然语言，可换说法）' },
            topk: { type: 'number', description: '返回条数，默认 5，最大 20' },
            brief: { type: 'boolean', description: '只回坐标+120字预览（省上下文），默认 false 返回全文片段' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args) {
            const dshHome = process.env.DSH_HOME || 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh';
            const script = join(dshHome, 'archives-search', 'search.mjs');
            const topk = Math.min(Math.max(Number(args.topk) || 5, 1), 20);
            const q = String(args.query ?? '');
            try {
                const { stdout } = await execFileAsync(process.execPath, [script, q], {
                    env: { ...process.env, ARCH_TOPK: String(topk), ARCH_BRIEF: args.brief === true ? "1" : "0" },
                    timeout: 90000,
                    maxBuffer: 16 * 1024 * 1024,
                    windowsHide: true,
                });
                return JSON.parse(stdout);
            } catch (error) {
                // 向量运行时缺失（如手机端）→ 进程内词法兜底，零外部依赖
                const { DatabaseSync } = await import('node:sqlite');
                const db = new DatabaseSync(join(dshHome, 'knowledge.sqlite'), { readOnly: true });
                try {
                    let rows = [];
                    try {
                        rows = db.prepare(`SELECT rowid AS id FROM arch_fts WHERE arch_fts MATCH ? LIMIT ?`).all(`"${q.replaceAll('"', ' ')}"`, topk);
                    } catch { /* 查询不合 FTS 语法 → LIKE 兜底 */ }
                    if (!rows.length) rows = db.prepare(`SELECT id FROM arch_chunks WHERE text LIKE ? LIMIT ?`).all(`%${q}%`, topk);
                    const sel = db.prepare(`SELECT conv, file, title, part, msg_from, msg_to, line_from, line_to, speakers, text FROM arch_chunks WHERE id = ?`);
                    const results = rows.map((r, i) => {
                        const c = sel.get(r.id);
                        return { score: Number((1 / (60 + i + 1)).toFixed(5)), semantic: 0, conv: c.conv, file: c.file, path: '聊天记录/' + c.file, title: c.title, part: c.part, msgs: `${c.msg_from}-${c.msg_to}`, lines: `${c.line_from}-${c.line_to}`, speakers: c.speakers, text: args.brief === true ? c.text.slice(0, 120) + '…' : (c.text.length > 900 ? c.text.slice(0, 900) + '…' : c.text) };
                    });
                    return { query: q, mode: 'lexical-fallback', hits: results.length, results, degraded: String(error && error.message || error).slice(0, 120) };
                } finally { db.close(); }
            }
        },
    }));
}
