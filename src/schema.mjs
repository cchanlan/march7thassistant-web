import fs from 'node:fs'
import { isMap, isSeq, parseDocument } from 'yaml'
import { isDeepStrictEqual } from 'node:util'

const seedMetadata = JSON.parse(fs.readFileSync(new URL('../metadata/schema.json', import.meta.url), 'utf8'))
const seedDefaults = fs.readFileSync(new URL('../metadata/defaults.yaml', import.meta.url), 'utf8')

export function createSchema(defaultText, metadata = seedMetadata) {
  const defaultsDoc = parseConfig(defaultText)
  const defaults = defaultsDoc.toJS({ maxAliasCount: 0 })
  const version = metadata.version
  const instances = metadata.instances
  const groups = [
    { id: 'power', title: '体力与培养', icon: '✧' },
    { id: 'daily', title: '日常与奖励', icon: '☀' },
    { id: 'weekly', title: '周常与挑战', icon: '◇' },
    { id: 'cloud', title: '云游戏与浏览器', icon: '☁' },
    { id: 'schedule', title: '运行与定时', icon: '◷' },
    { id: 'notify', title: '消息推送', icon: '✉' },
    { id: 'advanced', title: '更多设置', icon: '⚙' },
    { id: 'runtime', title: '运行记录', icon: '↺' },
  ]
  const envMap = {
    MARCH7TH_CLOUD_GAME_ENABLE: 'cloud_game_enable',
    MARCH7TH_CLOUD_GAME_USE_PAID_TIME: 'cloud_game_use_paid_time',
    MARCH7TH_BROWSER_HEADLESS_ENABLE: 'browser_headless_enable',
    MARCH7TH_BROWSER_HEADLESS_RESTART_ON_NOT_LOGGED_IN: 'browser_headless_restart_on_not_logged_in',
    MARCH7TH_BROWSER_DOWNLOAD_USE_MIRROR: 'browser_download_use_mirror',
    MARCH7TH_LOG_LEVEL: 'log_level',
    MARCH7TH_AFTER_FINISH: 'after_finish',
    MARCH7TH_BROWSER_TYPE: 'browser_type',
  }
  const labels = {
    instance_type: '默认副本类型', instance_names: '各类型的默认副本',
    instance_names_challenge_count: '副本连续挑战次数', power_plan: '体力计划',
    power_plan_keep: '保留体力计划', instance_teams: '指定副本的队伍',
    build_target_enable: '启用培养目标', break_down_level_four_relicset: '自动分解四星及以下遗器',
    currencywars_enable: '启用货币战争', scheduled_time: '循环运行时间',
    scheduled_tasks: '桌面端定时任务', after_finish: '任务完成后',
    cloud_game_enable: '启用云游戏', browser_headless_enable: '无窗口运行',
    loop_mode: '循环模式', power_limit: '循环所需开拓力', refresh_hour: '每日刷新时间',
    notification_enable: '启用消息推送', notify_template: '消息模板',
    log_level: '日志级别', log_retention_days: '日志保留天数',
    calyx_golden_preference: '拟造花萼（金）偏好地区',
  }
  const optionValues = {
    log_level: ['INFO', 'DEBUG', 'WARNING', 'ERROR'],
    ui_language: ['auto', 'zh_CN', 'zh_TW', 'ja_JP', 'ko_KR', 'en_US'],
    loop_mode: { '定时运行': 'scheduled', '根据开拓力': 'power' },
    after_finish: ['None', 'Exit', 'Loop', 'Shutdown', 'Sleep', 'Hibernate', 'Restart', 'Logoff', 'TurnOffDisplay', 'RunScript'],
    browser_type: ['integrated', 'edge', 'chrome', 'chromium'],
    build_target_scheme: { '副本名称识别': 'instance', '掉落物识别': 'drop' },
    currencywars_type: { '标准博弈': 'normal', '超频博弈': 'overclock' },
    currencywars_rank_difficulty: { '当前职级': 'current', '最低职级': 'lowest', '最高职级': 'highest' },
    currencywars_strategy: { '默认': 'default', '阿格莱雅': 'aglaea' },
    calyx_golden_preference: { '雅利洛-VI': 'Jarilo-VI', '仙舟「罗浮」': 'XianzhouLuofu', '匹诺康尼': 'Penacony' },
    weekly_divergent_type: { '常规演算': 'normal', '周期演算': 'cycle' },
    divergent_type: { '常规演算': 'normal', '周期演算': 'cycle' },
    universe_category: { '差分宇宙': 'divergent', '模拟宇宙': 'universe' },
    universe_frequency: { '每周': 'weekly', '每天': 'daily' },
    notify_level: { '全部通知': 'all', '仅错误通知': 'error' },
    scheduled_on_conflict: { '跳过新任务': 'skip', '停止当前任务': 'stop' },
    ocr_gpu_acceleration: ['auto', 'gpu', 'onnx_dml', 'cpu', 'openvino_cpu', 'onnx_cpu'],
  }
  const ranges = {
    browser_debug_port: [1, 65535], refresh_hour: [0, 23],
    weekly_divergent_level: [1, 6], echo_of_war_start_day_of_week: [1, 7],
    weekly_relic_cleanup_day_of_week: [1, 7],
    build_target_ornament_weekly_count: [0, 7], browser_scale_factor: [0.1, 5],
    power_limit: [0, 300], log_retention_days: [1, 3650],
  }
  const secrets = /token|password|secret|sctkey|sendkey|cdk|webhook(?:$|_url$|_headers$|_body$)|headers|^notify_.*_key$|^notify_custom_(url|data|image)$/i
  const runtime = /timestamp$|_completed_count$|^already_used_codes$|^daily_tasks$|^telemetry_(id|secret)$|_requirements$|^window_(width|height|x|y|maximized)$|^home_cards$/
  const common = new Set(['power_enable', 'instance_type', 'instance_names', 'build_target_enable', 'break_down_level_four_relicset', 'currencywars_enable', 'daily_enable', 'reward_enable', 'weekly_divergent_enable', 'scheduled_time', 'loop_mode', 'notification_enable'])
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
  const same = isDeepStrictEqual

  function parseConfig(text) {
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('配置文件过大')
    const doc = parseDocument(text, { uniqueKeys: true, version: '1.2' })
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error('配置文件格式不正确')
    const data = doc.toJS({ maxAliasCount: 0 })
    checkStructure(data)
    return doc
  }
  function checkStructure(value, depth = 0) {
    if (depth > 16) throw new Error('配置嵌套过深')
    if (value && typeof value === 'object') {
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('不支持的配置类型')
      for (const [key, v] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('不允许的配置字段')
        checkStructure(v, depth + 1)
      }
    } else if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('数值不正确')
  }
  function category(key) {
    if (runtime.test(key)) return 'runtime'
    if (/^(notify_|notification_)/.test(key)) return 'notify'
    if (/^(cloud_game_|browser_)/.test(key)) return 'cloud'
    if (/^(power_|instance_|build_target_|borrow_|echo_of_war_|calyx_|tp_before_|break_down_|merge_|use_fuel$|use_reserved_)/.test(key)) return 'power'
    if (/^(daily_|reward_|activity_|asset_)/.test(key)) return 'daily'
    if (/^(currencywars_|weekly_|universe_|divergent_|fight_|forgottenhall_|purefiction_|apocalyptic_)/.test(key)) return 'weekly'
    if (/^(scheduled_|loop_mode$|power_limit$|refresh_hour$|after_finish$|pause_after_success$|exit_after_failure$|play_audio$|script_path$)/.test(key)) return 'schedule'
    return 'advanced'
  }
  function typeOf(value) {
    return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  }
  function descriptionFor(key, doc) {
    const node = defaultsDoc.get(key, true) || doc.get(key, true)
    const comment = node?.comment || ''
    return comment.trim().replace(/\s+/g, ' ')
  }
  function normalizedOptions(key, type) {
    const raw = optionValues[key]
    let options = raw ? (Array.isArray(raw) ? raw.map(v => ({ label: v, value: v })) : Object.entries(raw).map(([label, value]) => ({ label, value }))) : metadata.fields[key]?.options
    if (!options || !options.every(o => typeOf(o.value) === type)) return undefined
    // 桌面端某些下拉菜单的显示值另有映射，不能把中文标签当作实际存储值。
    if (!raw && !options.some(o => same(o.value, defaults[key]))) return undefined
    return options
  }
  function fieldsFor(doc, overrides = {}) {
    const data = doc.toJS({ maxAliasCount: 0 })
    return Object.keys(data).map(key => {
      const value = data[key]
      const def = own(defaults, key) ? defaults[key] : value
      const type = typeOf(def)
      const description = descriptionFor(key, doc)
      const info = metadata.fields[key] || {}
      const group = category(key)
      const field = {
        key, group, type, label: labels[key] || info.label || description.split(/[。；]/)[0].replace(/^是否/, '').slice(0, 48) || key,
        description, options: normalizedOptions(key, type), range: ranges[key] || info.range,
        integer: type === 'number' && Number.isInteger(def) && key !== 'browser_scale_factor',
        common: common.has(key), secret: secrets.test(key) || !own(defaults, key), readonly: group === 'runtime' || !!overrides[key],
        override: overrides[key] || null,
      }
      if (!field.secret) field.value = value
      else field.configured = value !== '' && value != null
      if (!own(defaults, key)) { field.unknown = true; field.readonly = true }
      if (typeOf(value) !== type && type !== 'null') {
        field.warning = type === 'boolean' ? '请选择开启或关闭后保存。' : '请检查填写格式后保存。'
        field.invalidType = true
      }
      if (key === 'scheduled_tasks') field.description = '图形界面计划任务；命令行循环的运行时间请使用「循环运行时间」。'
      if (key === 'scheduled_time') field.description = '设置命令行循环运行的时间，使用 24 小时制。'
      return field
    })
  }
  function validateChange(field, value) {
    if (!field || field.readonly) throw new Error('该设置暂不可修改')
    checkStructure(value)
    if (field.type !== 'null' && typeOf(value) !== field.type) throw new Error(`${field.label}：填写格式不正确`)
    if (typeof value === 'string' && value.length > 32000) throw new Error(`${field.label}：内容过长`)
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (field.integer && !Number.isSafeInteger(value))) throw new Error(`${field.label}：请填写有效数字`)
      if (field.range && (value < field.range[0] || value > field.range[1])) throw new Error(`${field.label}：请填写 ${field.range[0]}～${field.range[1]}`)
      if (!field.range && value < 0) throw new Error(`${field.label}：不能小于 0`)
    }
    if (field.options && !field.options.some(o => same(o.value, value))) throw new Error(`${field.label}：请选择列表中的选项`)
    if (['scheduled_time', 'scheduled_run_time'].includes(field.key) && !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('运行时间：请填写 HH:mm')
    if (/team_number$/.test(field.key) && !/^(?:[1-9]|10)$/.test(value)) throw new Error('队伍编号：请填写 1～10')
    if (field.key === 'instance_names') {
      for (const [kind, name] of Object.entries(value)) {
        if (typeof name !== 'string' || (instances[kind] && !own(instances[kind], name))) throw new Error('副本名称：请选择列表中的副本')
      }
    }
    if (field.key === 'instance_names_challenge_count' && Object.values(value).some(v => !Number.isInteger(v) || v < 1 || v > 1000)) throw new Error('副本连续挑战次数：请填写 1～1000 的整数')
    if (field.key === 'power_plan') {
      for (const row of value) {
        if (!Array.isArray(row) || row.length !== 3 || !own(instances, row[0]) || !own(instances[row[0]], row[1]) || !Number.isInteger(row[2]) || row[2] < 1 || row[2] > 1000) throw new Error('体力计划：请选择副本并填写 1～1000 次')
      }
    }
    if (field.key === 'instance_teams') {
      for (const row of value) {
        if (!row || typeof row.instance_name !== 'string' || !/^(?:[1-9]|10)$/.test(String(row.team_number))) throw new Error('指定副本队伍：请填写副本名称和 1～10 的队伍编号')
      }
    }
    if (/^(forgottenhall|purefiction|apocalyptic)_level$/.test(field.key)) {
      const max = field.key.startsWith('forgottenhall') ? 12 : 4
      if (value.length !== 2 || value.some(n => !Number.isInteger(n) || n < 1 || n > max) || value[0] > value[1]) throw new Error(`关卡范围：请填写从小到大的两个数字，范围 1～${max}`)
    }
    if (/^(daily_memory_one_team|(?:forgottenhall|purefiction|apocalyptic)_team[12])$/.test(field.key)) {
      if (value.length !== 4 || value.some(v => !Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || !Number.isInteger(v[1]) || v[1] < -1 || v[1] > 5)) throw new Error('队伍配置：需要四名角色，秘技次数为 -1～5')
    }
    if (field.key === 'scheduled_tasks') {
      const ids = new Set()
      for (const row of value) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.name !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time) || typeof row.program !== 'string' || typeof row.enabled !== 'boolean') throw new Error('定时任务：请检查 ID、名称、时间、程序和启用状态')
        if (row.timeout !== undefined && (!Number.isInteger(row.timeout) || row.timeout < 0)) throw new Error('定时任务：超时需要填写非负整数')
        ids.add(row.id)
      }
    }
  }
  // 仅替换变化的节点；保留原注释、键序和未改动的字符串引号。
  function patchNode(doc, previous, value) {
    if (previous && same(previous.toJSON(), value)) return previous
    if (isMap(previous) && value && !Array.isArray(value) && typeof value === 'object') {
      for (const pair of [...previous.items]) if (!own(value, String(pair.key.value))) previous.delete(pair.key.value)
      for (const [key, val] of Object.entries(value)) previous.set(key, patchNode(doc, previous.get(key, true), val))
      return previous
    }
    if (isSeq(previous) && Array.isArray(value)) {
      previous.items = value.map((v, i) => patchNode(doc, previous.items[i], v))
      return previous
    }
    const node = doc.createNode(value)
    if (previous) for (const key of ['comment', 'commentBefore', 'spaceBefore']) if (previous[key] !== undefined) node[key] = previous[key]
    return node
  }
  function applyChanges(doc, changes) {
    for (const { key, value } of changes) doc.set(key, patchNode(doc, doc.get(key, true), value))
    const text = doc.toString({ lineWidth: 0 })
    parseConfig(text)
    return text
  }
  return { parseConfig, fieldsFor, validateChange, applyChanges, groups, instances, envMap, version }
}

export const seedSchema = createSchema(seedDefaults)
export const parseConfig = seedSchema.parseConfig
export const envMap = seedSchema.envMap
export const same = isDeepStrictEqual
export const fallbackMetadata = seedMetadata
