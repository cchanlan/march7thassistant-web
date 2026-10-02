import { containerMode, hostFS as fs, hostUid, readHostFile } from './host.mjs'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileIdentity, sameFile } from './io.mjs'
import {
  command, digest, failure, isPython, pause, pm2Call, pm2Daemon,
  processAt, processSnapshot, readLimited, scriptInvocation, unitFromCgroup, validUnit, within
} from './processes.mjs'

const MARKERS = ['assets/config/config.example.yaml', 'assets/config/version.txt', 'module/config/config.py']
const CONFIG_MODULE = 'module/config/__init__.py'
const SKIP = new Set(['node_modules', '.git', 'logs', 'log', '.state', '.venv', 'venv', '__pycache__', '.cache', '.tox', '.mypy_cache', 'site-packages', '.claude'])
const observed = new WeakMap()
const restores = new WeakMap()
const activeOperations = new Set()
const ENVIRONMENT_KEYS = Object.freeze([
  'MARCH7TH_CLOUD_GAME_ENABLE', 'MARCH7TH_CLOUD_GAME_USE_PAID_TIME', 'MARCH7TH_BROWSER_HEADLESS_ENABLE',
  'MARCH7TH_BROWSER_HEADLESS_RESTART_ON_NOT_LOGGED_IN', 'MARCH7TH_BROWSER_DOWNLOAD_USE_MIRROR',
  'MARCH7TH_LOG_LEVEL', 'MARCH7TH_AFTER_FINISH', 'MARCH7TH_BROWSER_TYPE'
])
export function filterEnvironment(input) {
  const result = {}
  for (const key of ENVIRONMENT_KEYS) {
    const value = input?.[key]
    if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = String(value)
  }
  return result
}
async function environmentOf(apps, manager, warnings) {
  const processes = apps.direct.filter(proc => isPython(proc.argv[0]))
  if (!processes.length) {
    if (manager?.environment != null) return { ...manager.environment }
    warnings.push('无法确认配置的环境变量覆盖项')
    return null
  }
  let result
  try {
    for (const previous of processes) {
      const before = await processAt(previous.pid)
      if (!before || before.startTime !== previous.startTime) throw new Error()
      const environment = {}
      for (const pair of (await readLimited(`/proc/${previous.pid}/environ`, 1024 * 1024)).split('\0')) {
        const split = pair.indexOf('=')
        const key = pair.slice(0, split)
        if (split > 0 && ENVIRONMENT_KEYS.includes(key)) environment[key] = pair.slice(split + 1)
      }
      const after = await processAt(previous.pid)
      if (!after || after.startTime !== previous.startTime) throw new Error()
      const filtered = filterEnvironment(environment)
      if (result && digest(result) !== digest(filtered)) throw new Error()
      result = filtered
    }
    return result
  } catch { warnings.push('无法读取或一致核验目标进程的环境变量覆盖项'); return null }
}
const defaultHome = () => process.env.PM2_HOME || path.join(os.homedir(), '.pm2')
const publicProcess = proc => ({ pid: proc.pid, startTime: proc.startTime, ppid: proc.ppid })
const sameProcesses = (a, b) => digest(a.map(p => `${p.pid}:${p.startTime}`).sort()) === digest(b.map(p => `${p.pid}:${p.startTime}`).sort())
const clamp = (value, fallback, min, max) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback

async function canonical(file) {
  const absolute = path.resolve(file)
  try { return await fs.realpath(absolute) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Canonicalize an absent leaf without following a future, unverified link.
    return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute))
  }
}
async function regular(file, boundary) {
  const real = await fs.realpath(file)
  if (boundary && !within(boundary, real)) return null
  const stat = await fs.stat(real)
  return stat.isFile() ? { path: real, stamp: [real, stat.dev, stat.ino, stat.size, stat.mtimeMs] } : null
}

