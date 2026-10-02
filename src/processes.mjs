import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { containerMode, getHostScope, hostFS, hostPm2Request, hostSystemctl, readHostFile } from './host.mjs'

const PROC = '/proc'
const LIMIT = 4 * 1024 * 1024
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const within = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export function failure(kind, message) {
  const status = Number.isInteger(kind) ? kind : ({ 'invalid-input': 400, unreadable: 400, forbidden: 403, 'invalid-token': 403, 'manager-unavailable': 503, 'manager-timeout': 503 })[kind] || 409
  return Object.assign(new Error(message), { status, code: typeof kind === 'string' ? kind : 'native-error' })
}

// Never put command output, argv, environment or manager error messages in an exception.
export function command(file, args, timeout = 3500, uid = null) {
  if (containerMode && file === 'systemctl') {
    return hostSystemctl(args, timeout, uid).catch(() => { throw failure('manager-unavailable', '无法核验管理器状态') })
  }
  // Direct installs may only address their own existing user manager. Never use
  // sudo/runuser or forward an arbitrary command into the host namespace.
  if (uid !== null && (file !== 'systemctl' || uid !== process.getuid?.() || !args.includes('--user'))) {
    return Promise.reject(failure('forbidden', '无法核验指定用户管理器'))
  }
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, timeout, killSignal: 'SIGKILL', maxBuffer: LIMIT, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(failure('manager-unavailable', '无法核验管理器状态'))
      else resolve(stdout)
    })
  })
}

export async function readLimited(file, limit = LIMIT) {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw failure('unreadable', '文件类型或大小不受支持')
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, limit + 1 - length, null)
      if (!bytesRead) return buffer.subarray(0, length).toString('utf8')
      length += bytesRead
    }
    throw failure('unreadable', '文件超过读取上限')
  } finally { await handle.close() }
}

export function parseProcStat(text) {
  const end = text.lastIndexOf(')')
  const fields = text.slice(end + 2).trim().split(/\s+/)
  const pid = Number(text.slice(0, text.indexOf(' ')))
  if (end < 0 || !Number.isSafeInteger(pid) || !/^\d+$/.test(fields[19] || '')) throw failure('unknown', '进程元数据不完整')
  return { pid, state: fields[0], ppid: Number(fields[1]), startTime: fields[19], kernel: Boolean(Number(fields[6]) & 0x00200000) }
}

async function processScope(pid) {
  const [mount, namespacePid, root] = await Promise.all([
    fs.readlink(`${PROC}/${pid}/ns/mnt`), fs.readlink(`${PROC}/${pid}/ns/pid`), fs.stat(`${PROC}/${pid}/root`, { bigint: true })
  ])
  if (!mount || !namespacePid || !root.isDirectory()) throw failure('unknown', '进程命名空间信息不完整')
  return { namespaces: { mount, pid: namespacePid }, rootIdentity: { dev: String(root.dev), ino: String(root.ino) } }
}

export async function processAt(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const first = parseProcStat(await readLimited(`${PROC}/${pid}/stat`, 8192))
    if (first.pid !== pid) throw failure('unknown', '进程身份无法核验')
    if (first.state === 'Z' || first.state === 'X') return null
    const argv = (await readLimited(`${PROC}/${pid}/cmdline`, 131072)).split('\0').filter(Boolean)
    // Kernel threads have no userspace command line, root or configuration to modify.
    if (!argv.length) {
      if (first.kernel) {
        const last = parseProcStat(await readLimited(`${PROC}/${pid}/stat`, 8192))
        if (last.pid !== pid || first.startTime !== last.startTime || last.state === 'Z' || last.state === 'X') return null
        return { ...last, argv, cwd: null, cgroup: '', namespaces: null, rootIdentity: null }
      }
      throw failure('unknown', '用户进程命令行暂不可见')
    }
    const [cwd, cgroup, owner, scope] = await Promise.all([
      fs.readlink(`${PROC}/${pid}/cwd`), readLimited(`${PROC}/${pid}/cgroup`, 32768), fs.stat(`${PROC}/${pid}`), processScope(pid)
    ])
    const last = parseProcStat(await readLimited(`${PROC}/${pid}/stat`, 8192))
    if (last.pid !== pid || first.startTime !== last.startTime || last.state === 'Z' || last.state === 'X') return null
    return { ...last, argv, cwd, cgroup, uid: owner.uid, ...scope }
  } catch {
    // Exiting processes can lose cmdline/cwd before /proc disappears. Drop them
    // only when a final stat proves they are gone or zombies; live unknowns deny.
    try {
      const state = parseProcStat(await readLimited(`${PROC}/${pid}/stat`, 8192)).state
      if (state === 'Z' || state === 'X') return null
    } catch (next) { if (next.code === 'ENOENT' || next.code === 'ESRCH') return null }
    throw failure('unknown', '无法读取完整进程元数据')
  }
}

