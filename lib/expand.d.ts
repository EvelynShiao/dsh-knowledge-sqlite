/**
 * dsh-knowledge-sqlite — L1 查询扩展。
 *
 * 每查询一次小模型调用（llm.stream），按归一化查询缓存，timeoutMs 超时/失败降级
 * `degraded: 'lexical'`（不是工具错误）。`expand: false` 或调用方 `variants` 跳过。
 *
 * 缓存两级（0.1.5 起）：进程内存（本查询会话内命中）+ SQLite 持久化（按 workspace 隔离，
 * 跨进程/重启复用——真实使用同查询第二次起 0 延迟、零降级）。`clear()` 同时清两级
 * （variance/fresh 语义：强制独立扩展）。
 *
 * 消息构造遵循 harness 约定（content blocks + source + id）——原型曾因字符串 content
 * 与 finish reason 字符串比较导致全部降级（见 research/memory-knowledge-seam/experiments/prototype/RESULTS-PROTOTYPE.md §4.4）。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface ExpansionOutcome {
    variants: string[];
    source: 'live' | 'cache' | null;
    degraded: boolean;
    latencyMs: number;
}
export interface QueryExpansionConfig {
    enabled: boolean;
    /** 专用扩展 provider（0.1.6：显式指定，优先级高于会话默认 provider——扩展是低延迟任务，
     *  不应跟随主模型路由（中转/推理模型 TTFT 可达 3s+，见 EXPERIMENTS §9）） */
    provider?: string;
    /** 专用扩展模型（V1.11：unset = 会话默认模型） */
    model?: string;
    maxOutputTokens: number;
    timeoutMs: number;
    cache: boolean;
}
/** 持久化缓存接口（store 实现：expansion_cache 表，按 workspace 隔离）。 */
export interface ExpansionCacheStore {
    get(wsId: string, normQuery: string): string[] | null;
    set(wsId: string, normQuery: string, variants: string[]): void;
    clear(): void;
}
export declare class QueryExpander {
    private readonly ctx;
    private readonly config;
    private readonly persist;
    private readonly cache;
    private msgSeq;
    stats: {
        calls: number;
        cacheHits: number;
        persistHits: number;
        degraded: number;
        totalLatencyMs: number;
    };
    constructor(ctx: Context, config: QueryExpansionConfig, persist?: ExpansionCacheStore | null);
    clear(): void;
    /**
     * 扩展一个查询。缓存键 = 归一化查询（内存层）+ (workspaceId, norm)（持久层）。
     * @param query 原始查询文本
     * @param signal 取消信号（来自工具执行）
     * @param wsId 调用方 workspace id（持久化缓存隔离键）
     */
    expand(query: string, signal?: AbortSignal, wsId?: string): Promise<ExpansionOutcome>;
    private callModel;
    /** 与超时竞速（timer 服务：宿主 fiber 计时器，插件停止时自动清理）。collect 先完成 → false；超时 → true。 */
    private raceWithTimeout;
}
/** 解析模型输出中的 variants（容忍 ```json 围栏）。 */
export declare function parseVariants(text: string): string[];