// Parse only an unambiguous top-level Python string literal; never import/execute source.
export function parseConfigPath(source) {
  const assignments = [...String(source).matchAll(/^CONFIG_PATH\s*(?::[^=\n]+)?=\s*(["'])((?:\\.|[^\\\n])*?)\1\s*(?:#[^\n]*)?$/gm)]
  const allAssignments = String(source).match(/^\s*CONFIG_PATH\s*(?::[^=\n]+)?=/gm) || []
  if (assignments.length !== 1 || allAssignments.length !== 1 || !/\bcfg\s*=\s*Config\s*\([^)]*\bCONFIG_PATH\b[^)]*\)/s.test(source)) return null
  const literal = assignments[0][2]
  if (/\\(?![\\'"])/.test(literal) || /['"]/.test(literal.replace(/\\[\\'"]/g, ''))) return null
  const value = literal.replace(/\\([\\'"])/g, '$1')
  return value && !/[\0\r\n]/.test(value) ? value : null
}

async function projectAt(directory) {
  try {
    const root = await fs.realpath(directory)
    if (!(await fs.stat(root)).isDirectory()) return null
    const markers = []
    for (const name of MARKERS) {
      const file = await regular(path.join(root, name), root)
      if (!file) return null
      markers.push(file.stamp)
    }
    const entries = []
    for (const name of ['app.py', 'main.py']) {
      try { const file = await regular(path.join(root, name), root); if (file) { entries.push(file.path); markers.push(file.stamp) } } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!entries.length) return null
    let configPath = null
    try {
      const module = await regular(path.join(root, CONFIG_MODULE), root)
      if (module) {
        const literal = parseConfigPath(await readHostFile(module.path, 524288))
        markers.push(module.stamp)
        const target = literal ? path.resolve(root, literal) : null
        if (target && within(root, target)) {
          const real = await canonical(target)
          if (within(root, real)) configPath = real
        }
      }
    } catch {}
    return { root, entries, configPath, fingerprint: digest(markers), evidence: ['已核验源码入口、配置示例、版本文件和配置模块', ...(configPath ? ['已静态核验 CONFIG_PATH 与配置实例的关联'] : [])] }
  } catch { return null }
}

const hasFileIdentity = value => typeof value?.dev === 'string' && value.dev.length > 0 && typeof value.ino === 'string' && value.ino.length > 0

// null means insufficient scope metadata, not a foreign process that can be skipped.
function localProcess(proc, hostScope) {
  for (const scope of [proc, hostScope]) {
    if (typeof scope?.namespaces?.mount !== 'string' || !scope.namespaces.mount || typeof scope.namespaces.pid !== 'string' || !scope.namespaces.pid || !hasFileIdentity(scope.rootIdentity)) return null
  }
  // PID-only isolation does not change filesystem paths: such a process can
  // still share the host config. Only mount/root establish the path boundary.
  return proc.namespaces.mount === hostScope.namespaces.mount && sameFile(proc.rootIdentity, hostScope.rootIdentity)
}

/** Read-only use detection is deliberately broader than projectAt's management boundary. */
export async function observeNativeConfigUsers(identity, snapshot) {
  const users = [], warnings = [...(snapshot?.warnings || [])]
  let complete = snapshot?.complete === true
  const uncertain = message => { complete = false; warnings.push(message) }
  const finish = () => ({ users: users.sort((a, b) => a.pid - b.pid || a.root.localeCompare(b.root)), complete, warnings: [...new Set(warnings)] })
  if (!complete) uncertain('进程快照不完整，无法排除其他配置使用者')
  if (process.platform !== 'linux' || !Array.isArray(snapshot?.processes) || localProcess(snapshot.hostScope, snapshot.hostScope) !== true) {
    uncertain('无法核验本机进程的命名空间'); return finish()
  }
  if (typeof identity?.actual !== 'string' || !path.isAbsolute(identity.actual) || !hasFileIdentity(identity)) {
    uncertain('无法核验配置文件身份'); return finish()
  }
  const candidates = new Map(), projects = new Map()
  const candidateAt = directory => {
    if (!candidates.has(directory)) candidates.set(directory, (async () => {
      try {
        const root = await fs.realpath(directory)
        if (!(await fs.stat(root)).isDirectory()) throw new Error()
        let related = false, readable = true
        // Probe only fixed markers, including broken links; never recurse or read unrelated source.
        for (const marker of MARKERS) {
          try { await fs.lstat(path.join(root, marker)); related = true }
          catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') readable = false }
        }
        return { root, related, readable }
      } catch { return { root: directory, related: false, readable: false } }
    })())
    return candidates.get(directory)
  }
  const configAt = root => {
    if (!projects.has(root)) projects.set(root, (async () => {
      const project = await projectAt(root)
      if (!project) return null
      try {
        // Do not use project.configPath here: external config symlinks/absolute paths
        // are ineligible for management but can still be in active use.
        const module = await regular(path.join(root, CONFIG_MODULE))
        if (!module) return null
        const literal = parseConfigPath(await readHostFile(module.path, 524288))
        const after = await regular(path.join(root, CONFIG_MODULE))
        if (!literal || !after || digest(module.stamp) !== digest(after.stamp)) return null
        return { project, literal }
      } catch { return null }
    })())
    return projects.get(root)
  }
  for (const proc of snapshot.processes) {
    const local = localProcess(proc, snapshot.hostScope)
    if (local === false) continue // Container/chroot paths must not be resolved against the host.
    if (local === null || !Number.isSafeInteger(proc.pid) || proc.pid <= 0 || typeof proc.startTime !== 'string' || !/^\d+$/.test(proc.startTime) || !Array.isArray(proc.argv) || !proc.argv.length || proc.argv.some(part => typeof part !== 'string') || typeof proc.cwd !== 'string' || !path.isAbsolute(proc.cwd)) {
      uncertain('部分进程身份无法完整核验'); continue
    }
    const python = isPython(proc.argv[0]) || path.basename(proc.argv[0] || '') === 'uv'
    if (!python) continue
    const invocation = scriptInvocation(proc.argv)
    const cwdCandidate = await candidateAt(proc.cwd)
    if (!cwdCandidate.readable) { uncertain('部分进程候选目录无法核验'); continue }
    const cwd = cwdCandidate.root
    const directories = new Set([cwd])
    let script = null
    if (invocation) {
      const requested = path.resolve(cwd, invocation.script)
      directories.add(path.dirname(requested))
      try { script = await fs.realpath(requested); directories.add(path.dirname(script)) } catch {}
    }
    const related = new Map()
    for (const directory of directories) {
      const candidate = directory === cwd ? cwdCandidate : await candidateAt(directory)
      if (!candidate.readable) uncertain('部分进程候选目录无法核验')
      if (candidate.related) related.set(candidate.root, candidate)
    }
    if (!related.size) continue // Ordinary Python services never reach config/source reads.
    if (!python || !invocation || !script) {
      uncertain('三月七目录存在无法确认入口的进程'); continue
    }
    let matched = false
    for (const { root } of related.values()) {
      const config = await configAt(root)
      if (!config) { uncertain('部分三月七目录的配置声明无法核验'); continue }
      if (!config.project.entries.includes(script)) continue
      matched = true
      try {
        // Python resolves a relative CONFIG_PATH from its real cwd, not the script root.
        const used = await fileIdentity(path.resolve(cwd, config.literal))
        if (!hasFileIdentity(used)) throw new Error()
        if (sameFile(identity, used)) users.push({ pid: proc.pid, startTime: proc.startTime, root: config.project.root })
      } catch { uncertain('部分三月七进程的配置文件身份无法核验') }
    }
    if (!matched) uncertain('三月七目录存在无法确认入口的进程')
  }
  return finish()
}

async function invocationMatches(argv, cwd, project) {
  const invocation = scriptInvocation(argv)
  if (!invocation || typeof cwd !== 'string') return false
  try {
    const realCwd = await fs.realpath(cwd)
    // March7th's relative CONFIG_PATH is resolved from its actual working directory.
    if (realCwd !== project.root) return false
    const script = await fs.realpath(path.resolve(realCwd, invocation.script))
    return project.entries.includes(script)
  } catch { return false }
}

async function appProcesses(project, snapshot) {
  const direct = [], suspicious = []
  for (const proc of snapshot.processes) {
    const local = localProcess(proc, snapshot.hostScope)
    if (local !== true) { if (local === null) suspicious.push(proc); continue }
    if (await invocationMatches(proc.argv, proc.cwd, project)) { direct.push(proc); continue }
    const invocation = scriptInvocation(proc.argv)
    const python = isPython(proc.argv[0]) || path.basename(proc.argv[0] || '') === 'uv'
    // Unknown Python entrypoints in this installation must not become 'zero processes'.
    if (python && within(project.root, proc.cwd || '')) suspicious.push(proc)
    else if (invocation) {
      try { if (project.entries.includes(await fs.realpath(path.resolve(proc.cwd, invocation.script)))) suspicious.push(proc) } catch {}
    }
  }
  const related = [...direct]
  const pids = new Set(direct.map(proc => proc.pid))
  let grew = true
  while (grew) {
    grew = false
    for (const proc of snapshot.processes) if (localProcess(proc, snapshot.hostScope) === true && !pids.has(proc.pid) && pids.has(proc.ppid)) { pids.add(proc.pid); related.push(proc); grew = true }
  }
  return { direct, related, suspicious: suspicious.filter(proc => !pids.has(proc.pid)) }
}
function belongsTo(proc, pid, snapshot) {
  const byPid = new Map(snapshot.processes.map(item => [item.pid, item]))
  const visited = new Set()
  for (let current = proc; current && !visited.has(current.pid); current = byPid.get(current.ppid)) {
    if (current.pid === pid) return true
    visited.add(current.pid)
  }
  return false
}

// This is argument tokenization, not shell execution. Unsupported/ambiguous quoting fails closed.
export function splitArguments(value) {
  if (Array.isArray(value)) return value.every(part => typeof part === 'string') ? [...value] : null
  if (typeof value !== 'string') return value == null ? [] : null
  if (value.length > 32768 || /[\0\r\n]/.test(value)) return null
  const result = []
  let token = '', quote = '', active = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '\\' && quote !== "'") {
      if (++i >= value.length) return null
      if (value[i] === 'x' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) { token += String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16)); i += 2 }
      else token += value[i]
      active = true
    } else if (quote) { if (char === quote) quote = ''; else token += char; active = true }
    else if (char === '"' || char === "'") { quote = char; active = true }
    else if (/\s/.test(char)) { if (active) { result.push(token); token = ''; active = false } }
    else { token += char; active = true }
  }
  if (quote) return null
  if (active) result.push(token)
  return result
}

