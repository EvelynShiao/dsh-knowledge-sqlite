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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteKnowledgeStore } from "./store.js";
import { QueryExpander } from "./expand.js";
import { estimateTokens, provenanceOf, queryGrams, snippetOf } from "./search.js";
import { registerKnowledgeTools } from "./tools.js";
import { runProbe } from "./probe.js";
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { vecDir, vecAvailable, lastError as vecLastError, clearError as vecClearError } from "./vec.js";
/** 插件根目录（lib/index.js 的上级）——安装脚本与自检脚本按 files 声明附带在这里。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** 一键安装的进程状态（模块级：webServer handler 与 spawn 回调共享）。 */
const vecInstall = { running: false, startedAt: 0, finishedAt: 0, ok: null, log: '' };
/** 当前活跃的 KnowledgeService 引用（模块级：供 vecApi 的 /health 只读体检分支使用）。 */
let healthServiceRef = null;
/**
 * 跑 install-vec-runtime（Windows=powershell，POSIX=bash），输出收集进 vecInstall。
 * 异步执行、立即返回——前端轮询 GET /vec/status 拿进度与日志：
 * 安装要下 24MB 模型，同步等待必撞 fetch 超时（与 OFM 冷启动同款教训）。
 */
function startVecInstall() {
    if (vecInstall.running) return false;
    const win = process.platform === 'win32';
    const script = join(PLUGIN_ROOT, win ? 'install-vec-runtime.ps1' : 'install-vec-runtime.sh');
    if (!existsSync(script)) {
        vecInstall.running = false;
        vecInstall.ok = false;
        vecInstall.startedAt = Date.now();
        vecInstall.finishedAt = Date.now();
        vecInstall.log = `安装脚本不在插件目录（${script}）。发布包应以 files 附带 install-vec-runtime.*（本仓 git clone 后存在）。`;
        return true;
    }
    vecInstall.running = true;
    vecInstall.startedAt = Date.now();
    vecInstall.finishedAt = 0;
    vecInstall.ok = null;
    vecInstall.log = '';
    const child = spawn(win ? 'powershell.exe' : 'bash',
        win ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
        { cwd: PLUGIN_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (d) => { vecInstall.log = (vecInstall.log + String(d)).slice(-16000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => { vecInstall.log += `\n[spawn] ${String(e?.message ?? e)}`; vecInstall.running = false; vecInstall.ok = false; vecInstall.finishedAt = Date.now(); });
    child.on('close', (code) => { vecInstall.running = false; vecInstall.ok = code === 0; vecInstall.finishedAt = Date.now(); vecInstall.log += `\n[exit ${code}]` + (code === 0 ? ' 安装完成——向量层惰性加载，即刻生效，无需重启。' : ' 安装失败（上方日志）。'); });
    return true;
}
/** 跑 scripts/vec-selftest.mjs（512 维 / L2≈1.0 判 PASS），同步等结果（自检秒级）。 */
function runVecSelftest() {
    return new Promise(resolve => {
        const script = join(PLUGIN_ROOT, 'scripts', 'vec-selftest.mjs');
        if (!existsSync(script)) {
            resolve({ ok: false, output: `自检脚本不在插件目录（${script}）。发布包应以 files 附带 scripts/vec-selftest.mjs。` });
            return;
        }
        let out = '';
        const child = spawn(process.execPath, [script], { cwd: PLUGIN_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 90_000);
        child.stdout?.on('data', (d) => { out += String(d); });
        child.stderr?.on('data', (d) => { out += String(d); });
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: String(e?.message ?? e) }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.slice(-8000) }); });
    });
}
/* ── queryExpansion 模型设置 ──────────────────────────────────────────────
 * 真源 = 宿主 profiles/web/cordis.patch.yml 的 knowledge-sqlite 条目。
 * chain 按顺序尝试固定模型/当前会话模型；旧 provider/model 单值读取时归一为
 * 单项 fixed 链，不主动回写。写回仍用文本级替换：备份 → 自检 → 失败回滚。 */
