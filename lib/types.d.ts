/**
 * dsh-knowledge-sqlite — V1.11 seam contract 类型。
 *
 * npm 版 schemastery（3.18.1 fork）API 缺口记录：无 `enum`/`nullable`/`z.infer`/`.optional()`。
 * 对策（dsh-session-health 同款）：schema 对象仅作契约文档与未来 Remote 生成素材，
 * 字段不声明 optional（缺实例方法）；TS 类型手写，可选字段用 `?`。
 */
import z from '@deepseek-ai/schemastery';
export declare const Scope: z<"workspace" | "session" | "global", "workspace" | "session" | "global", "plain">;
export type Scope = 'workspace' | 'session' | 'global';
export declare const ScopeFilter: z<"workspace" | "session" | "global" | "all", "workspace" | "session" | "global" | "all", "plain">;
export type ScopeFilter = 'workspace' | 'session' | 'global' | 'all';
export declare const AuthorTier: z<"llm" | "human" | "explicit" | "derived", "llm" | "human" | "explicit" | "derived", "plain">;
export type AuthorTier = 'human' | 'explicit' | 'derived' | 'llm';
export interface KnowledgeSource {
    sessionId: string;
    seq: number;
}
export declare const KnowledgeSourceSchema: z<Schemastery.ObjectS<NoInfer<{
    sessionId: z<string, string, "plain">;
    seq: z<number, number, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    sessionId: z<string, string, "plain">;
    seq: z<number, number, "plain">;
}>>, "plain">;
/**
 * 写入输入。打标字段（workspaceId/ownerId/authorTier）不在其中——
 * 工具层派生并打标，调用方伪造 → write-rejected（V1.11）。
 */
export interface KnowledgeItemInput {
    content: string;
    scope?: Scope;
    source?: KnowledgeSource;
    importance?: number;
    tags?: string[];
    dedupeKey?: string;
    ttl?: number;
}
export declare const KnowledgeItemInputSchema: z<Schemastery.ObjectS<NoInfer<{
    content: z<string, string, "plain">;
    scope: z<"workspace" | "session" | "global", "workspace" | "session" | "global", "plain">;
    source: z<Schemastery.ObjectS<NoInfer<{
        sessionId: z<string, string, "plain">;
        seq: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        sessionId: z<string, string, "plain">;
        seq: z<number, number, "plain">;
    }>>, "plain">;
    importance: z<number, number, "plain">;
    tags: z<string[], string[], "plain">;
    dedupeKey: z<string, string, "plain">;
    ttl: z<number, number, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    content: z<string, string, "plain">;
    scope: z<"workspace" | "session" | "global", "workspace" | "session" | "global", "plain">;
    source: z<Schemastery.ObjectS<NoInfer<{
        sessionId: z<string, string, "plain">;
        seq: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        sessionId: z<string, string, "plain">;
        seq: z<number, number, "plain">;
    }>>, "plain">;
    importance: z<number, number, "plain">;
    tags: z<string[], string[], "plain">;
    dedupeKey: z<string, string, "plain">;
    ttl: z<number, number, "plain">;
}>>, "plain">;
export interface KnowledgeUpdateInput {
    id: string;
    content?: string;
    importance?: number;
    tags?: string[];
    ttl?: number | null;
}
export interface SearchOptions {
    scope?: ScopeFilter;
    path?: string;
    budget?: {
        maxTokens?: number;
        maxItems?: number;
    };
    expand?: boolean;
    variants?: string[];
    signal?: AbortSignal;
}
export declare const SearchOptionsSchema: z<Schemastery.ObjectS<NoInfer<{
    scope: z<"workspace" | "session" | "global" | "all", "workspace" | "session" | "global" | "all", "plain">;
    path: z<string, string, "plain">;
    budget: z<Schemastery.ObjectS<NoInfer<{
        maxTokens: z<number, number, "plain">;
        maxItems: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxTokens: z<number, number, "plain">;
        maxItems: z<number, number, "plain">;
    }>>, "plain">;
    expand: z<boolean, boolean, "plain">;
    variants: z<string[], string[], "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    scope: z<"workspace" | "session" | "global" | "all", "workspace" | "session" | "global" | "all", "plain">;
    path: z<string, string, "plain">;
    budget: z<Schemastery.ObjectS<NoInfer<{
        maxTokens: z<number, number, "plain">;
        maxItems: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxTokens: z<number, number, "plain">;
        maxItems: z<number, number, "plain">;
    }>>, "plain">;
    expand: z<boolean, boolean, "plain">;
    variants: z<string[], string[], "plain">;
}>>, "plain">;
export interface ListOptions {
    cursor?: string;
    limit?: number;
    includeDeleted?: boolean;
    includeExpired?: boolean;
}
export interface KnowledgeHit {
    id: string;
    content: string;
    score: number;
    snippet: string;
    provenance?: 'original' | 'enriched';
    authorTier?: AuthorTier;
}
export interface KnowledgeMeta {
    id: string;
    content: string;
    scope: Scope;
    authorTier: AuthorTier;
    importance: number;
    dedupeKey: string | null;
    ttlSeconds: number | null;
    createdAt: number;
    updatedAt: number;
    expired: boolean;
    deleted: boolean;
}
export interface KnowledgeListResult {
    items: KnowledgeMeta[];
    nextCursor?: string;
}
/** 错误语义（镜像 DomainError 风格）：closed / missing-key / write-rejected。 */
export type KnowledgeErrorCode = 'closed' | 'missing-key' | 'write-rejected';
export interface KnowledgeError {
    error: {
        code: KnowledgeErrorCode;
        message: string;
    };
}
export type KnowledgeResult<T> = T | KnowledgeError;
export interface KnowledgeSearchResult {
    hits: KnowledgeHit[];
    /** L1 超时/失败时降级为纯词法，元数据标记（不是工具错误）。 */
    degraded: 'lexical' | null;
    expansion?: {
        used: boolean;
        source: 'live' | 'cache' | 'caller' | null;
        degraded: boolean;
        latencyMs: number;
        variantsCount: number;
        /** 降级原因（诊断用；仅降级时存在，如 'timeout: 3000ms …' / 'stream-error: …' / 'no-route: …'）。 */
        reason?: string;
    };
}
/** 打标字段：工具层所有权（调用方身份派生）。 */
export interface KnowledgeStamps {
    workspaceId: string;
    ownerId: string;
    authorTier: AuthorTier;
}
/** 检索表选择（内部）：base=仅原文（L0/L1），rich=原文+富化（L2）。 */
export type KnowledgeTable = 'base' | 'rich';