function pm2Entry(item) {
  const env = item?.pm2_env || item
  if (!env || !Number.isInteger(env.pm_id) || env.pm_id < 0 || typeof env.pm_cwd !== 'string' || typeof env.pm_exec_path !== 'string') return null
  const args = splitArguments(env.args)
  if (!args) return null
  const interpreter = typeof env.exec_interpreter === 'string' ? env.exec_interpreter : ''
  const argv = isPython(interpreter) ? [interpreter, env.pm_exec_path, ...args] : [env.pm_exec_path, ...args]
  // Copy a whitelist only: PM2's source object contains the entire environment.
  return {
    id: env.pm_id, pid: Number(item.pid || env.pid || 0), cwd: env.pm_cwd, argv,
    created: env.created_at, status: env.status, environment: filterEnvironment({ ...filterEnvironment(env.env), ...filterEnvironment(env) }),
    automatic: Boolean(env.watch) || Boolean(env.cron_restart),
    fingerprint: digest([env.pm_id, env.created_at, env.pm_cwd, env.pm_exec_path, interpreter, args, env.watch || false, env.cron_restart || null])
  }
}
async function pm2Context(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) return { daemon: { state: 'unknown' }, entries: [], warning: 'PM2_HOME 必须是绝对路径' }
  const daemon = await pm2Daemon(home)
  if (daemon.state === 'running') {
    try {
      const list = await pm2Call(daemon, 'getMonitorData', {})
      if (!Array.isArray(list) || list.length > 4096) throw failure('unknown', 'PM2 清单不完整')
      return { daemon, entries: list.map(pm2Entry).filter(Boolean), source: 'live' }
    } catch { return { daemon, entries: [], source: 'unknown', warning: '无法读取已运行 PM2 的完整清单' } }
  }
  try {
    const list = JSON.parse(await readHostFile(path.join(home, 'dump.pm2')))
    if (!Array.isArray(list) || list.length > 4096) throw failure('unknown', 'PM2 快照不完整')
    return { daemon, entries: list.map(pm2Entry).filter(Boolean), source: 'dump', warning: 'PM2 保存清单只作发现依据，不能代表当前运行状态' }
  } catch (error) {
    return { daemon, entries: [], source: error.code === 'ENOENT' ? 'none' : 'unknown', warning: error.code === 'ENOENT' ? undefined : '无法读取 PM2 保存清单' }
  }
}

