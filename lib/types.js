/**
 * dsh-knowledge-sqlite — V1.11 seam contract 类型。
 *
 * npm 版 schemastery（3.18.1 fork）API 缺口记录：无 `enum`/`nullable`/`z.infer`/`.optional()`。
 * 对策（dsh-session-health 同款）：schema 对象仅作契约文档与未来 Remote 生成素材，
 * 字段不声明 optional（缺实例方法）；TS 类型手写，可选字段用 `?`。
 */
import z from '@deepseek-ai/schemastery';
// ---------- 枚举（z.const 组合；运行期校验） ----------
export const Scope = z.union([z.const('workspace'), z.const('session'), z.const('global')]);
export const ScopeFilter = z.union([z.const('workspace'), z.const('session'), z.const('global'), z.const('all')]);
export const AuthorTier = z.union([z.const('human'), z.const('explicit'), z.const('derived'), z.const('llm')]);
export const KnowledgeSourceSchema = z.object({
    sessionId: z.string(),
    seq: z.number(),
});
export const KnowledgeItemInputSchema = z.object({
    content: z.string(),
    scope: Scope,
    source: KnowledgeSourceSchema,
    importance: z.number(),
    tags: z.array(z.string()),
    dedupeKey: z.string(),
    ttl: z.number(),
});
export const SearchOptionsSchema = z.object({
    scope: ScopeFilter,
    path: z.string(),
    budget: z.object({ maxTokens: z.number(), maxItems: z.number() }),
    expand: z.boolean(),
    variants: z.array(z.string()),
});
