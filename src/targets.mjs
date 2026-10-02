import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { discoverDocker, inspectDocker, readDockerFile, stopDocker, restoreDocker, writeDockerFile, observeDockerConfigUsers } from './docker.mjs'
import { discoverNative, inspectNative, stopNative, restoreNative, abandonNativeRestore, observeNativeConfigUsers } from './native.mjs'
import { processSnapshot } from './processes.mjs'
import { absolutePath, hash, problem, readLocal, validateGameConfig, atomicJSON, writeLocal, fileIdentity, sameFile } from './io.mjs'
import { MetadataStore, envOverrides } from './metadata.mjs'
import { containerMode, hostFS, canControlHost } from './host.mjs'

function targetId(spec) {
  return hash(spec.kind === 'docker' ? `docker:${spec.containerName}:${spec.containerConfigPath}` : `file:${spec.configPath}`).slice(0, 24)
}
function summary(record) {
  const spec = record.spec
  return { id: record.id, label: spec.label || spec.containerName || path.basename(path.dirname(spec.configPath)), kind: spec.kind, configPath: spec.configPath || null, root: spec.root || spec.containerRoot || null, containerName: spec.containerName || null }
}
export function publicRuntime(runtime) {
  return {
    available: !!runtime.available, running: runtime.running ?? null, status: runtime.status || 'unknown',
    canRead: !!runtime.canRead, canWrite: !!runtime.canWrite, canRestart: !!runtime.canRestart,
    label: runtime.label, managerLabel: runtime.managerLabel || '未确认', kind: runtime.kind,
    fileOnly: !!runtime.fileOnly, evidence: runtime.evidence || [], warnings: runtime.warnings || [],
  }
}
export class Targets {
  constructor(stateDir, roots) {
    this.directory = stateDir
    this.file = path.join(stateDir, 'connections.json')
    this.roots = roots || [os.homedir()]
    this.metadata = new MetadataStore(path.join(stateDir, 'metadata'))
    this.pending = new Map()
    this.records = new Map()
    if (fs.existsSync(this.file)) {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(stored) || stored.length > 100) throw new Error('实例记录格式不正确')
      for (const record of stored) if (record?.id && record.spec && record.revision) this.records.set(record.id, record)
    }
  }
  list() { return [...this.records.values()].map(summary) }
  record(id) {
    const record = this.records.get(id)
    if (!record) throw problem(404, '请选择已接入的实例')
    return record
  }
  persist() { atomicJSON(this.file, [...this.records.values()]) }
  register(spec) {
    const id = targetId(spec)
    if (!this.records.has(id) && this.records.size >= 50) throw problem(400, '已接入实例过多，请先移除不用的实例')
    const record = { id, revision: randomBytes(12).toString('hex'), spec }
    const old = this.records.get(id)
    this.records.set(id, record)
    try { this.persist() } catch (error) { if (old) this.records.set(id, old); else this.records.delete(id); throw error }
    return summary(record)
  }
  remove(id) {
    const old = this.record(id)
    this.records.delete(id)
    try { this.persist() } catch (error) { this.records.set(id, old); throw error }
  }
  async discover(roots, owner) {
    if (roots !== undefined && (!Array.isArray(roots) || roots.length > 8)) throw problem(400, '扫描目录最多填写 8 个')
    const directories = (!roots?.length ? this.roots : roots).map(absolutePath)
    const diagnostics = []
    // 宿主目录不可访问不应阻断独立的 Docker 发现。
    const nativeDiscovery = async () => {
      const canonicalRoots = []
      for (const directory of directories) {
        try {
          const root = await hostFS.realpath(directory)
          if (!(await hostFS.stat(root)).isDirectory()) throw problem(400, '扫描路径必须是目录')
          if (!canonicalRoots.includes(root)) canonicalRoots.push(root)
        } catch (error) {
          console.warn('[发现] 宿主目录不可访问', { directory, code: error.code || error.status || 'unknown' })
          diagnostics.push(`请检查宿主扫描目录：${directory}`)
        }
      }
      return discoverNative({ roots: canonicalRoots })
    }
    const results = await Promise.allSettled([discoverDocker(), nativeDiscovery()])
    const specs = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        specs.push(...result.value.candidates)
        diagnostics.push(...result.value.diagnostics)
      } else {
        const kind = index === 0 ? 'Docker' : '原生'
        console.warn('[发现] 实例扫描失败', { kind, code: result.reason?.code || result.reason?.status || 'unknown' })
        diagnostics.push(index === 0 ? '请检查 Docker 连接与访问权限' : '请检查宿主扫描目录与访问权限')
      }
    }
    const candidates = []
    const seen = new Set()
    for (const spec of specs) {
      const id = targetId(spec)
      if (seen.has(id)) continue
      seen.add(id)
      const key = randomBytes(16).toString('hex')
      this.pending.set(key, { spec, owner, until: Date.now() + 10 * 60 * 1000 })
      candidates.push({ ...summary({ id, spec }), key, evidence: spec.evidence || [], warnings: spec.warnings || [] })
    }
    for (const [key, candidate] of this.pending) if (candidate.until < Date.now() || this.pending.size > 200) this.pending.delete(key)
    return { candidates, diagnostics }
  }
  async accept(key, owner) {
    const candidate = this.pending.get(key)
    if (!candidate || candidate.owner !== owner || candidate.until < Date.now()) throw problem(409, '候选已过期，请重新发现')
    const runtime = await this.inspect(candidate.spec)
    if (!runtime.canRead) throw problem(400, '实例配置无法读取，请检查权限')
    this.pending.delete(key)
    return this.register(candidate.spec)
  }
  async manual(input) {
    if (!input || typeof input !== 'object') throw problem(400, '请填写配置路径')
    if (input.configLocation === 'container') {
      if (!input.containerName) throw problem(400, '使用容器内路径时请填写容器名称')
      const config = absolutePath(input.configPath)
      if (!/\.ya?ml$/i.test(config)) throw problem(400, '请选择 YAML 配置文件')
      let specs
      if (input.installDir) specs = [{ kind: 'docker', containerName: input.containerName, containerRoot: absolutePath(input.installDir), containerConfigPath: config }]
      else specs = (await discoverDocker({ containerName: input.containerName })).candidates.filter(spec => spec.containerConfigPath === config)
      if (specs.length !== 1) throw problem(400, '无法确认容器内配置，请核对路径并补充容器内安装目录')
      const runtime = await inspectDocker(specs[0])
      if (runtime.warnings.some(warning => warning.includes('实际配置路径无法确认'))) throw problem(400, '所填路径不是该程序声明的配置文件')
      return this.register({ ...specs[0], configPath: runtime.configPath, label: runtime.label, fileOnly: input.fileOnly === true })
    }
    if (input.configLocation && input.configLocation !== 'host') throw problem(400, '配置路径类型不正确')
    let file
    try { file = await readLocal(absolutePath(input.configPath)) } catch (error) {
      if (error.code === 'ENOENT') throw problem(400, '未找到配置文件，请填写服务器上的完整路径')
      if (['EACCES', 'EPERM'].includes(error.code)) throw problem(403, '面板用户没有读取该配置文件的权限')
      throw error
    }
    if (!/\.ya?ml$/i.test(file.actual)) throw problem(400, '请选择 YAML 配置文件')
    validateGameConfig(file.text)
    const docker = await discoverDocker({ hostConfig: file.actual, containerName: input.containerName || undefined })
    if (input.containerName && !docker.candidates.length) throw problem(400, '容器与配置路径不匹配，请检查名称、挂载和访问权限')
    if (docker.candidates.length > 1) throw problem(409, '该配置对应多个容器，请在高级选项填写容器名称')
    if (docker.candidates.length === 1) {
      return this.register({ ...docker.candidates[0], configPath: file.actual, fileOnly: input.fileOnly === true })
    }
    const spec = { kind: 'native', configPath: file.actual, root: input.installDir ? await hostFS.realpath(absolutePath(input.installDir)) : path.dirname(file.actual), label: path.basename(path.dirname(file.actual)), fileOnly: input.fileOnly === true }
    const runtime = await inspectNative(spec)
    if (runtime.kind === 'file' && !spec.fileOnly) throw problem(400, '未确认程序安装目录，请补充安装目录或选择仅编辑文件模式')
    if (runtime.kind === 'file') { spec.kind = 'file'; spec.root = null }
    else {
      spec.root = runtime.root
      if (runtime.manager?.type === 'pm2') spec.managerHint = { type: 'pm2', id: runtime.manager.id, home: runtime.manager.home }
      else if (runtime.manager?.type === 'systemd') spec.managerHint = { type: 'systemd', unit: runtime.manager.unit, user: !!runtime.manager.user, uid: runtime.manager.uid ?? null }
    }
    return this.register(spec)
  }
  async inspect(spec) {
    const runtime = spec.kind === 'docker' ? await inspectDocker(spec) : await inspectNative(spec)
    if (!runtime.canRead) return runtime
    if (spec.kind !== 'docker') {
      const local = await readLocal(spec.configPath)
      validateGameConfig(local.text)
      if (local.actual !== spec.configPath) throw problem(409, '配置路径已变化，请重新接入')
      runtime.configPath = local.actual
      runtime.config = local
    }
    if (spec.fileOnly) {
      runtime.fileOnly = true
      runtime.canRestart = false
      // 纯文件模式要求每次保存重新确认；已知运行中的程序不能绕过闸门。
      let writable = runtime.canWrite
      if (spec.kind !== 'docker') {
        try { await hostFS.access(spec.configPath, fs.constants.W_OK); writable = true } catch { writable = false }
      }
      runtime.canWrite = writable && runtime.running !== true
      runtime.warnings = [...(runtime.warnings || []), '仅保存配置文件；保存前必须确认没有运行中的程序写入，应用方式由原部署决定']
    }
    return this.verifyIsolation(runtime, spec)
  }
  async verifyIsolation(runtime, spec) {
    if (!runtime.canWrite) return runtime
    const deny = (message, reason) => {
      runtime.canWrite = false; runtime.canRestart = false
      runtime.warnings = [message, ...(runtime.warnings || [])]
      console.warn('[配置隔离]', reason)
      return runtime
    }
    const identity = runtime.storage?.identity || runtime.config?.identity
    if (!identity) return deny('请核对配置文件后重新接入', '配置文件身份不可用')
    const snapshot = await processSnapshot()
    if (!snapshot.complete || !snapshot.observer) return deny('请检查进程访问权限后重新载入', '进程检查不完整')
    const [native, docker] = await Promise.all([
      observeNativeConfigUsers(identity, snapshot), observeDockerConfigUsers(identity, snapshot, runtime)
    ])
    const own = runtime.kind === 'native' ? runtime.processes || [] : []
    const others = native.users.filter(user => !own.some(proc => proc.pid === user.pid && proc.startTime === user.startTime))
    let registered = false
    for (const record of this.records.values()) {
      if (record.id === targetId(spec) || record.spec.kind === 'docker' || !record.spec.configPath) continue
      try { if (sameFile(identity, await fileIdentity(record.spec.configPath))) registered = true }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return deny('请核对已连接实例的配置访问权限', '已连接配置身份不可用')
      }
    }
    if (others.length || docker.users.length || registered) return deny('请为每个实例配置独立文件后再保存', `共享配置：本机进程 ${others.length}，容器 ${docker.users.length}，其他连接 ${registered ? 1 : 0}`)
    if (!native.complete || !docker.complete) return deny(native.warnings[0] || docker.warnings[0] || '请核对其他部署后重新载入', '其他配置使用者无法完整核验')
    if (containerMode && !canControlHost()) return deny('请核对上次保存的备份与实例状态，然后在部署目录执行 docker compose restart web', '宿主变更操作已锁定')
    return runtime
  }
  async bundle(id) {
    const record = this.record(id)
    const runtime = await this.inspect(record.spec)
    if (!runtime.canRead) throw problem(503, '无法读取目标配置，请检查权限与运行环境')
    const metadata = await this.metadata.get(record.spec, runtime)
    runtime.warnings = [...(runtime.warnings || []), ...metadata.warnings]
    const config = runtime.config || (runtime.kind === 'docker' ? await readDockerFile(runtime.containerId, runtime.containerConfigPath) : await readLocal(record.spec.configPath))
    const doc = validateGameConfig(config.text)
    const overrides = envOverrides(runtime.environment)
    if (runtime.environment === null) runtime.warnings.push('无法确认运行进程的环境变量，修改前请检查外部覆盖项')
    const fields = metadata.schema.fieldsFor(doc, overrides)
    if (metadata.missingInstances) for (const field of fields) if (['instance_names', 'power_plan'].includes(field.key)) field.readonly = true
    const identity = runtime.kind === 'docker' ? runtime.identity : runtime.bindingIdentity
    const storage = runtime.storage?.identity || config.identity
    return { record, runtime, metadata, config, doc, fields, target: summary(record), binding: hash(JSON.stringify([record.revision, runtime.kind, identity, storage])) }
  }
  async stop(bundle) {
    const fresh = await this.bundle(bundle.record.id)
    if (fresh.binding !== bundle.binding || !fresh.runtime.canWrite) throw problem(409, fresh.runtime.warnings?.[0] || '实例已变化，请重新载入')
    return fresh.runtime.kind === 'docker' ? stopDocker(fresh.runtime) : stopNative(fresh.runtime)
  }
  async restore(runtime, token) { return runtime.kind === 'docker' ? restoreDocker(token) : restoreNative(token) }
  abandon(runtime, token) { if (runtime.kind !== 'docker') abandonNativeRestore(token) }
  async write(bundle, next) {
    const fresh = await this.bundle(bundle.record.id)
    if (fresh.binding !== bundle.binding || fresh.config.text !== bundle.config.text) throw problem(409, '配置文件已变化，请重新载入')
    if (!fresh.runtime.canWrite || fresh.runtime.running === true || (!fresh.runtime.fileOnly && fresh.runtime.running !== false)) throw problem(409, fresh.runtime.warnings?.[0] || '请确认实例已停止后再保存')
    if (fresh.runtime.kind === 'docker') await writeDockerFile(fresh.runtime, fresh.config, next)
    else await writeLocal(fresh.record.spec.configPath, fresh.config.text, next, fresh.runtime.configPath, fresh.config.identity)
  }
}
