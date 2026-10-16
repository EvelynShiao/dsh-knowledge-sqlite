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
import type { Context } from '@deepseek-ai/cordis';
import { SqliteKnowledgeStore } from './store.ts';
import { QueryExpander } from './expand.ts';
import type { AuthorTier, KnowledgeListResult, KnowledgeSearchResult, KnowledgeStamps, Scope, ScopeFilter } from './types.ts';
export interface KnowledgeSqliteConfig {
    /** 写入门控：'ask'（默认，V1.11）经 tools/pre-execute 请求确认；'none' 跳过门控（部署方选择，headless 自动放行） */
    gating?: 'ask' | 'none';
    /** SQLite 数据库路径；默认 $DSH_HOME/knowledge.sqlite */
    databasePath?: string;
    /** probe 语料目录；默认 '<workspace>/research/memory-knowledge-seam/experiments/memory-experiment'（实验套件） */
    corpusPath?: string;
    /** seam 级写上限（V1.11 enrichment.maxContentTokens，默认 2048） */
    maxContentTokens?: number;
    queryExpansion?: {
        enabled?: boolean;
        model?: string;
        maxOutputTokens?: number;
        timeoutMs?: number;
        cache?: boolean;
    };
    retrieval?: {
        topN?: number;
        maxQueryTrigrams?: number;
        maxCandidates?: number;
    };
    authorization?: {
        allowedGlobalWriters?: string[];
    };
    /** 可选提示词注入：把知识库使用说明挂进系统提示词（ctx.systemPrompt.section） */
    systemPrompt?: {
        /** 是否注入；默认 false（不注入，保持原行为） */
        enabled?: boolean;
        /** 注入文案；缺省用 DEFAULT_SYSTEM_PROMPT_TEXT */
        text?: string;
        /** 章节排序值；默认 950（FILE_REFERENCE=900 之后、TOOL_BASH=1000 之前） */
        order?: number;
    };
}
export interface ResolvedConfig {
    gating: 'ask' | 'none';
    databasePath: string;
    corpusPath: string;
    maxContentTokens: number;
    queryExpansion: {
        enabled: boolean;
        model?: string;
        maxOutputTokens: number;
        timeoutMs: number;
        cache: boolean;
    };
    retrieval: {
        topN: number;
        maxQueryTrigrams: number;
        maxCandidates: number;
    };
    authorization: {
        allowedGlobalWriters: string[];
    };
    systemPrompt: {
        enabled: boolean;
        text: string;
        order: number;
    };
}
export declare function defaultDbPath(): string;
export declare const DEFAULT_SYSTEM_PROMPT_TEXT: string;
export type WriteResult = {
    id: string;
    wasUpdate: boolean;
    scope: Scope;
    importance: number;
} | {
    error: {
        code: 'closed' | 'missing-key' | 'write-rejected';
        message: string;
    };
};
export declare class KnowledgeService extends Service {
    static inject: string[];
    private readonly store;
    private readonly expander;
    private readonly config;
    constructor(ctx: Context, store: SqliteKnowledgeStore, expander: QueryExpander, config: ResolvedConfig);
    private caller;
    private requireCaller;
    private readCaller;
    /** 发射 knowledge/* 事件（自定义事件名，绕过 cordis Events 键类型）。 */
    private emit;
    write(input: {
        content: string;
        scope?: Scope;
        source?: {
            sessionId: string;
            seq: number;
        } | null;
        importance?: number;
        tags?: string[];
        dedupeKey?: string;
        ttl?: number;
    }): Promise<WriteResult>;
    update(input: {
        id: string;
        content?: string;
        importance?: number;
        tags?: string[];
        ttl?: number | null;
    }): Promise<{
        updated: boolean;
    } | {
        error: {
            code: string;
            message: string;
        };
    }>;
    search(query: string, opts?: {
        scope?: ScopeFilter;
        path?: string;
        budget?: {
            maxTokens?: number;
            maxItems?: number;
        };
        expand?: boolean;
        variants?: string[];
        signal?: AbortSignal;
    }): Promise<KnowledgeSearchResult>;
    list(scope: ScopeFilter, opts?: {
        cursor?: string;
        limit?: number;
        includeDeleted?: boolean;
        includeExpired?: boolean;
    }): Promise<KnowledgeListResult>;
    delete(id: string): Promise<{
        deleted: boolean;
    } | {
        error: {
            code: string;
            message: string;
        };
    }>;
    /** Trusted internal writer（V1.11 注册 writer 类：probe 装载/富化回写/评估）。 */
    _seedWrite(input: {
        content: string;
        scope?: Scope;
        dedupeKey?: string;
        importance?: number;
        ttl?: number;
    }, stamps: KnowledgeStamps): Promise<{
        id: string;
    } | {
        error: {
            code: string;
            message: string;
        };
    }>;
    _seedUpdate(id: string, patch: {
        content?: string;
        importance?: number;
        tags?: string[];
        ttl?: number | null;
        scope?: never;
    }, stamps: KnowledgeStamps): Promise<{
        updated: boolean;
    } | {
        error: {
            code: string;
            message: string;
        };
    }>;
    _seedDelete(id: string, stamps: KnowledgeStamps): Promise<{
        deleted: boolean;
    } | {
        error: {
            code: string;
            message: string;
        };
    }>;
    _seedList(opts: {
        cursor?: string;
        limit?: number;
        includeDeleted?: boolean;
        includeExpired?: boolean;
    }, stamps: KnowledgeStamps): Promise<KnowledgeListResult>;
    /** 内部检索（probe 评估：table 可为 base/rich；stamps 可覆盖以测隔离）。 */
    _searchInternal(query: string, opts: {
        table?: 'items_fts_base' | 'items_fts_rich';
        expand?: boolean;
        variants?: string[];
        signal?: AbortSignal;
    }, stampsOverride?: KnowledgeStamps): Promise<KnowledgeSearchResult>;
    _dedupeIds(): Promise<Map<string, string>>;
    private doWrite;
    private doUpdate;
    private doSearch;
    probe(suite: 'seed' | 'hard' | 'human' | 'contract' | 'latency' | 'variance' | 'all', opts?: {
        fresh?: boolean;
        runs?: number;
    }): Promise<{
        ok: boolean;
        parts: Array<Record<string, unknown>>;
    }>;
}
export declare const name = "dsh-knowledge-sqlite";
/**
 * cordis loader 插件形状：loader 的 unwrapExports 后直接 registry.plugin(default)，
 * 函数会被当作插件 body 调用（工厂形态的 default 会被静默忽略——apply 从不执行）。
 * 因此 default 必须是插件对象（inject + apply），config 经 apply 第二参注入。
 */
declare const knowledgeSqlitePlugin: {
    inject: string[];
    apply(ctx: Context, config?: KnowledgeSqliteConfig): Promise<void>;
};
export default knowledgeSqlitePlugin;
export type { AuthorTier };