const UNIT_PROPERTIES = [
  'Id', 'LoadState', 'ActiveState', 'SubState', 'Type', 'MainPID', 'ControlPID', 'InvocationID', 'WorkingDirectory', 'ExecStart',
  'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'FragmentPath', 'DropInPaths', 'CanStart', 'CanStop',
  'RefuseManualStart', 'RefuseManualStop', 'NeedDaemonReload', 'TriggeredBy', 'ConsistsOf', 'BoundBy', 'PropagatesStopTo',
  'Environment', 'EnvironmentFiles', 'KillMode', 'OnSuccess', 'OnFailure'
]
function systemArgs(user) { return ['--no-ask-password', '--no-pager', ...(user ? ['--user'] : [])] }
function systemHint(hint) {
  if (!validUnit(hint?.unit) || typeof hint.user !== 'boolean') return null
  // Legacy user hints bind to this deployment's configured manager, never an
  // arbitrary account inferred from a directory or from the image's environment.
  const uid = hint.user ? (hint.uid === undefined ? hostUid : hint.uid) : null
  if (hint.user && (!Number.isSafeInteger(uid) || uid < 0 || uid >= 0xffffffff || (!containerMode && uid !== hostUid))) return null
  if (!hint.user && hint.uid != null) return null
  return { type: 'systemd', unit: hint.unit, user: hint.user, uid }
}
const unitKey = unit => JSON.stringify([unit.user, unit.user ? unit.uid : null, unit.unit || unit.Id])
function parseUnitMetadata(text, user = false, uid = null) {
  return text.trim().split(/\n\s*\n/).map(block => {
    const result = { user, uid: user ? uid : null }
    for (const line of block.split('\n')) {
      const split = line.indexOf('=')
      const key = line.slice(0, split)
      if (split > 0 && UNIT_PROPERTIES.includes(key)) result[key] = line.slice(split + 1)
    }
    // systemctl（含 --all）会省略空的 Exec* 数组；非空钩子仍完整返回。
    if (result.LoadState === 'loaded' && result.ExecStart) {
      for (const key of ['ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost']) if (!Object.hasOwn(result, key)) result[key] = ''
    }
    return result
  }).filter(item => validUnit(item.Id))
}
async function getUnit(hint) {
  const manager = systemHint(hint)
  if (!manager) return null
  try {
    const output = await command('systemctl', [...systemArgs(manager.user), 'show', `--property=${UNIT_PROPERTIES.join(',')}`, '--', manager.unit], 3500, manager.uid)
    return parseUnitMetadata(output, manager.user, manager.uid).find(unit => unit.Id === manager.unit) || null
  } catch { return null }
}
async function unitCatalog(roots = []) {
  const units = [], warnings = []
  const deadline = Date.now() + 7000
  // Discover only the system manager and one explicitly configured user manager.
  // Running app cgroups may identify another exact user unit; never enumerate users.
  for (const { user, uid } of [{ user: false, uid: null }, { user: true, uid: hostUid }]) {
    if (Date.now() >= deadline) { warnings.push('systemd 发现达到时间上限'); break }
    try {
      const output = await command('systemctl', [...systemArgs(user), 'list-unit-files', '--type=service', '--no-legend', '--plain'], Math.max(100, Math.min(2000, deadline - Date.now())), uid)
      const names = [...new Set(output.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(validUnit))]
      if (names.length > 200) warnings.push('systemd 单元数量超过发现上限，未扫描项保持未知')
      for (let offset = 0; offset < Math.min(names.length, 200); offset += 40) {
        if (Date.now() >= deadline) { warnings.push('systemd 发现达到时间上限'); break }
        // 先用最小元数据按安装目录筛选，不读取无关服务的环境和钩子配置。
        const basic = await command('systemctl', [...systemArgs(user), 'show', '--property=Id,WorkingDirectory', '--', ...names.slice(offset, Math.min(offset + 40, 200))], Math.max(100, Math.min(2000, deadline - Date.now())), uid)
        const relevant = parseUnitMetadata(basic, user, uid).filter(unit => path.isAbsolute(unit.WorkingDirectory || '') && roots.includes(path.resolve(unit.WorkingDirectory))).map(unit => unit.Id)
        if (!relevant.length) continue
        const detail = await command('systemctl', [...systemArgs(user), 'show', `--property=${UNIT_PROPERTIES.join(',')}`, '--', ...relevant], Math.max(100, Math.min(2000, deadline - Date.now())), uid)
        units.push(...parseUnitMetadata(detail, user, uid))
      }
    } catch { /* No bus/permissions is not evidence that a particular application stopped. */ }
  }
  return { units, warnings }
}
function unitInvocation(unit) {
  if (!unit || unit.LoadState !== 'loaded' || typeof unit.ExecStart !== 'string') return null
  const matches = [...unit.ExecStart.matchAll(/\{\s*path=(.*?)\s*;\s*argv\[\]=(.*?)\s*;/g)]
  if (matches.length !== 1) return null
  const argv = splitArguments(matches[0][2])
  if (!argv?.length || !scriptInvocation(argv)) return null
  return argv
}
async function unitMatches(unit, project) {
  const argv = unitInvocation(unit)
  if (!argv || !path.isAbsolute(unit.WorkingDirectory || '')) return false
  return invocationMatches(argv, unit.WorkingDirectory, project)
}
function unitEnvironment(unit) {
  if (unit.EnvironmentFiles) return null
  const pairs = splitArguments(unit.Environment)
  if (!pairs) return null
  const values = {}
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index > 0 && ENVIRONMENT_KEYS.includes(pair.slice(0, index))) values[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return filterEnvironment(values)
}
function unitFingerprint(unit) {
  return digest([unit.Id, unit.user, unit.uid, unit.WorkingDirectory, unitInvocation(unit), unit.FragmentPath, unit.DropInPaths,
    ...UNIT_PROPERTIES.filter(key => !['Id', 'WorkingDirectory', 'ExecStart', 'FragmentPath', 'DropInPaths', 'MainPID', 'ControlPID', 'InvocationID', 'ActiveState', 'SubState'].includes(key)).map(key => [key, unit[key]])])
}
function unitControllable(unit) {
  const empty = ['ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'TriggeredBy', 'ConsistsOf', 'BoundBy', 'PropagatesStopTo', 'OnSuccess', 'OnFailure']
  const required = [...empty, 'RefuseManualStart', 'RefuseManualStop', 'NeedDaemonReload']
  return required.every(key => Object.hasOwn(unit, key)) && ['control-group', 'mixed'].includes(unit.KillMode)
    && ['simple', 'exec', 'notify', 'idle'].includes(unit.Type) && unit.CanStart === 'yes' && unit.CanStop === 'yes'
    && unit.RefuseManualStart !== 'yes' && unit.RefuseManualStop !== 'yes' && unit.NeedDaemonReload !== 'yes'
    && !Number(unit.ControlPID) && empty.every(key => !unit[key]) && (unit.user || process.getuid?.() === 0)
}

async function managersFor(project, snapshot, apps, hint, pm2, catalog) {
  const candidates = [], warnings = []
  let uncertain = pm2.source === 'unknown'
  if (uncertain) warnings.push('PM2 状态不可见，不能确认是否存在托管目标')
  const matchingPM2 = []
  for (const entry of pm2.entries) if (await invocationMatches(entry.argv, entry.cwd, project)) matchingPM2.push(entry)
  if (hint?.type === 'pm2' && !matchingPM2.some(entry => entry.id === hint.id)) { uncertain = true; warnings.push('指定 PM2 目标无法与安装目录核验') }
  for (const entry of matchingPM2) {
    if (pm2.source !== 'live') {
      warnings.push('发现 PM2 保存条目，尚未核验当前管理实例')
      if (pm2.daemon.state !== 'absent') uncertain = true
      continue
    }
    const leader = snapshot.processes.find(proc => proc.pid === entry.pid)
    const descendants = apps.direct.filter(proc => belongsTo(proc, entry.pid, snapshot))
    const live = entry.status === 'online' && leader && localProcess(leader, snapshot.hostScope) === true && descendants.length && await invocationMatches(leader.argv, leader.cwd, project)
    const stopped = entry.status === 'stopped' && !entry.pid
    if (!live && !stopped) { uncertain = true; continue }
    const controllable = !entry.automatic && Number.isFinite(entry.created)
    if (!controllable) warnings.push('PM2 目标启用了自动触发或缺少稳定身份，仅提供只读状态')
    candidates.push({ type: 'pm2', id: entry.id, home: pm2.daemon.home, fingerprint: entry.fingerprint,
      daemon: pm2.daemon, pid: entry.pid, environment: entry.environment, state: live ? 'running' : 'stopped', controllable,
      covers: apps.related.filter(proc => belongsTo(proc, entry.pid, snapshot)).map(proc => proc.pid),
      instance: live ? `${leader.pid}:${leader.startTime}` : null })
  }
  const unitHints = new Map()
  const requestedUnit = hint?.type === 'systemd' ? systemHint(hint) : null
  if (requestedUnit) unitHints.set(unitKey(requestedUnit), requestedUnit)
  for (const proc of apps.direct) {
    const owner = unitFromCgroup(proc.cgroup)
    if (owner) {
      const scoped = systemHint(owner)
      if (scoped) unitHints.set(unitKey(scoped), scoped)
      else { uncertain = true; warnings.push('目标属于无法核验的用户管理器，仅提供只读状态') }
    }
  }
  const units = [...(catalog?.units || [])]
  for (const [key, unitHint] of unitHints) {
    if (!units.some(unit => unitKey(unit) === key)) {
      const unit = await getUnit(unitHint)
      if (unit) units.push(unit)
      else if (requestedUnit && key === unitKey(requestedUnit)) uncertain = true
    }
  }
  let matchedHint = false
  for (const unit of units) {
    if (!await unitMatches(unit, project)) continue
    if (requestedUnit && unitKey(unit) === unitKey(requestedUnit)) matchedHint = true
    const pid = Number(unit.MainPID)
    const leader = snapshot.processes.find(proc => proc.pid === pid)
    const descendants = apps.direct.filter(proc => belongsTo(proc, pid, snapshot) && (() => {
      const owner = unitFromCgroup(proc.cgroup)
      return owner && unitKey(owner) === unitKey(unit)
    })())
    const live = unit.ActiveState === 'active' && leader && localProcess(leader, snapshot.hostScope) === true && descendants.length && await invocationMatches(leader.argv, leader.cwd, project)
    const stopped = ['inactive', 'failed'].includes(unit.ActiveState) && !pid && !Number(unit.ControlPID)
    if (!live && !stopped) { uncertain = true; continue }
    const controllable = unitControllable(unit) && (!live || Boolean(unit.InvocationID))
    if (!controllable) warnings.push('systemd 目标不满足受限生命周期条件，仅提供只读状态')
    candidates.push({ type: 'systemd', unit: unit.Id, user: unit.user, uid: unit.uid, fingerprint: unitFingerprint(unit), pid,
      state: live ? 'running' : 'stopped', controllable, invocation: unit.InvocationID || '', environment: unitEnvironment(unit),
      covers: apps.related.filter(proc => belongsTo(proc, pid, snapshot)).map(proc => proc.pid),
      instance: live ? `${leader.pid}:${leader.startTime}` : null })
  }
  if (hint?.type === 'systemd' && !matchedHint) { uncertain = true; warnings.push('指定 systemd 单元无法与安装目录核验') }
  if (candidates.length > 1) { uncertain = true; warnings.push('同一安装目录对应多个管理目标，禁止自动控制') }
  let manager = candidates.length === 1 ? candidates[0] : null
  if (manager && (apps.related.some(proc => !manager.covers.includes(proc.pid)) || apps.suspicious.length)) {
    manager = null; uncertain = true; warnings.push('安装目录还存在管理目标之外的进程，禁止自动控制')
  }
  return { manager, uncertain, warnings }
}

function managerView(manager) {
  if (!manager) return null
  return manager.type === 'pm2'
    ? { type: 'pm2', id: manager.id, home: manager.home, verified: true, controllable: manager.controllable }
    : { type: 'systemd', unit: manager.unit, user: manager.user, uid: manager.uid, verified: true, controllable: manager.controllable }
}
function managerKey(manager) {
  if (!manager) return null
  return manager.type === 'pm2' ? digest([manager.type, manager.home, manager.id, manager.fingerprint, manager.daemon.pid, manager.daemon.startTime, manager.daemon.socketInode])
    : digest([manager.type, manager.unit, manager.user, manager.uid, manager.fingerprint])
}
function managerHint(manager) {
  return manager.type === 'pm2' ? { type: 'pm2', id: manager.id, home: manager.home } : { type: 'systemd', unit: manager.unit, user: manager.user, uid: manager.uid }
}

/** Bounded Linux discovery. All filesystem traversal stays within canonical caller roots. */
export async function discoverNative({ roots = [], maxDepth = 3, maxDirectories = 300, pm2Home = defaultHome() } = {}) {
  const diagnostics = [], candidates = []
  if (process.platform !== 'linux') return { candidates, diagnostics: ['原生部署识别只支持 Linux'] }
  if (!Array.isArray(roots)) throw failure('invalid-input', '扫描根目录必须是数组')
  const boundaries = []
  for (const root of roots.slice(0, 32)) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) { diagnostics.push('忽略非绝对扫描路径'); continue }
    try {
      const real = await fs.realpath(root)
      if (!(await fs.stat(real)).isDirectory()) throw new Error()
      if (!boundaries.some(parent => within(parent, real))) {
        for (let i = boundaries.length - 1; i >= 0; i--) if (within(real, boundaries[i])) boundaries.splice(i, 1)
        boundaries.push(real)
      }
    } catch { diagnostics.push('部分扫描根目录不可访问') }
  }
  if (roots.length > 32) diagnostics.push('扫描根目录数量超过上限')
  if (!boundaries.length) return { candidates, diagnostics }
  const queue = boundaries.map(root => ({ directory: root, depth: 0 })), seen = new Set(), projects = []
  const deadline = Date.now() + 4000
  maxDepth = clamp(maxDepth, 3, 0, 8); maxDirectories = clamp(maxDirectories, 300, 1, 5000)
  while (queue.length && seen.size < maxDirectories && Date.now() < deadline) {
    const { directory, depth } = queue.shift()
    let real
    try { real = await fs.realpath(directory) } catch { diagnostics.push('部分目录无法解析真实路径'); continue }
    if (seen.has(real) || !boundaries.some(root => within(root, real))) continue
    seen.add(real)
    const project = await projectAt(real)
    if (project?.configPath) projects.push(project)
    else if (project) diagnostics.push('发现源码安装，但 CONFIG_PATH 无法静态确认或超出安装边界')
    if (depth >= maxDepth) continue
    try {
      const entries = await fs.opendir(real)
      try {
        for await (const entry of entries) {
          if (Date.now() >= deadline || queue.length + seen.size >= maxDirectories * 4) { diagnostics.push('目录扫描达到时间或队列上限'); break }
          if ((entry.isDirectory() || entry.isSymbolicLink()) && !SKIP.has(entry.name)) queue.push({ directory: path.join(real, entry.name), depth: depth + 1 })
        }
      } finally { await entries.close().catch(() => {}) }
    } catch { diagnostics.push('部分目录不可读取') }
  }
  if (queue.length) diagnostics.push('目录扫描达到深度、数量或时间限制，结果可能不完整')
  if (!projects.length) return { candidates, diagnostics: [...new Set(diagnostics)] }
  const [snapshot, pm2, catalog] = await Promise.all([processSnapshot(), pm2Context(pm2Home), unitCatalog(projects.map(project => project.root))])
  diagnostics.push(...snapshot.warnings, ...catalog.warnings)
  if (pm2.warning) diagnostics.push(pm2.warning)
  for (const project of projects) {
    const apps = await appProcesses(project, snapshot)
    const managers = await managersFor(project, snapshot, apps, null, pm2, catalog)
    let hint = managers.manager ? managerHint(managers.manager) : undefined
    const evidence = [...project.evidence]
    if (apps.direct.length) evidence.push('真实进程的工作目录和源码入口匹配')
    if (!hint) {
      const matching = []
      for (const entry of pm2.entries) if (await invocationMatches(entry.argv, entry.cwd, project)) matching.push(entry)
      if (matching.length === 1) {
        hint = { type: 'pm2', id: matching[0].id, home: pm2.daemon.home || pm2Home }
        evidence.push(pm2.source === 'dump' ? 'PM2 保存清单包含此源码安装' : 'PM2 实时清单包含此源码安装')
      }
    }
    candidates.push({ kind: 'native', configPath: project.configPath, root: project.root, label: path.basename(project.root), ...(hint ? { managerHint: hint } : {}), evidence, warnings: [...new Set([...managers.warnings, ...snapshot.warnings])] })
  }
  return { candidates, diagnostics: [...new Set(diagnostics)] }
}

