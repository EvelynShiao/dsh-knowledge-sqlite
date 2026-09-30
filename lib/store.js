/**
 * dsh-knowledge-sqlite — SQLite provider（V1.11 存储层）。
 *
 * 蓝本：research/memory-knowledge-seam/experiments/prototype/sqlite-trigram-verify.mjs（已验证精确复现 RESULTS-v3 数字）：
 *  - items 表 + 非部分唯一索引 (workspace_id, scope, dedupe_key)（SQLite NULL 互不冲突）
 *  - upsert 用 ON CONFLICT DO UPDATE（保持 rowid 稳定 → FTS rowid 链接有效；
 *    不可用 INSERT OR REPLACE——rowid 变化会断 FTS 链接）
 *  - 双 FTS5 trigram 表：items_fts_base（仅 content）/ items_fts_rich（content+富化拼接）
 *  - 检索：grams OR 化 → MATCH → JOIN items 过滤 deleted/TTL/授权 → bm25 排序 → topN
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { djb2, docGrams, estimateTokens, matchOf, queryGrams, richTextOf, truncateGrams } from "./search.js";
function err(code, message) {
    return { error: { code, message } };
}
/**
 * 跨设备工作区键：取路径尾部两段（work/Evelyn），屏蔽盘符与系统根目录差异。
 * 电脑 C:\Users\...\.dsh\work\Evelyn 与安卓 /data/.../.dsh/work/Evelyn 归一后同键，
 * 其他工作区（work/1、default-workspace）依旧隔离——不是全局可见，只对同名工作区共享。
 */
function wsKey(p) {
    const norm = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0)
        return norm;
    return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
}
function normCaller(c) {
    return c ? { ...c, workspaceId: wsKey(c.workspaceId) } : c;
}
function normStamps(s) {
    return s ? { ...s, workspaceId: wsKey(s.workspaceId) } : s;
}
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    owner_id     TEXT,
    author_tier  TEXT NOT NULL,
    content      TEXT NOT NULL,
    keywords     TEXT,
    synonyms     TEXT,
    questions    TEXT,
    content_hash TEXT,
    importance   INTEGER NOT NULL DEFAULT 5,
    tags         TEXT,
    source       TEXT,
    dedupe_key   TEXT,
    ttl_seconds  INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_items_scope_ws ON items(scope, workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_items_dedupe ON items(workspace_id, scope, dedupe_key);
  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts_base USING fts5(content, tokenize='trigram');
  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts_rich USING fts5(content, tokenize='trigram');
  -- L1 扩展缓存持久化（0.1.5）：按 workspace 隔离；跨进程/重启复用，命中 0 延迟零降级
  CREATE TABLE IF NOT EXISTS expansion_cache (
    ws_id      TEXT NOT NULL,
    query      TEXT NOT NULL,
    variants   TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ws_id, query)
  );
