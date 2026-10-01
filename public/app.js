const $ = id => document.getElementById(id)
const state = { data: null, csrf: '', category: 'common', changes: new Map(), errors: new Map(), drafts: new Map(), busy: false, authBusy: false, operation: '', query: '', targets: [], targetId: '', runtime: null, candidates: [], candidateKey: '', loggedIn: false, session: 0, statusError: '' }
const targetStorageKey = 'march7thassistant:last-target'
const clone = value => JSON.parse(JSON.stringify(value))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isBusy = () => state.busy || state.authBusy || !!state.operation
const hasEdits = () => state.changes.size > 0 || state.errors.size > 0
let toastTimer, statusController
function pauseStatus() { statusController?.abort() }
function rememberedTarget() { try { return localStorage.getItem(targetStorageKey) || '' } catch { return '' } }
function rememberTarget(id) { try { if (id) localStorage.setItem(targetStorageKey, id); else localStorage.removeItem(targetStorageKey) } catch { /* 隐私模式下仍可连接。 */ } }
function kindLabel(kind) { return ({ docker: 'Docker', native: 'Linux 源码', source: 'Linux 源码', linux: 'Linux 源码', pm2: 'PM2', systemd: 'systemd', file: '配置文件', manual: '手动接入', 'file-only': '仅编辑文件' })[kind] || kind || '未识别' }
function messageText(value) { return typeof value === 'string' ? value : value?.message || value?.label || JSON.stringify(value) }
function messages(values) { return (Array.isArray(values) ? values : []).map(messageText).filter(Boolean) }
function messageList(container, values) {
  container.replaceChildren()
  const texts = [...new Set(messages(values))]
  container.hidden = !texts.length
  if (texts.length) { const list = node('ul'); list.append(...texts.map(text => node('li', '', text))); container.append(list) }
}
async function operation(name, callback) {
  if (isBusy()) return
  pauseStatus()
  state.operation = name
  updateSavebar()
  try { return await callback() } finally { state.operation = ''; updateSavebar() }
}
function node(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}
function toast(text, error = false) {
  clearTimeout(toastTimer)
  $('toast').textContent = text
  $('toast').classList.toggle('error', error)
  $('toast').hidden = false
  toastTimer = setTimeout(() => { $('toast').hidden = true }, error ? 12000 : 5000)
}
async function api(url, options = {}) {
  const session = state.session
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...options.headers } })
  const data = await response.json()
  if (options.signal?.aborted || session !== state.session) throw new DOMException('请求已取消', 'AbortError')
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin()
    throw new Error(data.error || '操作未完成，请稍后再试')
  }
  return data
}
function clearConfig() {
  state.data = null
  state.runtime = null
  state.statusError = ''
  state.changes.clear(); state.errors.clear(); state.drafts.clear()
  $('settings-list').replaceChildren()
  $('navigation').replaceChildren()
  $('warning-banner').hidden = true
  $('version').textContent = ''
}
function showLogin() {
  pauseStatus()
  state.session++
  state.loggedIn = false
  state.csrf = ''
  state.targetId = ''
  state.targets = []
  state.candidates = []
  state.candidateKey = ''
  clearConfig()
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
  $('password-form').reset()
  $('manual-form').reset()
  $('discover-form').reset()
  $('candidate-list').replaceChildren()
  $('password').value = ''
  $('loading').hidden = true
  $('app-view').hidden = true
  $('login-view').hidden = false
  $('password').focus()
}
function showApp() {
  state.loggedIn = true
  $('login-view').hidden = true
  $('app-view').hidden = false
  $('loading').hidden = true
  positionBackToTop()
}
function writeBlocked() {
  const runtime = state.runtime
  if (!state.targetId || !state.data) return '请先连接实例并读取配置。'
  if (state.statusError) return '状态更新失败，请重新载入后保存。'
  if (!runtime || runtime.canRead !== true) return '当前无法读取配置，请检查服务器上的配置路径和读取权限。'
  if (runtime.canWrite !== true) return '当前不可保存，请检查下方状态提示与服务器上的写入权限。'
  if (runtime.fileOnly === true && runtime.running === true) return '程序仍在运行，请先停止程序再保存文件。'
  if (runtime.fileOnly !== true && runtime.running !== true && runtime.running !== false) return '暂时无法确认运行状态，请重新载入后保存。'
  if (runtime.fileOnly !== true && runtime.running === true && runtime.canRestart !== true) return '当前无法管理运行中的程序，请先停止程序再保存。'
  return ''
}
function renderTarget() {
  const target = state.data?.target || state.targets.find(target => target.id === state.targetId)
  const runtime = state.runtime
  $('target-select').replaceChildren()
  if (!state.targets.length) { const option = node('option', '', '尚未连接实例'); option.value = ''; $('target-select').append(option) }
  for (const item of state.targets) { const option = node('option', '', `${item.label || item.id} · ${kindLabel(item.kind)}`); option.value = item.id; $('target-select').append(option) }
  $('target-select').value = state.targetId
  $('target-path').hidden = !target
  $('target-path').textContent = target ? `${kindLabel(target.kind)}${target.configPath ? ` · ${target.configPath}` : ''}${target.containerName ? ` · 容器 ${target.containerName}` : ''}` : ''
  const status = !target ? '未连接' : !runtime ? '待读取' : runtime.running === true ? '运行中' : runtime.running === false ? '已停止' : runtime.fileOnly ? '仅编辑文件' : '状态未知'
  $('container-status').textContent = status
  $('container-status').classList.toggle('offline', runtime?.running !== true)
  const permissions = runtime ? `${runtime.canRead ? '可读取' : '不可读取'} · ${runtime.canWrite ? '可写入' : '不可写入'}${runtime.fileOnly ? ' · 仅编辑文件' : ''}` : ''
  $('runtime-summary').textContent = runtime ? `${runtime.managerLabel || kindLabel(target?.kind)} · ${runtime.label || status} · ${permissions}` : target ? '点击重新载入，读取配置与运行状态。' : '尚未连接。请选择自动发现，或填写配置文件路径。'
  const warnings = [...messages(runtime?.warnings)]
  if (state.statusError) warnings.unshift(state.statusError)
  if (runtime?.fileOnly) warnings.unshift('仅编辑文件：请在保存前自行停止程序。只保存文件，不保证自动生效。')
  if (runtime && !runtime.available && !runtime.fileOnly) warnings.unshift('运行管理未连接，请检查服务器上的程序状态。')
  messageList($('runtime-warnings'), warnings)
  const evidence = messages(runtime?.evidence)
  $('runtime-evidence').hidden = !evidence.length
  $('runtime-evidence-list').replaceChildren(...evidence.map(text => node('li', '', text)))
  $('connect-state').hidden = !!state.targets.length
  $('config-toolbar').hidden = !state.targetId
  $('settings-section').hidden = !state.data
  $('page-note').hidden = !state.data
  const blocked = state.data ? writeBlocked() : ''
  $('offline-banner').hidden = !blocked
  $('offline-banner').textContent = blocked
}
async function load(targetId = state.targetId) {
  if (!targetId) return
  pauseStatus()
  clearConfig()
  $('target-error').hidden = true
  renderTarget(); updateSavebar()
  try {
    const data = await api(`/api/config?target=${encodeURIComponent(targetId)}`)
    if (state.targetId !== targetId || !state.loggedIn) return
    if (data.target?.id !== targetId) throw new Error('配置实例不一致，请重新载入。')
    state.data = data
    state.runtime = data.runtime
    if (data.csrf) state.csrf = data.csrf
    $('version').textContent = data.version ? `助手版本 ${data.version}` : ''
    const warnings = data.fields.filter(field => field.warning || field.override)
    $('warning-banner').replaceChildren()
    $('warning-banner').hidden = !warnings.length
    if (warnings.length) {
      const overrides = warnings.filter(field => field.override).length
      $('warning-banner').append(node('span', '', overrides ? `${warnings.length} 项设置有提示，其中 ${overrides} 项由环境变量固定。` : `${warnings.length} 项设置需要检查。`))
      const button = node('button', '', '查看提示 →')
      button.addEventListener('click', () => { $('changed-only').checked = false; selectCategory('warnings') })
      $('warning-banner').append(button)
    }
    renderNavigation(); renderFields()
  } catch (error) {
    if (state.loggedIn && state.targetId === targetId) { $('target-error').textContent = `${error.message} 请检查连接后重新载入。`; $('target-error').hidden = false }
    throw error
  } finally { renderTarget(); updateSavebar() }
}
async function loadTargets(preferredId = state.targetId || rememberedTarget()) {
  $('target-error').hidden = true
  const result = await api('/api/targets')
  state.targets = result.targets || []
  const id = state.targets.find(target => target.id === preferredId)?.id || state.targets[0]?.id || ''
  state.targetId = id
  rememberTarget(id)
  if (!id) { clearConfig(); renderTarget(); updateSavebar(); return }
  await load(id)
}
async function startSession() {
  showApp()
  renderTarget()
  try { await operation('正在读取实例…', () => loadTargets()) }
  catch (error) { if (state.loggedIn) { $('target-error').textContent = error.message; $('target-error').hidden = false } }
}
function renderNavigation() {
  $('navigation').replaceChildren()
  if (!state.data) return
  const categories = [{ id: 'common', title: '常用设置', icon: '✧' }, ...state.data.groups]
  for (const group of categories) {
    const button = node('button', `nav-item${state.category === group.id ? ' active' : ''}`)
    button.append(node('span', 'nav-icon', group.icon), node('span', '', group.title))
    if (state.category === group.id) {
      button.setAttribute('aria-current', 'page')
      button.append(node('span', 'nav-mark'))
    }
    button.addEventListener('click', () => selectCategory(group.id))
    $('navigation').append(button)
  }
}
function selectCategory(id) {
  state.category = id
  state.query = ''
  $('search').value = ''
  renderNavigation()
  renderFields()
  scrollToTop()
}
function scrollToTop() {
  window.scrollTo(0, 0)
  updateBackToTop()
}
function updateBackToTop() {
  $('back-to-top').hidden = !state.loggedIn || window.scrollY < 240
}
function positionBackToTop() {
  const height = document.querySelector('.savebar').getBoundingClientRect().height
  if (height) $('back-to-top').style.setProperty('--savebar-height', `${height}px`)
  updateBackToTop()
}
$('back-to-top').addEventListener('click', scrollToTop)
window.addEventListener('scroll', updateBackToTop, { passive: true })
window.addEventListener('resize', positionBackToTop)
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(positionBackToTop).observe(document.querySelector('.savebar'))
}
function updateSavebar() {
  const count = state.changes.size
  const busy = isBusy()
  const blocked = writeBlocked()
  $('change-count').textContent = state.busy ? '正在保存设置…' : state.operation || (!state.targetId ? '请先连接实例' : !state.data ? '配置尚未读取' : count ? `${count} 项设置待保存` : state.errors.size ? '有内容待修正' : '没有未保存的修改')
  $('save-hint').textContent = state.authBusy ? '正在修改登录密码。' : state.busy ? '请等待操作完成。' : state.operation ? '请稍候。' : !state.targetId ? '自动发现，或填写服务器配置路径。' : state.errors.size ? '请先修改标红的内容。' : blocked || (count ? '仅保存到当前所选实例。' : '修改后，点击保存设置。')
  $('save-dot').classList.toggle('dirty', count > 0 || !!state.errors.size)
  $('save-dot').classList.toggle('inactive', !state.data || !!blocked)
  $('save').disabled = busy || !count || !!state.errors.size || !!blocked
  $('discard').disabled = busy || !hasEdits()
  $('reload').disabled = busy || !state.targetId
  $('logout').disabled = busy
  $('change-password').disabled = busy
  $('target-select').disabled = busy || !state.targets.length
  $('remove-target').disabled = busy || !state.targetId
  for (const id of ['discover-open', 'manual-open', 'refresh-targets']) $(id).disabled = busy
  for (const formId of ['discover-form', 'manual-form']) for (const control of $(formId).elements) control.disabled = busy
  $('candidate-connect').disabled = busy || !state.candidateKey
  const canExport = !busy && !!state.data && state.runtime?.canRead === true
  $('export').setAttribute('aria-disabled', String(!canExport))
  $('export').tabIndex = canExport ? 0 : -1
  if (canExport) $('export').href = `/api/export?target=${encodeURIComponent(state.targetId)}`
  else $('export').removeAttribute('href')
  document.body.classList.toggle('busy', busy)
  for (const row of document.querySelectorAll('.field')) {
    row.classList.toggle('changed', state.changes.has(row.dataset.key) || state.errors.has(row.dataset.key))
    for (const control of row.querySelectorAll('input, select, textarea, button')) control.disabled = busy || row.dataset.readonly === 'true' || state.runtime?.canWrite !== true
  }
}
function change(field, value) {
  state.errors.delete(field.key)
  if (!field.secret && equal(value, field.value)) state.changes.delete(field.key)
  else state.changes.set(field.key, value)
  const error = document.getElementById(`error-${field.key}`)
  if (error) error.textContent = ''
  updateSavebar()
}
function current(field) {
  return state.changes.has(field.key) ? state.changes.get(field.key) : field.value
}
function controlId(field) { return `field-${field.key}` }
function labelText(value) {
  return typeof value === 'boolean' ? value ? '开启' : '关闭' : value === null ? '空' : String(value)
}
function select(options, value, onChange, label) {
  const input = node('select')
  if (label) input.setAttribute('aria-label', label)
  if (!options.some(o => equal(o.value, value))) {
    const placeholder = node('option', '', value === undefined ? '请选择' : `当前：${labelText(value)}`)
    placeholder.value = '-1'
    placeholder.disabled = true
    input.append(placeholder)
  }
  options.forEach((option, i) => {
    const el = node('option', '', option.label)
    el.value = String(i)
    input.append(el)
  })
  input.value = String(options.findIndex(o => equal(o.value, value)))
  input.addEventListener('change', () => onChange(options[Number(input.value)].value))
  return input
}
function instanceOptions(kind) {
  return Object.entries(state.data.instances[kind] || {}).map(([value, description]) => ({ value, label: `${value} · ${description}` }))
}
function mapEditor(field) {
  const grid = node('div', 'map-grid')
  const data = clone(current(field))
  const rawValues = state.drafts.get(field.key) || Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)]))
  Object.entries(data).forEach(([key, value], i) => {
    const row = node('div', 'map-item')
    const label = node('label', '', key)
    let input
    if (field.key === 'instance_names') {
      input = select(instanceOptions(key), value, v => { data[key] = v; change(field, clone(data)) }, key)
    } else {
      input = node('input')
      input.type = 'number'
      input.min = '1'
      input.max = '1000'
      input.step = '1'
      input.value = rawValues[key]
      input.addEventListener('input', () => {
        rawValues[key] = input.value
        state.drafts.set(field.key, { ...rawValues })
        if (Object.values(rawValues).some(v => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 1000)) {
          state.errors.set(field.key, '请填写 1～1000 的整数。')
          $(`error-${field.key}`).textContent = '请填写 1～1000 的整数。'
          updateSavebar()
          return
        }
        for (const [name, count] of Object.entries(rawValues)) data[name] = Number(count)
        change(field, clone(data))
      })
    }
    input.id = `${controlId(field)}-${i}`
    label.htmlFor = input.id
    row.append(label, input)
    grid.append(row)
  })
  return grid
}
function planEditor(field) {
  const wrapper = node('div', 'plan-editor')
  const rows = clone(state.drafts.get(field.key) || current(field))
  function commitRows() {
    state.drafts.set(field.key, clone(rows))
    if (rows.some(row => !Number.isInteger(row[2]) || row[2] < 1 || row[2] > 1000)) {
      state.errors.set(field.key, '次数请填写 1～1000 的整数。')
      $(`error-${field.key}`).textContent = '次数请填写 1～1000 的整数。'
      updateSavebar()
    } else change(field, clone(rows))
  }
  function render() {
    wrapper.replaceChildren()
    rows.forEach((row, index) => {
      const line = node('div', 'plan-row')
      const type = select(Object.keys(state.data.instances).map(v => ({ value: v, label: v })), row[0], value => {
        row[0] = value
        row[1] = Object.keys(state.data.instances[value]).find(v => v !== '无') || '无'
        commitRows(); render()
      }, `第 ${index + 1} 项副本类型`)
      const name = select(instanceOptions(row[0]), row[1], value => { row[1] = value; commitRows() }, `第 ${index + 1} 项副本名称`)
      const count = node('input')
      count.type = 'number'; count.min = '1'; count.max = '1000'; count.step = '1'; count.value = row[2] ?? ''
      count.setAttribute('aria-label', `第 ${index + 1} 项次数`)
      count.addEventListener('input', () => {
        row[2] = count.value === '' ? null : Number(count.value)
        commitRows()
      })
      const remove = node('button', 'remove-row', '×')
      remove.setAttribute('aria-label', `删除第 ${index + 1} 项计划`)
      remove.addEventListener('click', () => { rows.splice(index, 1); commitRows(); render() })
      line.append(type, name, count, remove)
      wrapper.append(line)
    })
    const add = node('button', 'add-row', '+ 添加一项体力计划')
    add.addEventListener('click', () => { rows.push(['拟造花萼（金）', '回忆之蕾', 1]); commitRows(); render() })
    wrapper.append(add)
  }
  render()
  return wrapper
}
function fieldControl(field, row) {
  const control = node('div', 'field-control')
  const value = field.override ? field.override.value : current(field)
  let input
  if (field.readonly && field.group === 'runtime') {
    control.append(node('span', 'readonly-value', field.secret ? '已隐藏' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '空')))
    return control
  }
  if (field.type === 'boolean' && (typeof value === 'boolean' || field.override)) {
    control.classList.add('bool-control')
    const wrap = node('label', 'switch-wrap')
    const text = node('span', 'switch-text', value ? '已开启' : '已关闭')
    const toggle = node('span', 'switch')
    input = node('input')
    input.type = 'checkbox'; input.checked = !!value
    input.addEventListener('change', () => { change(field, input.checked); text.textContent = input.checked ? '已开启' : '已关闭' })
    toggle.append(input, node('span', 'switch-track'))
    wrap.append(text, toggle)
    control.append(wrap)
  } else if (field.type === 'boolean') {
    input = select([{ label: '开启', value: true }, { label: '关闭', value: false }], value, v => change(field, v))
    row.classList.add('invalid')
    control.append(input)
  } else if (field.secret) {
    row.classList.add('text-field')
    const wrap = node('div', 'secret-control')
    input = node('input'); input.type = 'password'; input.autocomplete = 'new-password'
    input.placeholder = field.configured ? '已设置 · 留空保持不变' : '未设置'
    input.value = state.changes.get(field.key) || ''
    input.addEventListener('input', () => {
      if (input.value === '') { state.changes.delete(field.key); updateSavebar() }
      else change(field, input.value)
    })
    const clear = node('button', 'text-button', '清空')
    clear.addEventListener('click', () => { input.value = ''; input.placeholder = '保存后清空'; change(field, '') })
    wrap.append(input, clear); control.append(wrap)
  } else if (['instance_names', 'instance_names_challenge_count'].includes(field.key)) {
    row.classList.add('complex'); control.append(mapEditor(field))
  } else if (field.key === 'power_plan' && Array.isArray(value) && value.every(v => Array.isArray(v) && v.length === 3)) {
    row.classList.add('complex'); control.append(planEditor(field))
  } else if (field.options) {
    input = select(field.options, value, v => change(field, v))
    control.append(input)
  } else if (field.type === 'array' || field.type === 'object' || field.type === 'null') {
    row.classList.add('complex')
    control.append(node('p', 'editor-note', '按 JSON 格式填写。'))
    input = node('textarea', 'json-input'); input.spellcheck = false
    input.value = state.drafts.has(field.key) ? state.drafts.get(field.key) : JSON.stringify(value, null, 2)
    input.addEventListener('input', () => {
      state.drafts.set(field.key, input.value)
      try {
        const parsed = JSON.parse(input.value)
        if (field.type === 'array' && !Array.isArray(parsed)) throw new Error()
        if (field.type === 'object' && (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')) throw new Error()
        change(field, parsed)
      } catch {
        state.errors.set(field.key, '请检查 JSON 格式。')
        $(`error-${field.key}`).textContent = '请检查 JSON 格式。'
        updateSavebar()
      }
    })
    control.append(input)
  } else {
    input = node('input')
    input.type = field.type === 'number' ? 'number' : ['scheduled_time', 'scheduled_run_time'].includes(field.key) ? 'time' : 'text'
    if (input.type === 'time') input.value = String(value).padStart(5, '0')
    else input.value = state.drafts.has(field.key) ? state.drafts.get(field.key) : value ?? ''
    if (input.type === 'number') {
      input.step = field.integer ? '1' : 'any'
      input.min = field.range ? String(field.range[0]) : '0'
      if (field.range) input.max = String(field.range[1])
    } else if (input.type !== 'time') row.classList.add('text-field')
    input.addEventListener('input', () => {
      state.drafts.set(field.key, input.value)
      if (input.type === 'number' && (!input.value || !input.validity.valid)) {
        state.errors.set(field.key, '请填写有效数字。')
        $(`error-${field.key}`).textContent = '请填写有效数字。'
        updateSavebar(); return
      }
      change(field, field.type === 'number' ? Number(input.value) : input.value)
    })
    control.append(input)
  }
  if (input) {
    input.id = controlId(field)
    input.setAttribute('aria-label', field.label)
    input.disabled = field.readonly
  }
  return control
}
function renderFields() {
  if (!state.data) return
  const query = state.query.toLowerCase().trim()
  const changedOnly = $('changed-only').checked
  let fields = state.data.fields.filter(field => {
    if (changedOnly && !state.changes.has(field.key) && !state.errors.has(field.key)) return false
    if (query) return `${field.label} ${field.key} ${field.description}`.toLowerCase().includes(query)
    if (state.category === 'warnings') return field.warning || field.override
    return state.category === 'common' ? field.common : field.group === state.category
  })
  const group = state.data.groups.find(g => g.id === state.category)
  $('section-title').textContent = query ? '搜索结果' : state.category === 'warnings' ? '待检查的设置' : group?.title || '常用设置'
  $('section-subtitle').textContent = query ? `找到 ${fields.length} 项设置` : state.category === 'common' ? '常用的功能放在一起，调整起来更顺手。' : state.category === 'runtime' ? '查看助手自动记录的运行信息。' : '调整设置后，点击底部保存。'
  $('settings-list').replaceChildren()
  $('empty-state').hidden = fields.length !== 0
  const buckets = new Map()
  for (const field of fields) {
    const key = field.group === 'notify' ? field.key.split('_').slice(0, 2).join('_') : field.group
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(field)
  }
  const notifyTitles = { notify_telegram: 'Telegram', notify_matrix: 'Matrix', notify_serverchanturbo: 'Server 酱 · Turbo', notify_serverchan3: 'Server 酱 · 3', notify_bark: 'Bark', notify_smtp: '邮件', notify_onebot: 'OneBot · QQ', notify_gocqhttp: 'Go-cqhttp', notify_dingtalk: '钉钉', notify_pushplus: 'PushPlus', notify_qmsg: 'Qmsg', notify_wechatworkapp: '企业微信应用', notify_wechatworkbot: '企业微信机器人', notify_gotify: 'Gotify', notify_discord: 'Discord', notify_pushdeer: 'PushDeer', notify_lark: '飞书', notify_kook: 'KOOK', notify_meow: 'MeoW', notify_webhook: 'Webhook', notify_custom: '自定义推送' }
  for (const [key, items] of buckets) {
    const card = node('section', 'settings-card')
    const info = state.data.groups.find(g => g.id === items[0].group)
    const heading = node('h3', 'card-heading')
    heading.append(node('span', '', info?.icon || '✧'), node('strong', '', notifyTitles[key] || info?.title || '设置'))
    card.append(heading)
    for (const field of items) {
      const row = node('div', `field${state.changes.has(field.key) ? ' changed' : ''}`)
      row.dataset.key = field.key
      row.dataset.readonly = String(!!field.readonly || !!field.override)
      const details = node('div', 'field-info')
      const title = node('div', 'field-title')
      const label = node('label', '', field.label)
      label.htmlFor = controlId(field)
      title.append(label)
      if (field.override) title.append(node('span', 'badge', '环境变量固定'))
      else if (field.readonly) title.append(node('span', 'badge', '只读'))
      else if (field.unknown) title.append(node('span', 'badge', '扩展字段'))
      details.append(title, node('small', 'field-key', field.key))
      if (field.description) {
        const description = node('p', 'field-description', field.description.length > 130 ? `${field.description.slice(0, 127)}…` : field.description)
        description.title = field.description
        details.append(description)
      }
      if (field.override) details.append(node('p', 'field-description', `请在程序的启动配置中修改环境变量 ${field.override.env}。`))
      if (field.warning) details.append(node('p', 'field-warning', field.warning))
      const error = node('p', 'field-error', state.errors.get(field.key) || '')
      error.id = `error-${field.key}`
      error.setAttribute('role', 'alert')
      details.append(error)
      row.append(details, fieldControl(field, row))
      card.append(row)
    }
    $('settings-list').append(card)
  }
  updateSavebar()
}
function confirmAction(title, message, action, changes = []) {
  pauseStatus()
  if ($('confirm-dialog').open) return Promise.resolve(false)
  return new Promise(resolve => {
    $('confirm-title').textContent = title
    $('confirm-copy').textContent = message
    $('confirm-ok').textContent = action
    $('confirm-changes').replaceChildren(...changes.map(text => node('li', '', text)))
    const dialog = $('confirm-dialog')
    const close = result => { cleanup(); if (dialog.open) dialog.close(); resolve(result) }
    const ok = () => close(true)
    const cancel = () => close(false)
    const escape = event => { event.preventDefault(); close(false) }
    const cleanup = () => { $('confirm-ok').removeEventListener('click', ok); $('confirm-cancel').removeEventListener('click', cancel); dialog.removeEventListener('cancel', escape); dialog.removeEventListener('close', cancel) }
    $('confirm-ok').addEventListener('click', ok)
    $('confirm-cancel').addEventListener('click', cancel)
    dialog.addEventListener('cancel', escape)
    dialog.addEventListener('close', cancel)
    dialog.showModal()
    $('confirm-cancel').focus()
  })
}
function resetFilters() { state.category = 'common'; state.query = ''; $('search').value = ''; $('changed-only').checked = false }
async function confirmSwitch() { return !hasEdits() || await confirmAction('切换实例？', '放弃当前未保存的修改，读取所选实例的配置。', '放弃并切换') }
function openManual() {
  if (isBusy()) return
  pauseStatus()
  if ($('discover-dialog').open) $('discover-dialog').close()
  $('manual-form').reset()
  $('manual-error').textContent = ''
  $('manual-dialog').showModal()
  $('manual-config').focus()
}
function renderCandidates() {
  $('candidate-list').replaceChildren()
  $('candidate-fieldset').hidden = !state.candidates.length
  for (const candidate of state.candidates) {
    const item = node('label', 'candidate')
    const radio = node('input')
    radio.type = 'radio'; radio.name = 'candidate'; radio.value = candidate.key
    radio.checked = state.candidateKey === candidate.key
    radio.addEventListener('change', () => { state.candidateKey = candidate.key; updateSavebar() })
    const details = node('span', 'candidate-info')
    const title = node('span', 'candidate-title')
    title.append(node('strong', '', candidate.label || '三月七助手'), node('span', 'badge', kindLabel(candidate.kind)))
    details.append(title)
    if (candidate.configPath) details.append(node('span', 'candidate-path', candidate.configPath))
    if (candidate.root) details.append(node('span', 'candidate-meta', `安装目录：${candidate.root}`))
    if (candidate.containerName) details.append(node('span', 'candidate-meta', `容器：${candidate.containerName}`))
    for (const text of messages(candidate.evidence)) details.append(node('span', 'candidate-meta', text))
    for (const text of messages(candidate.warnings)) details.append(node('span', 'candidate-warning', text))
    item.append(radio, details)
    $('candidate-list').append(item)
  }
  updateSavebar()
}
async function acceptTarget(target, dialogId) {
  if (!target?.id) throw new Error('未取得实例信息，请刷新列表。')
  state.targets = [...state.targets.filter(item => item.id !== target.id), target]
  state.targetId = target.id
  rememberTarget(target.id)
  resetFilters()
  $(dialogId).close()
  renderTarget()
  try { await load(target.id); toast('已连接所选实例') }
  catch (error) { if (state.loggedIn) toast(`实例已连接，${error.message}`, true) }
}
$('discover-open').addEventListener('click', () => {
  if (isBusy()) return
  pauseStatus()
  state.candidates = []; state.candidateKey = ''
  $('discover-error').textContent = ''; $('discover-progress').textContent = ''
  $('discover-empty').hidden = true; $('discover-diagnostics').hidden = true
  renderCandidates()
  $('discover-dialog').showModal()
  $('discover-scan').focus()
})
$('manual-open').addEventListener('click', openManual)
$('discover-manual').addEventListener('click', openManual)
for (const name of ['discover', 'manual']) {
  $(`${name}-cancel`).addEventListener('click', () => { if (!isBusy()) $(`${name}-dialog`).close() })
  $(`${name}-dialog`).addEventListener('cancel', event => { if (isBusy()) event.preventDefault() })
}
$('discover-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (isBusy()) return
  const roots = $('scan-roots').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (roots.some(root => !root.startsWith('/'))) { $('discover-error').textContent = '请填写 Linux 服务器上的绝对目录，以 / 开头。'; return }
  try {
    await operation('正在扫描服务器…', async () => {
      state.candidates = []; state.candidateKey = ''
      $('discover-error').textContent = ''; $('discover-progress').textContent = '正在扫描，请稍候…'
      $('discover-empty').hidden = true; $('discover-diagnostics').hidden = true
      renderCandidates()
      const result = await api('/api/discover', { method: 'POST', body: JSON.stringify(roots.length ? { roots } : {}) })
      state.candidates = result.candidates || []
      messageList($('discover-diagnostics'), result.diagnostics)
      $('discover-empty').hidden = !!state.candidates.length
      $('discover-progress').textContent = state.candidates.length ? `发现 ${state.candidates.length} 个候选，请选择。` : '扫描完成'
      renderCandidates()
    })
  } catch (error) { $('discover-progress').textContent = ''; $('discover-error').textContent = error.message }
})
$('candidate-connect').addEventListener('click', async () => {
  if (isBusy() || !state.candidateKey) return
  const candidateKey = state.candidateKey
  try {
    await operation('正在连接实例…', async () => {
      if (!await confirmSwitch()) return
      $('discover-error').textContent = ''
      const result = await api('/api/targets', { method: 'POST', body: JSON.stringify({ candidateKey }) })
      await acceptTarget(result.target, 'discover-dialog')
    })
  } catch (error) { if ($('discover-dialog').open) $('discover-error').textContent = error.message; else toast(error.message, true) }
})
$('manual-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (isBusy()) return
  const configPath = $('manual-config').value.trim()
  const installDir = $('manual-root').value.trim()
  const containerName = $('manual-container').value.trim()
  if (!configPath.startsWith('/') || (installDir && !installDir.startsWith('/'))) { $('manual-error').textContent = '请填写 Linux 服务器上的绝对路径，以 / 开头。'; return }
  const configLocation = $('manual-container-path').checked ? 'container' : 'host'
  if (configLocation === 'container' && !containerName) { $('manual-error').textContent = '使用容器内路径时请填写 Docker 容器名。'; return }
  const body = { configPath, configLocation, fileOnly: $('manual-file-only').checked }
  if (installDir) body.installDir = installDir
  if (containerName) body.containerName = containerName
  try {
    await operation('正在连接实例…', async () => {
      if (!await confirmSwitch()) return
      $('manual-error').textContent = ''
      const result = await api('/api/targets/manual', { method: 'POST', body: JSON.stringify(body) })
      await acceptTarget(result.target, 'manual-dialog')
    })
  } catch (error) { if ($('manual-dialog').open) $('manual-error').textContent = error.message; else toast(error.message, true) }
})
$('target-select').addEventListener('change', async () => {
  const targetId = $('target-select').value
  $('target-select').value = state.targetId
  if (isBusy() || !targetId || targetId === state.targetId) return
  try {
    await operation('正在切换实例…', async () => {
      if (!await confirmSwitch()) return
      state.targetId = targetId
      rememberTarget(targetId)
      resetFilters()
      await load(targetId)
    })
  } catch (error) { toast(error.message, true) }
})
$('refresh-targets').addEventListener('click', async () => {
  if (isBusy()) return
  try {
    await operation('正在读取实例…', async () => {
      if (hasEdits() && !await confirmAction('刷新实例与设置？', '放弃未保存的修改，重新读取实例列表和配置。', '重新读取')) return
      await loadTargets()
      toast('已刷新实例列表')
    })
  } catch (error) { if (state.loggedIn) { $('target-error').textContent = error.message; $('target-error').hidden = false } }
})
$('remove-target').addEventListener('click', async () => {
  if (isBusy() || !state.targetId) return
  const targetId = state.targetId
  const target = state.targets.find(item => item.id === targetId)
  try {
    await operation('正在移除连接…', async () => {
      if (!await confirmAction('移除这个连接？', `从本面板移除「${target?.label || targetId}」，不会删除配置文件或停止程序。${hasEdits() ? '未保存的修改将被放弃。' : ''}`, '移除连接')) return
      await api(`/api/targets/${encodeURIComponent(targetId)}`, { method: 'DELETE' })
      state.targets = state.targets.filter(item => item.id !== targetId)
      state.targetId = state.targets[0]?.id || ''
      rememberTarget(state.targetId)
      clearConfig(); resetFilters(); renderTarget()
      if (state.targetId) await load()
      toast('已移除连接')
    })
  } catch (error) { toast(error.message, true) }
})
$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = $('login-form').querySelector('button')
  if (button.disabled) return
  button.disabled = true
  $('login-error').textContent = ''
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) })
    state.csrf = result.csrf
    $('password').value = ''
    await startSession()
  } catch (error) { $('login-error').textContent = error.message }
  finally { button.disabled = false }
})
$('search').addEventListener('input', () => { state.query = $('search').value; renderFields() })
$('changed-only').addEventListener('change', renderFields)
$('reload').addEventListener('click', async () => {
  if (isBusy() || !state.targetId) return
  try {
    await operation('正在读取配置…', async () => {
      if (hasEdits() && !await confirmAction('重新载入设置？', '放弃未保存的修改，读取最新设置。', '重新载入')) return
      await load(); toast('已载入最新设置')
    })
  } catch (error) { toast(error.message, true) }
})
$('discard').addEventListener('click', async () => {
  if (isBusy() || !hasEdits()) return
  if (!await confirmAction('撤销本次修改？', '恢复为打开页面时的设置。', '撤销修改')) return
  state.changes.clear(); state.errors.clear(); state.drafts.clear(); renderFields(); updateSavebar()
})
$('logout').addEventListener('click', async () => {
  if (isBusy()) return
  try {
    await operation('正在退出…', async () => {
      if (hasEdits() && !await confirmAction('退出设置？', '放弃未保存的修改并退出。', '退出')) return
      await api('/api/logout', { method: 'POST', body: '{}' })
      showLogin()
    })
  } catch (error) { toast(error.message, true) }
})
$('change-password').addEventListener('click', async () => {
  if (isBusy()) return
  pauseStatus()
  if (hasEdits() && !await confirmAction('继续修改密码？', '修改成功后会退出登录，未保存的设置将被丢弃。', '继续')) return
  $('password-form').reset()
  $('password-error').textContent = ''
  $('password-dialog').showModal()
  $('current-password').focus()
})
$('password-cancel').addEventListener('click', () => {
  if (!state.authBusy) $('password-dialog').close()
})
$('password-dialog').addEventListener('cancel', event => {
  if (state.authBusy) event.preventDefault()
})
$('password-dialog').addEventListener('close', () => {
  $('password-form').reset()
  $('password-error').textContent = ''
})
$('password-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (isBusy()) return
  const currentPassword = $('current-password').value
  const newPassword = $('new-password').value
  const confirmPassword = $('confirm-password').value
  if (newPassword.length < 8 || newPassword.length > 128) { $('password-error').textContent = '新密码需要 8～128 个字符'; return }
  if (newPassword !== confirmPassword) { $('password-error').textContent = '两次新密码不一致'; return }
  const controls = [...$('password-form').elements]
  pauseStatus()
  state.authBusy = true
  controls.forEach(control => { control.disabled = true })
  $('password-error').textContent = ''
  $('password-submit').textContent = '正在修改…'
  updateSavebar()
  try {
    const result = await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) })
    showLogin()
    toast(result.message)
  } catch (error) {
    if ($('password-dialog').open) $('password-error').textContent = error.message
    else toast(error.message, true)
  } finally {
    state.authBusy = false
    controls.forEach(control => { control.disabled = false })
    $('password-submit').textContent = '确认修改'
    updateSavebar()
  }
})
$('save').addEventListener('click', async () => {
  if (!state.changes.size || state.errors.size || isBusy() || writeBlocked()) return
  const targetId = state.targetId
  const snapshot = state.data.snapshot
  const changes = [...state.changes].map(([key, value]) => ({ key, value: clone(value) }))
  const titles = changes.map(change => state.data.fields.find(field => field.key === change.key)?.label || change.key)
  const label = state.data.target.label || targetId
  pauseStatus()
  state.busy = true; updateSavebar()
  try {
    if (snapshot === undefined || snapshot === null) throw new Error('配置快照已失效，请重新载入。')
    // 确认弹窗使用新状态；POST 仍由后端再次核验状态和快照。
    state.runtime = await api(`/api/status?target=${encodeURIComponent(targetId)}`)
    state.statusError = ''
    renderTarget(); updateSavebar()
    const blocked = writeBlocked()
    if (blocked) throw new Error(blocked)
    const fileOnly = state.runtime.fileOnly === true
    const running = state.runtime.running === true
    const title = fileOnly ? '确认程序已停止？' : running ? '停止后保存并恢复运行？' : '保存这些修改？'
    const copy = fileOnly ? `请确认「${label}」及其他使用此配置的程序已停止。此操作只保存文件，不管理程序，也不保证自动生效。` : running ? `将停止「${label}」并中断当前任务，保存配置后恢复运行。` : `保存「${label}」的修改并保留备份，不会启动程序。`
    const action = fileOnly ? '已停止，仅保存文件' : running ? '停止、保存并恢复' : '保存设置'
    if (!await confirmAction(title, copy, action, titles)) return
    if (state.targetId !== targetId || state.data?.snapshot !== snapshot) throw new Error('所选实例已变化，请重新检查后保存。')
    const body = { targetId, snapshot, changes, confirmRestart: !fileOnly && running }
    if (fileOnly) body.confirmStopped = true
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(body) })
    if (result.saved !== true) throw new Error(result.message || '配置未保存，请重新检查。')
    state.changes.clear(); state.errors.clear(); state.drafts.clear()
    try { await load(targetId); toast(result.message || '设置已保存', !!result.restartFailed) }
    catch { if (state.loggedIn) toast(`${result.message || '设置已保存'} 请点击重新载入。`, true) }
  } catch (error) { if (error.name !== 'AbortError') toast(error.message, true) }
  finally { state.busy = false; updateSavebar() }
})
window.addEventListener('beforeunload', event => {
  if (hasEdits() || isBusy()) { event.preventDefault(); event.returnValue = '' }
})
window.addEventListener('keydown', event => {
  if (event.key === '/' && state.data && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('app-view').hidden) { event.preventDefault(); $('search').focus() }
})
setInterval(async () => {
  if (!state.data || isBusy() || statusController || document.hidden || !state.loggedIn || document.querySelector('dialog[open]')) return
  const targetId = state.targetId
  const controller = new AbortController()
  statusController = controller
  try {
    const status = await api(`/api/status?target=${encodeURIComponent(targetId)}`, { signal: controller.signal })
    if (controller.signal.aborted || isBusy() || document.querySelector('dialog[open]') || state.targetId !== targetId || !state.data) return
    state.runtime = status
    state.statusError = ''
    renderTarget(); updateSavebar()
  } catch (error) {
    if (error.name !== 'AbortError' && !controller.signal.aborted && state.loggedIn && state.targetId === targetId) {
      state.statusError = '状态更新失败，请重新载入后保存。'
      renderTarget(); updateSavebar()
    }
  } finally { if (statusController === controller) statusController = null }
}, 30000)
;(async () => {
  try {
    const session = await api('/api/session')
    if (!session.authenticated) return showLogin()
    state.csrf = session.csrf
    await startSession()
  } catch (error) { showLogin(); $('login-error').textContent = error.message }
})()