export async function processSnapshot({ timeout = 4000, maxProcesses = 16384 } = {}) {
  const processes = [], warnings = []
  let complete = true
  let observer = { namespaces: null, rootIdentity: null }
  let hostScope = { namespaces: null, rootIdentity: null }
  const until = Date.now() + timeout
  try { observer = await processScope('self') } catch { complete = false }
  try {
    hostScope = await getHostScope()
    if (typeof hostScope?.namespaces?.mount !== 'string' || !hostScope.namespaces.mount || typeof hostScope.namespaces.pid !== 'string' || !hostScope.namespaces.pid
      || typeof hostScope.rootIdentity?.dev !== 'string' || !hostScope.rootIdentity.dev || typeof hostScope.rootIdentity.ino !== 'string' || !hostScope.rootIdentity.ino) throw new Error()
    // host PID sharing is required even though the observer keeps its own mount namespace.
    if (observer.namespaces?.pid !== hostScope.namespaces.pid) complete = false
  } catch { hostScope = { namespaces: null, rootIdentity: null }; complete = false }
  try {
    const mounts = await readLimited(`${PROC}/self/mountinfo`, 262144)
    const procMount = mounts.split('\n').find(line => line.split(' ')[4] === PROC)
    if (!procMount || /(?:^|[ ,])hidepid=(?!0(?:[, ]|$))[^, ]+/.test(procMount)) complete = false
    // A separate PID namespace cannot prove host processes are absent.
    const status = await readLimited(`${PROC}/self/status`, 32768)
    const levels = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/)
    if (levels && levels.length > 1) complete = false
    let pids = (await fs.readdir(PROC)).filter(name => /^\d+$/.test(name)).map(Number)
    if (pids.length > maxProcesses) { pids = pids.slice(0, maxProcesses); complete = false }
    let cursor = 0
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (cursor < pids.length) {
        if (Date.now() > until) { complete = false; return }
        const pid = pids[cursor++]
        try { const proc = await processAt(pid); if (proc && !proc.kernel) processes.push(proc) }
        catch { complete = false }
      }
    }))
  } catch { complete = false }
  if (!complete) warnings.push('进程可见性不足或扫描达到上限，不能确认应用已停止')
  return { observer, hostScope, processes, complete, warnings }
}

export const isPython = executable => /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/.test(path.basename(executable || ''))

// Return only a structural script reference. Never execute a wrapper or interpret shell text.
export function scriptInvocation(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(part => typeof part !== 'string')) return null
  let index = 1
  if (path.basename(argv[0]) === 'uv') {
    if (argv[index++] !== 'run') return null
    while (argv[index]?.startsWith('-')) {
      const flag = argv[index++]
      if (flag === '--') break
      const equals = flag.indexOf('=')
      const name = equals < 0 ? flag : flag.slice(0, equals)
      // A closed allowlist excludes --directory/--project, their short forms and
      // unknown --name=value options: the observed cwd must remain authoritative.
      if (['--python', '--with', '--with-requirements', '--env-file'].includes(name)) {
        const value = equals < 0 ? argv[index++] : flag.slice(equals + 1)
        if (!value || value.startsWith('-')) return null
      } else if (!['--no-sync', '--frozen', '--locked', '--offline', '--no-project', '--active', '--isolated', '--no-dev'].includes(flag)) return null
    }
    if (isPython(argv[index])) return scriptInvocation(argv.slice(index))
    return argv[index]?.endsWith('.py') ? { script: argv[index], wrapper: true } : null
  }
  if (!isPython(argv[0])) return null
  while (argv[index]?.startsWith('-')) {
    const flag = argv[index++]
    if (flag === '--') break
    if (flag === '-m' || flag === '-c' || flag.startsWith('-c') || flag.startsWith('-m')) return null
    if (flag === '-W' || flag === '-X') index++
    else if (!/^-[uBbOdEisSIqvRx]+$/.test(flag) && !/^-[WX].+/.test(flag)) return null
  }
  return argv[index] ? { script: argv[index], wrapper: false } : null
}

