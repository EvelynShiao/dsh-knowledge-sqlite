import type { KnowledgeService } from './index.ts';
import type { SqliteKnowledgeStore } from './store.ts';
import type { QueryExpander } from './expand.ts';
import type { KnowledgeStamps } from './types.ts';
export interface ProbeReport {
    ok: boolean;
    parts: Array<Record<string, unknown>>;
}
export declare function runProbe(deps: {
    store: SqliteKnowledgeStore;
    expander: QueryExpander;
    service: KnowledgeService;
    corpusPath: string;
}, suite: 'seed' | 'hard' | 'human' | 'contract' | 'latency' | 'variance' | 'all', caller: {
    stamps: KnowledgeStamps;
    sessionId: string;
} | null, runs?: number): Promise<ProbeReport>;
