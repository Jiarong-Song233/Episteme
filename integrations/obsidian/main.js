/* Episteme's thin Obsidian client. Only the service owns the graph. */
const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  requestUrl,
} = require('obsidian')
const VIEW_TYPE = 'episteme-panel'
const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:4321',
  agentToken: '',
  humanToken: '',
  scene: 'dev',
  scope: '',
}

class EpistemeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
    this.mode = 'recall'
    this.payload = null
    this.error = ''
  }
  getViewType() {
    return VIEW_TYPE
  }
  getDisplayText() {
    return 'Episteme'
  }
  getIcon() {
    return 'brain-circuit'
  }
  async onOpen() {
    this.render()
  }
  // ItemView.setState belongs to Obsidian's workspace restoration protocol.
  show(mode, payload, error = '') {
    this.mode = mode
    this.payload = payload
    this.error = error
    this.render()
  }
  render() {
    const root = this.contentEl
    root.empty()
    root.createEl('h4', { text: this.mode === 'pending' ? 'Episteme · 待确认' : 'Episteme · 召回' })
    const toolbar = root.createDiv({ cls: 'epi-actions' })
    const refresh = toolbar.createEl('button', { text: '刷新待确认' })
    refresh.onclick = () => this.plugin.openPending()
    if (this.error) {
      root.createEl('p', { text: this.error, cls: 'epi-error', attr: { role: 'alert' } })
      return
    }
    if (this.mode === 'pending') return this.renderPending(root)
    const ranked = this.payload?.ranked ?? []
    if (!ranked.length) {
      root.createEl('p', { text: '没有相关的已确认理解。' })
      return
    }
    const known = new Map((this.payload?.known ?? []).map((k) => [k.nodeId, k]))
    for (const item of ranked) {
      const card = root.createDiv({ cls: 'epi-card' })
      card.createDiv({ cls: 'epi-label', text: item.label })
      const dims = (known.get(item.nodeId)?.dimensions ?? [])
        .map((d) => `${d.id}=${d.level}`)
        .join(', ')
      card.createDiv({
        cls: 'epi-meta',
        text: `${item.type} · ${Number(item.score).toFixed(3)}${dims ? ` · ${dims}` : ''}`,
      })
      if (item.reasons?.length)
        card.createDiv({ cls: 'epi-meta', text: `召回原因：${JSON.stringify(item.reasons)}` })
    }
    if (this.payload?.semanticUnavailable)
      root.createEl('p', {
        text: `语义检索不可用，已用关键词：${this.payload.semanticUnavailable}`,
      })
  }
  renderPending(root) {
    const list = this.payload?.suggestions ?? []
    if (!list.length) {
      root.createEl('p', { text: '没有待确认的提议。' })
      return
    }
    if (!this.plugin.settings.humanToken)
      root.createEl('p', { text: '可在设置中填本人令牌，或用终端 ep accept / ep reject 审阅。' })
    for (const suggestion of list) {
      const card = root.createDiv({ cls: 'epi-card' })
      card.createDiv({
        cls: 'epi-label',
        text: suggestion.proposal.label ?? JSON.stringify(suggestion.proposal),
      })
      card.createDiv({
        cls: 'epi-meta',
        text: `${suggestion.proposedBy} · ${suggestion.scope ?? '未分类'}`,
      })
      if (suggestion.rationale) card.createDiv({ cls: 'epi-meta', text: suggestion.rationale })
      if (suggestion.origin)
        card.createDiv({ cls: 'epi-quote', text: `原文：${suggestion.origin.excerpt}` })
      const actions = card.createDiv({ cls: 'epi-actions' })
      for (const [label, action] of [
        ['确认', 'accept'],
        ['驳回', 'dismiss'],
      ]) {
        const button = actions.createEl('button', { text: label })
        button.disabled = !this.plugin.settings.humanToken
        button.onclick = async () => {
          for (const child of actions.children) child.disabled = true
          await this.plugin.decide(suggestion.id, action)
          for (const child of actions.children) child.disabled = !this.plugin.settings.humanToken
        }
      }
    }
  }
}

class EpistemeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }
  display() {
    const root = this.containerEl
    root.empty()
    const textSetting = (name, description, key, password = false) =>
      new Setting(root)
        .setName(name)
        .setDesc(description)
        .addText((text) => {
          if (password) text.inputEl.type = 'password'
          text.setValue(this.plugin.settings[key]).onChange(async (value) => {
            this.plugin.settings[key] = value.trim()
            await this.plugin.saveSettings()
          })
        })
    textSetting('服务地址', '建议用 pnpm serve --scene capture 启动，共用一个图谱。', 'baseUrl')
    textSetting(
      'Agent 令牌',
      '读取与提议。本地模式可留空；共享模式用独立 agent 令牌。',
      'agentToken',
      true,
    )
    textSetting(
      '本人令牌',
      '可选；填了才能确认/驳回。令牌保存在本机插件 data.json 中。',
      'humanToken',
      true,
    )
    new Setting(root)
      .setName('场景')
      .setDesc('选择这次要沉淀的内容。')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ dev: '开发经验', learn: '学习理解', discussion: '讨论立场' })
          .setValue(this.plugin.settings.scene)
          .onChange(async (value) => {
            this.plugin.settings.scene = value
            await this.plugin.saveSettings()
          }),
      )
    textSetting(
      '上下文 scope',
      '例如 project:episteme，自动加 scene 前缀；召回优先匹配此范围，仍可关联其他范围。',
      'scope',
    )
  }
}

class EpistemePlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
    this.registerView(VIEW_TYPE, (leaf) => new EpistemeView(leaf, this))
    this.addRibbonIcon('brain-circuit', '打开 Episteme', () => this.activateView())
    this.addCommand({
      id: 'epi-recall',
      name: 'Recall from selection or note',
      callback: () => this.recallFromEditor(),
    })
    this.addCommand({
      id: 'epi-propose',
      name: 'Propose selection or note',
      callback: () => this.proposeFromEditor(),
    })
    this.addCommand({
      id: 'epi-pending',
      name: 'Open pending proposals',
      callback: () => this.openPending(),
    })
    this.addSettingTab(new EpistemeSettingTab(this.app, this))
  }
  async saveSettings() {
    await this.saveData(this.settings)
  }
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)
      if (!leaf) return null
      await leaf.setViewState({ type: VIEW_TYPE, active: true })
    }
    await this.app.workspace.revealLeaf(leaf)
    return leaf
  }
  currentContext() {
    const view =
      this.app.workspace.getActiveViewOfType(MarkdownView) ??
      this.app.workspace.getMostRecentLeaf()?.view
    if (!(view instanceof MarkdownView)) return null
    const text = (view.editor.getSelection() || view.editor.getValue() || '').trim()
    return { text, path: view.file?.path ?? '', vault: this.app.vault.getName() }
  }
  scope() {
    const base = `scene:${this.settings.scene}`
    const scope = this.settings.scope.trim()
    if (!scope) return base
    if (scope.startsWith('scene:')) {
      if (scope !== base && !scope.startsWith(`${base}:`)) throw new Error(`scope 应属于 ${base}`)
      return scope
    }
    return `${base}:${scope}`
  }
  async request(path, { method = 'GET', body, as = 'agent' } = {}) {
    const token = as === 'human' ? this.settings.humanToken : this.settings.agentToken
    let response
    try {
      response = await requestUrl({
        url: `${this.settings.baseUrl.replace(/\/+$/, '')}${path}`,
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        throw: false,
      })
    } catch {
      throw new Error('服务不可用。请先启动 Episteme 服务，并检查地址。')
    }
    let data
    try {
      data = response.json ?? JSON.parse(response.text)
    } catch {
      throw new Error(`服务返回非 JSON（HTTP ${response.status}）`)
    }
    if (response.status >= 400)
      throw new Error(data.message || data.error || data.code || `HTTP ${response.status}`)
    return data
  }
  async recallFromEditor() {
    const context = this.currentContext()
    if (!context?.text) {
      new Notice('先打开一篇笔记或选中一段文字')
      return
    }
    const leaf = await this.activateView()
    if (!leaf) return
    try {
      const data = await this.request('/api/v1/recall', {
        method: 'POST',
        body: { question: context.text.slice(0, 2000), scope: this.scope() },
      })
      leaf.view.show('recall', data)
    } catch (error) {
      leaf.view.show('recall', null, error.message)
      new Notice(`召回失败：${error.message}`)
    }
  }
  async proposeFromEditor() {
    const context = this.currentContext()
    if (!context?.text) {
      new Notice('先打开一篇笔记或选中一段文字')
      return
    }
    if (context.text.length > 1000) {
      new Notice('请选中不超过 1000 字符的核心段落；长篇材料用 CLI 提炼并校验引用。')
      return
    }
    try {
      const state = await this.request('/api/v1/state')
      const scene = this.settings.scene
      const name = state.scene === 'capture' ? `capture/${scene}` : state.scene
      if (
        state.scene !== 'capture' &&
        state.scene !== scene &&
        !(state.scene === 'default' && scene === 'learn')
      )
        throw new Error('服务场景不匹配；请用 --scene capture 启动。')
      const source = `obsidian://open?vault=${encodeURIComponent(context.vault)}&file=${encodeURIComponent(context.path)}`
      const data = await this.request(`/api/v1/scene/${name}/notes`, {
        method: 'POST',
        body: {
          text: context.text,
          source,
          scope: this.scope(),
          why: `Selected in ${context.path}`,
        },
      })
      new Notice(`已提议待确认：${data.suggestionId}`)
      await this.openPending()
    } catch (error) {
      new Notice(`提议失败：${error.message}`)
    }
  }
  async openPending() {
    const leaf = await this.activateView()
    if (!leaf) return
    try {
      leaf.view.show('pending', await this.request('/api/v1/suggestions'))
    } catch (error) {
      leaf.view.show('pending', null, error.message)
      new Notice(`读取待确认失败：${error.message}`)
    }
  }
  async decide(id, action) {
    if (!this.settings.humanToken) {
      new Notice('需要本人令牌，或回终端执行 ep accept / ep reject')
      return
    }
    try {
      await this.request('/api/v1/suggestions/decide', {
        method: 'POST',
        as: 'human',
        body: { id, action },
      })
      new Notice(action === 'accept' ? '已确认' : '已驳回')
      await this.openPending()
    } catch (error) {
      new Notice(`操作失败：${error.message}`)
    }
  }
}
module.exports = EpistemePlugin
