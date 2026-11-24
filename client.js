/**
 * dsh-knowledge-sqlite — browser half（2026-11-11）。
 *
 * Contributes one settings section (`settings.section` id `knowledge-sqlite`,
 * order 36)，三张卡片：
 *   VecCard   — 向量运行时状态：可用性、模型目录、一键安装（跑 install-vec-runtime.ps1/sh，
 *               下载 ~24MB bge 模型）、自检（512 维 / L2≈1.0）；
 *   ModelCard — 模型设置（2026-11-23）：知识库检索（L1 查询扩展）用哪个模型——
 *               跟随当前会话模型或专用 provider/model，真源 cordis.patch.yml 的
 *               queryExpansion 块（/api/knowledge-sqlite/model-config 读写）；
 *   HealthCard — 记忆与知识库体检（A 记忆库段在 session-kit 插件未启用时自动隐藏）。
 *
 * 会话标题生成模型的设置不在本插件（放 adapter-compat 的 exit 面板）——它不属于知识库。
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
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useState, useEffect, useCallback } = React
    /* ── ModelSelect：仿 MemorySelect（分组下拉 + 可搜索 + 选中勾）────────────── */
    function ModelSelect({ value, options, disabled, placeholder, ariaLabel, onChange, searchable = false, searchPlaceholder }) {
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const rootRef = React.useRef(null)
      const searchInputRef = React.useRef(null)
      const normalizedOptions = (Array.isArray(options) ? options : []).map((option) => ({ ...option, id: String(option.value) }))
      const selected = normalizedOptions.find((option) => option.id === String(value))
      const label = selected?.composed || selected?.label || placeholder || ''
      const trimmedQuery = query.trim().toLowerCase()
      const visibleOptions = !searchable || trimmedQuery === ''
        ? normalizedOptions
        : normalizedOptions.filter((option) => String(option.label ?? '').toLowerCase().includes(trimmedQuery) || String(option.composed ?? '').toLowerCase().includes(trimmedQuery))
      React.useEffect(() => {
        if (!open) { setQuery(''); return undefined }
        const onPointerDown = (event) => {
          if (!(event.target instanceof Node)) return
          if (rootRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      React.useEffect(() => {
        if (!open || !searchable) return undefined
        const id = typeof window !== 'undefined' ? window.requestAnimationFrame(() => searchInputRef.current?.focus()) : 0
        return () => { if (typeof window !== 'undefined') window.cancelAnimationFrame(id) }
      }, [open, searchable])
      const selectOption = (option) => {
        if (option.disabled) return
        setOpen(false)
        onChange?.(option.value)
      }
      return h('span', { ref: rootRef, className: 'dsh-chain-select-root' },
        h(primitives.Button, {
          variant: 'outline', size: 'md', disabled,
          className: 'dsh-chain-select-button',
          onClick: () => { if (!disabled) setOpen((current) => !current) },
          'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-label': ariaLabel || placeholder || label,
        },
          h('span', { className: 'dsh-chain-select-label', title: label }, label),
          h('span', { className: `dsh-chain-select-chevron${open ? ' dsh-chain-select-chevron-open' : ''}`, 'aria-hidden': 'true' },
            h(primitives.IconChevronDownOutlineRegular, { size: 14 }))),
        open && h('div', { className: 'dsh-chain-select-panel', role: 'menu' },
          searchable && h('div', { className: 'dsh-chain-select-search' },
            h('span', { className: 'dsh-chain-select-search-icon', 'aria-hidden': 'true' }, h(primitives.IconSearchOutlineRegular, { size: 14 })),
            h('input', {
              ref: searchInputRef, type: 'text', className: 'dsh-chain-select-search-input',
              value: query, placeholder: searchPlaceholder || placeholder || '',
              'aria-label': searchPlaceholder || ariaLabel || placeholder || '',
              onChange: (event) => setQuery(event.currentTarget.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && visibleOptions.length > 0 && !visibleOptions[0].disabled) {
                  event.preventDefault()
                  selectOption(visibleOptions[0])
                }
              },
              onClick: (event) => event.stopPropagation(),
              onPointerDown: (event) => event.stopPropagation(),
            })),
          visibleOptions.length === 0
            ? h('div', { className: 'dsh-chain-select-empty' }, '—')
            : (() => {
              /* 分组渲染：连续同 group 的选项归为一节，节前插组头（provider 名）。 */
              const sections = []
              for (const option of visibleOptions) {
                const group = typeof option.group === 'string' && option.group !== '' ? option.group : ''
                const last = sections[sections.length - 1]
                if (last === undefined || last.group !== group) sections.push({ group, items: [option] })
                else last.items.push(option)
              }
              return sections.map((section) => h(React.Fragment, { key: section.group || '__ungrouped__' },
                section.group !== '' && h('div', { className: 'dsh-chain-select-group-label' }, section.group),
                section.items.map((option) => h('button', {
                  key: option.id, type: 'button', role: 'menuitem', disabled: option.disabled,
                  className: 'dsh-chain-select-option',
                  'data-selected': option.id === selected?.id || undefined,
                  onClick: () => selectOption(option),
                },
                  h('span', { className: 'dsh-chain-select-option-label', title: option.composed || option.label }, option.label),
                  option.id === selected?.id && h(primitives.IconCheckOutlineRegular, { size: 16 })))))
            })()
          ))
    }

    /* ── 模型目录 hook：与蒸馏同源（ctx.modelDirectories.directoryFor(当前会话)）─────
       目录不可用时返回 groups=[]、status='unavailable'，调用方降级为手输 provider/model。 */
    function useModelDirectory(ctx) {
      const emptyState = React.useMemo(() => ({ current: null, groups: [], status: 'idle', error: null }), [])
      const [state, setState] = React.useState(emptyState)
      React.useEffect(() => {
        let disposed = false
        let retryTimer = null
        let unsubscribe
        let attempts = 0
        const resolveSessionId = () => {
          let sessionId = ''
          const sessions = ctx?.sessions
          /* 与 session-kit 同一把尺子：list 快照中 retainedBy.mainView > 0 的主视图会话。
             兼容其他宿主形态；每一路径独立捕获，拿不到 id 时保持空串并由 directoryFor 外层捕获。 */
          for (const store of [sessions?.list, sessions?.store, sessions]) {
            if (!store || sessionId) continue
            try {
              const snapshot = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : store
              const byId = snapshot?.byId ?? snapshot?.sessions ?? null
              if (byId && typeof byId === 'object') {
                const current = Object.values(byId).find((session) => (session?.retainedBy?.mainView ?? 0) > 0)
                if (current?.id) sessionId = String(current.id)
              }
              if (!sessionId) {
                const current = snapshot?.currentId ?? snapshot?.current
                const id = current && typeof current === 'object' ? current.id ?? current.sessionId : current
                if (id !== undefined && id !== null && String(id)) sessionId = String(id)
              }
            } catch { /* ignore */ }
          }
          for (const key of ['current', 'currentId', 'active', 'activeId', 'currentSessionId']) {
            if (sessionId) break
            try {
              const candidate = sessions?.[key]
              const value = typeof candidate === 'function' ? candidate.call(sessions) : candidate
              const id = value && typeof value === 'object' ? value.id ?? value.sessionId : value
              if (id !== undefined && id !== null && String(id)) sessionId = String(id)
            } catch { /* ignore */ }
          }
          return sessionId
        }
        const attempt = () => {
          if (disposed) return
          attempts += 1
          let directory
          try {
            directory = ctx?.modelDirectories?.directoryFor?.(resolveSessionId())
          } catch { directory = undefined }
          const store = directory?.store
          if (!store) {
            setState({ ...emptyState, status: 'unavailable' })
            if (attempts < 3) retryTimer = setTimeout(attempt, 1500)
            return
          }
          setState(store.getSnapshot?.() ?? emptyState)
          unsubscribe = store.subscribe?.(() => {
            if (!disposed) setState(store.getSnapshot?.() ?? emptyState)
          })
          try {
            const snap = store.getSnapshot?.()
            if (snap?.status === 'idle') void directory.load?.().catch(() => undefined)
          } catch { /* ignore */ }
        }
        attempt()
        return () => {
          disposed = true
          if (retryTimer !== null) clearTimeout(retryTimer)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [ctx, emptyState])
      return state
    }

    /* ── ChainEditor：链条编辑器（与蒸馏链条卡逐项同构）──────────────────────────
       props: { chain, onChange(nextChain), directory:{groups,status}, t(key), busy,
                followLabel, addLabel, reasoningLabel, providerDefaultLabel } */
    function ChainEditor(props) {
      const { chain, onChange, directory, t, busy } = props
      const items = Array.isArray(chain) ? chain : []
      const safeGroups = Array.isArray(directory?.groups) ? directory.groups : []
      /* 可用判据 = 目录里有模型（groups 非空）。宿主目录快照的 status 字段值不稳定
         （实测 ready 之外还有别的形态），只看 status 会把已加载误判为不可用。 */
      const directoryReady = safeGroups.length > 0
      const setItem = (index, next) => {
        const copy = [...items]
        copy[index] = next
        onChange(copy)
      }
      const move = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= items.length) return
        const copy = [...items]
        ;[copy[target], copy[index]] = [copy[index], copy[target]]
        onChange(copy)
      }
      const remove = (index) => onChange(items.filter((_, i) => i !== index))
      const addFixed = () => onChange([...items, { type: 'fixed', provider: '', model: '', reasoningEffort: undefined }])

      const rows = items.map((item, index) => {
        const isSession = item.type === 'session'
        const modelOptions = [
          { value: '__follow_session__', label: props.followLabel, composed: props.followLabel },
          ...safeGroups.flatMap((group) => (Array.isArray(group?.models) ? group.models : []).map((model) => ({
            value: `${group?.id ?? ''}\u001F${model?.id ?? ''}`,
            label: model?.name || model?.id,
            group: group?.name || group?.id,
            composed: `${group?.name || group?.id} / ${model?.name || model?.id}`,
          }))),
        ]
        const handleModelPick = (combined) => {
          if (combined === '__follow_session__') { setItem(index, { type: 'session' }); return }
          const sep = String(combined ?? '').indexOf('\u001F')
          if (sep < 0) return
          const provider = String(combined).slice(0, sep)
          const model = String(combined).slice(sep + 1)
          if (!provider || !model) return
          setItem(index, { ...items[index], type: 'fixed', provider, model })
        }
        /* 思考度选项：按目录里该模型的 reasoning.efforts 出（与蒸馏同款）；
           目录里没有该模型/无 reasoning 信息时不渲染此行。 */
        const selectedGroup = safeGroups.find((group) => group.id === item.provider)
        const selectedModel = (Array.isArray(selectedGroup?.models) ? selectedGroup.models : []).find((model) => model.id === item.model)
        const reasoningOptions = selectedModel?.reasoning ? [
          ...(selectedModel.reasoning.defaultEffort === undefined ? [{ value: '', label: props.providerDefaultLabel }] : []),
          ...(Array.isArray(selectedModel.reasoning.efforts) ? selectedModel.reasoning.efforts : []).map((effort) => ({ value: effort.id, label: effort.name || effort.id })),
        ] : []
        return h('div', { key: index, className: 'dsh-chain-item' },
          h('div', { className: 'dsh-chain-item-header' },
            h('span', { className: 'dsh-chain-item-index' }, `#${index + 1}`),
            h('span', { className: isSession ? 'dsh-chain-item-type-session' : 'dsh-chain-item-type-fixed' },
              isSession ? t('chainSession') : t('chainFixed')),
            h('div', { className: 'dsh-chain-item-actions' },
              index > 0 && h(primitives.Button, { variant: 'ghost', size: 'sm', icon: h(primitives.IconChevronUpOutlineRegular, { size: 14 }), onClick: () => move(index, -1), 'aria-label': t('chainMoveUp') }),
              index < items.length - 1 && h(primitives.Button, { variant: 'ghost', size: 'sm', icon: h(primitives.IconChevronDownOutlineRegular, { size: 14 }), onClick: () => move(index, 1), 'aria-label': t('chainMoveDown') }),
              h(primitives.Button, { variant: 'ghost', size: 'sm', icon: h(primitives.IconTrashOutlineRegular, { size: 14 }), onClick: () => remove(index), 'aria-label': t('chainDelete') }))),
          h('div', { className: 'dsh-chain-item-fields' },
            h('label', { className: 'dsh-chain-field' },
              h('span', null, t('chainModel')),
              h(ModelSelect, {
                value: isSession ? '__follow_session__' : (item.provider && item.model ? `${item.provider}\u001F${item.model}` : ''),
                options: modelOptions,
                disabled: busy || !directoryReady,
                placeholder: safeGroups.length === 0 && directory?.status !== 'unavailable' ? t('chainModelsLoading') : t('chainNoModels'),
                ariaLabel: t('chainModel'),
                searchable: true,
                searchPlaceholder: t('chainSearchModels'),
                onChange: handleModelPick,
              })),
            /* 目录不可用时的兜底：手输 provider/model，保证任何环境都能配置。 */
            !directoryReady && !isSession && h('div', { className: 'dsh-chain-manual' },
              h('input', {
                className: 'dsh-chain-manual-input', placeholder: 'provider',
                value: item.provider ?? '',
                onChange: (e) => setItem(index, { ...items[index], provider: e.target.value }),
              }),
              h('input', {
                className: 'dsh-chain-manual-input', placeholder: 'model',
                value: item.model ?? '',
                onChange: (e) => setItem(index, { ...items[index], model: e.target.value }),
              })),
            !isSession && reasoningOptions.length > 0 && h('label', { className: 'dsh-chain-field' },
              h('span', null, props.reasoningLabel),
              h(ModelSelect, {
                value: item.reasoningEffort || '',
                options: reasoningOptions,
                disabled: busy,
                placeholder: props.providerDefaultLabel,
                ariaLabel: props.reasoningLabel,
                onChange: (effort) => setItem(index, { ...items[index], reasoningEffort: effort || undefined }),
              }))))
      })

      return h('div', { className: 'dsh-chain-editor' },
        ...rows,
        h(primitives.Button, { variant: 'outline', className: 'dsh-chain-add', disabled: busy, onClick: addFixed }, props.addLabel))
    }

    /* ── 样式：注入一次（与蒸馏链条卡同款外观，类名加 dsh-chain- 前缀避免撞宿主）── */
    const CHAIN_EDITOR_CSS = `
.dsh-chain-editor { display: flex; flex-direction: column; gap: 10px; }
.dsh-chain-item { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); }
.dsh-chain-item-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dsh-chain-item-index { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 600; }
.dsh-chain-item-type-session, .dsh-chain-item-type-fixed { flex: none; font-size: 11px; line-height: 16px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-chain-item-type-fixed { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.dsh-chain-item-actions { display: inline-flex; gap: 4px; }
.dsh-chain-item-fields { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-chain-field { display: grid; gap: 4px; font-size: 12px; }
.dsh-chain-add { align-self: flex-start; margin-top: 4px; font-weight: 600; }
.dsh-chain-manual { display: flex; gap: 8px; flex-wrap: wrap; }
.dsh-chain-manual-input { flex: 1 1 140px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-strong, #888); background: transparent; color: inherit; font-size: 12px; }
.dsh-chain-select-root { position: relative; display: inline-block; max-width: 100%; }
.dsh-chain-select-label { display: inline-block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
.dsh-chain-select-chevron { display: inline-flex; margin-left: 6px; vertical-align: middle; transition: transform .15s ease; }
.dsh-chain-select-chevron-open { transform: rotate(180deg); }
.dsh-chain-select-panel { position: absolute; z-index: 1200; top: calc(100% + 4px); left: 0; min-width: 240px; max-width: 360px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base)); box-shadow: var(--dsw-shadow-lv3); }
.dsh-chain-select-search { display: flex; align-items: center; gap: 6px; padding: 4px 6px 8px; }
.dsh-chain-select-search-input { flex: 1; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: inherit; font-size: 12px; }
.dsh-chain-select-group-label { padding: 6px 8px 2px; font-size: 11px; font-weight: 700; color: var(--dsw-alias-label-tertiary); }
.dsh-chain-select-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; text-align: left; cursor: pointer; }
.dsh-chain-select-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-chain-select-option[data-selected] { color: var(--dsw-alias-state-business-primary); }
.dsh-chain-select-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
`
    let cssInjected = false
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return
      cssInjected = true
      const el = document.createElement('style')
      el.setAttribute('data-dsh-chain-editor', '')
      el.textContent = CHAIN_EDITOR_CSS
      document.head.appendChild(el)
    }
    const inject = ['slots', 'locale', 'modelDirectories', 'sessions']

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
      healthTitle: '记忆与知识库体检',
      healthTitleNoMem: '知识库体检',
      healthDesc: '一次体检三处：session-kit 记忆库（memory.sqlite：表行数/FTS 一致性/孤儿引用）、知识库条目层（items+向量缺口）、对话档案层（arch_*，同库不同表）。全程只读，不修任何数据。',
      healthDescNoMem: '一次体检两处：知识库条目层（items+向量缺口）、对话档案层（arch_*，同库不同表）。全程只读，不修任何数据。',
      healthRun: '开始体检',
      healthRebuildFts: '修复词法索引',
      healthRebuilt: '已重建词法索引条目数',
      healthRunning: '体检中…',
      healthFailed: '体检请求失败',
      healthMemSection: '记忆库（session-kit / memory.sqlite）',
      healthKbSection: '知识库条目层（items）',
      healthArchSection: '对话档案层（arch_*）',
      healthTable: '表',
      healthFts: 'FTS 索引',
      healthFtsSynced: '一致',
      healthFtsOutOfSync: '与主表行数不一致——重启 DSH 会触发自动重建',
      healthFtsDisabled: '未启用',
      healthOrphans: '孤儿引用',
      healthDir: '项目',
      healthEphemeral: '临时记忆（内存池）',
      healthSettings: '生效设置',
      healthItems: '条目',
      healthKbFts: 'FTS 行数',
      healthVec: '向量语义层',
      healthVecMissing: '条目缺向量索引（纯词法仍可用）——向量运行时就绪后可用 knowledge_vec 回填',
      healthVecUnavailable: '向量层不可用（缺模型/运行时），已降级纯词法检索',
      healthExpansionCache: '查询扩展缓存',
      healthArchEmpty: '档案层为空或未建（archives_search 首次使用后才有数据）',
      healthUnavailable: '服务未加载（插件改动需重启 DSH 生效）',
      healthSkOff: 'session-kit 插件未启用——记忆库体检段已隐藏，相关检测请求也不再发送（启用后刷新本页恢复）。',
      modelTitle: '模型设置',
      modelDesc: '知识库检索（knowledge_search）查库前会先调一次小模型，把查询改写成几个同义问法以提升召回（L1 查询扩展）；失败会自动降级纯词法检索，不影响结果可用性。向量嵌入模型不可换（与索引口径绑定）。',
      modelChainHint: '按顺序逐项尝试：某项失败（配额、超时等）自动换下一项，全部失败＝降级纯词法检索；空链条＝使用当前会话模型。',
      chainFollowSession: '跟随会话使用模型',
      chainAdd: '添加固定渠道',
      chainReasoning: '思考度',
      chainProviderDefault: '跟随提供商默认',
      chainSession: '跟随会话',
      chainFixed: '固定模型',
      chainModel: 'Model',
      chainMoveUp: '上移',
      chainMoveDown: '下移',
      chainDelete: '删除',
      chainModelsLoading: '模型目录加载中…',
      chainNoModels: '目录不可用，可手输 provider/model',
      chainSearchModels: '搜索模型',
      modelFollowLabel: '跟随当前会话模型',
      modelFollowDesc: '开：扩展请求走当前会话正在用的模型（会话走免费车道则扩展同样免费）。关：用下方专用模型。',
      modelProviderLabel: 'Provider',
      modelModelLabel: 'Model',
      modelSave: '保存',
      modelSaving: '保存中…',
      modelSaved: '已保存并即刻生效（扩展缓存已清）',
      promptTitle: '知识库说明（随知识库同步）',
      promptDesc: '这些说明会直接展示给 AI。保存在 knowledge.sqlite 的 knowledge_settings 表中，随 dsh-sync 的 knowledge 组同步；不修改插件源码。留空工具描述则使用通用默认。',
      promptEnabled: '在系统提示中附带自定义资料说明',
      promptSearch: '知识条目工具描述',
      promptArchives: '对话档案工具描述',
      promptCustom: '自定义资料说明（可选）',
      promptSave: '保存说明',
      promptSaved: '说明已保存，将随知识库同步',
      promptSearchNote: '注：「知识条目」工具（knowledge_search）由本插件自身提供，不依赖 session-kit——session-kit 关闭时它照常可用，所以这项描述不需要隐藏。',
      modelCurrent: '当前生效：',
      modelCurrentSession: '跟随会话模型',
      modelSaveFailed: '保存失败',
      modelTimeoutLabel: '扩展超时（秒）',
      modelTimeoutDesc: '1-60 秒，超时即降级词法，不阻塞检索。',
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
      healthTitle: 'Memory & knowledge checkup',
      healthTitleNoMem: 'Knowledge base checkup',
      healthDesc: 'One checkup, three stores: session-kit memory database (memory.sqlite: table rows / FTS consistency / orphan refs), knowledge entry layer (items + vector gaps), and the conversation archive layer (arch_*, same database, separate tables). Read-only — never modifies data.',
      healthDescNoMem: 'One checkup, two stores: knowledge entry layer (items + vector gaps) and the conversation archive layer (arch_*, same database, separate tables). Read-only — never modifies data.',
      healthRun: 'Run checkup',
      healthRebuildFts: 'Rebuild lexical indexes',
      healthRebuilt: 'Rebuilt lexical index entries',
      healthRunning: 'Checking…',
      healthFailed: 'Checkup request failed',
      healthMemSection: 'Memory database (session-kit / memory.sqlite)',
      healthKbSection: 'Knowledge entry layer (items)',
      healthArchSection: 'Conversation archive layer (arch_*)',
      healthTable: 'Table',
      healthFts: 'FTS index',
      healthFtsSynced: 'in sync',
      healthFtsOutOfSync: 'row count differs from the main table — restarting DSH triggers an automatic rebuild',
      healthFtsDisabled: 'disabled',
      healthOrphans: 'Orphan references',
      healthDir: 'Project',
      healthEphemeral: 'Ephemeral memories (in-memory pool)',
      healthSettings: 'Active settings',
      healthItems: 'Entries',
      healthKbFts: 'FTS rows',
      healthVec: 'Vector semantic layer',
      healthVecMissing: 'entries lack vector index (lexical still works) — once the vector runtime is ready, backfill with knowledge_vec',
      healthVecUnavailable: 'vector layer unavailable (model/runtime missing), fell back to lexical-only search',
      healthExpansionCache: 'Query expansion cache',
      healthArchEmpty: 'Archive layer is empty or not created (data appears after first archives_search use)',
      healthUnavailable: 'Service not loaded (plugin changes need a DSH restart)',
      healthSkOff: 'The dsh-session-kit plugin is disabled — the memory checkup section is hidden and its requests are no longer sent (enable it and refresh to restore).',
      modelTitle: 'Model settings',
      modelDesc: 'Before querying the store, knowledge_search calls a small model once to rewrite the query into paraphrases for better recall (L1 query expansion); on failure it silently falls back to lexical-only search — results stay usable. The embedding model is not switchable (tied to the index).',
      modelChainHint: 'Tried in order: on failure (quota, timeout, ...) the next item is tried; if all fail it degrades to lexical search. An empty chain = use the current session model.',
      chainFollowSession: 'Follow the session model',
      chainAdd: 'Add fixed lane',
      chainReasoning: 'Reasoning',
      chainProviderDefault: 'Provider default',
      chainSession: 'Follow session',
      chainFixed: 'Fixed model',
      chainModel: 'Model',
      chainMoveUp: 'Move up',
      chainMoveDown: 'Move down',
      chainDelete: 'Delete',
      chainModelsLoading: 'Loading model directory…',
      chainNoModels: 'Directory unavailable; you can type provider/model manually',
      chainSearchModels: 'Search models',
      modelFollowLabel: 'Follow the current session model',
      modelFollowDesc: 'On: expansion requests use the model the current session is using (a free-lane session keeps expansion free). Off: use the dedicated model below.',
      modelProviderLabel: 'Provider',
      modelModelLabel: 'Model',
      modelSave: 'Save',
      modelSaving: 'Saving…',
      modelSaved: 'Saved and effective immediately (expansion cache cleared)',
      promptTitle: 'Knowledge guidance (synced with database)',
      promptDesc: 'Shown to AI. Stored in knowledge_settings inside knowledge.sqlite and synced by dsh-sync; never changes plugin source. Empty tool descriptions use generic defaults.',
      promptEnabled: 'Append custom collection guidance to the system prompt',
      promptSearch: 'Knowledge entry tool description',
      promptArchives: 'Conversation archive tool description',
      promptCustom: 'Custom collection guidance (optional)',
      promptSave: 'Save guidance',
      promptSaved: 'Guidance saved and ready to sync',
      promptSearchNote: 'Note: the "knowledge entry" tool (knowledge_search) is provided by this plugin itself, not by session-kit — it keeps working when session-kit is disabled, so this description stays visible.',
      modelCurrent: 'Effective now: ',
      modelCurrentSession: 'follow session model',
      modelSaveFailed: 'Save failed',
      modelTimeoutLabel: 'Expansion timeout (seconds)',
      modelTimeoutDesc: '1-60 seconds; on timeout it degrades to lexical and never blocks retrieval.',
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
    // session-kit 记忆库健康路由（统一体检 A 段，跨插件同源调用；子路径部署同款兼容）。
    const memoryHealthPath = (() => {
      try { return new URL('dsh-session-kit/memory/health', document.baseURI).pathname } catch { return '/dsh-session-kit/memory/health' }
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
      input: { padding: '5px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-strong, #888)', background: 'transparent', color: 'inherit', fontSize: 12 },
    }

    /* session-kit 启用状态共享 hook（2026-11-23 二次智能化）：
       HealthCard 用它驱动「记忆库体检段/标题/描述/记忆检测请求」的整体显隐。
       判据 = r.ok（HTTP 2xx）：实测关闭后路由回 404/空响应体（不是 401）。
       失败保守视为启用（网络抖动不该把正常 UI 藏掉）。 */
    function useSessionKitEnabled() {
      const [enabled, setEnabled] = useState(true)
      useEffect(() => {
        let alive = true
        fetch(memoryHealthPath, { method: 'GET' }).then((r) => { if (alive) setEnabled(r.ok === true) }).catch(() => { /* 保守显示 */ })
        return () => { alive = false }
      }, [])
      return enabled
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

    function HealthCard() {
      const [report, setReport] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [repairNote, setRepairNote] = useState('')
      /* 启用状态由分区顶层 hook 统一探测注入（useSessionKitEnabled，见上）；
         未启用 = 标题切「知识库体检」、记忆段隐藏、记忆库检测请求完全不发。 */
      const skEnabled = useSessionKitEnabled()
      const run = async () => {
        setBusy(true); setErr(''); setReport(null)
        try {
          /* session-kit 未启用（skEnabled=false）时不发记忆体检请求——A 段隐藏后 mem 数据无人消费，
             发过去只会吃到 401 还浪费一次调用。mem=null + memErr=null 即可。 */
          const [memRes, kbRes] = await Promise.all([
            /* 空响应/404 防御：禁用插件的路由回 404 空 body，直接 r.json() 会抛
               「Unexpected end of JSON input」——先判 ok 再解析，失败落 {ok:false} 让 A 段显示错误行而不是炸整卡。 */
            skEnabled
              ? fetch(memoryHealthPath).then(async (r) => {
                  if (r.ok !== true) return { ok: false, status: r.status }
                  return r.json().catch(() => ({ ok: false, status: r.status }))
                }).catch(() => ({ ok: false }))
              : Promise.resolve(null),
            fetchJson('/health')
          ])
          setReport({
            mem: memRes?.ok === true ? memRes.value : null,
            memErr: memRes?.ok === true ? null : String(memRes?.error ?? (memRes?.status !== undefined ? `HTTP ${memRes.status}` : '请求失败')),
            kb: kbRes?.ok === true ? kbRes.value : null,
            kbErr: kbRes?.ok === true ? null : String(kbRes?.error ?? `HTTP ${kbRes?.status ?? '?'}`)
          })
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
      }
      const rebuildFts = async () => {
        setBusy(true); setErr(''); setRepairNote('')
        try {
          const result = await fetchJson('/health/rebuild-fts', { method: 'POST', body: '{}' })
          setRepairNote(`${t('healthRebuilt')}: ${result?.value?.rebuilt ?? 0}`)
          await run()
        } catch (e) { setErr(String(e?.message ?? e)); setBusy(false) }
      }
      const fmtBytes = (n) => (typeof n === 'number' && n >= 0 ? `${(n / 1048576).toFixed(1)} MB` : '—')
      const num = (v) => (v === null || v === undefined ? '缺失/损坏' : String(v))
      const toneStyle = (tone) => tone === 'bad' ? styles.err : tone === 'good'
        ? { color: 'var(--dsw-alias-state-success-primary, #12a150)', fontSize: 12 }
        : tone === 'warn' ? { color: 'var(--dsw-alias-state-warning-primary, #d89614)', fontSize: 12 } : { fontSize: 12 }
      const row = (label, value, tone) => h('div', { key: label + String(value), style: { display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.6 } },
        h('span', { style: { minWidth: 200, opacity: 0.72 } }, label),
        h('span', { style: toneStyle(tone) }, String(value)))
      const section = (key, title, rows) => h('div', { key, style: { display: 'grid', gap: 2 } },
        h('strong', { style: { fontSize: 13 } }, title), ...rows)
      let sections = null
      if (report) {
        /* A 段：记忆库（session-kit） */
        const mem = report.mem
        const memRows = []
        if (mem?.error) memRows.push(row('error', mem.error, 'bad'))
        else if (mem) {
          memRows.push(row('db', `${mem.dbPath ?? '—'} · ${fmtBytes(mem.dbSizeBytes)}`))
          for (const [table, n] of Object.entries(mem.tables ?? {})) memRows.push(row(`${t('healthTable')} ${table}`, num(n), n === null ? 'bad' : undefined))
          memRows.push(mem.fts?.available === true
            ? row(t('healthFts'), mem.fts.inSync === true ? `${t('healthFtsSynced')}（${mem.fts.ftsRows}/${mem.fts.memoryRows}）` : t('healthFtsOutOfSync'), mem.fts.inSync === true ? 'good' : 'bad')
            : row(t('healthFts'), t('healthFtsDisabled')))
          const orphanTotal = (mem.orphans?.tagLinks ?? 0) + (mem.orphans?.sessionDirectories ?? 0)
          memRows.push(row(t('healthOrphans'), `tag_links=${num(mem.orphans?.tagLinks)} · session_directories=${num(mem.orphans?.sessionDirectories)}`, orphanTotal > 0 ? 'warn' : 'good'))
          for (const d of mem.directories ?? []) memRows.push(row(`${t('healthDir')} ${d.name}`, String(d.activeMemories)))
          memRows.push(row(t('healthEphemeral'), String(mem.ephemeralCount ?? 0)))
          memRows.push(row(t('healthSettings'), `autoDistill=${mem.settings?.autoDistill === true ? 'on' : 'off'} · allSessionsDefault=${mem.settings?.allSessionsDefault === true ? 'on' : 'off'} · autoMatch=${mem.settings?.autoMatch === true ? 'on' : 'off'} · workspaceBinding=${mem.settings?.workspaceBinding === true ? 'on' : 'off'}`))
        } else memRows.push(row('error', report.memErr ?? t('healthUnavailable'), 'bad'))
        /* B 段：知识库条目层 + C 段：档案层（同一路由返回） */
        const kb = report.kb
        const kbRows = []
        const archRows = []
        if (kb?.ready !== true) {
          kbRows.push(row('error', report.kbErr ?? t('healthUnavailable'), 'bad'))
          archRows.push(row('error', report.kbErr ?? t('healthUnavailable'), 'bad'))
        } else if (kb.error) {
          kbRows.push(row('error', kb.error, 'bad'))
          archRows.push(row('error', kb.error, 'bad'))
        } else {
          kbRows.push(row(t('healthItems'), `active=${num(kb.items?.active)} · deleted=${num(kb.items?.deleted)} · expired=${num(kb.items?.expired)}`))
          kbRows.push(row(t('healthKbFts'), `base=${num(kb.fts?.baseRows)} · rich=${num(kb.fts?.richRows)}`))
          const missing = kb.vector?.missingCount
          kbRows.push(row(t('healthVec'), kb.vector?.available === true
            ? ((missing ?? 0) > 0 ? `missing=${missing} — ${t('healthVecMissing')}` : `ready（missing=0）`)
            : t('healthVecUnavailable'), kb.vector?.available === true ? ((missing ?? 0) > 0 ? 'warn' : 'good') : 'warn'))
          kbRows.push(row(t('healthExpansionCache'), num(kb.expansionCache)))
          const arch = kb.archive
          if (arch?.chunks === null || arch?.chunks === undefined) archRows.push(row('arch_*', t('healthArchEmpty'), 'warn'))
          else {
            archRows.push(row('arch_chunks', num(arch.chunks), arch.chunks === 0 ? 'warn' : undefined))
            archRows.push(row('词法检索', arch.lexicalMode === 'fts' ? 'arch_fts' : 'arch_chunks.text（LIKE，正常实现）'))
            archRows.push(row('arch_vec', num(arch.vecRows)))
            archRows.push(row('arch_meta', num(arch.metaRows)))
            if (arch.chunks === 0) archRows.push(row('', t('healthArchEmpty'), 'warn'))
          }
        }
        /* 段落编号动态化：session-kit 未启用时记忆库段隐藏，后续段自动补位（A/B 重排）。 */
        let letter = 0
        const tag = () => `${String.fromCharCode(65 + letter++)} · `
        sections = h('div', { style: { display: 'grid', gap: 16 } },
          skEnabled ? section('mem', tag() + t('healthMemSection'), memRows) : null,
          section('kb', tag() + t('healthKbSection'), kbRows),
          section('arch', tag() + t('healthArchSection'), archRows))
      }
      return h('div', { style: { display: 'grid', gap: 8 } },
        h('strong', { style: { fontSize: 13 } }, skEnabled ? t('healthTitle') : t('healthTitleNoMem')),
        h('p', { style: styles.note }, skEnabled ? t('healthDesc') : t('healthDescNoMem')),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { onClick: () => void run(), disabled: busy, style: styles.btn }, busy ? t('healthRunning') : t('healthRun')),
          report?.kb?.ready === true && ((report.kb.items?.total ?? 0) > 0 && (report.kb.fts?.baseRows ?? 0) === 0)
            ? h('button', { onClick: () => void rebuildFts(), disabled: busy, style: styles.btn }, t('healthRebuildFts')) : null),
        repairNote !== '' ? h('div', { style: { color: 'var(--dsw-alias-state-success-primary, #12a150)', fontSize: 12 } }, repairNote) : null,
        err !== '' ? h('div', { style: styles.err }, `${t('healthFailed')}: ${err}`) : null,
        skEnabled ? null : h('div', { style: styles.note }, t('healthSkOff')),
        sections)
    }

    /* 链条编辑器需要的宿主上下文：从 apply 注入的 ctx 读取（modelDirectories/agents）。
       apply 里通过 ModelContextProvider 包一层。 */
    const ModelContext = React.createContext(null)
    function useModelContext() { return React.useContext(ModelContext) }

    /* 模型设置卡（2026-11-24 仿记忆蒸馏）：知识库检索（L1 查询扩展）模型链条。
       链条按顺序逐项尝试：每项 = 跟随会话使用模型 / 固定模型（provider 分组下拉，可指定思考度）。
       真源 = cordis.patch.yml knowledge-sqlite 条目的 queryExpansion.chain（/api/knowledge-sqlite/model-config 读写）。
       保存后就地热更运行中的 expander 并清扩展缓存，免重启即刻生效。 */
    function ModelCard() {
      const [chain, setChain] = useState(null)
      const [timeoutSec, setTimeoutSec] = useState(3)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [err, setErr] = useState('')
      const ctx = useModelContext()
      const directory = useModelDirectory(ctx)
      useEffect(() => { ensureCss() }, [])
      const load = useCallback(async () => {
        try {
          const data = await fetchJson('/model-config')
          setChain(Array.isArray(data.chain) ? data.chain : [])
          setTimeoutSec(Math.max(1, Math.min(60, Math.round((Number(data.timeoutMs) || 3000) / 1000))))
          setErr('')
        } catch (e) { setErr(String(e?.message ?? e)) }
      }, [])
      useEffect(() => { void load() }, [load])
      const save = async () => {
        setBusy(true); setNote(''); setErr('')
        try {
          const result = await fetchJson('/model-config', {
            method: 'POST',
            body: JSON.stringify({
              chain: chain ?? [],
              timeoutSeconds: Math.max(1, Math.min(60, Math.trunc(Number(timeoutSec) || 3))),
            }),
          })
          setNote(result?.note ?? t('modelSaved'))
          await load()
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
      }
      return h('div', { style: { display: 'grid', gap: 8 } },
        h('strong', { style: { fontSize: 13 } }, t('modelTitle')),
        h('p', { style: styles.note }, t('modelDesc')),
        h('p', { style: styles.note }, t('modelChainHint')),
        chain === null
          ? h('div', { style: styles.note }, t('loading'))
          : h(ChainEditor, {
              chain, onChange: setChain, directory, t, busy,
              followLabel: t('chainFollowSession'),
              addLabel: t('chainAdd'),
              reasoningLabel: t('chainReasoning'),
              providerDefaultLabel: t('chainProviderDefault'),
            }),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' } },
          h('span', null, t('modelTimeoutLabel')),
          h('input', { type: 'number', min: 1, max: 60, step: 1, value: timeoutSec, onChange: (e) => setTimeoutSec(Math.max(1, Math.min(60, Math.trunc(Number(e.target.value) || 3)))), style: { ...styles.input, width: 70 } }),
          h('span', { style: styles.note }, t('modelTimeoutDesc'))),
        h('div', null,
          h('button', { onClick: () => void save(), disabled: busy || chain === null, style: styles.btn }, busy ? t('modelSaving') : t('modelSave'))),
        note !== '' ? h('div', { style: { color: 'var(--dsw-alias-state-success-primary, #12a150)', fontSize: 12 } }, note) : null,
        err !== '' ? h('div', { style: styles.err }, `${t('modelSaveFailed')}: ${err}`) : null)
    }

    function PromptCard() {
      const [value, setValue] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [err, setErr] = useState('')
      const load = useCallback(async () => {
        try { const data = await fetchJson('/prompt-config'); setValue(data.value ?? data); setErr('') }
        catch (e) { setErr(String(e?.message ?? e)) }
      }, [])
      useEffect(() => { void load() }, [load])
      const save = async () => {
        setBusy(true); setErr(''); setNote('')
        try {
          const data = await fetchJson('/prompt-config', { method: 'POST', body: JSON.stringify(value) })
          setValue(data.value ?? value); setNote(t('promptSaved'))
        } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
      }
      const field = (key, label, rows = 3) => h('label', { style: { display: 'grid', gap: 4, fontSize: 12 } }, label,
        h('textarea', { value: value?.[key] ?? '', rows, onChange: (e) => setValue((old) => ({ ...old, [key]: e.target.value })), style: { ...styles.input, resize: 'vertical', fontFamily: 'inherit' } }))
      return h('div', { style: { display: 'grid', gap: 8 } },
        h('strong', { style: { fontSize: 13 } }, t('promptTitle')),
        h('p', { style: styles.note }, t('promptDesc')),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
          h('input', { type: 'checkbox', checked: value?.enabled === true, onChange: (e) => setValue((old) => ({ ...old, enabled: e.target.checked })) }),
          t('promptEnabled')),
        /* 「知识条目」工具（knowledge_search）由本插件自身注册（lib/tools.js），不依赖 session-kit——
           因此不随 skEnabled 隐藏，只在字段下留一行说明，纠正「它属于记忆侧」的直觉误解。 */
        field('searchDescription', t('promptSearch'), 4),
        h('div', { style: styles.note }, t('promptSearchNote')),
        field('archivesDescription', t('promptArchives'), 4),
        field('customText', t('promptCustom'), 5),
        h('div', null, h('button', { onClick: () => void save(), disabled: busy || value === null, style: styles.btn }, t('promptSave'))),
        note !== '' ? h('div', { style: { color: 'var(--dsw-alias-state-success-primary, #12a150)', fontSize: 12 } }, note) : null,
        err !== '' ? h('div', { style: styles.err }, err) : null)
    }

    function apply(ctx) {
      const applyCtx = ctx
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
      }, () => h(ModelContext.Provider, { value: applyCtx }, h('div', { style: { display: 'grid', gap: 28 } }, h(VecCard), h(ModelCard), h(PromptCard), h(HealthCard)))))
    }
    exports.apply = apply
    // shell 的 ModuleLoader 按本 bundle 导出的 inject 给 apply 的 ctx 挂服务（OFM/webin 同款）；
    // 缺了它 ctx.slots 是 undefined，配合 immediately:true 会在 shell 初始化期炸整页。
    exports.inject = inject
    return module.exports
  }
})
