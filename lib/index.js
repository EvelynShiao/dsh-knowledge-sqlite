/**
 * dsh-knowledge-sqlite — cross-session knowledge for DeepSeek Harness.
 *
 * 单 bundle（执行计划阶段 1 决策）：ctx.knowledge 服务注册（V1.11 契约）
 * + SQLite FTS5 trigram provider + knowledge_* 工具 + L1 查询扩展 + 实验套件探针。
 *
 * 授权：workspace 隔离（调用方 cwd 身份）+ ask 门控（tools/pre-execute）
 * + allowedGlobalWriters（global scope 写）。
 * 信任：authorTier 四档，打标字段工具层所有（服务从执行上下文派生，绝不来自调用方参数）。
 */
import { Service } from '@deepseek-ai/cordis';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteKnowledgeStore } from "./store.js";
import { QueryExpander } from "./expand.js";
import { estimateTokens, provenanceOf, queryGrams, snippetOf } from "./search.js";
import { registerKnowledgeTools } from "./tools.js";
import { runProbe } from "./probe.js";
/**
 * 跨设备工作区键：取路径尾部两段（如 work/Evelyn），屏蔽盘符/根目录差异。
 * 电脑 C:\Users\...\.dsh\work\Evelyn 与手机 /data/.../.dsh/work/Evelyn
 * 归一后同键 → 同一知识库；不同工作区（work/1 等）仍然隔离。
 * 其他工作区（如 default-workspace）不会串。不是全局可见，只对同名工作区共享。
 */
function workspaceKey(p) {
    const norm = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0)
        return norm;
    return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
}
export function defaultDbPath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'knowledge.sqlite');
}
/**
 * 默认提示词注入文案（config.systemPrompt.text 未设时使用）。
 *
 * 目的：让模型在回答前知道有跨会话知识库可用、以及检索的两个硬约束
 * （trigram 中文子串 ≥3 字；查询扩展超时只降级不报错）。写"先检索再回答"
 * 而非"必须检索"，避免在无关问答上强制多一次工具调用。
 */