/** 运行中的 QueryExpander（apply 时赋值；模型设置卡保存后就地改 chain + clear()）。 */
let activeExpanderRef = null;
function dshHomeDir() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function patchYmlPath() {
    return join(dshHomeDir(), 'profiles', 'web', 'cordis.patch.yml');
}
/** YAML 值安全校验：字母数字与 . _ - /（覆盖 tiantian / deepseek-v4.1-flash / z-ai/glm-5.3-flash），拒换行冒号引号。 */
function safeYamlValue(v) {
    return typeof v === 'string' && /^[\w.\-/]+$/.test(v.trim()) ? v.trim() : null;
}
/** 定位 knowledge-sqlite 条目 + 其 queryExpansion 子块。返回 { idStart, idEnd, qeLine, qeEnd }（行号 0 基）；找不到返回 null。 */
function locateQueryExpansionBlock(lines) {
    const idStart = lines.findIndex((l) => /^\s*- id:\s*knowledge-sqlite\s*$/.test(l));
    if (idStart < 0) return null;
    let idEnd = lines.length;
    for (let i = idStart + 1; i < lines.length; i++) {
        if (/^\s*- id:/.test(lines[i])) { idEnd = i; break; }
    }
    const qeLine = lines.findIndex((l, i) => i > idStart && i < idEnd && /^\s+queryExpansion:\s*$/.test(l));
    if (qeLine < 0) return null;
    const qeIndent = lines[qeLine].match(/^\s*/)[0].length;
    let qeEnd = idEnd;
    for (let i = qeLine + 1; i < idEnd; i++) {
        const raw = lines[i];
        if (raw.trim() === '') continue;
        if (raw.match(/^\s*/)[0].length <= qeIndent) { qeEnd = i; break; }
    }
    return { idStart, idEnd, qeLine, qeEnd };
}
/** 读当前扩展模型配置；旧单值 provider/model 自动归一为单项 fixed 链。 */
function readQueryExpansionConfig() {
    const path = patchYmlPath();
    const base = { path, present: false, chain: [], provider: null, model: null, timeoutMs: null };
    if (!existsSync(path)) return base;
    try {
        const lines = readFileSync(path, 'utf8').split(/\r?\n/);
        const block = locateQueryExpansionBlock(lines);
        if (!block) return base;
        let provider = null;
        let model = null;
        let timeoutMs = null;
        let chain = [];
        let hasChain = false;
        let current = null;
        const qeIndent = lines[block.qeLine].match(/^\s*/)[0].length;
        for (let i = block.qeLine + 1; i < block.qeEnd; i++) {
            const line = lines[i];
            const indent = line.match(/^\s*/)[0].length;
            let m = line.match(/^\s+chain:\s*$/);
            if (m && indent === qeIndent + 2) {
                hasChain = true;
                current = null;
                continue;
            }
            if (hasChain && indent > qeIndent + 2) {
                m = line.match(/^\s+-\s+type:\s*(session|fixed)\s*$/);
                if (m) {
                    current = { type: m[1] };
                    chain.push(current);
                    continue;
                }
                if (current?.type === 'fixed') {
                    m = line.match(/^\s+provider:\s*(.+?)\s*$/);
                    if (m) { current.provider = m[1]; continue; }
                    m = line.match(/^\s+model:\s*(.+?)\s*$/);
                    if (m) { current.model = m[1]; continue; }
                    m = line.match(/^\s+reasoningEffort:\s*(off|low|medium|high)\s*$/);
                    if (m) { current.reasoningEffort = m[1]; continue; }
                }
            }
            if (indent !== qeIndent + 2) continue;
            m = line.match(/^\s+provider:\s*(.+?)\s*$/);
            if (m) provider = m[1] || null;
            m = line.match(/^\s+model:\s*(.+?)\s*$/);
            if (m) model = m[1] || null;
            m = line.match(/^\s+timeoutMs:\s*(.+?)\s*$/);
            if (m) { const n = Number(m[1]); if (Number.isFinite(n) && n > 0) timeoutMs = Math.round(n); }
        }
        if (!hasChain) {
            const fixedProvider = safeYamlValue(provider ?? '');
            const fixedModel = safeYamlValue(model ?? '');
            chain = fixedProvider && fixedModel ? [{ type: 'fixed', provider: fixedProvider, model: fixedModel }] : [];
        }
        const firstFixed = chain.find((item) => item.type === 'fixed');
        return { path, present: true, chain, provider: firstFixed?.provider ?? null, model: firstFixed?.model ?? null, timeoutMs };
    } catch (error) {
        return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
}
/** 写扩展模型链（文本级行替换 + 备份 + 自检 + 失败回滚）。timeoutSec 单位秒。 */
function writeQueryExpansionConfig(chain, timeoutSec = 3) {
    const path = patchYmlPath();
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split(/\r?\n/);
    const block = locateQueryExpansionBlock(lines);
    if (!block) throw new Error('cordis.patch.yml 未找到 knowledge-sqlite 条目的 queryExpansion 块——请先确认插件条目存在（首次配置请手动补块后重试）');
    const indent = lines[block.qeLine].match(/^\s*/)[0] + '  ';
    const next = [`${indent}chain:`];
    for (const item of chain) {
        next.push(`${indent}  - type: ${item.type}`);
        if (item.type === 'fixed') {
            next.push(`${indent}    provider: ${item.provider}`);
            next.push(`${indent}    model: ${item.model}`);
            if (item.reasoningEffort) next.push(`${indent}    reasoningEffort: ${item.reasoningEffort}`);
        }
    }
    next.push(`${indent}timeoutMs: ${Math.max(1, Math.round(timeoutSec)) * 1000}`);
    lines.splice(block.qeLine + 1, block.qeEnd - block.qeLine - 1, ...next);
    const out = lines.join('\n');
    const checkLines = out.split(/\r?\n/);
    const check = locateQueryExpansionBlock(checkLines);
    const checkOk = check !== null
        && /^\s*- id:\s*knowledge-sqlite\s*$/m.test(out)
        && !/\t/.test(out)
        && chain.every((item) => item.type === 'session' || (out.includes(`provider: ${item.provider}`) && out.includes(`model: ${item.model}`)));
    if (!checkOk) throw new Error('写回自检未通过（已放弃写入，原文件未动）');
    const backup = `${path}.bak-modelconfig-${Date.now()}`;
    copyFileSync(path, backup);
    try {
        writeFileSync(path, out, 'utf8');
    } catch (error) {
        try { copyFileSync(backup, path); } catch { /* 备份恢复失败也如实上报 */ }
        throw error;
    }
    return { ok: true, backup, path, chain };
}
/** 保存后就地热更运行中的 expander + 清扩展缓存。 */
function hotApplyQueryExpansion(chain) {
    const expander = activeExpanderRef;
    if (!expander) return false;
    try {
        expander.config.chain = chain;
        delete expander.config.provider;
        delete expander.config.model;
        expander.clear();
        return true;
    } catch { return false; }
}
/** /api/knowledge-sqlite/vec/* 路由（状态 / 一键安装 / 自检 / 体检）+ /model-config（扩展模型设置卡的读写）。async 读 body，与宿主 async handler 规范同（OFM 同款）。 */
async function vecApi(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const sub = (new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '')).replace(/^\/api\/knowledge-sqlite/, '') || '/';
    /* 模型设置卡：GET 回显链条；POST 校验并保存链条 + 就地热更 + 清缓存。 */
    if (req.method === 'GET' && sub === '/model-config') {
        return send(200, { ...readQueryExpansionConfig(), hotApplied: activeExpanderRef !== null });
    }
    if (req.method === 'POST' && sub === '/model-config') {
        let body = {};
        try {
            const text = await new Promise((resolve) => {
                let data = '';
                req.on('data', (c) => { data += c; if (data.length > 4096) { resolve(''); req.destroy(); } });
                req.on('end', () => resolve(data));
                req.on('error', () => resolve(''));
            });
            body = JSON.parse(text || '{}');
        } catch { body = {}; }
        if (!Array.isArray(body?.chain)) return send(400, { error: 'chain 必须是数组；每项为 session 或 fixed' });
        const chain = [];
        for (const rawItem of body.chain) {
            if (rawItem?.type === 'session') {
                chain.push({ type: 'session' });
                continue;
            }
            if (rawItem?.type !== 'fixed') return send(400, { error: 'chain 每项 type 必须为 session 或 fixed' });
            const provider = safeYamlValue(rawItem.provider ?? '');
            const model = safeYamlValue(rawItem.model ?? '');
            if (!provider || !model) return send(400, { error: 'fixed 项需要合法的 provider 与 model（字母数字 . _ - /）' });
            if (rawItem.reasoningEffort !== undefined && !['off', 'low', 'medium', 'high'].includes(rawItem.reasoningEffort)) {
                return send(400, { error: 'reasoningEffort 必须为 off、low、medium 或 high' });
            }
            chain.push({ type: 'fixed', provider, model, ...(rawItem.reasoningEffort ? { reasoningEffort: rawItem.reasoningEffort } : {}) });
        }
        /* 扩展超时：秒，1-60，缺省 3；落盘为 timeoutMs。 */
        const timeoutRaw = Number(body?.timeoutSeconds);
        const timeoutSec = Number.isFinite(timeoutRaw) ? Math.min(60, Math.max(1, Math.round(timeoutRaw))) : 3;
        try {
            const result = writeQueryExpansionConfig(chain, timeoutSec);
            const hot = hotApplyQueryExpansion(chain);
            console.log(`[knowledge-sqlite] 扩展模型链已保存 items=${chain.length} hotApply=${hot} backup=${result.backup}`);
            return send(200, { ...result, hotApplied: hot, note: hot ? '已保存并即刻生效（扩展缓存已清）' : '已写入真源；运行中的服务未能就地热更，重启 DSH 后生效' });
        } catch (error) {
            return send(500, { error: error instanceof Error ? error.message : String(error) });
        }
    }
    if (req.method === 'GET' && sub === '/vec/status') {
        const win = process.platform === 'win32';
        return send(200, {
            available: vecAvailable(),
            dir: vecDir(),
            platform: process.platform,
            // 存在性拆分：前端据此分级提示（缺模型/缺运行时）并给出对应的手动放置指引。
            modelPresent: existsSync(join(vecDir(), 'model_quantized.onnx')),
            runtimePresent: existsSync(join(vecDir(), 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')),
            // 环境路径来源：DSH_HOME 未设时回退 %LOCALAPPDATA%\DeepSeekHarness\.dsh（与安装脚本同规则）。
            dshHomeSource: process.env.DSH_HOME ? 'DSH_HOME' : 'default',
            // 最近一次向量调用失败（加载/推理/融合查询）——文件在但调用失败时前端弹醒目警示框。
            lastError: vecLastError(),
            scriptPresent: existsSync(join(PLUGIN_ROOT, win ? 'install-vec-runtime.ps1' : 'install-vec-runtime.sh')),
            install: { running: vecInstall.running, startedAt: vecInstall.startedAt, finishedAt: vecInstall.finishedAt, ok: vecInstall.ok, log: vecInstall.log.slice(-8000) },
        });
    }
    if (req.method === 'POST' && sub === '/vec/install') {
        if (vecInstall.running) return send(409, { error: '安装已在进行中，请等待本轮结束' });
        // force=true：先删模型文件（权重副本 + model/ 整树）再跑脚本——调用失败/自检 FAIL 的修复路径；
        // 脚本幂等只在文件缺失时下载，不先删就只会跳过。npm 运行时不动（损坏场景少，自检会暴露）。
        let force = false;
        try {
            const raw = await new Promise((resolve) => {
                let data = '';
                req.on('data', (c) => { data += c; if (data.length > 4096) { resolve(''); req.destroy(); } });
                req.on('end', () => resolve(data));
                req.on('error', () => resolve(''));
                setTimeout(() => resolve(data), 2000);
            });
            force = JSON.parse(raw || '{}')?.force === true;
        }
        catch { /* body 解析失败按非 force 处理 */ }
        if (force) {
            try {
                const d = vecDir();
                rmSync(join(d, 'model_quantized.onnx'), { force: true });
                rmSync(join(d, 'model'), { recursive: true, force: true });
                vecClearError();
                vecInstall.log = '[force] 已清除模型文件，开始重新下载…\n';
            }
            catch (e) {
                return send(500, { started: false, error: `清除旧模型失败：${String(e?.message ?? e)}` });
            }
        }
        const started = startVecInstall();
        return send(started ? 202 : 500, { started, log: vecInstall.log });
    }
    if (req.method === 'POST' && sub === '/vec/selftest') {
        return void runVecSelftest().then((r) => send(200, r));
    }
    /* 统一体检（B/C 段，只读）：知识库 items/FTS/向量缺口 + 同库 arch_* 档案层。
       服务未就绪时也返回结构化响应（前端给「服务未加载」提示），绝不抛 500。 */
    if (req.method === 'POST' && sub === '/health/rebuild-fts') {
        const svc = healthServiceRef;
        if (!svc) return send(503, { ok: false, error: 'knowledge service not ready' });
        try {
            return send(200, { ok: true, value: svc.store.rebuildFts() });
        }
        catch (e) {
            return send(500, { ok: false, error: String(e?.message ?? e) });
        }
    }
    if (sub === '/prompt-config') {
        const svc = healthServiceRef;
        if (!svc) return send(503, { ok: false, error: 'knowledge service not ready' });
        if (req.method === 'GET') return send(200, { ok: true, value: { ...DEFAULT_PROMPT_CONFIG, ...(svc.store.getPromptConfig() ?? {}) } });
        if (req.method === 'POST') {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            try {
                const body = JSON.parse(raw || '{}');
                const value = {
                    enabled: body.enabled === true,
                    customText: String(body.customText ?? '').slice(0, 20000),
                    searchDescription: String(body.searchDescription ?? '').slice(0, 4000),
                    archivesDescription: String(body.archivesDescription ?? '').slice(0, 4000),
                };
                svc.store.setPromptConfig(value);
                svc.refreshPromptToolDescriptions?.();
                return send(200, { ok: true, value });
            }
            catch (e) { return send(400, { ok: false, error: String(e?.message ?? e) }); }
        }
    }
    if (req.method === 'GET' && sub === '/health') {
        const svc = healthServiceRef;
        if (!svc) return send(200, { ok: true, value: { ready: false } });
        try {
            return send(200, { ok: true, value: { ready: true, ...svc.store.healthSnapshot() } });
        }
        catch (e) {
            return send(200, { ok: true, value: { ready: true, error: String(e?.message ?? e) } });
        }
    }
    send(404, { error: `unknown route ${req.method} ${sub}` });
}
/**
 * 跨设备工作区键：取路径尾部两段（如 work/Evelyn），屏蔽盘符/根目录差异。
 * 电脑 C:\Users\...\.dsh\work\Evelyn 与手机 /data/.../.dsh/work/Evelyn
 * 归一后同键 → 同一知识库；不同工作区（work/1 等）仍然隔离。
 * 其他工作区（如 default-workspace）不会串。不是全局可见，只对同名工作区共享。
 */
function workspaceKey(p) {
    const norm = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0)
        return norm;
    return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
}
export function defaultDbPath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'knowledge.sqlite');
}
/** probe 语料默认目录：包内 fixture（lib/index.js → ../tests/fixtures/corpus），随包发布。
    0.1.10 摘樱桃：此前默认指 research/memory-knowledge-seam/...（部署态必 ENOENT）。 */
