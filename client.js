/**
 * dsh-knowledge-sqlite — browser half（2026-11-11）。
 *
 * Contributes one settings section (`settings.section` id `knowledge-sqlite`,
 * order 36)：向量运行时状态卡片——可用性、模型目录、一键安装（跑
 * install-vec-runtime.ps1/sh，下载 ~24MB bge 模型）、自检（512 维 / L2≈1.0）。
 *
 * 背景（用户定案「UI 层面的下载解决方案」）：向量层缺失时本插件自动降级纯词法
 * 检索、功能不受影响，但此前降级是纯静默的——用户不知道语义检索没生效、更不知
 * 道怎么补。这块卡片把状态摆出来，缺就给一键安装。
 *
 * Data rides the plugin's own same-origin `/api/knowledge-sqlite/vec/*` routes
 * (host webServer),同 OFM 的做法。手写 ModuleLoader bundle：无构建步骤，
 * 仅依赖 shell 已提供的 react。文案走宿主 locale 服务（zh/en 双字典，
 * 2026-11-12：英文界面不再露中文；缺失键回落中文）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-knowledge-sqlite',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React
    const inject = ['slots', 'locale']

    const NS = 'knowledge-sqlite:client'

    const zh = {
      label: '知识库',
      disabledTitle: '知识库插件当前处于禁用状态（宿主网关拒绝，HTTP 401）。',
      disabledHint: '到 插件管理 → dsh-knowledge-sqlite 启用后刷新本页；若反复出现，检查 profiles/web/cordis.patch.yml 是否残留 disabled: true。',
      loadFailed: '加载失败：{err}',
      loading: '加载中…',
      retry: '重试',
      copied: '已复制',
      copyPath: '复制路径',
      alertTitle: '⚠ 向量语义检索调用失败',
      alertDesc: '已自动降级纯词法检索——检索结果仍可用，但缺语义排序。失败原因：',
      lastFail: '最近失败：{at}（本次运行第 {count} 次）',
      fixing: '修复中…（看下方日志）',
      fixBtn: '一键修复（清模型强制重装）',
      selftesting: '自检中…',
      selftestRerun: '重跑自检',
      refreshStatus: '刷新状态',
      fixNote: '修复会重新下载 ~24MB 模型（hf-mirror），网络不畅可设 HF_ENDPOINT；重装完成即刻生效，无需重启。',
      statusErr: '向量语义检索：调用异常（见上方警示框）',
      statusReady: '向量语义检索：已就绪',
      statusNeedBoth: '向量语义检索：运行时与模型均未安装——已自动降级纯词法检索，功能不受影响',
      statusNeedModel: '向量语义检索：模型缺失——已自动降级纯词法检索，功能不受影响',
      statusNeedRuntime: '向量语义检索：推理运行时缺失——已自动降级纯词法检索，功能不受影响',
      prevFail: '上次一键安装未成功（exit 非 0）。可按下方「手动放置」自行补齐，或设好 NPM_REGISTRY / HF_ENDPOINT 后重试；日志见下。',
      modelDirLabel: '模型目录（实际生效路径）：',
      dirFromEnv: '目录来自环境变量 DSH_HOME——改该变量会迁移模型位置。',
      dirDefault: '未设 DSH_HOME，按默认 %LOCALAPPDATA%\\DeepSeekHarness\\.dsh 解析；设置 DSH_HOME 可迁移。',
      manualTitle: '手动放置清单（二选一：跑一键安装，或按下表自行补齐后即刻生效，无需重启）：',
      modelCheck: ' 模型权重 model_quantized.onnx（≥20MB）→ 放到目录根：',
      hfLink: 'hf-mirror 直链下载',
      hfNote: '（源 Xenova/bge-small-zh-v1.5 q8，与索引嵌入口径一致，不可换模型）',
      runtimeCheck: ' 推理运行时 @huggingface/transformers → 目录下 node_modules：',
      scriptMissing: '一键安装脚本不在插件目录。npm 发布包应附带 install-vec-runtime.*；本机也可从 git 仓库取脚本放到插件目录后用「一键安装」。',
      installRunning: '安装中…（可看下方日志）',
      installBtn: '一键安装向量运行时（下载 ~24MB 模型）',
      selftestBtn: '跑自检（512 维 / L2≈1.0）',
      waitingLog: '（等待输出…）',
    }
    const en = {
      label: 'Knowledge base',
      disabledTitle: 'The knowledge plugin is currently disabled (host gateway rejected the call, HTTP 401).',
      disabledHint: 'Enable it under Plugin Manager → dsh-knowledge-sqlite, then refresh this page. If it keeps happening, check whether profiles/web/cordis.patch.yml still contains disabled: true.',
      loadFailed: 'Load failed: {err}',
      loading: 'Loading…',
      retry: 'Retry',
      copied: 'Copied',
      copyPath: 'Copy path',
      alertTitle: '⚠ Vector semantic search call failed',
      alertDesc: 'Automatically fell back to lexical-only search — results still work, but semantic ranking is missing. Reason:',
      lastFail: 'Last failure: {at} (attempt {count} in this run)',
      fixing: 'Repairing… (see log below)',
      fixBtn: 'One-click repair (wipe model, force reinstall)',
      selftesting: 'Self-testing…',
      selftestRerun: 'Re-run self-test',
      refreshStatus: 'Refresh status',
      fixNote: 'Repair re-downloads the ~24MB model (hf-mirror). On a flaky network set HF_ENDPOINT. Takes effect immediately after reinstall — no restart needed.',
      statusErr: 'Vector semantic search: call errors (see the alert above)',
      statusReady: 'Vector semantic search: ready',
      statusNeedBoth: 'Vector semantic search: runtime and model both missing — fell back to lexical-only search; features unaffected',
      statusNeedModel: 'Vector semantic search: model missing — fell back to lexical-only search; features unaffected',
      statusNeedRuntime: 'Vector semantic search: inference runtime missing — fell back to lexical-only search; features unaffected',
      prevFail: 'Last one-click install did not succeed (non-zero exit). Either follow the manual placement checklist below, or set NPM_REGISTRY / HF_ENDPOINT and retry; log below.',
      modelDirLabel: 'Model directory (effective path):',
      dirFromEnv: 'Directory comes from the DSH_HOME environment variable — changing it relocates the model.',
      dirDefault: 'DSH_HOME is not set; resolved from the default %LOCALAPPDATA%\\DeepSeekHarness\\.dsh. Set DSH_HOME to relocate.',
      manualTitle: 'Manual placement checklist (either run one-click install, or place the files yourself as below — effective immediately, no restart):',
      modelCheck: ' model weights model_quantized.onnx (≥20MB) → into the directory root:',
      hfLink: 'Direct download from hf-mirror',
      hfNote: '(source Xenova/bge-small-zh-v1.5 q8, same embedding as the index — do not swap the model)',
      runtimeCheck: ' inference runtime @huggingface/transformers → node_modules under that directory:',
      scriptMissing: 'The one-click install script is not in the plugin directory. npm packages should ship install-vec-runtime.*; you can also fetch it from the git repo into the plugin directory, then use one-click install.',
      installRunning: 'Installing… (see log below)',
      installBtn: 'One-click install vector runtime (~24MB model download)',
      selftestBtn: 'Run self-test (512 dims / L2≈1.0)',
      waitingLog: '(waiting for output…)',
    }
    let t = (key, vars) => {
      let out = zh[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }

    const apiBase = (() => {
      // 用页面 base 解析而不是 origin-absolute：DSH 可能挂在反向代理子路径下（OFM 同款）。
      try { return new URL('api/knowledge-sqlite', document.baseURI).pathname } catch { return '/api/knowledge-sqlite' }
    })()
    const fetchJson = async (path, opts = {}) => {
      const res = await fetch(apiBase + path, { headers: { 'content-type': 'application/json' }, ...opts })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { const e = new Error(body?.error ?? `HTTP ${res.status}`); e.status = res.status; throw e }
      return body
    }

    const styles = {
      btn: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-strong, #888)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      log: { maxHeight: 220, overflow: 'auto', fontSize: 11, lineHeight: 1.5, background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 },
      note: { opacity: 0.72, fontSize: 12 },
      err: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: 12 },
      alert: { border: '1.5px solid var(--dsw-alias-state-error-primary, #d33)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d33) 10%, transparent)', borderRadius: 8, padding: 10, display: 'grid', gap: 6 },
      alertTitle: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontWeight: 700, fontSize: 13 },
    }

    function VecCard() {
      const [st, setSt] = useState(null)
      const [selftest, setSelftest] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [errStatus, setErrStatus] = useState(0)
      const [copied, setCopied] = useState(false)
      const load = useCallback(async () => {
        try { setSt(await fetchJson('/vec/status')); setErr(''); setErrStatus(0) }
        catch (e) { setErr(String(e?.message ?? e)); setErrStatus(e?.status ?? 0) }
      }, [])
      useEffect(() => { void load() }, [load])
      // 安装进行中：2s 轮询；后端 running=false（结束）后再拉一次拿最终日志。
      useEffect(() => {
        if (st?.install?.running !== true) return
        const timer = setInterval(() => { void load() }, 2000)
        return () => clearInterval(timer)
      }, [st?.install?.running, load])
      const install = async (force = false) => {
        setBusy('install'); setErr(''); setErrStatus(0); setSelftest(null)
        try {
          await fetchJson('/vec/install', { method: 'POST', body: JSON.stringify({ force }) })
          await load()
        } catch (e) { setErr(String(e?.message ?? e)); setErrStatus(e?.status ?? 0) } finally { setBusy('') }
      }
      const runSelftest = async () => {
        setBusy('selftest'); setErr(''); setErrStatus(0); setSelftest(null)
        try { setSelftest(await fetchJson('/vec/selftest', { method: 'POST' })) } catch (e) { setErr(String(e?.message ?? e)); setErrStatus(e?.status ?? 0) } finally { setBusy('') }
      }
      const copyDir = async () => {
        try { await navigator.clipboard.writeText(st?.dir ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* 剪贴板不可用时静默 */ }
      }
      // 状态拉取失败：401=插件被禁（宿主网关统一拒），给启用指引；其余给原始错误 + 重试。
      if (st === null) {
        if (errStatus === 401) {
          return h('div', { style: styles.err },
            t('disabledTitle'),
            h('div', { style: styles.note }, t('disabledHint')))
        }
        return h('div', null,
          err !== '' ? h('div', { style: styles.err }, t('loadFailed', { err })) : t('loading'),
          err !== '' ? h('button', { onClick: () => void load(), style: { ...styles.btn, marginLeft: 8 } }, t('retry')) : null)
      }
      const running = st.install?.running === true
      const needModel = st.available !== true && st.modelPresent !== true
      const needRuntime = st.available !== true && st.runtimePresent !== true
      const dirStyle = { ...styles.log, maxHeight: 'none', userSelect: 'all', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }
      const copyBtn = h('button', { onClick: () => void copyDir(), style: { ...styles.btn, padding: '2px 10px', fontSize: 11 } }, copied ? t('copied') : t('copyPath'))
      // 醒目警示框：文件在但调用失败（最隐蔽的坏法）优先于一切状态显示——降级不许静默。
      const vecErr = st.lastError
      const alertBox = vecErr
        ? h('div', { style: styles.alert },
            h('div', { style: styles.alertTitle }, t('alertTitle')),
            h('div', { style: { fontSize: 12 } },
              t('alertDesc'),
              h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, vecErr.message)),
            h('div', { style: styles.note },
              t('lastFail', { at: new Date(vecErr.at).toLocaleString(), count: vecErr.count })),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', { onClick: () => void install(true), disabled: busy !== '' || running, style: styles.btn },
                running ? t('fixing') : t('fixBtn')),
              h('button', { onClick: () => void runSelftest(), disabled: busy !== '' }, busy === 'selftest' ? t('selftesting') : t('selftestRerun')),
              h('button', { onClick: () => void load(), disabled: busy !== '', style: styles.btn }, t('refreshStatus'))),
            h('div', { style: styles.note },
              t('fixNote')))
        : null
      return h('div', { style: { display: 'grid', gap: 8 } },
        alertBox,
        h('div', null,
          h('strong', null, vecErr
            ? t('statusErr')
            : st.available === true
            ? t('statusReady')
            : needModel && needRuntime ? t('statusNeedBoth')
            : needModel ? t('statusNeedModel')
            : t('statusNeedRuntime'))),
        // 上轮一键安装失败：红字总结 + 指向下方手动路径（对齐 OFM「失败有指示」标准）。
        st.install?.ok === false
          ? h('div', { style: styles.err },
              t('prevFail'))
          : null,
        // 快捷路径 + 环境路径来源（对齐 LDW「路径可见可指定」标准）。
        h('div', null,
          h('div', { style: styles.note }, t('modelDirLabel')),
          h('div', { style: dirStyle }, h('code', { style: { wordBreak: 'break-all' } }, st.dir), copyBtn),
          h('div', { style: styles.note }, st.dshHomeSource === 'DSH_HOME'
            ? t('dirFromEnv')
            : t('dirDefault'))),
        st.available !== true
          ? h('div', null,
              h('div', { style: styles.note }, t('manualTitle')),
              h('ul', { style: { margin: '4px 0 0 18px', padding: 0, fontSize: 12, display: 'grid', gap: 4 } },
                h('li', null,
                  needModel ? '✗' : '✓', t('modelCheck'),
                  h('div', null,
                    h('a', { href: 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx', target: '_blank', rel: 'noreferrer', style: { fontSize: 12 } }, t('hfLink')),
                    t('hfNote'))),
                h('li', null,
                  needRuntime ? '✗' : '✓', t('runtimeCheck'),
                  h('code', { style: { fontSize: 11 } }, `npm install --prefix "${st.dir}" @huggingface/transformers --registry https://registry.npmmirror.com`))))
          : null,
        st.available !== true && st.scriptPresent !== true
          ? h('div', { style: styles.err },
              t('scriptMissing'))
          : null,
        st.available !== true && st.scriptPresent === true
          ? h('button', { onClick: () => void install(), disabled: busy !== '' || running, style: styles.btn },
              running ? t('installRunning') : t('installBtn'))
          : null,
        h('button', { onClick: () => void runSelftest(), disabled: busy !== '' },
          busy === 'selftest' ? t('selftesting') : t('selftestBtn')),
        running || (st.install?.log ?? '') !== ''
          ? h('pre', { style: styles.log }, (st.install?.log ?? '').slice(-3000) || t('waitingLog'))
          : null,
        selftest !== null
          ? h('pre', { style: styles.log }, `${selftest.ok === true ? '✅ PASS' : '❌ FAIL'}\n${selftest.output ?? ''}`)
          : null,
        err !== '' ? h('div', { style: styles.err }, err) : null)
    }

    function apply(ctx) {
      if (!ctx.slots) {
        // 防御：inject 声明链断裂时绝不炸 shell——丢一张卡片远好于崩整页。
        console.warn('[dsh-knowledge-sqlite] ctx.slots unavailable; settings card skipped')
        return
      }
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect?.(() => ctx.locale.register(NS, { zh, en }), NS + ': dictionaries')
          const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
          if (bound) t = (key, vars) => {
            let out = bound(key) || zh[key] || key
            if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
            return out
          }
        }
      } catch (e) { try { console.warn('[dsh-knowledge-sqlite] locale init:', e) } catch {} }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'knowledge-sqlite',
        order: 36,
        locale: NS,
        label: () => t('label'),
      }, () => h(VecCard)))
    }
    exports.apply = apply
    // shell 的 ModuleLoader 按本 bundle 导出的 inject 给 apply 的 ctx 挂服务（OFM/webin 同款）；
    // 缺了它 ctx.slots 是 undefined，配合 immediately:true 会在 shell 初始化期炸整页。
    exports.inject = inject
    return module.exports
  }
})