export const DEFAULT_SYSTEM_PROMPT_TEXT = [
    '跨会话知识库（dsh-knowledge-sqlite）可用：',
    '- knowledge_search 检索既有知识。中文子串需 ≥3 字才可能命中 trigram 索引；两字短词请补足上下文或换同义说法。',
    '- knowledge_list / knowledge_tags 浏览与审计条目；knowledge_write 写入（默认 ask 门控）。',
    '- 检索默认带 L1 查询扩展，超时自动降级为词法检索（结果带 degraded 标记），不会因此报错。',
    '涉及跨会话事实（"我记得""之前说过""上次"等）时，先 knowledge_search 再回答，避免凭记忆编造。',
].join('\n');
export class KnowledgeService extends Service {
    static inject = ['agents'];
    store;
    expander;
    config;
    constructor(ctx, store, expander, config) {
        super(ctx, 'knowledge');
        this.store = store;
        this.expander = expander;
        this.config = config;
    }
    // ============ 调用方派生（工具层所有权：打标字段来自执行上下文，绝不来自参数） ============
    caller() {
        const agents = this.ctx.get('agents');
        const agent = agents?.currentInitiator();
        if (agent === undefined || agent === null)
            return null;
        let workspaceId = null;
        try {
            workspaceId = agent.session?.header?.cwd ?? null;
        }
        catch {
            workspaceId = null;
        }
        if (workspaceId === null || workspaceId === undefined)
            return null;
        const sessionId = agent.session?.id ?? agent.id;
        // global 写 allowlist 的 actor：agent/preset id（V1.11：稳定跨会话重建）
        let presetId;
        try {
            const presets = this.ctx.get('agentPresets');
            presetId = presets?.composedPreset(agent.ctx);
        }
        catch {
            presetId = undefined;
        }
        return {
            // 归一化：电脑与手机路径前缀不同，取尾部两段后同键
            stamps: { workspaceId: workspaceKey(workspaceId), ownerId: sessionId, authorTier: 'explicit' },
            sessionId,
            actorId: presetId ?? agent.id,
        };
    }
    requireCaller() {
        const caller = this.caller();
        if (caller === null) {
            throw Object.assign(new Error('knowledge requires an agent execution context'), { code: 'write-rejected' });
        }
        return caller;
    }
    readCaller() {
        return this.caller();
    }
    /** 发射 knowledge/* 事件（自定义事件名，绕过 cordis Events 键类型）。 */
    emit(name, payload) {
        ;
        this.ctx.emit(name, payload);
    }
    // ============ V1.11 契约 ============
    async write(input) {
        const caller = this.requireCaller();
        return this.doWrite(input, caller);
    }
    async update(input) {
        const caller = this.requireCaller();
        return this.doUpdate(input, caller);
    }
    async search(query, opts = {}) {
        const caller = this.readCaller();
        if (caller === null)
            return { hits: [], degraded: null };
        return this.doSearch(query, opts, caller, 'items_fts_rich');
    }
    async list(scope, opts = {}) {
        const caller = this.readCaller();
        if (caller === null)
            return { items: [] };
        const result = this.store.list(scope, opts, { ...caller.stamps, sessionId: caller.sessionId });
        // 工具层 JSON 校验拒绝 undefined 字段
        if (result.nextCursor === undefined)
            delete result.nextCursor;
        return result;
    }
    /** 标签目录树（图书馆式逐层浏览）。prefix 空串 = 顶层。 */
    async listTags(opts = {}) {
        const caller = this.readCaller();
        if (caller === null)
            return { prefix: '', tags: [] };
        return this.store.listTags({ prefix: opts.prefix, scope: opts.scope, limit: opts.limit }, { ...caller.stamps, sessionId: caller.sessionId });
    }
    async delete(id) {
        const caller = this.requireCaller();
        const result = await this.store.delete(id, { ...caller.stamps, sessionId: caller.sessionId });
        if (!('error' in result) && result.deleted === true) {
            const item = this.store.get(id);
            this.emit('knowledge/deleted', { id, scope: item?.scope ?? 'workspace' });
        }
        return result;
    }
    // ============ 内部（trusted writer / probe / 测试） ============
    /** Trusted internal writer（V1.11 注册 writer 类：probe 装载/富化回写/评估）。 */
    async _seedWrite(input, stamps) {
        const actorId = stamps.ownerId;
        const result = await this.store.write({ content: input.content, scope: input.scope, dedupeKey: input.dedupeKey, importance: input.importance, ttl: input.ttl }, stamps, this.config.authorization.allowedGlobalWriters, actorId);
        if ('error' in result)
            return result;
        this.emit('knowledge/written', { id: result.id, scope: result.scope, importance: result.importance });
        return { id: result.id };
    }
    async _seedUpdate(id, patch, stamps) {
        if (patch.scope !== undefined) {
            return { error: { code: 'write-rejected', message: 'scope/dedupeKey are immutable after write (V1.11)' } };
        }
        const result = await this.store.update(id, patch, { ...stamps, sessionId: stamps.ownerId });
        if ('error' in result)
            return result;
        this.emit('knowledge/updated', { id, scope: 'workspace' });
        return result;
    }
    async _seedDelete(id, stamps) {
        const result = await this.store.delete(id, { ...stamps, sessionId: stamps.ownerId });
        if ('error' in result)
            return result;
        this.emit('knowledge/deleted', { id, scope: 'workspace' });
        return result;
    }
    async _seedList(opts, stamps) {
        return this.store.list('all', opts, { ...stamps, sessionId: stamps.ownerId });
    }
    /** 内部检索（probe 评估：table 可为 base/rich；stamps 可覆盖以测隔离）。 */
    async _searchInternal(query, opts, stampsOverride) {
        const caller = stampsOverride !== undefined
            ? { stamps: stampsOverride, sessionId: stampsOverride.ownerId, actorId: stampsOverride.ownerId }
            : this.readCaller();
        if (caller === null)
            return { hits: [], degraded: null };
        const table = opts.table === 'items_fts_base' ? 'items_fts_base' : 'items_fts_rich';
        return this.doSearch(query, opts, caller, table);
    }
    async _dedupeIds() {
        return this.store.dedupeIds();
    }
    // ============ 内部实现 ============
    async doWrite(input, caller) {
        const result = await this.store.write(input, caller.stamps, this.config.authorization.allowedGlobalWriters, caller.actorId);
        if ('error' in result)
            return result;
        this.emit('knowledge/written', { id: result.id, scope: result.scope, importance: result.importance });
        return result;
    }
    async doUpdate(input, caller) {
        if (input.scope !== undefined || input.dedupeKey !== undefined) {
            return { error: { code: 'write-rejected', message: 'scope/dedupeKey are immutable after write (V1.11)' } };
        }
        const result = await this.store.update(input.id, input, { ...caller.stamps, sessionId: caller.sessionId });
        if ('error' in result)
            return result;
        const item = await this.store.get(input.id);
        this.emit('knowledge/updated', { id: input.id, scope: item?.scope ?? 'workspace' });
        return result;
    }
    async doSearch(query, opts, caller, table) {
        if (typeof query !== 'string' || query.trim() === '')
            return { hits: [], degraded: null };
        const expand = opts.expand !== false;
        let variants = Array.isArray(opts.variants) ? opts.variants : null;
        let expansion;
        let degraded = null;
        if (variants === null && expand && this.config.queryExpansion.enabled) {
            const e = await this.expander.expand(query, opts.signal, caller.stamps.workspaceId);
            variants = e.variants;
            if (e.degraded)
                degraded = 'lexical';
            expansion = { used: true, source: e.source, degraded: e.degraded, latencyMs: e.latencyMs, variantsCount: variants.length };
        }
        else if (variants !== null && variants.length > 0) {
            expansion = { used: true, source: 'caller', degraded: false, latencyMs: 0, variantsCount: variants.length };
        }
        const texts = variants !== null && variants.length > 0 ? [query, ...variants] : [query];
        const rows = await this.store.search(table === 'items_fts_base' ? 'base' : 'rich', texts, { ...caller.stamps, sessionId: caller.sessionId }, {
            scope: opts.scope,
            tags: opts.tags,
            topN: this.config.retrieval.topN,
            maxQueryTrigrams: this.config.retrieval.maxQueryTrigrams,
        });
        const maxItems = opts.budget?.maxItems ?? this.config.retrieval.topN;
        const qgrams = queryGrams(texts.join(' '));
        const hits = [];
        let tokens = 0;
        for (const r of rows) {
            if (hits.length >= maxItems)
                break;
            const item = r.item;
            // score 归一化：Math.round 可能产出 -0（极小 bm25 分数），工具层 JSON 校验拒绝 -0/NaN
            const rounded = Math.round(r.score * 1000) / 1000;
            const score = Object.is(rounded, -0) || !Number.isFinite(rounded) ? 0 : rounded;
            hits.push({
                id: item.id,
                content: item.content,
                score,
                snippet: snippetOf(item.content, qgrams),
                provenance: provenanceOf(item.content, item.keywords, item.synonyms, item.questions, qgrams),
                authorTier: item.authorTier,
            });
            if (opts.budget?.maxTokens !== undefined) {
                tokens += estimateTokens(item.content);
                if (tokens > opts.budget.maxTokens)
                    break;
            }
        }
        // 工具层 JSON 校验拒绝 undefined 字段——返回对象只含已定义字段
        const result = { hits, degraded };
        if (expansion !== undefined)
            result.expansion = expansion;
        return result;
    }
    // ============ 实验套件探针（阶段 3 门禁 e2e） ============
    async probe(suite, opts = {}) {
        // fresh：清扩展缓存——单轮方差需要独立扩展（缓存会杀死随机性）
        if (opts.fresh === true)
            this.expander.clear();
        const caller = this.readCaller();
        const workspaceId = caller?.stamps.workspaceId;
        const corpusPath = workspaceId !== undefined
            ? (this.config.corpusPath.startsWith('/') ? this.config.corpusPath : join(workspaceId, this.config.corpusPath))
            : this.config.corpusPath;
        return runProbe({ store: this.store, expander: this.expander, service: this, corpusPath }, suite, caller, opts.runs ?? 10);
    }
}
// ---------- 插件入口 ----------
export const name = 'dsh-knowledge-sqlite';
/**
 * cordis loader 插件形状：loader 的 unwrapExports 后直接 registry.plugin(default)，
 * 函数会被当作插件 body 调用（工厂形态的 default 会被静默忽略——apply 从不执行）。
 * 因此 default 必须是插件对象（inject + apply），config 经 apply 第二参注入。
 */