export function defaultCorpusPath() {
    return join(PLUGIN_ROOT, 'tests', 'fixtures', 'corpus');
}
/**
 * 默认提示词注入文案（config.systemPrompt.text 未设时使用）。
 *
 * 目的：让模型在回答前知道有跨会话知识库可用、以及检索的几个硬约束
 * （trigram 中文子串 ≥3 字；查询扩展超时只降级不报错；向量层缺模型时静默降级）。
 *
 * 2026-10-18 扩充（用户定案）：本库是「两层语料、各查各的」——
 *   · 第一层 items（knowledge_* 工具）
 *   · 第二层 arch_* 对话档案（archives_search 工具，同库不同表）
 * 原文案只讲了第一层，模型不知道有原始对话档案可翻，导致需要原话/上下文时
 * 不去查档案层。同时补两条纪律：
 *   ① 现场执行类事实（文件数、目录内容、命令输出）不在任何一层，必须实际执行工具；
 *   ② 写完回查一次验证入索引（写入回执带 vectorized 字段）。
 *
 * 写"先检索再回答"而非"必须检索"，避免在无关问答上强制多一次工具调用。
 */
export const DEFAULT_SYSTEM_PROMPT_TEXT = [
    '跨会话知识检索：两层语料，按问题类型选择工具。',
    '',
    '知识条目（items）',
    '- knowledge_search 检索既有结论、偏好、经历与项目事实；knowledge_list / knowledge_tags 浏览与审计。',
    '- 中文 trigram 查询需 ≥3 字；两字短词请补足上下文或换同义说法。默认 L1 查询扩展，超时降级词法检索。',
    '- knowledge_write 写入；knowledge_update / knowledge_delete 修正与删除。',
    '',
    '对话档案（arch_*）',
    '- archives_search 检索原始对话片段：要原话、上下文或某轮具体说法时使用；支持语义检索，知识层查不到时可在这里找原文。',
    '',
    '检索纪律',
    '- 涉及跨会话事实时先检索再回答；两层都查不到就明确说没有记录，不要编造。',
    '- 文件数量、目录内容、命令输出、当前运行状态等现场事实必须实际调用工具获取。',
    '- 写入后可用 knowledge_search 回查确认入索引。',
].join('\n');
export const DEFAULT_PROMPT_CONFIG = Object.freeze({
    enabled: false,
    customText: '',
    searchDescription: '【知识条目】检索跨会话沉淀的结论、偏好、经历与项目事实。查不到时可去 archives_search 找原始对话出处；现场执行类事实必须实际调用工具获取。',
    archivesDescription: '【对话档案】检索跨会话原始对话片段：要原话、上下文或某轮具体说法时使用；支持语义检索，返回原文与出处。现场执行类事实必须实际调用工具获取。',
});
export class KnowledgeService extends Service {
    static inject = ['agents'];
    store;
    expander;
    promptDescriptions() {
        const custom = this.store.getPromptConfig() ?? {};
        return {
            search: typeof custom.searchDescription === 'string' && custom.searchDescription.trim() !== '' ? custom.searchDescription : DEFAULT_PROMPT_CONFIG.searchDescription,
            archives: typeof custom.archivesDescription === 'string' && custom.archivesDescription.trim() !== '' ? custom.archivesDescription : DEFAULT_PROMPT_CONFIG.archivesDescription,
        };
    }
    config;
    constructor(ctx, store, expander, config) {
        super(ctx, 'knowledge');
        this.store = store;
        this.expander = expander;
        this.config = config;
    }
    // ============ 调用方派生（工具层所有权：打标字段来自执行上下文，绝不来自参数） ============
    caller() {
        const agents = this.ctx.get('agents');
        const agent = agents?.currentInitiator();
        if (agent === undefined || agent === null)
            return null;
        let workspaceId = null;
        try {
            workspaceId = agent.session?.header?.cwd ?? null;
        }
        catch {
            workspaceId = null;
        }
        if (workspaceId === null || workspaceId === undefined)
            return null;
        const sessionId = agent.session?.id ?? agent.id;
        // global 写 allowlist 的 actor：agent/preset id（V1.11：稳定跨会话重建）
        let presetId;
        try {
            const presets = this.ctx.get('agentPresets');
            presetId = presets?.composedPreset(agent.ctx);
        }
        catch {
            presetId = undefined;
        }
        return {
            // 归一化：电脑与手机路径前缀不同，取尾部两段后同键
            stamps: { workspaceId: workspaceKey(workspaceId), ownerId: sessionId, authorTier: 'explicit' },
            sessionId,
            actorId: presetId ?? agent.id,
        };
    }
    requireCaller() {
        const caller = this.caller();
        if (caller === null) {
            throw Object.assign(new Error('knowledge requires an agent execution context'), { code: 'write-rejected' });
        }
        return caller;
    }
    readCaller() {
        return this.caller();
    }
    /** 发射 knowledge/* 事件（自定义事件名，绕过 cordis Events 键类型）。 */
    emit(name, payload) {
        ;
        this.ctx.emit(name, payload);
    }
    // ============ V1.11 契约 ============
    async write(input) {
        const caller = this.requireCaller();
        return this.doWrite(input, caller);
    }
    async update(input) {
        const caller = this.requireCaller();
        return this.doUpdate(input, caller);
    }
    async search(query, opts = {}) {
        const caller = this.readCaller();
        if (caller === null)
            return { hits: [], degraded: null };
        return this.doSearch(query, opts, caller, 'items_fts_rich');
    }
    async list(scope, opts = {}) {
        const caller = this.readCaller();
        if (caller === null)
            return { items: [] };
        const result = this.store.list(scope, opts, { ...caller.stamps, sessionId: caller.sessionId });
        // 工具层 JSON 校验拒绝 undefined 字段
        if (result.nextCursor === undefined)
            delete result.nextCursor;
        return result;
    }
    /** 标签目录树（图书馆式逐层浏览）。prefix 空串 = 顶层。 */
    async listTags(opts = {}) {
        const caller = this.readCaller();
        if (caller === null)
            return { prefix: '', tags: [] };
        return this.store.listTags({ prefix: opts.prefix, scope: opts.scope, limit: opts.limit }, { ...caller.stamps, sessionId: caller.sessionId });
    }
    async delete(id) {
        const caller = this.requireCaller();
        const result = await this.store.delete(id, { ...caller.stamps, sessionId: caller.sessionId });
        if (!('error' in result) && result.deleted === true) {
            const item = this.store.get(id);
            this.emit('knowledge/deleted', { id, scope: item?.scope ?? 'workspace' });
        }
        return result;
    }
    /**
     * 向量层自检 / 回填（knowledge_vec 工具）。只读 + 补索引，不改条目内容。
     * @param mode 'check' 只列缺口；'backfill' 补齐
     */
    async vecMaintenance(mode, opts = {}) {
        const limit = Math.max(1, Math.min(Number(opts.limit) || 500, 5000));
        if (mode === 'backfill') {
            const r = await this.store.backfillVec(limit);
            return { mode, ...r };
        }
        const ids = this.store.missingVecIds(limit);
        if (ids === null)
            return { mode: 'check', available: false, missing: [], missingCount: 0 };
        return { mode: 'check', available: true, missing: ids, missingCount: ids.length };
    }
    // ============ 内部（trusted writer / probe / 测试） ============    /** Trusted internal writer（V1.11 注册 writer 类：probe 装载/富化回写/评估）。 */
    async _seedWrite(input, stamps) {
        const actorId = stamps.ownerId;
        const result = await this.store.write({ content: input.content, scope: input.scope, dedupeKey: input.dedupeKey, importance: input.importance, ttl: input.ttl }, stamps, this.config.authorization.allowedGlobalWriters, actorId);
        if ('error' in result)
            return result;
        this.emit('knowledge/written', { id: result.id, scope: result.scope, importance: result.importance });
        return { id: result.id };
    }
    async _seedUpdate(id, patch, stamps) {
        if (patch.scope !== undefined) {
            return { error: { code: 'write-rejected', message: 'scope/dedupeKey are immutable after write (V1.11)' } };
        }
        const result = await this.store.update(id, patch, { ...stamps, sessionId: stamps.ownerId });
        if ('error' in result)
            return result;
        this.emit('knowledge/updated', { id, scope: 'workspace' });
        return result;
    }
    async _seedDelete(id, stamps) {
        const result = await this.store.delete(id, { ...stamps, sessionId: stamps.ownerId });
        if ('error' in result)
            return result;
        this.emit('knowledge/deleted', { id, scope: 'workspace' });
        return result;
    }
    async _seedList(opts, stamps) {
        return this.store.list('all', opts, { ...stamps, sessionId: stamps.ownerId });
    }
    /** 内部检索（probe 评估：table 可为 base/rich；stamps 可覆盖以测隔离）。 */
    async _searchInternal(query, opts, stampsOverride) {
        const caller = stampsOverride !== undefined
            ? { stamps: stampsOverride, sessionId: stampsOverride.ownerId, actorId: stampsOverride.ownerId }
            : this.readCaller();
        if (caller === null)
            return { hits: [], degraded: null };
        const table = opts.table === 'items_fts_base' ? 'items_fts_base' : 'items_fts_rich';
        return this.doSearch(query, opts, caller, table);
    }
    async _dedupeIds() {
        return this.store.dedupeIds();
    }
    // ============ 内部实现 ============
    async doWrite(input, caller) {
        const result = await this.store.write(input, caller.stamps, this.config.authorization.allowedGlobalWriters, caller.actorId);
        if ('error' in result)
            return result;
        this.emit('knowledge/written', { id: result.id, scope: result.scope, importance: result.importance });
        // vectorized: false 表示本条只有词法索引、无向量（模型/表缺失）——
        // 调用方据此可决定是否重试或提示；正常环境恒为 true。
        return { ...result, vectorized: result.vectorized === true };
    }
    async doUpdate(input, caller) {
        if (input.scope !== undefined || input.dedupeKey !== undefined) {
            return { error: { code: 'write-rejected', message: 'scope/dedupeKey are immutable after write (V1.11)' } };
        }
        const result = await this.store.update(input.id, input, { ...caller.stamps, sessionId: caller.sessionId });
        if ('error' in result)
            return result;
        const item = await this.store.get(input.id);
        this.emit('knowledge/updated', { id: input.id, scope: item?.scope ?? 'workspace' });
        return result;
    }
    async doSearch(query, opts, caller, table) {
        if (typeof query !== 'string' || query.trim() === '')
            return { hits: [], degraded: null };
        const expand = opts.expand !== false;
        let variants = Array.isArray(opts.variants) ? opts.variants : null;
        let expansion;
        let degraded = null;
        if (variants === null && expand && this.config.queryExpansion.enabled) {
            const e = await this.expander.expand(query, opts.signal, caller.stamps.workspaceId);
            variants = e.variants;
            if (e.degraded)
                degraded = 'lexical';
            expansion = { used: true, source: e.source, degraded: e.degraded, latencyMs: e.latencyMs, variantsCount: variants.length };
            /* 0.1.10 摘樱桃：扩展降级原因透出（配合 expand.js 的结构化 reason） */
            if (e.reason !== undefined)
                expansion.reason = e.reason;
            // 2026-10-31：路由明细透传到工具回包（失败可见，红线「不许静默降级」）
            if (e.routeDetail !== undefined)
                expansion.routeDetail = e.routeDetail;
        }
        else if (variants !== null && variants.length > 0) {
            expansion = { used: true, source: 'caller', degraded: false, latencyMs: 0, variantsCount: variants.length };
        }
        const texts = variants !== null && variants.length > 0 ? [query, ...variants] : [query];
        const rows = await this.store.search(table === 'items_fts_base' ? 'base' : 'rich', texts, { ...caller.stamps, sessionId: caller.sessionId }, {
            scope: opts.scope,
            tags: opts.tags,
            topN: this.config.retrieval.topN,
            maxQueryTrigrams: this.config.retrieval.maxQueryTrigrams,
        });
        const maxItems = opts.budget?.maxItems ?? this.config.retrieval.topN;
        const qgrams = queryGrams(texts.join(' '));
        const hits = [];
        let tokens = 0;
        for (const r of rows) {
            if (hits.length >= maxItems)
                break;
            const item = r.item;
            // score 归一化：Math.round 可能产出 -0（极小 bm25 分数），工具层 JSON 校验拒绝 -0/NaN
            const rounded = Math.round(r.score * 1000) / 1000;
            const score = Object.is(rounded, -0) || !Number.isFinite(rounded) ? 0 : rounded;
            hits.push({
                id: item.id,
                content: item.content,
                score,
                snippet: snippetOf(item.content, qgrams),
                provenance: provenanceOf(item.content, item.keywords, item.synonyms, item.questions, qgrams),
                authorTier: item.authorTier,
            });
            if (opts.budget?.maxTokens !== undefined) {
                tokens += estimateTokens(item.content);
                if (tokens > opts.budget.maxTokens)
                    break;
            }
        }
        // 工具层 JSON 校验拒绝 undefined 字段——返回对象只含已定义字段
        const result = { hits, degraded };
        if (expansion !== undefined)
            result.expansion = expansion;
        // 向量调用失败透传到工具回包（红线「不许静默降级」）：AI 能看到并向用户转述修复入口。
        const vecErr = vecLastError();
        if (vecErr)
            result.vecNotice = `向量语义检索调用失败（已自动降级纯词法，检索结果仍可用但缺语义排序）：${vecErr.message}；修复入口：设置页 → 知识库卡片（一键修复/自检）。`;
        return result;
    }
    // ============ 实验套件探针（阶段 3 门禁 e2e） ============
    async probe(suite, opts = {}) {
        // fresh：清扩展缓存——单轮方差需要独立扩展（缓存会杀死随机性）
        if (opts.fresh === true)
            this.expander.clear();
        const caller = this.readCaller();
        const workspaceId = caller?.stamps.workspaceId;
        const corpusPath = workspaceId !== undefined
            ? (this.config.corpusPath.startsWith('/') ? this.config.corpusPath : join(workspaceId, this.config.corpusPath))
            : this.config.corpusPath;
        return runProbe({ store: this.store, expander: this.expander, service: this, corpusPath }, suite, caller, opts.runs ?? 10);
    }
}
// ---------- 插件入口 ----------
export const name = 'dsh-knowledge-sqlite';
/**
 * cordis loader 插件形状：loader 的 unwrapExports 后直接 registry.plugin(default)，
 * 函数会被当作插件 body 调用（工厂形态的 default 会被静默忽略——apply 从不执行）。
 * 因此 default 必须是插件对象（inject + apply），config 经 apply 第二参注入。
 */
