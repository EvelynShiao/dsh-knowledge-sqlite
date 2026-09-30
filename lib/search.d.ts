/**
 * dsh-knowledge-sqlite — trigram 检索工具函数。
 *
 * 口径与 memory-experiment 完全一致（已在 RESEARCH/prototype 验证：
 * JS 实现与 SQLite FTS5 bm25 0/72 处 rank 不一致，SQL 层精确复现
 * RESULTS-v3 的 7%/21%/50%/65%）。
 */
import type { KnowledgeTable } from './types.ts';
/** 查询侧 grams：clean（去空白标点、ASCII 小写）后按位 3-gram（实验管线口径）。 */
export declare function queryGrams(text: string): string[];
/** 文档侧 grams：FTS5 trigram 风格（token 内 3-gram，非字母数字切分，ASCII 小写）。 */
export declare function docGrams(text: string): string[];
/**
 * 构造 FTS5 MATCH 查询：grams 全部 OR 化（长查询必须 OR；quoted 单 gram 是子串语义）。
 * @param grams 查询 gram 集合（已去重）
 */
export declare function matchOf(grams: string[]): string;
/**
 * gram 截断：生产 maxQueryTrigrams 封顶时按 idf 降序保留（顺序截断会丢失长查询
 * 判别词汇——原型实测 human A 65%→41%；idf 高的 gram 更稀有、判别力更强）。
 * @param grams 查询 gram 集合
 * @param dfOf gram → 包含它的文档数（本 workspace 可见文档）
 * @param totalDocs 文档总数
 * @param cap 0 = 不限
 */
export declare function truncateGrams(grams: string[], dfOf: Map<string, number>, totalDocs: number, cap: number): string[];
/** 命中片段：最优匹配 gram 附近 ±窗口（content 内）。 */
export declare function snippetOf(content: string, qgrams: string[]): string;
/** 命中窗口来自原文（original）还是富化字段（enriched）。 */
export declare function provenanceOf(content: string, keywords: string | null, synonyms: string | null, questions: string | null, qgrams: string[]): 'original' | 'enriched';
/** 粗略 token 估算（正式版可换 ctx.tokenMeter 估算器；CJK+ASCII 混合 ~3 字符/token）。 */
export declare function estimateTokens(text: string): number;
/** djb2 哈希 → 8 位 hex（确定性 id 与 contentHash）。 */
export declare function djb2(s: string): string;
/** 归一化查询（L1 缓存键）。 */
export declare function normalizeQuery(q: string): string;
/** 富化文本拼接（rich 表索引内容）。 */
export declare function richTextOf(fields: {
    content: string;
    keywords: string | null;
    synonyms: string | null;
    questions: string | null;
}): string;
/** FTS 表名。 */
export declare function ftsTableOf(table: KnowledgeTable): string;
