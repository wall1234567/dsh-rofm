/**
 * dsh-rofm — 浏览器半身：Derpyu 白名单「授权弹窗」。
 *
 * 宿主准备把 rofm 的四个工具名注入 `qq-tool-restrict.mjs` 的 SAFE_EXACT 白名单前，
 * 先问用户同不同意。本文件只做那张卡片：轮询同源接口 → 有 pending 就弹窗 →
 * 用户点按钮 → POST 决定 → 显示结果后自动关闭。
 *
 * 标题/正文/细节/按钮/结果提示全部来自 GET 响应，`lib/compat-consent.js` 是唯一
 * 真相，客户端只留「提交中…」这类界面框架短句。不引包、不构建、不注册 slot；
 * 因为没有 slot 引用，宿主 manifest 的 `dsh.client.immediately` 必须为 true。
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-rofm',
    // 没有依赖：`require` 只为满足 loader 的 factory 签名，不调用。
    factory: require => {
      const module = { exports: {} }
      const exports = module.exports

      // ── 常量 ──────────────────────────────────────────────────────────────
      // 路由与宿主 `lib/compat-consent.js` 的 CONSENT_ROUTE 必须逐字一致。
      const ROUTE = '/api/rofm/derpyu-consent'
      const PACKAGE = 'dsh-rofm'
      const FAST_POLL_MS = 2500 // 还没看到 pending 时的轮询间隔
      const SLOW_POLL_MS = 30000 // 连续失败时的退避上限
      const RECONCILE_MS = 5000 // 弹窗开着时核对：别的标签页可能已经决定
      const REQUEST_TIMEOUT_MS = 8000 // 宿主卡住时轮询不能跟着挂死
      const NOTICE_HOLD_MS = 2000 // 结果提示停留 2s 再淡出
      const FADE_OUT_MS = 220
      const SINGLETON_KEY = '__dshRofmConsentPrompt'

      /** 只放界面框架短句；面向用户的正文一律来自 GET 响应。 */
      const UI_TEXT = {
        zh: {
          submitting: '提交中…',
          retry: '提交失败，请重试',
          close: '关闭（稍后再说）',
          gone: '授权接口已不可用（插件可能已停用）；可先关闭本窗口，刷新页面后再试。',
        },
        en: {
          submitting: 'Submitting…',
          retry: 'Submission failed, please retry',
          close: 'Close (ask later)',
          gone: 'The consent API is unavailable (the plugin may be disabled); close this dialog and reload the page to retry.',
        },
      }

      // ── 文案：zh 优先，非中文界面用 en ────────────────────────────────────
      function isChinese() {
        try {
          return /^zh/i.test(typeof navigator === 'object' && navigator !== null ? navigator.language : '')
        } catch {
          return false
        }
      }

      /** 从响应的 `{zh,en}` 对象里取当前界面语言；缺一边就退到另一边。 */
      function pick(value) {
        if (typeof value === 'string') return value
        if (value === null || typeof value !== 'object') return ''
        const zh = typeof value.zh === 'string' ? value.zh : ''
        const en = typeof value.en === 'string' ? value.en : ''
        return isChinese() ? zh || en : en || zh
      }

      function uiText(key) {
        return (isChinese() ? UI_TEXT.zh : UI_TEXT.en)[key] || ''
      }

      function isRecord(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      }

      // ── 同源请求 ──────────────────────────────────────────────────────────
      /**
       * 任何网络错误 / 非 JSON / 404 / 非 2xx 都收敛成 `{ ok:false }`，
       * 由调用方当成「宿主还没准备好」静默重试 —— 本文件不向 window 抛异常。
       */
      async function requestJson(options) {
        if (typeof fetch !== 'function') return { ok: false, status: 0, body: null }
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller !== null ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null
        try {
          const response = await fetch(ROUTE, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...options,
            ...(controller !== null ? { signal: controller.signal } : {}),
          })
          const body = await response.json().catch(() => null)
          return { ok: response.ok === true, status: response.status, body }
        } catch {
          return { ok: false, status: 0, body: null }
        } finally {
          if (timer !== null) clearTimeout(timer)
        }
      }

      // ── 样式：内联在 JS 里，选择器全带 rofm 前缀，只作用于本插件创建的节点 ──
      // 颜色优先取 DSH 主题变量，每个变量都带无变量时的 fallback。
      const CSS = `
.rofm-consent-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(5,7,11,.52);opacity:1;transition:opacity .2s ease}
.rofm-consent-overlay.is-closing{opacity:0;pointer-events:none}
.rofm-consent-card{box-sizing:border-box;position:relative;width:min(480px,100%);max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:11px;padding:20px 22px 18px;border:.5px solid var(--dsw-alias-border-l2,#34363d);border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-layer-2,#1e2026);color:var(--dsw-alias-label-primary,#f2f3f5);font:inherit;font-size:13px;line-height:1.6;box-shadow:0 18px 48px rgba(0,0,0,.45);animation:rofm-consent-in .18s ease-out}
@keyframes rofm-consent-in{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.rofm-consent-card *{box-sizing:border-box}
.rofm-consent-close{position:absolute;top:6px;right:8px;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a8);font:inherit;font-size:18px;line-height:1;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
.rofm-consent-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#f2f3f5)}
.rofm-consent-title{margin:0;font-size:15px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary,#f2f3f5)}
.rofm-consent-message{margin:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#c9ccd2);overflow-wrap:anywhere}
.rofm-consent-detail{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#9aa0a8);overflow-wrap:anywhere}
.rofm-consent-meta{margin:0;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9aa0a8);overflow-wrap:anywhere}
.rofm-consent-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:6px}
.rofm-consent-btn{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);padding:7px 16px;font:inherit;font-size:13px;line-height:1.4;cursor:pointer;transition:filter .15s ease,background-color .15s ease,border-color .15s ease}
.rofm-consent-btn:disabled{opacity:.5;cursor:default}
.rofm-consent-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:2px}
.rofm-consent-btn.primary{background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}
.rofm-consent-btn.primary:hover:not(:disabled){filter:brightness(1.08)}
.rofm-consent-btn.secondary{background:transparent;border-color:var(--dsw-alias-border-l3,#4a4d57);color:var(--dsw-alias-label-primary,#f2f3f5)}
.rofm-consent-btn.secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.rofm-consent-status{min-height:17px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9aa0a8);overflow-wrap:anywhere}
.rofm-consent-status.is-success{color:var(--dsw-alias-state-success-primary,#2f9e44)}
.rofm-consent-status.is-error{color:var(--dsw-alias-state-error-primary,#e03131)}
`

      function createNode(tag, className, text) {
        const element = document.createElement(tag)
        if (className !== undefined) element.className = className
        if (text !== undefined && text !== '') element.textContent = text
        return element
      }

      function removeNode(element) {
        try {
          if (element !== null && element !== undefined && element.parentNode !== null) element.parentNode.removeChild(element)
        } catch {
          // 清理失败不值得把页面搞崩。
        }
      }

      // ── 运行时：一个实例 = 一个定时器 + 至多一个弹窗 ──────────────────────
      function createRuntime() {
        let disposed = false
        let stopped = false
        let timer = null
        let inflight = false
        let failures = 0
        let overlay = null
        let fadingOverlay = null
        let styleEl = null
        let domReadyHandler = null
        let submitting = false
        let settled = false // 本页已有决定：成功后不再弹，也不因迟到的 pending 重开
        let snapshot = null
        let allowButton = null
        let denyButton = null
        let closeButton = null
        let statusEl = null
        let noticeTimer = null
        let fadeTimer = null

        function setStatus(text, tone) {
          if (statusEl === null) return
          statusEl.textContent = text
          statusEl.classList.remove('is-success', 'is-error')
          if (tone === 'success') statusEl.classList.add('is-success')
          if (tone === 'error') statusEl.classList.add('is-error')
        }

        function ensureStyle() {
          if (styleEl !== null) return
          const head = document.head || document.documentElement
          if (head === null || head === undefined) return
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin', PACKAGE)
          styleEl.textContent = CSS
          head.appendChild(styleEl)
        }

        // ── 弹窗 ────────────────────────────────────────────────────────────
        function openModal(data) {
          if (disposed || stopped || overlay !== null || settled) return
          if (typeof document === 'undefined' || !document.body) return
          removeNode(fadingOverlay)
          fadingOverlay = null
          ensureStyle()
          snapshot = data

          const titleId = 'rofm-consent-title'
          const messageId = 'rofm-consent-message'
          const root = createNode('div', 'rofm-consent-overlay')
          root.setAttribute('data-plugin', PACKAGE)
          const card = createNode('div', 'rofm-consent-card')
          card.setAttribute('role', 'dialog')
          card.setAttribute('aria-modal', 'true')
          card.setAttribute('aria-labelledby', titleId)
          card.setAttribute('aria-describedby', messageId)

          // 关闭出口（× / Esc）：POST 一直失败或宿主接口失效时，用户必须能
          // 退出弹窗，否则整页会被遮罩永久卡住（v1.5.7 首次实测事故）。
          closeButton = createNode('button', 'rofm-consent-close', '×')
          closeButton.setAttribute('type', 'button')
          closeButton.setAttribute('aria-label', uiText('close'))
          closeButton.setAttribute('title', uiText('close'))
          closeButton.addEventListener('click', () => dismiss())

          const title = createNode('h2', 'rofm-consent-title', pick(data.title))
          title.id = titleId
          const message = createNode('p', 'rofm-consent-message', pick(data.message))
          message.id = messageId
          const detailText = pick(data.detail)
          const version = typeof data.pluginVersion === 'string' && data.pluginVersion.trim() !== '' ? data.pluginVersion.trim() : '?'
          const meta = createNode('p', 'rofm-consent-meta', `${PACKAGE} v${version}`)

          const actions = createNode('div', 'rofm-consent-actions')
          denyButton = createNode('button', 'rofm-consent-btn secondary', pick(data.denyLabel) || (isChinese() ? '不允许' : "Don't allow"))
          denyButton.setAttribute('type', 'button')
          denyButton.addEventListener('click', () => submit('deny'))
          allowButton = createNode('button', 'rofm-consent-btn primary', pick(data.allowLabel) || (isChinese() ? '允许' : 'Allow'))
          allowButton.setAttribute('type', 'button')
          allowButton.addEventListener('click', () => submit('allow'))
          actions.appendChild(denyButton)
          actions.appendChild(allowButton)

          statusEl = createNode('div', 'rofm-consent-status')
          statusEl.setAttribute('role', 'status')
          statusEl.setAttribute('aria-live', 'polite')

          card.appendChild(closeButton)
          card.appendChild(title)
          card.appendChild(message)
          if (detailText !== '') card.appendChild(createNode('p', 'rofm-consent-detail', detailText))
          card.appendChild(meta)
          card.appendChild(actions)
          card.appendChild(statusEl)
          root.appendChild(card)
          document.body.appendChild(root)
          overlay = root
          submitting = false
          try { allowButton.focus({ preventScroll: true }) } catch { /* 老浏览器没有 preventScroll */ }
        }

        /** `immediately` 为 true 时直接摘掉（POST already / 别的标签页已决定）。 */
        function closeModal(immediately) {
          if (noticeTimer !== null) {
            clearTimeout(noticeTimer)
            noticeTimer = null
          }
          if (fadeTimer !== null) {
            clearTimeout(fadeTimer)
            fadeTimer = null
          }
          const root = overlay
          overlay = null
          allowButton = null
          denyButton = null
          closeButton = null
          statusEl = null
          submitting = false
          if (root === null) return
          if (immediately === true) {
            removeNode(root)
            return
          }
          try {
            root.classList.add('is-closing')
          } catch {
            // classList 不可用就直接移除。
          }
          fadingOverlay = root
          fadeTimer = setTimeout(() => {
            fadeTimer = null
            fadingOverlay = null
            removeNode(root)
          }, FADE_OUT_MS)
        }

        /**
         * 用户主动关闭（× / Esc / 宿主接口失效）：本页不再弹、不再轮询。
         * 宿主侧保持 pending（没写任何决定文件），刷新页面会重新询问。
         */
        function dismiss() {
          if (disposed) return
          stopped = true
          settled = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          closeModal(true)
        }

        function onKeyDown(event) {
          if (disposed || event === null || typeof event !== 'object') return
          if (event.key !== 'Escape' && event.key !== 'Esc') return
          if (overlay === null || submitting) return
          try {
            event.preventDefault()
          } catch {
            // 阻止默认行为失败不影响关闭弹窗。
          }
          dismiss()
        }

        function showDecision(action, body) {
          const data = snapshot !== null ? snapshot : {}
          const decision = body.decision === 'allowed' || body.decision === 'denied' ? body.decision : action === 'deny' ? 'denied' : 'allowed'
          setStatus(pick(decision === 'denied' ? data.deniedNotice : data.allowedNotice), 'success')
          if (allowButton !== null) allowButton.disabled = true
          if (denyButton !== null) denyButton.disabled = true
          noticeTimer = setTimeout(() => {
            noticeTimer = null
            closeModal(false)
          }, NOTICE_HOLD_MS)
        }

        async function submit(action) {
          if (stopped || submitting || settled || overlay === null) return
          submitting = true
          if (allowButton !== null) allowButton.disabled = true
          if (denyButton !== null) denyButton.disabled = true
          setStatus(uiText('submitting'), '')
          const response = await requestJson({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: action }),
          })
          if (stopped || overlay === null) return
          submitting = false
          if (response.ok && isRecord(response.body) && response.body.ok === true) {
            // 多标签页：另一个标签页已经替用户决定了，直接关掉，不再打扰。
            if (response.body.already === true) {
              settled = true
              closeModal(true)
              return
            }
            settled = true
            showDecision(action, response.body)
            return
          }
          const reason = isRecord(response.body) && typeof response.body.error === 'string' ? response.body.error : ''
          setStatus(reason === '' ? uiText('retry') : `${uiText('retry')} ${reason}`, 'error')
          if (allowButton !== null) allowButton.disabled = false
          if (denyButton !== null) denyButton.disabled = false
        }

        // ── 轮询 ────────────────────────────────────────────────────────────
        function schedule(delay) {
          if (stopped) return
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(tick, delay)
        }

        async function tick() {
          timer = null
          if (stopped || inflight) return
          inflight = true
          let delay = FAST_POLL_MS
          try {
            delay = await pollOnce()
          } catch {
            delay = SLOW_POLL_MS // pollOnce 已兜底；这里保证轮询永不停摆
          } finally {
            inflight = false
            if (!stopped) schedule(delay)
          }
        }

        /** 返回下一次轮询的间隔；唯一副作用是开/关弹窗。 */
        async function pollOnce() {
          const response = await requestJson({ method: 'GET' })
          if (stopped) return SLOW_POLL_MS
          if (!response.ok || !isRecord(response.body) || response.body.ok !== true) {
            // 宿主还没准备好（404 / 非 JSON / 网络失败）：静默退避重试。
            failures += 1
            // 连续 404 = 宿主行被禁用/未加载（例如拒绝授权后 rofm 已关闭）。
            // 页面刷新之前不会有授权可问，停下来，别再空转轮询；若弹窗还开着，
            // 明确提示可以关闭（否则用户会以为界面卡死）。
            if (response.status === 404 && failures >= 6) {
              stopped = true
              if (overlay !== null) setStatus(uiText('gone'), 'error')
              return SLOW_POLL_MS
            }
            return Math.min(FAST_POLL_MS * 2 ** failures, SLOW_POLL_MS)
          }
          failures = 0
          const data = response.body
          if (data.pending === true) {
            // 本页已经作答（或用户主动关闭）但宿主仍报 pending：可能决定没写
            // 成功。停止轮询，避免开着重询循环；刷新页面会再次询问。
            if (settled) {
              stopped = true
              return SLOW_POLL_MS
            }
            if (overlay === null) openModal(data)
            return overlay !== null ? RECONCILE_MS : FAST_POLL_MS
          }
          // 不再 pending：不需要再问了，停止轮询。没有检测到 qq-bridge 时
          // 连一次复查都不做（= 普通 rofm，零后台轮询）；已决定 / 预授权 /
          // 补丁关闭同样停止。代价：qq-bridge 若是在本页面打开之后才安装，
          // 需要刷新页面才会弹窗（宿主在下一次页面加载时按新 profile 重新检测）。
          stopped = true
          if (!settled && overlay !== null) {
            settled = true
            closeModal(true)
          }
          return SLOW_POLL_MS
        }

        function onVisibilityChange() {
          if (stopped || inflight) return
          if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
          // 回到可见时立刻补查一次，不用等被退避拉长的定时器。
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          tick()
        }

        function begin() {
          if (disposed || stopped || typeof document === 'undefined') return
          if (typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibilityChange)
            document.addEventListener('keydown', onKeyDown)
          }
          schedule(0)
        }

        function start() {
          if (typeof document === 'undefined') return
          if (document.body) {
            begin()
            return
          }
          // 模块可能比 body 先到：等 DOM 可写再开始，避免往 null 上挂节点。
          domReadyHandler = () => {
            domReadyHandler = null
            begin()
          }
          document.addEventListener('DOMContentLoaded', domReadyHandler)
        }

        function dispose() {
          if (disposed) return
          disposed = true
          stopped = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (noticeTimer !== null) {
            clearTimeout(noticeTimer)
            noticeTimer = null
          }
          if (fadeTimer !== null) {
            clearTimeout(fadeTimer)
            fadeTimer = null
          }
          if (typeof document !== 'undefined') {
            if (domReadyHandler !== null) document.removeEventListener('DOMContentLoaded', domReadyHandler)
            if (typeof document.removeEventListener === 'function') {
              document.removeEventListener('visibilitychange', onVisibilityChange)
              document.removeEventListener('keydown', onKeyDown)
            }
          }
          domReadyHandler = null
          removeNode(fadingOverlay)
          fadingOverlay = null
          removeNode(overlay)
          overlay = null
          allowButton = null
          denyButton = null
          closeButton = null
          statusEl = null
          removeNode(styleEl)
          styleEl = null
        }

        return { start, dispose }
      }

      // ── 接进 shell ────────────────────────────────────────────────────────
      /**
       * 重复 apply（HMR / 多入口）先拆掉上一个实例：弹窗与定时器都不叠加。
       * 清理走 `ctx.effect`；没有 effect 的宿主上退化为「下一次 apply 再拆」。
       */
      function apply(ctx) {
        const previous = typeof window !== 'undefined' ? window[SINGLETON_KEY] : undefined
        if (previous !== null && typeof previous === 'object' && typeof previous.dispose === 'function') {
          try { previous.dispose() } catch { /* 旧实例坏了也不该拦住新实例 */ }
        }
        const runtime = createRuntime()
        if (typeof window !== 'undefined') window[SINGLETON_KEY] = runtime
        runtime.start()
        const dispose = () => {
          runtime.dispose()
          if (typeof window !== 'undefined' && window[SINGLETON_KEY] === runtime) window[SINGLETON_KEY] = null
        }
        try {
          if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
            ctx.effect(() => dispose, `${PACKAGE}: derpyu consent prompt`)
            return
          }
        } catch {
          // effect 注册失败：实例照旧运行，只是只能靠下一次 apply 来清理。
        }
      }

      exports.name = 'dsh-rofm'
      exports.inject = []
      exports.apply = apply
      return module.exports
    },
  })
}
