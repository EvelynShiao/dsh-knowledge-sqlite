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
            return { variants: [], source: null, degraded: true, latencyMs, ...(outcome.trace !== undefined ? { routeDetail: outcome.trace } : {}) };
        }
        const variants = parseVariants(outcome.text);
        if (variants.length === 0) {
            this.stats.degraded++;
            console.error(`[knl-expand] 扩展输出解析失败（模型有回但不是合法 variants JSON）route=${JSON.stringify(outcome.trace)} text=${outcome.text.slice(0, 120)}`);
            return { variants: [], source: null, degraded: true, latencyMs, routeDetail: outcome.trace };
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
        // 模型路由（2026-10-26 v2 修复「27ms 秒拒」）：
        // 优先级①专用扩展模型（设置页配置 expansionProvider + expansionModel）
        // ②当前会话正在用的模型（agent.session.requestHeader——工具在会话里跑，
        //   会话用什么通道扩展就用什么通道，用户会话是免费通道则扩展免费）
        // ③全局默认（agentDefaultModel.currentSelection——历史上是唯一来源，
        //   实证坑：全局默认=deepseek-official 且无 API key 时 27ms 秒拒，
        //   每次查询扩展必降级词法，「向量化搜索坏了」的观感来源）。
        let provider;
        let model;
        let route = null;
        // ②级探测（2026-10-31 可见性改造）：无论①是否命中都探测并记录，
        // 用于确诊「会话模型跟随」在真实宿主里拿不到 config 的原因
        // （真实 requestHeader 结构与 E2E mock 不一致是最大嫌疑；诊断稳定后可移回②分支内）。
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
        // ① 专用配置
        if (typeof this.config.provider === 'string' && this.config.provider
            && typeof this.config.model === 'string' && this.config.model) {
            provider = this.config.provider;
            model = this.config.model;
            route = 'dedicated';
        }
        // ② 当前会话真实模型（requestHeader 是本会话最后一个请求的路由，
        //    含 installModelSelection 的会话级改写——比全局默认忠实得多）
        if (provider === undefined) {
            const probe = sessionProbe;
            if (typeof probe?.provider === 'string' && probe.provider
                && typeof probe.model === 'string' && probe.model) {
                provider = probe.provider;
                model = probe.model;
                route = 'session';
            }
        }
        // ③ 全局默认（兜底）
        if (provider === undefined) {
            const sel = this.ctx.get('agentDefaultModel');
            try {
                const s = sel?.currentSelection();
                provider = s?.provider;
                model = this.config.model ?? s?.model;
                route = 'global';
            }
            catch {
                provider = undefined;
            }
        }
        if (provider === undefined || model === undefined) {
            // 2026-10-31：失败必须可见（红线「不许静默降级」）——stderr 日志 + 回包 trace 双通道
            console.error(`[knl-expand] 扩展降级：无可用模型路由 session-probe=${JSON.stringify(sessionProbe)}`);
            return { ok: false, trace: { reason: 'no-route', sessionProbe } };
        }
        const llm = this.ctx.get('llm');
        if (llm === undefined) {
            console.error('[knl-expand] 扩展降级：ctx.llm 服务不可用');
            return { ok: false, trace: { reason: 'no-llm', route, provider, model, sessionProbe } };
        }
        // 2026-10-31 真凶修复：0.1.6 起固定发 reasoningEffort:'off'，但严格上游（如 inai-free/z-ai/glm-5.3-flash）
        // 对该参数做能力校验并同步秒拒（does not support reasoning effort "off"，实测 7~39ms），
        // 扩展从未真正跑过 LLM——「向量化搜索坏了」的第二层真相（第一层是 10-26 前的 deepseek-official 无 key）。
        // 修法：attempt(useReasoningOff) 包装收集逻辑；首选拒思维链，秒拒则去参重试一次。
        const attempt = async (useReasoningOff) => {
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
                        // 0.1.6：扩展是低延迟任务，首选关闭思维链——reasoning 模型的 thinking 预热
                        // 可让 TTFT 高达 3s+（实测 opencode-go deepseek-v4-flash 默认 thinking 全开，
                        // TTFT 3387ms / total 11.3s，见 EXPERIMENTS §9）。
                        // 2026-10-31：改为可降级——不支持 'off' 的模型重试时省略该参数（下方重试逻辑）。
                        ...(useReasoningOff ? { reasoningEffort: 'off' } : {}),
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
        let result = await attempt(true);
        if (!result.timedOut && result.streamError !== null && /does not support reasoning effort/i.test(result.streamError)) {
            console.warn(`[knl-expand] ${provider}/${model} 不支持 reasoningEffort:'off'，去掉该参数重试一次`);
            result = await attempt(false);
        }
        const { text, streamError, timedOut } = result;
        if (timedOut) {
            console.error(`[knl-expand] 扩展超时(${this.config.timeoutMs}ms) route=${route}(${provider}/${model})${streamError ? ` streamError=${streamError}` : ''}`);
            return { ok: false, trace: { reason: 'timeout', route, provider, model, sessionProbe } };
        }
        if (streamError !== null) {
            console.error(`[knl-expand] 扩展调用失败 route=${route}(${provider}/${model}): ${streamError}`);
            return { ok: false, trace: { reason: 'stream-error', route, provider, model, error: streamError, sessionProbe } };
        }
        return { ok: true, text, trace: { route, provider, model } };
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