/** Inspect never equates failed detection with an empty process list. */
export async function inspectNative(spec) {
  if (!spec || typeof spec.configPath !== 'string' || !path.isAbsolute(spec.configPath)) throw failure('invalid-input', '配置路径必须是绝对路径')
  const warnings = [], evidence = []
  let configPath, canRead = false, fileWritable = false
  try { configPath = await canonical(spec.configPath) } catch { configPath = path.resolve(spec.configPath); warnings.push('无法确认配置文件真实路径') }
  try {
    const file = await regular(configPath)
    if (file) {
      await fs.access(configPath, constants.R_OK); canRead = true
      try { await fs.access(configPath, constants.W_OK); await fs.access(path.dirname(configPath), constants.W_OK); fileWritable = true } catch {}
    }
  } catch {}
  let project = null
  if (typeof spec.root === 'string' && path.isAbsolute(spec.root)) project = await projectAt(spec.root)
  if (!project) project = await projectAt(path.dirname(configPath))
  if (project && !project.configPath) warnings.push('源码 CONFIG_PATH 无法静态确认，禁止自动应用配置')
  if (project?.configPath !== configPath) project = null
  const base = {
    kind: project ? 'native' : 'file', label: project ? path.basename(project.root) : path.basename(configPath), configPath,
    root: project?.root || null, available: canRead, running: null, status: 'unknown', canRead, canWrite: false,
    canRestart: false, managerLabel: '未确认', manager: null, environment: null, evidence, warnings, identity: '', processes: [],
    bindingIdentity: digest(project ? [project.fingerprint, configPath, null] : ['file', configPath])
  }
  if (!project || process.platform !== 'linux') {
    warnings.push(!project ? '未核验到完整源码安装，纯文件模式不推断运行状态' : '原生生命周期控制只支持 Linux')
    base.identity = digest(['file', configPath]); return base
  }
  evidence.push(...project.evidence)
  const home = spec.managerHint?.type === 'pm2' ? spec.managerHint.home : defaultHome()
  const [snapshot, pm2] = await Promise.all([processSnapshot(), pm2Context(home)])
  const apps = await appProcesses(project, snapshot)
  // Running services are found by exact cgroup; stopped services require bounded metadata discovery.
  const catalog = apps.direct.length || spec.managerHint?.type === 'systemd' ? { units: [], warnings: [] } : await unitCatalog([project.root])
  const result = await managersFor(project, snapshot, apps, spec.managerHint, pm2, catalog)
  const manager = result.manager
  warnings.push(...snapshot.warnings, ...catalog.warnings, ...result.warnings)
  if (pm2.warning && (spec.managerHint?.type === 'pm2' || pm2.source === 'unknown')) warnings.push(pm2.warning)
  if (apps.direct.length) {
    base.running = true
    base.status = manager ? 'running' : 'unmanaged'
    evidence.push('真实进程的工作目录和源码入口匹配')
  } else if (snapshot.complete && !apps.suspicious.length && !result.uncertain && manager?.state !== 'running') {
    base.running = false; base.status = 'stopped'
    evidence.push('完整进程快照未发现源码入口进程')
  }
  if (apps.suspicious.length) warnings.push('安装目录存在无法确认身份的 Python/uv 进程')
  if (base.running && !manager) warnings.push('未托管或未核验的运行中进程只提供只读状态')
  base.manager = managerView(manager)
  base.managerLabel = manager ? (manager.type === 'pm2' ? `PM2 #${manager.id}` : `systemd ${manager.unit}${manager.user ? '（用户）' : ''}`) : (base.running ? '手动或未核验托管' : '未确认')
  base.canRestart = base.running === true && Boolean(manager?.controllable) && snapshot.complete && !result.uncertain && !apps.suspicious.length
  base.canWrite = fileWritable && (base.running === false ? (!manager || manager.controllable) : base.canRestart)
  base.processes = apps.related.map(publicProcess).sort((a, b) => a.pid - b.pid)
  base.environment = await environmentOf(apps, manager, warnings)
  base.warnings = [...new Set(warnings)]
  // Stable across stopping/starting the application; the manager definition stays bound.
  base.bindingIdentity = digest([project.fingerprint, configPath, managerKey(manager)])
  base.identity = digest([project.fingerprint, configPath, managerKey(manager), base.processes.map(proc => [proc.pid, proc.startTime])])
  const savedSpec = { kind: 'native', root: project.root, configPath, ...(manager ? { managerHint: managerHint(manager) } : spec.managerHint ? { managerHint: { ...spec.managerHint } } : {}) }
  observed.set(base, { spec: savedSpec, project, manager, running: base.running, canRestart: base.canRestart, identity: base.identity, processes: base.processes.map(proc => ({ ...proc })) })
  return base
}

