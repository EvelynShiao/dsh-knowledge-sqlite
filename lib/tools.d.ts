import type { Context } from '@deepseek-ai/cordis';
import type { KnowledgeService } from './index.ts';
import type { Scope } from './types.ts';
export declare function registerKnowledgeTools(ctx: Context, service: KnowledgeService): void;
/** 工具注册时暴露的 scope 类型引用（供类型检查）。 */
export type { Scope };
