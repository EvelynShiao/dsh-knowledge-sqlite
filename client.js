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
 * 仅依赖 shell 已提供的 react。文案内联中文（本插件面向中文场景）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-knowledge-sqlite',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React
    const inject = ['slots']

    const apiBase = (() => {
      // 用页面 base 解析而不是 origin-absolute：DSH 可能挂在反向代理子路径下（OFM 同款）。
      try { return new URL('api/knowledge-sqlite', document.baseURI).pathname } catch { return '/api/knowledge-sqlite' }
    })()
    const fetchJson = async (path, opts = {}) => {
      const res = await fetch(apiBase + path, { headers: { 'content-type': 'application/json' }, ...opts })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      return body
    }

    const styles = {
      btn: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-strong, #888)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      log: { maxHeight: 220, overflow: 'auto', fontSize: 11, lineHeight: 1.5, background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 },
      note: { opacity: 0.72, fontSize: 12 },
      err: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: 12 },
    }

    function VecCard() {
      const [st, setSt] = useState(null)
      const [selftest, setSelftest] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const load = useCallback(async () => {
        try { setSt(await fetchJson('/vec/status')) } catch (e) { setErr(String(e?.message ?? e)) }
      }, [])
      useEffect(() => { void load() }, [load])
      // 安装进行中：2s 轮询；后端 running=false（结束）后再拉一次拿最终日志。
      useEffect(() => {
        if (st?.install?.running !== true) return
        const timer = setInterval(() => { void load() }, 2000)
        return () => clearInterval(timer)
      }, [st?.install?.running, load])
      const install = async () => {
        setBusy('install'); setErr(''); setSelftest(null)
        try { await fetchJson('/vec/install', { method: 'POST' }); await load() } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
      }
      const runSelftest = async () => {
        setBusy('selftest'); setErr(''); setSelftest(null)
        try { setSelftest(await fetchJson('/vec/selftest', { method: 'POST' })) } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
      }
      if (st === null) {
        return h('div', null, err !== '' ? h('div', { style: styles.err }, `加载失败：${err}`) : '加载中…')
      }
      const running = st.install?.running === true
      return h('div', { style: { display: 'grid', gap: 8 } },
        h('div', null,
          h('strong', null, st.available === true
            ? '向量语义检索：已就绪'
            : '向量语义检索：未安装 —— 已自动降级纯词法检索，功能不受影响')),
        h('div', { style: styles.note }, `模型目录：${st.dir}`),
        st.available !== true && st.scriptPresent !== true
          ? h('div', { style: styles.err },
              '安装脚本不在插件目录。npm 发布包应附带 install-vec-runtime.*；本机也可从 git 仓库 plugin-src/dsh-knowledge-sqlite 取脚本后重试。')
          : null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          st.available !== true && st.scriptPresent === true
            ? h('button', { onClick: () => void install(), disabled: busy !== '' || running, style: styles.btn },
                running ? '安装中…（可看下方日志）' : '一键安装向量运行时（下载 ~24MB 模型）')
            : null,
          h('button', { onClick: () => void runSelftest(), disabled: busy !== '' },
            busy === 'selftest' ? '自检中…' : '跑自检（512 维 / L2≈1.0）')),
        running || (st.install?.log ?? '') !== ''
          ? h('pre', { style: styles.log }, (st.install?.log ?? '').slice(-3000) || '（等待输出…）')
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
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'knowledge-sqlite',
        order: 36,
        label: () => '知识库',
      }, () => h(VecCard)))
    }
    exports.apply = apply
    // shell 的 ModuleLoader 按本 bundle 导出的 inject 给 apply 的 ctx 挂服务（OFM/webin 同款）；
    // 缺了它 ctx.slots 是 undefined，配合 immediately:true 会在 shell 初始化期炸整页。
    exports.inject = inject
    return module.exports
  }
})
