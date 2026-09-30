const EXPANSION_PROMPT = '你是记忆系统的查询扩展器。对用户输入的查询，生成 3-4 个同义/口语化/更具体的变体问法（中文），'
    + '用于检索同义改写。只输出 JSON：{"variants": ["变体1", "变体2", ...]}，不要输出其他内容。';
export class QueryExpander {
    ctx;
    config;
    persist;
    cache = new Map();
    msgSeq = 0;
    stats = { calls: 0, cacheHits: 0, persistHits: 0, degraded: 0, totalLatencyMs: 0 };
    constructor(ctx, config, persist = null) {
        this.ctx = ctx;
        this.config = config;
        this.persist = persist;
    }
    clear() {
        this.cache.clear();
        this.persist?.clear();
    }
    /**
     * 扩展一个查询。缓存键 = 归一化查询（内存层）+ (workspaceId, norm)（持久层）。
     * @param query 原始查询文本
     * @param signal 取消信号（来自工具执行）
     * @param wsId 调用方 workspace id（持久化缓存隔离键）
     */
    async expand(query, signal, wsId) {
        const norm = query.trim().toLowerCase().replace(/\s+/g, ' ');
        if (this.config.cache) {
            const cached = this.cache.get(norm);
            if (cached !== undefined) {
                this.stats.cacheHits++;
                return { variants: cached, source: 'cache', degraded: false, latencyMs: 0 };
            }
            // 持久层命中（跨进程/重启）：回填内存缓存
            if (wsId !== undefined && this.persist !== null) {
                const stored = this.persist.get(wsId, norm);
                if (stored !== null) {
                    this.stats.cacheHits++;
                    this.stats.persistHits++;
                    this.cache.set(norm, stored);
                    return { variants: stored, source: 'cache', degraded: false, latencyMs: 0 };
                }
            }
        }
        this.stats.calls++;
        const started = Date.now();
        const outcome = await this.callModel(query, signal);
        const latencyMs = Date.now() - started;
        this.stats.totalLatencyMs += latencyMs;
        if (!outcome.ok) {
            this.stats.degraded++;
            return { variants: [], source: null, degraded: true, latencyMs };
        }
        const variants = parseVariants(outcome.text);
        if (variants.length === 0) {
            this.stats.degraded++;
            return { variants: [], source: null, degraded: true, latencyMs };
        }
        if (this.config.cache) {
            this.cache.set(norm, variants);
            if (wsId !== undefined && this.persist !== null)
                this.persist.set(wsId, norm, variants);
        }
        return { variants, source: 'live', degraded: false, latencyMs };
    }
    async callModel(query, signal) {
        // 模型路由：配置了专用扩展模型时用它（provider 跟随会话路由）；
        // 未配置用会话默认模型（agentDefaultModel.currentSelection）
        const sel = this.ctx.get('agentDefaultModel');
        let provider;
        let model;
        try {
            const s = sel?.currentSelection();
            provider = s?.provider;
            model = this.config.model ?? s?.model;
        }
        catch {
            provider = undefined;
        }
        if (provider === undefined || model === undefined)
            return { ok: false };
        const llm = this.ctx.get('llm');
        if (llm === undefined)
            return { ok: false };
        let text = '';
        let streamError = null;
        const collect = (async () => {
            try {
                const stream = llm.stream({
                    provider,
                    model,
                    messages: [{
                            role: 'user',
                            content: [{ type: 'text', text: `${EXPANSION_PROMPT}\n查询：${query}` }],
                            source: { kind: 'plugin', plugin: 'dsh-knowledge-sqlite' },
                            id: `knl-expand-${this.msgSeq++}`,
                        }],
                    maxTokens: this.config.maxOutputTokens,
                    temperature: 0.2,
                    // 0.1.6：扩展是低延迟任务，显式关闭思维链——reasoning 模型的 thinking 预热
                    // 可让 TTFT 高达 3s+（实测 opencode-go deepseek-v4-flash 默认 thinking 全开，
                    // TTFT 3387ms / total 11.3s，见 EXPERIMENTS §9）；'off' → pi-ai
                    // `thinking: { type: 'disabled' }`，退化为普通生成。
                    reasoningEffort: 'off',
                    signal,
                });
                for await (const chunk of stream) {
                    if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                        text += chunk.text;
                    if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                        throw new Error(`expansion stream ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'unknown failure'}`);
                    }
                }
            }
            catch (error) {
                streamError = error instanceof Error ? error.message : String(error);
            }
        })();
        const timedOut = await this.raceWithTimeout(collect);
        if (timedOut)
            return { ok: false };
        if (streamError !== null)
            return { ok: false };
        return { ok: true, text };
    }
    /** 与超时竞速（timer 服务：宿主 fiber 计时器，插件停止时自动清理）。collect 先完成 → false；超时 → true。 */
    raceWithTimeout(promise) {
        const timer = this.ctx.get('timer');
        if (timer === undefined)
            return Promise.resolve(false); // 无 timer 服务：不设超时（collect 自行收敛）
        return new Promise((resolve) => {
            let settled = false;
            const disposer = timer.timeout(() => {
                if (!settled) {
                    settled = true;
                    resolve(true);
                }
            }, this.config.timeoutMs);
            promise.then(() => { if (!settled) {
                settled = true;
                disposer();
                resolve(false);
            } }, () => { if (!settled) {
                settled = true;
                disposer();
                resolve(false);
            } });
        });
    }
}
/** 解析模型输出中的 variants（容忍 ```json 围栏）。 */
export function parseVariants(text) {
    try {
        let t = String(text).trim();
        t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const data = JSON.parse(t);
        const list = Array.isArray(data) ? data : data.variants;
        if (!Array.isArray(list))
            return [];
        return list.filter((v) => typeof v === 'string' && v.length > 0).slice(0, 6);
    }
    catch {
        return [];
    }
}