async function validateManaged(saved, mustBeRunning) {
  const runtime = await inspectNative(saved.spec)
  const current = observed.get(runtime)
  if (!current || current.project.fingerprint !== saved.project.fingerprint || managerKey(current.manager) !== managerKey(saved.manager)) throw failure('identity-changed', '安装目录或管理目标身份已变化')
  if (mustBeRunning) {
    if (!runtime.canRestart || runtime.running !== true || !sameProcesses(current.processes, saved.processes) || current.manager.instance !== saved.manager.instance || (current.manager.type === 'systemd' && current.manager.invocation !== saved.manager.invocation)) throw failure('identity-changed', '运行实例已变化，请重新检查')
  } else if (runtime.running !== false || current.manager.state !== 'stopped') throw failure('state-unknown', '尚未确认原管理目标已经停止')
  return { runtime, current }
}
async function validateDefinition(saved) {
  const project = await projectAt(saved.project.root)
  if (!project || project.fingerprint !== saved.project.fingerprint) throw failure('identity-changed', '源码安装身份已变化')
  const manager = saved.manager
  if (manager.type === 'pm2') {
    const context = await pm2Context(manager.home)
    const entry = context.entries.find(item => item.id === manager.id)
    const daemon = context.daemon
    if (context.source !== 'live' || !entry || entry.fingerprint !== manager.fingerprint || daemon.pid !== manager.daemon.pid || daemon.startTime !== manager.daemon.startTime || daemon.socketInode !== manager.daemon.socketInode) throw failure('identity-changed', 'PM2 管理目标身份已变化')
  } else {
    const unit = await getUnit(manager)
    if (!unit || unitFingerprint(unit) !== manager.fingerprint) throw failure('identity-changed', 'systemd 管理目标身份已变化')
  }
}
async function control(manager, action) {
  if (manager.type === 'pm2') return pm2Call(manager.daemon, action === 'stop' ? 'stopProcessId' : 'startProcessId', manager.id)
  if (manager.type === 'systemd' && systemHint(manager)) return command('systemctl', [...systemArgs(manager.user), action === 'stop' ? 'stop' : 'start', '--', manager.unit], 15000, manager.uid)
  throw failure('forbidden', '没有可用的受限管理目标')
}
async function waitState(saved, running, timeout = 15000) {
  const deadline = Date.now() + timeout
  do {
    const runtime = await inspectNative(saved.spec)
    const current = observed.get(runtime)
    if (!current || current.project.fingerprint !== saved.project.fingerprint || (current.manager && managerKey(current.manager) !== managerKey(saved.manager))) throw failure('identity-changed', '等待期间管理目标身份已变化')
    // A launching/stopping manager has no verified runtime yet. Check its exact
    // definition instead of mistaking this transition for an unrelated target.
    if (!current.manager) { await validateDefinition(saved); await pause(200); continue }
    if (running) {
      if (runtime.running === true && runtime.canRestart && current.manager.state === 'running') return current
    } else if (runtime.running === false && current.manager.state === 'stopped') {
      // Also wait for originally observed children: they may have moved out of the root.
      let alive = false
      for (const previous of saved.processes) {
        const proc = await processAt(previous.pid)
        if (proc?.startTime === previous.startTime) { alive = true; break }
      }
      if (!alive) return current
    }
    await pause(200)
  } while (Date.now() < deadline)
  throw failure('manager-timeout', running ? '尚未确认原目标恢复运行' : '尚未确认原目标完全停止')
}