export function unitFromCgroup(cgroup) {
  for (const line of String(cgroup).split('\n')) {
    const location = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1)
    const units = location.split('/').filter(part => validUnit(part) && !/^user@\d+\.service$/.test(part))
    if (!units.length) continue
    const unit = units[units.length - 1]
    const userScope = /\/user\.slice\/user-(\d+)\.slice\/user@(\d+)\.service\//.exec(location)
    if (userScope) {
      const uid = Number(userScope[1])
      if (userScope[1] !== userScope[2] || !Number.isSafeInteger(uid) || uid < 0 || uid >= 0xffffffff) return null
      return { type: 'systemd', unit, user: true, uid, cgroup: location }
    }
    if (location.startsWith('/system.slice/')) return { type: 'systemd', unit, user: false, uid: null, cgroup: location }
  }
  return null
}
export const validUnit = unit => typeof unit === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,190}\.service$/.test(unit)

export async function pm2Daemon(home) {
  try {
    const canonical = await hostFS.realpath(home)
    const pidText = (await readHostFile(path.join(canonical, 'pm2.pid'), 64)).trim()
    if (!/^\d+$/.test(pidText)) return { state: 'unknown' }
    const pid = Number(pidText)
    const proc = await processAt(pid)
    if (!proc) return { state: 'absent', home: canonical }
    const title = proc.argv.join(' ')
    const match = /^PM2 v[\w.+-]+: God Daemon \((.+)\)$/.exec(title)
    if (!match || await hostFS.realpath(match[1]) !== canonical) return { state: 'unknown', home: canonical }
    const scope = await getHostScope()
    if (!scope?.namespaces?.mount || !scope.namespaces.pid || !scope.rootIdentity?.dev || !scope.rootIdentity.ino
      || proc.namespaces?.mount !== scope.namespaces.mount || proc.namespaces.pid !== scope.namespaces.pid
      || proc.rootIdentity?.dev !== scope.rootIdentity.dev || proc.rootIdentity.ino !== scope.rootIdentity.ino) return { state: 'unknown', home: canonical }
    const socketPath = path.join(canonical, 'rpc.sock')
    const [socket, directory, unix, fds] = await Promise.all([
      hostFS.lstat(socketPath), hostFS.stat(canonical), readLimited(`${PROC}/net/unix`, 1024 * 1024), fs.readdir(`${PROC}/${pid}/fd`)
    ])
    if (!socket.isSocket() || socket.uid !== proc.uid || directory.uid !== proc.uid || fds.length > 8192) return { state: 'unknown', home: canonical }
    const inode = unix.split('\n').map(line => /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(.+)$/.exec(line.trim())).find(parts => parts?.[2] === socketPath)?.[1]
    if (!inode) return { state: 'unknown', home: canonical }
    let ownsSocket = false
    for (const fd of fds) {
      try { if (await fs.readlink(`${PROC}/${pid}/fd/${fd}`) === `socket:[${inode}]`) { ownsSocket = true; break } } catch {}
    }
    if (!ownsSocket) return { state: 'unknown', home: canonical }
    return { state: 'running', home: canonical, pid, startTime: proc.startTime, socketInode: inode, uid: proc.uid }
  } catch (error) {
    // An absent pidfile alone does NOT prove that no daemon exists.
    return { state: error.code === 'ENOENT' ? 'unconfirmed' : 'unknown', home }
  }
}

