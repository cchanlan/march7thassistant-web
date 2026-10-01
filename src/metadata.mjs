import fs from 'node:fs'
import path from 'node:path'
import { createSchema, fallbackMetadata, seedSchema, envMap } from './schema.mjs'
import { readDockerFile } from './docker.mjs'
import { readLocal, hash, atomicJSON, problem } from './io.mjs'

function instancesFrom(text) {
  const data = JSON.parse(text)
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('副本资料格式不正确')
  for (const [key, value] of Object.entries(data)) {
    if (key.length > 200 || !value || Array.isArray(value) || typeof value !== 'object' || Object.entries(value).some(([name, description]) => name.length > 300 || typeof description !== 'string' || description.length > 2000)) throw new Error('副本资料格式不正确')
  }
  return data
}
export function envOverrides(environment, { linux = true } = {}) {
  const result = {}
  for (const [name, key] of Object.entries(envMap)) {
    if (environment && Object.prototype.hasOwnProperty.call(environment, name)) {
      const raw = String(environment[name])
      result[key] = { env: name, value: ['log_level', 'after_finish', 'browser_type'].includes(key) ? (key === 'log_level' ? raw.toUpperCase() : raw) : ['true', '1'].includes(raw.toLowerCase()) }
    }
  }
  // 上游非 Windows 初始化默认启用云游戏。显式环境覆盖仍优先。
  if (linux && !result.cloud_game_enable) result.cloud_game_enable = { env: 'MARCH7TH_CLOUD_GAME_ENABLE', value: true, source: '非 Windows 默认值' }
  return result
}
export class MetadataStore {
  constructor(directory) {
    this.directory = directory
    this.cache = new Map()
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  async get(spec, runtime) {
    if (!runtime.root || runtime.kind === 'file') {
      return { schema: seedSchema, warnings: ['仅文件模式使用面板附带的字段说明，未确认程序版本'], version: '未检测', reference: true, missingInstances: false }
    }
    let defaults, version, instanceText
    const warnings = []
    try {
      if (runtime.kind === 'docker') {
        defaults = runtime.defaults
        version = runtime.version
        try { instanceText = (await readDockerFile(runtime.containerId, path.posix.join(runtime.root, 'assets/config/instance_names.json'))).text } catch { /* 下面统一降级为只读副本设置。 */ }
      } else {
        defaults = readLocal(path.join(runtime.root, 'assets/config/config.example.yaml')).text
        version = readLocal(path.join(runtime.root, 'assets/config/version.txt')).text.trim()
        try { instanceText = readLocal(path.join(runtime.root, 'assets/config/instance_names.json')).text } catch {}
      }
    } catch { throw problem(503, '无法读取当前程序的字段定义，请检查安装目录权限') }
    if (typeof version !== 'string' || version.length > 100 || /[\r\n\0]/.test(version)) throw problem(400, '程序版本信息不正确')
    let instances
    try { instances = instancesFrom(instanceText) } catch {
      instances = fallbackMetadata.instances
      warnings.push('当前副本资料无法读取，副本名称和体力计划暂为只读')
    }
    const fingerprint = hash(`${defaults}\n${JSON.stringify(instances)}\n${version}`)
    let schema = this.cache.get(fingerprint)
    if (!schema) {
      // 类型、注释与副本来自当前安装；内置中文标题只作为已有字段的展示补充。
      schema = createSchema(defaults, { fields: fallbackMetadata.fields, instances, version })
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value)
      this.cache.set(fingerprint, schema)
      atomicJSON(path.join(this.directory, `${fingerprint}.json`), { version, fingerprint, source: runtime.kind })
    }
    return { schema, warnings, version, reference: false, missingInstances: warnings.length > 0, fingerprint }
  }
}