const knowledgeSqlitePlugin = {
    inject: ['tools', 'agents', 'timer'],
    async apply(ctx, config = {}) {
        {
            const resolved = {
                gating: config.gating ?? 'ask',
                databasePath: config.databasePath ?? defaultDbPath(),
                corpusPath: config.corpusPath ?? defaultCorpusPath(),
                maxContentTokens: config.maxContentTokens ?? 2048,
                queryExpansion: {
                    enabled: config.queryExpansion?.enabled ?? true,
                    /* 与记忆蒸馏同语义：按链尝试；旧单值 provider/model 仍兼容。 */
                    chain: config.queryExpansion?.chain,
                    provider: config.queryExpansion?.provider,
                    model: config.queryExpansion?.model,
                    maxOutputTokens: config.queryExpansion?.maxOutputTokens ?? 300,
                    timeoutMs: config.queryExpansion?.timeoutMs ?? 3000,
                    cache: config.queryExpansion?.cache ?? true,
                },
                retrieval: {
                    topN: config.retrieval?.topN ?? 20,
                    maxQueryTrigrams: config.retrieval?.maxQueryTrigrams ?? 0, // 0 = 不限（对齐实验基线；生产可设 24，见 README）
                    maxCandidates: config.retrieval?.maxCandidates ?? 200,
                },
                authorization: {
                    allowedGlobalWriters: config.authorization?.allowedGlobalWriters ?? [],
                },
                systemPrompt: {
                    enabled: config.systemPrompt?.enabled ?? true,
                    text: typeof config.systemPrompt?.text === 'string' ? config.systemPrompt.text : '',
                    order: Number.isFinite(config.systemPrompt?.order) ? config.systemPrompt.order : 950,
                },
            };
            const store = await SqliteKnowledgeStore.open(resolved.databasePath, resolved.maxContentTokens);
            ctx.effect(() => () => store.close());
            /* 本机个性化说明存 knowledge.sqlite（随 knowledge 同步组走），仓库默认保持通用。
               首次从旧硬编码迁移；已有配置绝不覆盖。 */
            if (store.getPromptConfig() === null && /DeepSeekHarness[\\/]\.dsh$/i.test(String(process.env.DSH_HOME ?? ''))) {
                store.setPromptConfig({
                    enabled: true,
                    customText: '本机两层语料主要收录 Evelyn 与 Lyma 相关经历、对话与 AI 聊天沉淀；技术操作、学习任务、通用百科不必为此调用知识工具。',
                    searchDescription: '【知识条目】检索 Evelyn 与 Lyma 相关的结论、经历、偏好与 AI 聊天沉淀。技术操作/通用百科不在库中；查不到时去 archives_search 找原文。',
                    archivesDescription: '【对话档案】检索 Evelyn 与 Lyma 相关的原始对话（05 DeepSeek、02/03 第N个AI、01 ChatGPT、04 幻想等）。要原话/上下文/某轮说法时使用；支持语义检索。',
                });
            }
            /* 启动自愈：主表有数据而 FTS 为空时全量重放，避免知识库“有内容但词法零命中”。 */
            try {
                const repair = store.ensureFtsHealthy();
                if (repair.rebuilt > 0) ctx.logger?.warn?.(`[knowledge-sqlite] rebuilt empty FTS indexes for ${repair.rebuilt} items`);
            } catch (error) {
                ctx.logger?.warn?.('[knowledge-sqlite] FTS startup health check failed:', error);
            }
            const expander = new QueryExpander(ctx, {
                enabled: resolved.queryExpansion.enabled,
                chain: resolved.queryExpansion.chain,
                provider: resolved.queryExpansion.provider,
                model: resolved.queryExpansion.model,
                maxOutputTokens: resolved.queryExpansion.maxOutputTokens,
                timeoutMs: resolved.queryExpansion.timeoutMs,
                cache: resolved.queryExpansion.cache,
            }, {
                get: (wsId, norm) => store.getExpansion(wsId, norm),
                set: (wsId, norm, variants) => store.setExpansion(wsId, norm, variants),
                clear: () => store.clearExpansionCache(),
            });
            activeExpanderRef = expander; // 模型设置卡保存后就地热更用（免重启）
            const service = new KnowledgeService(ctx, store, expander, resolved);
            healthServiceRef = service; // 供 /api/knowledge-sqlite/health 只读体检（vecApi 模块级访问）
            // 注：cordis Service 构造器已通过 ctx.reflect.provide 注册 'knowledge'，勿再 ctx.provide
            registerKnowledgeTools(ctx, service);
            /* 工具 description 在 defineTool 注册时复制；保存 UI 配置后需同步已注册定义，
               否则系统提示变了而工具目录仍旧文案。下一步 wireSchemas 会读到新值。 */
            const refreshPromptToolDescriptions = () => {
                const descriptions = service.promptDescriptions();
                const toolsService = ctx.get?.('tools', false);
                const layers = toolsService?.layers;
                const candidates = [];
                if (layers?.global) candidates.push(layers.global);
                if (layers?.scoped instanceof Map) candidates.push(...layers.scoped.values());
                for (const layer of candidates) {
                    const tools = layer?.tools;
                    if (!tools || typeof tools.get !== 'function') continue;
                    const search = tools.get('knowledge_search');
                    const archives = tools.get('archives_search');
                    if (search) search.description = descriptions.search;
                    if (archives) archives.description = descriptions.archives;
                }
            };
            refreshPromptToolDescriptions();
            service.refreshPromptToolDescriptions = refreshPromptToolDescriptions;
            // ask 门控（V1.11 批准层，默认开）：knowledge_write/delete 是跨会话持久变更，需要用户确认。
            // headless（approval=never）自动拒绝——config gating 替代交互确认。
            // gating: 'none'（部署配置）跳过门控：模型写入自动放行（信任模型场景）。
            if (resolved.gating === 'ask') {
                ctx.on('tools/pre-execute', (exec, next) => {
                    if (exec.name === 'knowledge_write' || exec.name === 'knowledge_delete') {
                        return Promise.resolve({ kind: 'ask', reason: '知识库写入/删除是跨会话持久变更（V1.11 ask 门控）' });
                    }
                    return Promise.resolve(next());
                });
            }
            // 提示词注入（可选）：把知识库使用说明挂进系统提示词。
            // 用 ctx.get 软读而非 inject——systemPrompt 服务缺失时静默跳过，
            // 不让本插件转 INACTIVE（inject 是硬依赖，缺一服务即整插件失效）。
            if (resolved.systemPrompt.enabled) {
                const systemPrompt = ctx.get('systemPrompt');
                if (systemPrompt) {
                    ctx.effect(() => systemPrompt.section({
                        name: 'knowledge-sqlite:usage',
                        order: resolved.systemPrompt.order,
                        text: () => {
                            const prompt = store.getPromptConfig() ?? {};
                            const custom = typeof prompt.customText === 'string' ? prompt.customText.trim() : '';
                            const base = resolved.systemPrompt.text.trim() !== '' ? resolved.systemPrompt.text : DEFAULT_SYSTEM_PROMPT_TEXT;
                            return [base, custom].filter(Boolean).join('\n\n自定义资料说明\n');
                        },
                    }), 'knowledge-sqlite.systemPrompt()');
                }
            }
            // 向量运行时状态/安装/自检 API（2026-11-11，用户定案「UI 层面的下载解决方案」）：
            // webServer 必须走 inject fiber——apply 时它尚未发布（插件先于浏览器半区装载），
            // 直接 ctx.get('webServer') 是 undefined、路由永远注册不上（OFM 实锤过的坑）。
            ctx.inject(['webServer'], scoped => {
                scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: '/api/knowledge-sqlite', handler: vecApi }), 'knowledge-sqlite: vec api routes');
            });
        }
    },
};
export default knowledgeSqlitePlugin;