function ampEncode(parts) {
  const chunks = [Buffer.from([0x10 | parts.length])]
  for (const part of parts) {
    const content = Buffer.from(typeof part === 'string' ? 's:' + part : 'j:' + JSON.stringify(part))
    const size = Buffer.alloc(4); size.writeUInt32BE(content.length)
    chunks.push(size, content)
  }
  return Buffer.concat(chunks)
}
function ampDecode(buffer) {
  if (!buffer.length) return null
  if ((buffer[0] >> 4) !== 1 || (buffer[0] & 15) !== 2) throw failure('manager-unavailable', '不支持的 PM2 本地协议')
  const parts = []
  let offset = 1
  for (let i = 0; i < 2; i++) {
    if (buffer.length < offset + 4) return null
    const size = buffer.readUInt32BE(offset); offset += 4
    if (size > LIMIT) throw failure('manager-unavailable', 'PM2 响应超过上限')
    if (buffer.length < offset + size) return null
    const value = buffer.subarray(offset, offset + size).toString('utf8'); offset += size
    if (value.startsWith('j:')) parts.push(JSON.parse(value.slice(2)))
    else if (value.startsWith('s:')) parts.push(value.slice(2))
    else throw failure('manager-unavailable', '不支持的 PM2 本地协议')
  }
  if (buffer.length !== offset) throw failure('manager-unavailable', 'PM2 响应格式不完整')
  return parts
}

// Deliberately do not invoke the PM2 CLI: even `jlist` can create a daemon between
// the liveness check and connection. This bounded AMP client only connects to an
// existing socket; it has no launch/reconnect/command-execution capability.
export async function pm2Call(daemon, method, argument) {
  if (!['getMonitorData', 'stopProcessId', 'startProcessId'].includes(method)) throw failure('forbidden', '不支持的管理操作')
  const fresh = await pm2Daemon(daemon.home)
  if (fresh.state !== 'running' || fresh.home !== daemon.home || fresh.pid !== daemon.pid || fresh.startTime !== daemon.startTime || fresh.socketInode !== daemon.socketInode || fresh.uid !== daemon.uid) throw failure('identity-changed', 'PM2 实例已变化')
  const id = randomBytes(16).toString('hex')
  const request = ampEncode([{ type: 'call', method, args: [argument] }, id])
  const timeout = method === 'getMonitorData' ? 3500 : 15000
  const confirmed = response => {
    if (!response || response[1] !== id || !response[0] || response[0].error || !Array.isArray(response[0].args)) throw failure('manager-unavailable', 'PM2 操作未获确认')
    return response[0].args[0]
  }
  if (containerMode) {
    let content
    try { content = await hostPm2Request(fresh, request, timeout) }
    catch (error) { throw failure(error.code === 'manager-timeout' ? 'manager-timeout' : 'manager-unavailable', '无法确认已验证的 PM2 实例响应') }
    try {
      if (!Buffer.isBuffer(content) || content.length > LIMIT) throw new Error()
      return confirmed(ampDecode(content))
    } catch { throw failure('manager-unavailable', '无法解析或确认 PM2 响应') }
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(daemon.home, 'rpc.sock'))
    let content = Buffer.alloc(0), settled = false
    const timer = setTimeout(() => finish(failure('manager-timeout', 'PM2 操作未在限定时间内确认')), timeout)
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    socket.on('connect', () => socket.write(request))
    socket.on('error', () => finish(failure('manager-unavailable', '无法连接已验证的 PM2 实例')))
    socket.on('end', () => { if (!settled) finish(failure('manager-unavailable', 'PM2 连接中断')) })
    socket.on('data', chunk => {
      try {
        if (content.length + chunk.length > LIMIT) return finish(failure('manager-unavailable', 'PM2 响应超过上限'))
        content = Buffer.concat([content, chunk])
        const response = ampDecode(content)
        if (!response) return
        finish(null, confirmed(response))
      } catch { finish(failure('manager-unavailable', '无法解析 PM2 响应')) }
    })
  })
}