/** Only an object returned by this module's inspection can authorize control. */
export async function stopNative(runtime) {
  const saved = observed.get(runtime)
  if (!saved || runtime.identity !== saved.identity || runtime.running !== saved.running) throw failure('identity-changed', '运行状态已失效，请重新检查')
  if (saved.running === false) return null
  if (saved.running !== true || !saved.canRestart || !saved.manager?.controllable) throw failure('not-controllable', '当前运行实例只允许读取')
  const key = managerKey(saved.manager)
  if (activeOperations.has(key)) throw failure('busy', '该管理目标已有未完成的停止或恢复操作')
  activeOperations.add(key)
  try {
    await validateManaged(saved, true)
    await validateDefinition(saved)
    // No recovery token is issued until all preflight PID checks passed.
    for (const previous of saved.processes) {
      const proc = await processAt(previous.pid)
      if (!proc || proc.startTime !== previous.startTime) throw failure('identity-changed', '进程身份已变化')
    }
  } catch (error) { activeOperations.delete(key); throw error }
  const token = Object.freeze({ kind: 'native', id: randomBytes(24).toString('hex'), identity: saved.identity,
    ...(saved.manager.type === 'systemd' ? { uid: saved.manager.uid } : {}) })
  const record = { saved, key, phase: 'stopping', busy: false }
  restores.set(token, record)
  try {
    await control(saved.manager, 'stop')
    await waitState(saved, false)
    record.phase = 'stopped'
    return token
  } catch (cause) {
    const error = failure(cause.status || 'stop-failed', '未能安全确认停止；请检查原目标状态')
    // The caller can retain this opaque token even when a stop acknowledgement was lost.
    error.restoreToken = token
    try {
      await validateManaged(saved, false)
      record.phase = 'stopped'
      await restoreNative(token)
      error.restored = true
    } catch { error.restored = false }
    throw error
  }
}

