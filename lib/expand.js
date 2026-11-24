const EXPANSION_PROMPT = '你是记忆系统的查询扩展器。对用户输入的查询，生成 3-4 个同义/口语化/更具体的变体问法（中文），'
    + '用于检索同义改写。只输出 JSON：{"variants": ["变体1", "变体2", ...]}，不要输出其他内容。';
export class QueryExpander {
    ctx;
    config;
    persist;
    cache = new Map();
    msgSeq = 0;
    stats = {
        calls: 0,
        cacheHits: 0,
        persistHits: 0,
        degraded: 0,
        totalLatencyMs: 0,
        /* 0.1.10 摘樱桃：降级原因首段 → 次数（诊断；probe 的 expansion-stats 会展开） */
        degradeReasons: {},
        /* 最近一次降级原因（含细节） */
        lastDegradeReason: null,
    };
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
            const reason = outcome.trace?.reason ?? 'unknown';
            /* 0.1.10 摘樱桃：结构化降级诊断——首段计数 + 最近原因，随 expansion.reason 透出 */
            this.stats.lastDegradeReason = reason;
            const key = String(reason).split(':', 1)[0];
            this.stats.degradeReasons[key] = (this.stats.degradeReasons[key] ?? 0) + 1;
            return { variants: [], source: null, degraded: true, latencyMs, reason, ...(outcome.trace !== undefined ? { routeDetail: outcome.trace } : {}) };
        }
        const variants = parseVariants(outcome.text);
        if (variants.length === 0) {
            this.stats.degraded++;
            console.error(`[knl-expand] 扩展输出解析失败（模型有回但不是合法 variants JSON）route=${JSON.stringify(outcome.trace)} text=${outcome.text.slice(0, 120)}`);
            const reason = `empty-variants: raw=${JSON.stringify(outcome.text).slice(0, 200)}`;
            this.stats.lastDegradeReason = 'empty-variants';
            this.stats.degradeReasons['empty-variants'] = (this.stats.degradeReasons['empty-variants'] ?? 0) + 1;
            return { variants: [], source: null, degraded: true, latencyMs, reason, routeDetail: outcome.trace };
        }
        if (this.config.cache) {
            this.cache.set(norm, variants);
            if (wsId !== undefined && this.persist !== null)
                this.persist.set(wsId, norm, variants);
        }
        console.log(`[knl-expand] 扩展成功 route=${outcome.trace?.route}(${outcome.trace?.provider}/${outcome.trace?.model}) ${latencyMs}ms variants=${variants.length}`);
        return { variants, source: 'live', degraded: false, latencyMs };
    }
    async callModel(query, signal) {
        /* 按链逐项尝试。旧单值配置归一为 fixed；空链先跟随会话，再用全局默认兜底。 */
        let sessionProbe;
        try {
            const agents = this.ctx.get('agents');
            const agent = agents?.currentInitiator?.();
            const header = agent?.session?.requestHeader?.();
            const config = header?.config;
            if (config && typeof config === 'object') {
                sessionProbe = { provider: config.provider ?? null, model: config.model ?? null, keys: Object.keys(config).slice(0, 12) };
            }
            else {
                sessionProbe = { headerType: header === null || header === undefined ? String(header) : typeof header, configType: config === undefined ? 'undefined' : typeof config };
            }
        }
        catch (error) {
            sessionProbe = { throw: error instanceof Error ? error.message : String(error) };
        }
        const emptyChain = Array.isArray(this.config.chain) && this.config.chain.length === 0;
        const items = Array.isArray(this.config.chain)
            ? (emptyChain ? [{ type: 'session' }, { type: 'global' }] : this.config.chain)
            : (this.config.provider && this.config.model
                ? [{ type: 'fixed', provider: this.config.provider, model: this.config.model }]
                : [{ type: 'session' }]);
        const attempts = [];
        const llm = this.ctx.get('llm');
        for (const item of items) {
            let provider;
            let model;
            let route;
            let reasoningEffort;
            if (item.type === 'fixed') {
                provider = item.provider;
                model = item.model;
                route = 'dedicated';
                reasoningEffort = item.reasoningEffort;
            }
            else if (item.type === 'session') {
                route = 'session';
                if (typeof sessionProbe?.provider === 'string' && sessionProbe.provider
                    && typeof sessionProbe.model === 'string' && sessionProbe.model) {
                    provider = sessionProbe.provider;
                    model = sessionProbe.model;
                }
                else {
                    attempts.push({ type: 'session', status: 'failed', reason: 'no-session-route' });
                    continue;
                }
            }
            else if (item.type === 'global') {
                route = 'global';
                try {
                    const selection = this.ctx.get('agentDefaultModel')?.currentSelection();
                    provider = selection?.provider;
                    model = selection?.model;
                }
                catch { /* 记入下方 no-route，继续降级 */ }
            }
            if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
                attempts.push({ type: item.type, route, status: 'failed', reason: 'no-route' });
                continue;
            }
            if (llm === undefined) {
                attempts.push({ type: item.type, route, provider, model, status: 'failed', reason: 'no-llm' });
                continue;
            }
            /* 显式 effort 原样传递；未指定时首选 off，被拒则去参重试一次。 */
            const attempt = async (effort) => {
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
                            ...(effort ? { reasoningEffort: effort } : {}),
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
                return { text, streamError, timedOut };
            };
            let result = await attempt(reasoningEffort ?? 'off');
            if (reasoningEffort === undefined && !result.timedOut && result.streamError !== null
                && /does not support reasoning effort/i.test(result.streamError)) {
                console.warn(`[knl-expand] ${provider}/${model} 不支持 reasoningEffort:'off'，去掉该参数重试一次`);
                result = await attempt(undefined);
            }
            const { text, streamError, timedOut } = result;
            if (timedOut || streamError !== null) {
                const reason = timedOut ? 'timeout' : 'stream-error';
                const failure = { type: item.type, route, provider, model, status: 'failed', reason, ...(streamError ? { error: streamError } : {}) };
                attempts.push(failure);
                console.error(`[knl-expand] 链项失败，尝试下一项 ${JSON.stringify(failure)}`);
                continue;
            }
            const chainTried = [...attempts, { type: item.type, route, provider, model, status: 'ok' }];
            return { ok: true, text, trace: { route, provider, model, chainTried } };
        }
        console.error(`[knl-expand] 扩展链全部失败，降级词法检索 attempts=${JSON.stringify(attempts)}`);
        return { ok: false, trace: { reason: 'chain-exhausted', attempts } };
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
