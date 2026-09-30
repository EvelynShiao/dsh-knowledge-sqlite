import type { AuthorTier, KnowledgeListResult, KnowledgeStamps, KnowledgeTable, Scope } from './types.ts';
/** 一条存储行（含富化字段与溯源）。 */
export interface StoredItem {
    id: string;
    scope: Scope;
    workspaceId: string;
    ownerId: string;
    authorTier: AuthorTier;
    content: string;
    keywords: string | null;
    synonyms: string | null;
    questions: string | null;
    contentHash: string;
    importance: number;
    tags: string[];
    source: {
        sessionId: string;
        seq: number;
    } | null;
    dedupeKey: string | null;
    ttlSeconds: number | null;
    createdAt: number;
    updatedAt: number;
    deleted: boolean;
}
export type StoreResult<T> = T | {
    error: {
        code: 'closed' | 'missing-key' | 'write-rejected';
        message: string;
    };
};
export declare class SqliteKnowledgeStore {
    private readonly db;
    private writeChain;
    private closed;
    /** 写入上限（V1.11 enrichment.maxContentTokens 语义：seam 级写上限）。 */
    readonly maxContentTokens: number;
    private constructor();
    /** 打开（或创建）数据库。node:sqlite 动态 import：Node 22.5+ 无该内置时给出明确错误。 */
    static open(path: string, maxContentTokens?: number): Promise<SqliteKnowledgeStore>;
    close(): void;
    private enqueue;
    private rowToItem;
    private getItem;
    /** 读取单条（服务层事件用；不暴露删除/过期过滤）。 */
    get(id: string): StoredItem | undefined;
    /** dedupeKey → id（评估套件目标解析：确定性 id 是 k-<hash> 前缀）。 */
    dedupeIds(): Map<string, string>;
    /** 读扩展缓存（按 workspace 隔离；不存在/坏数据 → null）。 */
    getExpansion(wsId: string, normQuery: string): string[] | null;
    /** 写扩展缓存（upsert）。 */
    setExpansion(wsId: string, normQuery: string, variants: string[]): void;
    /** 清空扩展缓存（variance/fresh 语义：强制独立扩展）。 */
    clearExpansionCache(): void;
    private canRead;
    /**
     * 写入/upsert。stamps 由工具层派生（打标字段工具层所有）。
     * @param input 内容与元数据（不得含打标字段）
     * @param stamps 打标：workspaceId/ownerId/authorTier
     * @param allowedGlobalWriters 允许写 global scope 的 actor id 列表（agent/preset id）
     */
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
    }, stamps: KnowledgeStamps, allowedGlobalWriters: string[], actorId: string): Promise<StoreResult<{
        id: string;
        wasUpdate: boolean;
        scope: Scope;
        importance: number;
    }>>;
    /** 富化写入（trusted writer：enrichment writeback / 评估装载）。保留原打标，仅更新索引字段。 */
    enrich(id: string, fields: {
        keywords?: string[];
        synonyms?: string[];
        questions?: string[];
    }): Promise<StoreResult<{
        enriched: boolean;
    }>>;
    update(id: string, patch: {
        content?: string;
        importance?: number;
        tags?: string[];
        ttl?: number | null;
    }, caller: KnowledgeStamps & {
        sessionId: string;
    }): Promise<StoreResult<{
        updated: boolean;
    }>>;
    /**
     * 检索：topN 个候选（含 score 与 item 字段）。
     * @param texts 查询文本集合（原文 + 扩展变体）
     * @param caller 调用方（读取授权）
     * @param opts scopeFilter / topN / maxQueryTrigrams
     */
    search(table: KnowledgeTable, texts: string[], caller: KnowledgeStamps & {
        sessionId: string;
    }, opts?: {
        scope?: 'workspace' | 'session' | 'global' | 'all';
        topN?: number;
        maxQueryTrigrams?: number;
    }): Promise<Array<{
        item: StoredItem;
        score: number;
    }>>;
    private getItemByIdRow;
    /** 文档频率（cap>0 的 idf 截断用）：扫描 FTS 表内容统计（O(N)，cap 默认 0 不触发）。 */
    private dfOf;
    private docCount;
    list(scopeFilter: 'workspace' | 'session' | 'global' | 'all', opts: {
        cursor?: string;
        limit?: number;
        includeDeleted?: boolean;
        includeExpired?: boolean;
    }, caller: KnowledgeStamps & {
        sessionId: string;
    }): KnowledgeListResult;
    delete(id: string, caller: KnowledgeStamps & {
        sessionId: string;
    }): Promise<StoreResult<{
        deleted: boolean;
    }>>;
}