export function abandonNativeRestore(token) {
  const record = restores.get(token)
  if (!record || record.busy) return
  activeOperations.delete(record.key)
  restores.delete(token)
}

/** Restore only a formerly-running target stopped by this module; no arbitrary commands. */
export async function restoreNative(token) {
  const record = restores.get(token)
  if (!record) throw failure('invalid-token', '恢复凭据无效或来自其他进程')
  if (record.phase === 'restored') return
  if (record.busy) throw failure('busy', '该目标正在恢复')
  record.busy = true
  try {
    if (record.phase === 'starting') {
      const runtime = await inspectNative(record.saved.spec)
      if (runtime.running === true) {
        await waitState(record.saved, true)
        record.phase = 'restored'; activeOperations.delete(record.key); return
      }
      // A previously unacknowledged start may be retried only while still stopped.
      // PM2 startProcessId refuses an already running PID, unlike restartProcessId.
    }
    const { current } = await validateManaged(record.saved, false)
    await validateDefinition(record.saved)
    // A timeout while stopping may still leave surviving children. Do not overlap instances.
    for (const previous of record.saved.processes) {
      const proc = await processAt(previous.pid)
      if (proc?.startTime === previous.startTime) throw failure('state-unknown', '原进程尚未完全结束')
    }
    record.phase = 'starting'
    await control(current.manager, 'start')
    await waitState(record.saved, true)
    record.phase = 'restored'
    activeOperations.delete(record.key)
  } catch (cause) {
    const error = failure(cause.status || 'restore-failed', '尚未确认原目标恢复运行')
    error.restoreToken = token
    throw error
  } finally { record.busy = false }
}