const knowledgeSqlitePlugin = {
    inject: ['tools', 'agents', 'timer'],
    async apply(ctx, config = {}) {
        {
            const resolved = {
                gating: config.gating ?? 'ask',
                databasePath: config.databasePath ?? defaultDbPath(),
                corpusPath: config.corpusPath ?? 'research/memory-knowledge-seam/experiments/memory-experiment',
                maxContentTokens: config.maxContentTokens ?? 2048,
                queryExpansion: {
                    enabled: config.queryExpansion?.enabled ?? true,
                    model: config.queryExpansion?.model,
                    maxOutputTokens: config.queryExpansion?.maxOutputTokens ?? 300,
                    timeoutMs: config.queryExpansion?.timeoutMs ?? 3000,
                    cache: config.queryExpansion?.cache ?? true,
                },
                retrieval: {
                    topN: config.retrieval?.topN ?? 20,
                    maxQueryTrigrams: config.retrieval?.maxQueryTrigrams ?? 0, // 0 = 不限（对齐实验基线；生产可设 24，见 README）
                    maxCandidates: config.retrieval?.maxCandidates ?? 200,
                },
                authorization: {
                    allowedGlobalWriters: config.authorization?.allowedGlobalWriters ?? [],
                },
                systemPrompt: {
                    enabled: config.systemPrompt?.enabled ?? false,
                    text: typeof config.systemPrompt?.text === 'string' ? config.systemPrompt.text : DEFAULT_SYSTEM_PROMPT_TEXT,
                    order: Number.isFinite(config.systemPrompt?.order) ? config.systemPrompt.order : 950,
                },
            };
            const store = await SqliteKnowledgeStore.open(resolved.databasePath, resolved.maxContentTokens);
            ctx.effect(() => () => store.close());
            const expander = new QueryExpander(ctx, {
                enabled: resolved.queryExpansion.enabled,
                model: resolved.queryExpansion.model,
                maxOutputTokens: resolved.queryExpansion.maxOutputTokens,
                timeoutMs: resolved.queryExpansion.timeoutMs,
                cache: resolved.queryExpansion.cache,
            }, {
                get: (wsId, norm) => store.getExpansion(wsId, norm),
                set: (wsId, norm, variants) => store.setExpansion(wsId, norm, variants),
                clear: () => store.clearExpansionCache(),
            });
            const service = new KnowledgeService(ctx, store, expander, resolved);
            // 注：cordis Service 构造器已通过 ctx.reflect.provide 注册 'knowledge'，勿再 ctx.provide
            registerKnowledgeTools(ctx, service);
            // ask 门控（V1.11 批准层，默认开）：knowledge_write/delete 是跨会话持久变更，需要用户确认。
            // headless（approval=never）自动拒绝——config gating 替代交互确认。
            // gating: 'none'（部署配置）跳过门控：模型写入自动放行（信任模型场景）。
            if (resolved.gating === 'ask') {
                ctx.on('tools/pre-execute', (exec, next) => {
                    if (exec.name === 'knowledge_write' || exec.name === 'knowledge_delete') {
                        return Promise.resolve({ kind: 'ask', reason: '知识库写入/删除是跨会话持久变更（V1.11 ask 门控）' });
                    }
                    return Promise.resolve(next());
                });
            }
            // 提示词注入（可选）：把知识库使用说明挂进系统提示词。
            // 用 ctx.get 软读而非 inject——systemPrompt 服务缺失时静默跳过，
            // 不让本插件转 INACTIVE（inject 是硬依赖，缺一服务即整插件失效）。
            if (resolved.systemPrompt.enabled && resolved.systemPrompt.text.trim() !== '') {
                const systemPrompt = ctx.get('systemPrompt');
                if (systemPrompt) {
                    ctx.effect(() => systemPrompt.section({
                        name: 'knowledge-sqlite:usage',
                        order: resolved.systemPrompt.order,
                        text: resolved.systemPrompt.text,
                    }), 'knowledge-sqlite.systemPrompt()');
                }
            }
        }
    },
};
export default knowledgeSqlitePlugin;