`;
export class SqliteKnowledgeStore {
    db;
    writeChain = Promise.resolve();
    closed = false;
    /** 写入上限（V1.11 enrichment.maxContentTokens 语义：seam 级写上限）。 */
    maxContentTokens;
    constructor(db, maxContentTokens) {
        this.db = db;
        this.maxContentTokens = maxContentTokens;
    }
    /** 打开（或创建）数据库。node:sqlite 动态 import：Node 22.5+ 无该内置时给出明确错误。 */
    static async open(path, maxContentTokens = 2048) {
        let DatabaseSyncCtor;
        try {
            const mod = await import('node:sqlite');
            DatabaseSyncCtor = mod.DatabaseSync;
        }
        catch {
            throw new Error('dsh-knowledge-sqlite: node:sqlite is unavailable — requires Node.js >= 22.5 (or --experimental-sqlite)');
        }
        mkdirSync(dirname(path), { recursive: true });
        const db = new DatabaseSyncCtor(path);
        db.exec(SCHEMA);
        // 迁移：早期库缺 source 列（0.1.0 前的开发库）
        try {
            db.exec('ALTER TABLE items ADD COLUMN source TEXT');
        }
        catch {
            // 列已存在
        }
        return new SqliteKnowledgeStore(db, maxContentTokens);
    }
    close() {
        this.closed = true;
        try {
            this.db.close();
        }
        catch { /* idempotent */ }
    }
    // ---------- 写链（V1.11：write/update/delete 串行化） ----------
    enqueue(fn) {
        const next = this.writeChain.then(fn, fn);
        this.writeChain = next.catch(() => undefined);
        return next;
    }
    // ---------- 内部映射 ----------
    rowToItem(row) {
        return {
            id: String(row.id),
            scope: row.scope,
            workspaceId: String(row.workspace_id),
            ownerId: row.owner_id === null ? '' : String(row.owner_id),
            authorTier: row.author_tier,
            content: String(row.content),
            keywords: row.keywords === null ? null : String(row.keywords),
            synonyms: row.synonyms === null ? null : String(row.synonyms),
            questions: row.questions === null ? null : String(row.questions),
            contentHash: row.content_hash === null ? '' : String(row.content_hash),
            importance: Number(row.importance),
            tags: row.tags === null || row.tags === '' ? [] : JSON.parse(String(row.tags)),
            source: row.source === null || row.source === undefined || row.source === ''
                ? null
                : JSON.parse(String(row.source)),
            dedupeKey: row.dedupe_key === null ? null : String(row.dedupe_key),
            ttlSeconds: row.ttl_seconds === null ? null : Number(row.ttl_seconds),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            deleted: Number(row.deleted) === 1,
        };
    }
    getItem(id) {
        const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
        return row === undefined ? undefined : this.rowToItem(row);
    }
    /** 读取单条（服务层事件用；不暴露删除/过期过滤）。 */
    get(id) {
        if (this.closed)
            return undefined;
        const item = this.getItem(id);
        return item !== undefined && !item.deleted ? item : undefined;
    }
    /** dedupeKey → id（评估套件目标解析：确定性 id 是 k-<hash> 前缀）。 */
    dedupeIds() {
        const map = new Map();
        if (this.closed)
            return map;
        const rows = this.db.prepare('SELECT dedupe_key, id FROM items WHERE dedupe_key IS NOT NULL').all();
        for (const r of rows)
            map.set(r.dedupe_key, r.id);
        return map;
    }
    // ---------- L1 扩展缓存持久化（0.1.5） ----------
    /** 读扩展缓存（按 workspace 隔离；不存在/坏数据 → null）。 */
    getExpansion(wsId, normQuery) {
        if (this.closed)
            return null;
        const row = this.db.prepare('SELECT variants FROM expansion_cache WHERE ws_id = ? AND query = ?')
            .get(wsId, normQuery);
        if (row === undefined)
            return null;
        try {
            const v = JSON.parse(row.variants);
            if (!Array.isArray(v))
                return null;
            const valid = v.filter((x) => typeof x === 'string' && x.length > 0);
            return valid.length > 0 ? valid : null; // 空/全非字符串 = 坏数据，按未命中
        }
        catch {
            return null; // 坏数据按未命中处理，下次扩展覆盖
        }
    }
    /** 写扩展缓存（upsert）。 */
    setExpansion(wsId, normQuery, variants) {
        if (this.closed)
            return;
        this.db.prepare(`
      INSERT INTO expansion_cache (ws_id, query, variants, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(ws_id, query) DO UPDATE SET variants = excluded.variants, updated_at = excluded.updated_at
    `).run(wsId, normQuery, JSON.stringify(variants), Date.now());
    }
    /** 清空扩展缓存（variance/fresh 语义：强制独立扩展）。 */
    clearExpansionCache() {
        if (this.closed)
            return;
        this.db.prepare('DELETE FROM expansion_cache').run();
    }
    // ---------- 授权（V1.11 读取面：workspace 本区 + session 属主 + global；写面由调用方打标） ----------
    canRead(item, caller) {
        if (item.scope === 'workspace')
            return wsKey(item.workspaceId) === wsKey(caller.workspaceId);
        if (item.scope === 'session')
            return item.ownerId === caller.sessionId;
        if (item.scope === 'global')
            return true;
        return false;
    }
    // ---------- write ----------
    /**
     * 写入/upsert。stamps 由工具层派生（打标字段工具层所有）。
     * @param input 内容与元数据（不得含打标字段）
     * @param stamps 打标：workspaceId/ownerId/authorTier
     * @param allowedGlobalWriters 允许写 global scope 的 actor id 列表（agent/preset id）
     */
    write(input, stamps, allowedGlobalWriters, actorId) {
        if (this.closed)
            return Promise.resolve(err('closed', 'knowledge store is closing'));
        stamps = normStamps(stamps);
        return this.enqueue(() => {
            const forged = input;
            if (forged.workspaceId !== undefined || forged.ownerId !== undefined || forged.authorTier !== undefined) {
                return err('write-rejected', 'stamp fields (workspaceId/ownerId/authorTier) are tool-layer-owned');
            }
            if (typeof input.content !== 'string' || input.content.trim().length === 0) {
                return err('write-rejected', 'content is required');
            }
            if (estimateTokens(input.content) > this.maxContentTokens) {
                return err('write-rejected', `content exceeds maxContentTokens (${this.maxContentTokens})`);
            }
            const scope = input.scope ?? 'workspace';
            if (scope !== 'workspace' && scope !== 'session' && scope !== 'global') {
                return err('write-rejected', `invalid scope: ${scope}`);
            }
            if (scope === 'global' && !allowedGlobalWriters.includes(actorId)) {
                return err('write-rejected', 'global scope requires allowedGlobalWriters membership');
            }
            const importance = Math.max(1, Math.min(10, Math.round(input.importance ?? 5)));
            const now = Date.now();
            const dedupeKey = typeof input.dedupeKey === 'string' && input.dedupeKey.length > 0 ? input.dedupeKey : null;
            const id = dedupeKey !== null
                ? `k-${djb2(`${stamps.workspaceId}\u0000${scope}\u0000${dedupeKey}`)}`
                : `i-${djb2(`${stamps.workspaceId}\u0000${scope}\u0000${now}\u0000${randomUUID()}`)}`;
            const tags = Array.isArray(input.tags) ? input.tags : [];
            const ttlSeconds = typeof input.ttl === 'number' ? input.ttl : null;
            const source = input.source ?? null;
            const existing = this.getItem(id);
            this.db.prepare(`
        INSERT INTO items
          (id, scope, workspace_id, owner_id, author_tier, content, keywords, synonyms, questions,
           content_hash, importance, tags, source, dedupe_key, ttl_seconds, created_at, updated_at, deleted)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(workspace_id, scope, dedupe_key) DO UPDATE SET
          id = excluded.id, content = excluded.content,
          content_hash = excluded.content_hash, importance = excluded.importance,
          tags = excluded.tags, source = excluded.source,
          ttl_seconds = excluded.ttl_seconds, updated_at = excluded.updated_at,
          deleted = 0
      `).run(id, scope, stamps.workspaceId, stamps.ownerId, stamps.authorTier, input.content, djb2(input.content), importance, JSON.stringify(tags), source === null ? null : JSON.stringify(source), dedupeKey, ttlSeconds, now, now);
            const rowid = this.db.prepare('SELECT rowid FROM items WHERE id = ?').get(id).rowid;
            // FTS 同步：upsert 后 rowid 不变（ON CONFLICT DO UPDATE），OR REPLACE 按 rowid 幂等
            this.db.prepare('INSERT OR REPLACE INTO items_fts_base(rowid, content) VALUES (?, ?)').run(rowid, input.content);
            this.db.prepare('INSERT OR REPLACE INTO items_fts_rich(rowid, content) VALUES (?, ?)').run(rowid, input.content);
            return { id, wasUpdate: existing !== undefined, scope, importance };
        });
    }
    /** 富化写入（trusted writer：enrichment writeback / 评估装载）。保留原打标，仅更新索引字段。 */
    enrich(id, fields) {
        if (this.closed)
            return Promise.resolve(err('closed', 'knowledge store is closing'));
        return this.enqueue(() => {
            const item = this.getItem(id);
            if (item === undefined || item.deleted)
                return err('missing-key', `unknown id: ${id}`);
            this.db.prepare(`
        UPDATE items SET keywords = ?, synonyms = ?, questions = ?, updated_at = ?
        WHERE id = ?
      `).run(fields.keywords?.join(' ') ?? item.keywords, fields.synonyms?.join(' ') ?? item.synonyms, fields.questions?.join(' ') ?? item.questions, Date.now(), id);
            const rowid = this.db.prepare('SELECT rowid FROM items WHERE id = ?').get(id).rowid;
            this.db.prepare('INSERT OR REPLACE INTO items_fts_rich(rowid, content) VALUES (?, ?)')
                .run(rowid, richTextOf({
                content: item.content,
                keywords: fields.keywords?.join(' ') ?? item.keywords,
                synonyms: fields.synonyms?.join(' ') ?? item.synonyms,
                questions: fields.questions?.join(' ') ?? item.questions,
            }));
            return { enriched: true };
        });
    }
    // ---------- update ----------
    update(id, patch, caller) {
        if (this.closed)
            return Promise.resolve(err('closed', 'knowledge store is closing'));
        return this.enqueue(() => {
            const item = this.getItem(id);
            if (item === undefined || item.deleted)
                return err('missing-key', `unknown id: ${id}`);
            if (!this.canRead(item, caller))
                return err('write-rejected', 'caller is not authorized for this item');
            const content = patch.content ?? item.content;
            if (patch.content !== undefined) {
                if (typeof patch.content !== 'string' || patch.content.trim().length === 0) {
                    return err('write-rejected', 'content must be a non-empty string');
                }
                if (estimateTokens(patch.content) > this.maxContentTokens) {
                    return err('write-rejected', `content exceeds maxContentTokens (${this.maxContentTokens})`);
                }
            }
            this.db.prepare(`
        UPDATE items SET
          content = ?, content_hash = ?, importance = ?, tags = ?, ttl_seconds = ?, updated_at = ?
        WHERE id = ?
      `).run(content, djb2(content), Math.max(1, Math.min(10, Math.round(patch.importance ?? item.importance))), JSON.stringify(patch.tags ?? item.tags), patch.ttl !== undefined ? patch.ttl : item.ttlSeconds, Date.now(), id);
            const rowid = this.db.prepare('SELECT rowid FROM items WHERE id = ?').get(id).rowid;
            this.db.prepare('INSERT OR REPLACE INTO items_fts_base(rowid, content) VALUES (?, ?)').run(rowid, content);
            this.db.prepare('INSERT OR REPLACE INTO items_fts_rich(rowid, content) VALUES (?, ?)')
                .run(rowid, richTextOf({ content, keywords: item.keywords, synonyms: item.synonyms, questions: item.questions }));
            return { updated: true };
        });
    }
    // ---------- search ----------
    /**
     * 检索：topN 个候选（含 score 与 item 字段）。
     * @param texts 查询文本集合（原文 + 扩展变体）
     * @param caller 调用方（读取授权）
     * @param opts scopeFilter / topN / maxQueryTrigrams
     */
    async search(table, texts, caller, opts = {}) {
        if (this.closed)
            return [];
        caller = normCaller(caller);
        const topN = Math.max(1, Math.min(opts.topN ?? 20, 200));
        const fts = table === 'rich' ? 'items_fts_rich' : 'items_fts_base';
        const grams = new Set();
        const cleans = [];
        for (const t of texts) {
            const clean = String(t).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
            if (clean.length > 0)
                cleans.push(clean);
            for (const g of queryGrams(t))
                grams.add(g);
        }
        if (grams.size === 0 && cleans.length === 0)
            return [];
        // 生产封顶：idf 优先截断（dfOf 从 fts5vocab 读取；不可用时回退顺序截断——cap 默认 0）
        let qgrams = [...grams];
        const cap = opts.maxQueryTrigrams ?? 0;
        if (cap > 0) {
            const dfOf = this.dfOf(fts);
            qgrams = truncateGrams(qgrams, dfOf, this.docCount(fts), cap);
        }
        const now = Date.now();
        const scopeSql = opts.scope === undefined || opts.scope === 'all'
            ? ''
            : ' AND i.scope = ?';
        const tagList = Array.isArray(opts.tags)
            ? opts.tags.filter((t) => typeof t === 'string' && t.length > 0)
            : [];
        // 目录语义：命中该路径**及其全部子路径**（"自然科学/物理" 也命中 "自然科学/物理/光学"）
        const tagClause = tagList.length > 0
            ? `EXISTS (SELECT 1 FROM json_each(COALESCE(i.tags, '[]')) je WHERE ${tagList.map(() => '(je.value = ? OR substr(je.value, 1, ?) = ?)').join(' OR ')})`
            : '';
        /** 每个标签 -> 3 个绑定值（精确 / 长度 / 前缀段） */
        const tagParams = [];
        for (const t of tagList) {
            tagParams.push(t, t.length + 1, t + '/');
        }
        const matched = new Map();
        // ---- 1) 主路：FTS5 trigram（查询需 ≥3 字才有 gram）----
        if (qgrams.length > 0) {
            const params = [matchOf(qgrams), now, caller.workspaceId, caller.sessionId];
            if (scopeSql !== '')
                params.push(opts.scope);
            params.push(...tagParams);
            params.push(topN);
            const sql = `
      SELECT f.rowid, bm25(${fts}) AS score
      FROM ${fts} f JOIN items i ON i.rowid = f.rowid
      WHERE f.${fts} MATCH ?
        AND i.deleted = 0
        AND (i.ttl_seconds IS NULL OR i.created_at + i.ttl_seconds * 1000 > ?)
        AND (
          (i.scope = 'workspace' AND i.workspace_id = ?)
          OR (i.scope = 'session' AND i.owner_id = ?)
          OR (i.scope = 'global')
        )
        ${scopeSql}${tagClause !== '' ? ' AND ' + tagClause : ''}
      ORDER BY score LIMIT ?
    `;
            try {
                for (const r of this.db.prepare(sql).all(...params))
                    matched.set(r.rowid, r.score);
            }
            catch { /* 主路失败不阻断兜底 */ }
        }
        // ---- 2) 兜底：子串扫描。trigram 对 ≤2 字的中文查询切不出任何 gram，
        //      4~8 字的查询也会因 OR 语义漏掉字面命中——用 LIKE 补齐（本地库规模小，可承受）----
        const minLen = cleans.length > 0 ? Math.min(...cleans.map((c) => c.length)) : Number.POSITIVE_INFINITY;
        if (grams.size === 0 || minLen <= 8) {
            const hay = "lower(coalesce(i.content,'') || ' ' || coalesce(i.keywords,'') || ' ' || coalesce(i.synonyms,'') || ' ' || coalesce(i.questions,'') || ' ' || coalesce(i.tags,''))";
            const likes = cleans.map((c) => `${hay} LIKE ?`);
            if (likes.length > 0) {
                const lwhere = [
                    'i.deleted = 0',
                    '(i.ttl_seconds IS NULL OR i.created_at + i.ttl_seconds * 1000 > ?)',
                    "((i.scope = 'workspace' AND i.workspace_id = ?) OR (i.scope = 'session' AND i.owner_id = ?) OR (i.scope = 'global'))",
                    `(${likes.join(' OR ')})`,
                ];
                const lparams = [now, caller.workspaceId, caller.sessionId, ...cleans.map((c) => '%' + c + '%')];
                if (scopeSql !== '') {
                    lwhere.push('i.scope = ?');
                    lparams.push(opts.scope);
                }
                if (tagClause !== '') {
                    lwhere.push(tagClause);
                    lparams.push(...tagParams);
                }
                lparams.push(topN * 3);
                try {
                    for (const r of this.db.prepare(`SELECT i.rowid AS rowid FROM items i WHERE ${lwhere.join(' AND ')} ORDER BY i.importance DESC, i.updated_at DESC LIMIT ?`).all(...lparams)) {
                        if (!matched.has(r.rowid))
                            matched.set(r.rowid, 0);
                    }
                }
                catch { /* 兜底失败不影响主路结果 */ }
            }
        }
        const rows = [];
        for (const [rowid, score] of matched) {
            if (rows.length >= topN)
                break;
            rows.push({ rowid, score });
        }
        return rows.map((r) => ({ item: this.getItemByIdRow(r.rowid), score: r.score }));
    }
    getItemByIdRow(rowid) {
        const row = this.db.prepare('SELECT * FROM items WHERE rowid = ?').get(rowid);
        return this.rowToItem(row);
    }
    /** 文档频率（cap>0 的 idf 截断用）：扫描 FTS 表内容统计（O(N)，cap 默认 0 不触发）。 */
    dfOf(fts) {
        const map = new Map();
        try {
            const rows = this.db.prepare(`SELECT content FROM ${fts}`).all();
            for (const r of rows) {
                for (const g of new Set(docGrams(r.content)))
                    map.set(g, (map.get(g) ?? 0) + 1);
            }
        }
        catch {
            // 空表或不可用 → 空 map，truncateGrams 退化为顺序截断
        }
        return map;
    }
    docCount(fts) {
        try {
            const row = this.db.prepare(`SELECT count(*) AS c FROM ${fts}`).get();
            return Number(row.c);
        }
        catch {
            return 0;
        }
    }
    // ---------- list ----------
    list(scopeFilter, opts, caller) {
        if (this.closed)
            return { items: [] };
        caller = normCaller(caller);
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
        const offset = typeof opts.cursor === 'string' && /^\d+$/.test(opts.cursor) ? Number(opts.cursor) : 0;
        const now = Date.now();
        const where = [];
        const params = [];
        if (opts.includeDeleted !== true)
            where.push('i.deleted = 0');
        if (opts.includeExpired !== true) {
            where.push('(i.ttl_seconds IS NULL OR i.created_at + i.ttl_seconds * 1000 > ?)');
            params.push(now);
        }
        where.push(`(
      (i.scope = 'workspace' AND i.workspace_id = ?)
      OR (i.scope = 'session' AND i.owner_id = ?)
      OR (i.scope = 'global')
    )`);
        params.push(caller.workspaceId, caller.sessionId);
        if (scopeFilter !== 'all') {
            where.push('i.scope = ?');
            params.push(scopeFilter);
        }
        const tagList = Array.isArray(opts.tags)
            ? opts.tags.filter((t) => typeof t === 'string' && t.length > 0)
            : [];
        if (tagList.length > 0) {
            // 目录语义：该路径及其全部子路径
            where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(i.tags, '[]')) je WHERE ${tagList.map(() => '(je.value = ? OR substr(je.value, 1, ?) = ?)').join(' OR ')})`);
            for (const t of tagList)
                params.push(t, t.length + 1, t + '/');
        }
        params.push(limit + 1, offset);
        const sql = `
      SELECT i.* FROM items i
      WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `;
        const rows = this.db.prepare(sql).all(...params);
        const items = rows.slice(0, limit).map((row) => {
            const item = this.rowToItem(row);
            return {
                id: item.id,
                content: item.content,
                scope: item.scope,
                authorTier: item.authorTier,
                importance: item.importance,
                tags: item.tags,
                dedupeKey: item.dedupeKey,
                ttlSeconds: item.ttlSeconds,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                expired: item.ttlSeconds !== null && item.createdAt + item.ttlSeconds * 1000 <= now,
                deleted: item.deleted,
            };
        });
        const nextCursor = rows.length > limit ? String(offset + limit) : undefined;
        return { items, nextCursor };
    }
    /**
     * 标签目录树（图书馆式逐层浏览）。
     * 标签按 '/' 作为路径分隔符（如 "自然科学/物理/量子科学"）。
     * @param opts { prefix?: 上一层路径（空串=顶层）, scope?, limit? }
     * @param caller 调用方（读取授权）
     */
    listTags(opts = {}, caller) {
        if (this.closed)
            return { prefix: '', tags: [] };
        caller = normCaller(caller);
        const now = Date.now();
        const where = [
            'i.deleted = 0',
            '(i.ttl_seconds IS NULL OR i.created_at + i.ttl_seconds * 1000 > ?)',
            "((i.scope = 'workspace' AND i.workspace_id = ?) OR (i.scope = 'session' AND i.owner_id = ?) OR (i.scope = 'global'))",
        ];
        const params = [now, caller.workspaceId, caller.sessionId];
        if (opts.scope !== undefined && opts.scope !== 'all') {
            where.push('i.scope = ?');
            params.push(opts.scope);
        }
        let prefix = typeof opts.prefix === 'string' ? opts.prefix : '';
        if (prefix !== '' && !prefix.endsWith('/'))
            prefix += '/'; // 容错：用户传 "文学" 等价于 "文学/"
        const rows = this.db.prepare(`SELECT i.tags AS tags FROM items i WHERE ${where.join(' AND ')}`).all(...params);
        /** key -> { count: 涉及条目数, items: 本节点直接条目数 } */
        const nodes = new Map();
        for (const r of rows) {
            let arr = [];
            try {
                const v = JSON.parse(String(r.tags ?? '[]'));
                if (Array.isArray(v))
                    arr = v;
            }
            catch { arr = []; }
            /** 这一行落在哪些下一层节点上（一行只给每层计一次） */
            const touched = new Map();
            for (const raw of arr) {
                const s = String(raw);
                if (s.length === 0)
                    continue;
                if (prefix !== '' && !s.startsWith(prefix))
                    continue;
                const rel = prefix === '' ? s : s.slice(prefix.length);
                const head = rel.split('/')[0];
                if (head === '')
                    continue;
                const key = prefix + head;
                touched.set(key, (touched.get(key) ?? 0) + 1);
            }
            for (const [key, add] of touched) {
                const node = nodes.get(key) ?? { count: 0, items: 0 };
                node.count += add;
                if (arr.includes(key))
                    node.items += 1;
                nodes.set(key, node);
            }
        }
        const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
        const tags = [...nodes.entries()]
            .map(([tag, v]) => ({
                tag,
                count: v.count,
                items: v.items,
                children: v.count > v.items,
                path: tag,
            }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
            .slice(0, limit);
        return { prefix, tags };
    }
    // ---------- delete ----------
    delete(id, caller) {
        if (this.closed)
            return Promise.resolve(err('closed', 'knowledge store is closing'));
        return this.enqueue(() => {
            const item = this.getItem(id);
            if (item === undefined)
                return err('missing-key', `unknown id: ${id}`);
            if (!this.canRead(item, caller))
                return err('write-rejected', 'caller is not authorized for this item');
            if (item.ttlSeconds !== null && item.createdAt + item.ttlSeconds * 1000 <= Date.now()) {
                return { deleted: false }; // 过期条目 delete → false（V1.11）
            }
            this.db.prepare('UPDATE items SET deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
            return { deleted: true };
        });
    }
}
