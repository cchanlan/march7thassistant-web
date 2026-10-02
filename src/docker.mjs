import fs from 'node:fs'
import path from 'node:path'
import tar from 'tar-stream'
import { execute, hash, problem, inside, validateGameConfig, readLocal, writeLocal, fileIdentity, sameFile } from './io.mjs'
import { scriptInvocation, processAt, isPython } from './processes.mjs'
import { containerMode, hostFS, readHostFile, hostProcessFileIdentity, getHostScope, authorizeHost, canControlHost } from './host.mjs'
import { parseConfigPath } from './native.mjs'

const LIMIT = 2 * 1024 * 1024
const restores = new WeakSet()
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
function containerRef(value) {
  if (typeof value !== 'string' || !namePattern.test(value)) throw problem(400, '容器名称不正确')
  return value
}
function containerPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\0\r\n]/.test(value)) throw problem(400, '容器内路径不正确')
  return path.posix.normalize(value)
}
async function docker(args, options = {}) {
  const env = { ...process.env }
  if (containerMode) {
    for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_CONFIG']) delete env[key]
    env.DOCKER_HOST = 'unix:///var/run/docker.sock'
    if (['stop', 'start'].includes(args[0])) {
      await verifyContainerHost()
      if (!canControlHost()) throw problem(503, '请核对上次保存的备份与实例状态，然后在部署目录执行 docker compose restart web')
    }
  }
  return (await execute('docker', args, { timeout: 15000, maxBuffer: 6 * 1024 * 1024, ...options, env })).stdout
}
export async function localDocker() {
  if (containerMode) {
    if (!fs.statSync('/var/run/docker.sock').isSocket()) throw problem(503, '请挂载本机 Docker socket 后重建面板')
    return
  }
  let endpoint = process.env.DOCKER_HOST
  if (process.env.DOCKER_CONTEXT || !endpoint) {
    endpoint = JSON.parse(await docker(['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}']))
  }
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw problem(400, '目前只支持本机 Docker，请切换到本机 Unix socket')
}
export async function dockerInfo(ref) {
  await localDocker()
  const info = JSON.parse(await docker(['inspect', '--type', 'container', containerRef(ref)]))[0]
  if (!info?.Id || !info.State) throw problem(404, '没有找到目标容器')
  return info
}
export async function readDockerFile(id, file) {
  const bytes = await docker(['cp', '-L', `${containerRef(id)}:${containerPath(file)}`, '-'], { encoding: 'buffer', maxBuffer: LIMIT + 65536 })
  return new Promise((resolve, reject) => {
    const extract = tar.extract()
    let result
    extract.on('entry', (header, stream, next) => {
      if (result || header.type !== 'file' || header.size > LIMIT) {
        extract.destroy(problem(400, '容器配置必须是普通文件且不超过 2 MiB'))
        stream.resume()
        return
      }
      const chunks = []
      let size = 0
      stream.on('data', chunk => { size += chunk.length; if (size > LIMIT) extract.destroy(problem(400, '容器文件过大')); else chunks.push(chunk) })
      stream.on('error', reject)
      stream.on('end', () => { result = { text: Buffer.concat(chunks).toString('utf8'), header }; next() })
    })
    extract.on('error', reject)
    extract.on('finish', () => result ? resolve(result) : reject(problem(400, '容器文件为空或无法读取')))
    extract.end(bytes)
  })
}
export async function writeDockerFile(runtime, original, next) {
  const info = await dockerInfo(runtime.containerId)
  if (info.State.Running || info.Id !== runtime.containerId || containerDefinition(info) !== runtime.definition) throw problem(409, '容器状态已变化，未写入配置')
  const latest = await readDockerFile(info.Id, runtime.containerConfigPath)
  if (latest.text !== original.text || !runtime.storage?.identity) throw problem(409, '配置已变化，请重新载入')
  const local = await readLocal(runtime.storage.identity.actual)
  if (!sameFile(local.identity, runtime.storage.identity) || local.text !== latest.text) throw problem(409, '配置挂载已变化，请重新接入')
  const write = (from, to) => writeLocal(local.actual, from, to, local.actual, runtime.storage.identity)
  try {
    // 从已验证的宿主存储原地写入，保留 bind 和 local volume 的文件身份。
    await write(latest.text, next)
    const after = await readDockerFile(info.Id, runtime.containerConfigPath)
    if (after.text !== next || after.header.uid !== latest.header.uid || after.header.gid !== latest.header.gid || (after.header.mode & 0o777) !== (latest.header.mode & 0o777)) throw problem(500, '配置内容或权限校验失败')
  } catch (error) {
    try {
      const current = (await readLocal(local.actual)).text
      if (current === next) await write(next, latest.text)
      else if (current !== latest.text) error.unsafeToStart = true
    } catch {
      error.unsafeToStart = true
      console.error('[保存] 容器配置无法恢复，禁止自动启动，请从本地备份恢复')
    }
    throw error
  }
}
function mapping(info, file) {
  const matches = (info.Mounts || []).filter(m => inside(m.Destination, file)).sort((a, b) => b.Destination.length - a.Destination.length)
  const mount = matches[0]
  const backingPath = mount && ['bind', 'volume'].includes(mount.Type) && path.isAbsolute(mount.Source || '')
    ? path.join(mount.Source, path.posix.relative(mount.Destination, file)) : null
  return { mount, hostPath: mount?.Type === 'bind' ? backingPath : null, backingPath }
}
function containerDefinition(info) {
  // docker inspect --format serializes map keys in a different order from plain inspect.
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
  return hash(JSON.stringify(ordered([info.Id, info.Image, info.Path, info.Args, info.Config?.WorkingDir,
    (info.Mounts || []).map(m => [m.Type, m.Name || '', m.Source, m.Destination, m.RW]).sort((a, b) => a[3].localeCompare(b[3])),
    info.HostConfig?.ReadonlyRootfs, [...(info.HostConfig?.Mounts || [])].sort((a, b) => String(a.Target || a.Destination).localeCompare(String(b.Target || b.Destination)))])))
}
async function storageFor(info, file) {
  const { mount, backingPath } = mapping(info, file)
  if (!backingPath) throw problem(409, '请为配置设置可核验的本机持久化挂载')
  const options = (info.HostConfig?.Mounts || []).find(m => (m.Target || m.Destination) === mount.Destination)
  if (options?.VolumeOptions?.Subpath) throw problem(409, '请使用可直接核验的配置挂载路径')
  const identity = await fileIdentity(backingPath)
  const source = await hostFS.realpath(mount.Source)
  if (identity.actual !== source && !inside(source, identity.actual)) throw problem(409, '请将配置链接改为明确的挂载文件')
  if (info.State?.Running) {
    const proc = await processAt(info.State.Pid)
    if (!proc) throw problem(409, '容器进程已变化，请重新载入')
    const actual = await hostProcessFileIdentity(proc.pid, file, proc.startTime)
    if (!sameFile(identity, actual)) throw problem(409, '配置挂载已变化，请核对挂载后重新接入')
  }
  return { identity, type: mount.Type, location: [mount.Name || mount.Source, path.posix.relative(mount.Destination, file)] }
}
function transparentEntrypoint(text) {
  // Only these environment-only forwarding forms are known; never interpret arbitrary shell.
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (lines[0] === 'set -e') lines.shift()
  const simple = ['exec "$@"']
  const upstream = ['if [ "$(uname -m)" = "aarch64" ]; then',
    'export MARCH7TH_BROWSER_TYPE=chromium', 'export MARCH7TH_BROWSER_PATH=/usr/bin/chromium',
    'export MARCH7TH_DRIVER_PATH=/usr/bin/chromedriver', 'fi', 'exec "$@"']
  return JSON.stringify(lines) === JSON.stringify(simple) || JSON.stringify(lines) === JSON.stringify(upstream)
}
async function launchFor(info, selectedRoot, verifyProcess = true) {
  const root = info.Config?.WorkingDir
  if (typeof root !== 'string' || !root.startsWith('/') || path.posix.normalize(root) !== selectedRoot) return null
  let argv = [info.Path, ...(info.Args || [])], wrapper = ''
  let invocation = scriptInvocation(argv)
  if (!invocation && typeof info.Path === 'string' && info.Path.endsWith('.sh')) {
    try {
      wrapper = (await readDockerFile(info.Id, path.posix.resolve(root, info.Path))).text
      if (!transparentEntrypoint(wrapper)) return null
      argv = info.Args || []; invocation = scriptInvocation(argv)
    } catch { return null }
  }
  if (!invocation) return null
  const script = path.posix.resolve(root, invocation.script)
  if (path.posix.dirname(script) !== selectedRoot || !['main.py', 'app.py'].includes(path.posix.basename(script))) return null
  if (verifyProcess && info.State?.Running) {
    try {
      const proc = await processAt(info.State.Pid), actual = scriptInvocation(proc?.argv)
      if (!actual || proc.cwd !== selectedRoot || path.posix.resolve(proc.cwd, actual.script) !== script) return null
    } catch { return null }
  }
  return { root: selectedRoot, script, fingerprint: hash(JSON.stringify([argv, wrapper, root, script])) }
}
const INSPECT_METADATA = '{"Id":{{json .Id}},"Image":{{json .Image}},"Name":{{json .Name}},"Path":{{json .Path}},"Args":{{json .Args}},"Config":{"WorkingDir":{{json .Config.WorkingDir}}},"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}}},"Mounts":{{json .Mounts}},"HostConfig":{"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"Mounts":{{json (index .HostConfig "Mounts")}},"PidMode":{{json .HostConfig.PidMode}},"NetworkMode":{{json .HostConfig.NetworkMode}},"UsernsMode":{{json .HostConfig.UsernsMode}},"Privileged":{{json .HostConfig.Privileged}},"CapAdd":{{json .HostConfig.CapAdd}}}}'
const SELF_METADATA = '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}}},"HostConfig":{"PidMode":{{json .HostConfig.PidMode}},"NetworkMode":{{json .HostConfig.NetworkMode}},"UsernsMode":{{json .HostConfig.UsernsMode}}}}'
async function containerInventory(format = INSPECT_METADATA) {
  await localDocker()
  const list = async () => (await docker(['ps', '-aq', '--no-trunc'])).trim().split(/\r?\n/).filter(Boolean).sort()
  const ids = await list()
  if (ids.length > 256 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw problem(409, '请缩小管理范围后重新检查实例')
  const items = []
  for (let i = 0; i < ids.length; i += 32) {
    const text = await docker(['inspect', '--type', 'container', '--format', format, ...ids.slice(i, i + 32)])
    items.push(...text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)))
  }
  if (JSON.stringify(ids) !== JSON.stringify(items.map(item => item.Id).sort()) || JSON.stringify(ids) !== JSON.stringify(await list())) throw problem(409, '实例列表已变化，请重新检查')
  return items
}
export async function verifyContainerHost(snapshot, inventory) {
  if (!containerMode) return null
  const deny = () => problem(503, '请按镜像部署说明检查宿主权限后重建面板')
  if (process.getuid() !== 0 || (snapshot && !snapshot.complete)) throw deny()
  const scope = await getHostScope()
  const before = await processAt(process.pid), init = await processAt(1)
  if (!before || !init || before.namespaces?.pid !== scope.namespaces?.pid || init.namespaces?.mount !== scope.namespaces?.mount || !sameFile(init.rootIdentity, scope.rootIdentity)) throw deny()
  if (before.namespaces.mount === scope.namespaces.mount || sameFile(before.rootIdentity, scope.rootIdentity)) throw deny()
  for (const namespace of ['net', 'cgroup']) if (fs.readlinkSync(`/proc/self/ns/${namespace}`) !== fs.readlinkSync(`/proc/1/ns/${namespace}`)) throw deny()
  for (const file of ['uid_map', 'gid_map']) if (!/^\s*0\s+0\s+4294967295\s*$/.test(fs.readFileSync(`/proc/self/${file}`, 'utf8'))) throw deny()
  const [localSocket, hostSocket] = await Promise.all([
    fs.promises.stat('/var/run/docker.sock', { bigint: true }), hostFS.stat('/var/run/docker.sock', { bigint: true })
  ])
  if (!localSocket.isSocket() || !hostSocket.isSocket() || localSocket.dev !== hostSocket.dev || localSocket.ino !== hostSocket.ino) throw deny()
  const security = JSON.parse(await docker(['info', '--format', '{{json .SecurityOptions}}']))
  if (!Array.isArray(security) || security.some(option => /rootless|userns/i.test(option))) throw deny()
  const items = inventory || await containerInventory(SELF_METADATA)
  const matches = items.filter(info => info.State?.Running && info.State.Pid === process.pid)
  if (matches.length !== 1) throw deny()
  const own = matches[0]
  const ownsCgroup = before.cgroup.split('\n').some(line => {
    const start = line.indexOf(':', line.indexOf(':') + 1)
    return start >= 0 && line.slice(start + 1).split('/').some(part => part === own.Id || part === `docker-${own.Id}.scope`)
  })
  if (!ownsCgroup) throw deny()
  if (own.HostConfig?.PidMode !== 'host' || own.HostConfig?.NetworkMode !== 'host' || !['', 'host'].includes(own.HostConfig?.UsernsMode || '')) throw deny()
  const observer = snapshot?.observer || before
  if (before.namespaces.mount !== observer.namespaces?.mount || !sameFile(before.rootIdentity, observer.rootIdentity)) throw deny()
  // Only the current Node process is a management exemption, never an image/name/label.
  if (snapshot?.processes.some(proc => proc.pid !== process.pid && proc.namespaces?.mount === before.namespaces.mount && sameFile(proc.rootIdentity, before.rootIdentity) && (isPython(proc.argv?.[0]) || path.basename(proc.argv?.[0] || '') === 'uv'))) throw deny()
  const after = await processAt(process.pid)
  if (!after || after.startTime !== before.startTime || after.namespaces.mount !== before.namespaces.mount || !sameFile(after.rootIdentity, before.rootIdentity)) throw deny()
  await authorizeHost({ pid: process.pid, startTime: after.startTime, scope })
  return own
}
async function mountMayExpose(info, identity) {
  for (const mount of info.Mounts || []) {
    if (!['bind', 'volume'].includes(mount.Type) || !path.isAbsolute(mount.Source || '')) continue
    try {
      const source = await hostFS.realpath(mount.Source)
      if (inside(source, identity.actual)) return true
      if ((await hostFS.stat(source)).isFile() && sameFile(await fileIdentity(source), identity)) return true
    } catch {
      // An inaccessible mount must not silently become proof of independent storage.
      throw problem(409, '请检查挂载访问权限后重新载入')
    }
  }
  return false
}
export async function observeDockerConfigUsers(identity, snapshot, runtime) {
  const users = [], warnings = []
  let complete = true, items
  try { items = await containerInventory() } catch (error) {
    // A host without Docker can still manage native installs. Visible container/daemon
    // evidence, configured Docker endpoints or a connected Docker target cannot be ignored.
    const dockerPresent = runtime.kind === 'docker' || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT ||
      snapshot.processes.some(p => /(?:^|\/)(?:dockerd|containerd)(?:$|\s)/.test(p.argv?.[0] || '') || /docker|containerd/.test(p.cgroup || ''))
    if (error.code === 'ENOENT' && !dockerPresent) return { users, complete, warnings }
    console.warn('[配置隔离] Docker 清单未完成', error.code || error.status || 'unknown')
    return { users, complete: false, warnings: ['请检查 Docker 访问权限后重新载入'] }
  }
  let panel = null
  if (containerMode) {
    try { panel = await verifyContainerHost(snapshot, items) }
    catch (error) {
      console.warn('[宿主桥接] 容器身份核验未完成', error.code || error.status || 'unknown')
      return { users, complete: false, warnings: ['请按镜像部署说明检查宿主权限后重建面板'] }
    }
  }
  if (panel) {
    for (const proc of snapshot.processes) {
      if (proc.pid === process.pid || proc.namespaces?.mount !== snapshot.hostScope?.namespaces?.mount || !sameFile(proc.rootIdentity, snapshot.hostScope?.rootIdentity) || !/^node(?:js)?$/.test(path.posix.basename(proc.argv?.[0] || '')) || !proc.cwd?.startsWith('/')) continue
      const entries = proc.argv.slice(1).filter(arg => path.posix.basename(arg) === 'server.mjs').slice(0, 4)
      for (const entry of entries) {
        let peer = false
        try { peer = JSON.parse(await readHostFile(path.posix.join(path.posix.dirname(path.posix.resolve(proc.cwd, entry)), 'package.json'), 65536)).name === 'march7thassistant-web' } catch {}
        if (peer) return { users, complete: false, warnings: ['请只保留一个正在运行的配置面板后再保存'] }
      }
    }
  }
  if (runtime.kind === 'docker') {
    const own = items.find(info => info.Id === runtime.containerId)
    if (!own || containerDefinition(own) !== runtime.definition) return { users, complete: false, warnings: ['实例身份已变化，请重新载入'] }
    if (own.State.Running) {
      const init = snapshot.processes.find(p => p.pid === own.State.Pid)
      if (!init?.namespaces || !init.rootIdentity) return { users, complete: false, warnings: ['请检查容器进程访问权限后重新载入'] }
      let mains = 0
      for (const proc of snapshot.processes) {
        if (proc.namespaces?.mount !== init.namespaces.mount || !sameFile(proc.rootIdentity, init.rootIdentity) || !isPython(proc.argv?.[0])) continue
        const invocation = scriptInvocation(proc.argv)
        if (!invocation || !['main.py', 'app.py'].includes(path.posix.basename(invocation.script))) continue
        try {
          const initSource = await readDockerFile(own.Id, path.posix.join(proc.cwd, 'module/config/__init__.py'))
          if (parseConfigPath(initSource.text)) mains++
        } catch { /* Unrelated Python entrypoints are not configuration users. */ }
      }
      if (mains > 1) return { users, complete: false, warnings: ['请将容器内多个助手拆分部署后保存'] }
    }
  }
  for (const info of items) {
    if (info.Id === runtime.containerId || info.Id === panel?.Id) continue
    let exposed
    try { exposed = await mountMayExpose(info, identity) }
    catch { complete = false; continue }
    const root = info.Config?.WorkingDir
    if (panel && info.State.Running && info.HostConfig?.PidMode === 'host') {
      // Host-namespace access does not require a config mount. Unknown privileged
      // peers must not become 'independent' just because cwd/package.json is absent.
      const hostAccess = info.HostConfig.Privileged || (info.HostConfig.CapAdd || []).some(cap => /^(?:CAP_)?SYS_ADMIN$/i.test(cap))
      const roots = new Set(typeof root === 'string' && root.startsWith('/') ? [root] : [])
      const init = snapshot.processes.find(proc => proc.pid === info.State.Pid)
      if (init?.cwd?.startsWith('/') && /^node(?:js)?$/.test(path.posix.basename(init.argv?.[0] || ''))) {
        for (const arg of init.argv.slice(1)) if (!arg.startsWith('-') && /\.(?:mjs|cjs|js)$/.test(arg)) roots.add(path.posix.dirname(path.posix.resolve(init.cwd, arg)))
      }
      let peer = info.Image === panel.Image
      for (const directory of [...roots].slice(0, 4)) {
        if (peer) break
        try { peer = JSON.parse((await readDockerFile(info.Id, path.posix.join(directory, 'package.json'))).text).name === 'march7thassistant-web' } catch {}
      }
      if (peer || hostAccess) {
        complete = false
        warnings.push(peer ? '请只保留一个正在运行的配置面板后再保存' : '请核对其他宿主管理容器后重新载入')
        continue
      }
    }
    if (typeof root !== 'string' || !root.startsWith('/')) { if (exposed) complete = false; continue }
    let declaration
    try { declaration = (await readDockerFile(info.Id, path.posix.join(root, 'module/config/__init__.py'))).text }
    catch { if (exposed) complete = false; continue }
    const declared = parseConfigPath(declaration)
    if (!declared) { if (exposed) complete = false; continue }
    try {
      const file = path.posix.resolve(root, declared)
      // A proven private writable layer cannot share host storage. It remains read-only
      // as a selected target, but must not disable independent mounted configurations.
      if (!mapping(info, file).mount && !(info.Mounts || []).length) {
        if (!await launchFor(info, path.posix.normalize(root))) complete = false
        continue
      }
      const storage = await storageFor(info, file)
      if (sameFile(storage.identity, identity)) users.push({ containerId: info.Id, label: info.Name.replace(/^\//, '') })
      else if (!await launchFor(info, path.posix.normalize(root))) complete = false
    } catch { complete = false }
  }
  if (!complete) warnings.push('请核对共享挂载与其他部署后重新载入')
  return { users, complete, warnings }
}
function hasIdentity(text, source, main) {
  const doc = validateGameConfig(text)
  const data = doc.toJS({ maxAliasCount: 0 })
  if (!data.instance_names || typeof data.instance_names !== 'object' || !source.includes('class Config') || !source.includes('config_path') || !main.includes('module.config')) throw problem(400, '该容器没有可确认的三月七程序结构')
}
export async function inspectDocker(spec) {
  const info = await dockerInfo(spec.containerName)
  const root = containerPath(spec.containerRoot || info.Config.WorkingDir || '/m7a')
  const file = containerPath(spec.containerConfigPath || path.posix.join(root, 'config.yaml'))
  const [defaults, source, main, init, versionFile, config] = await Promise.all([
    readDockerFile(info.Id, path.posix.join(root, 'assets/config/config.example.yaml')),
    readDockerFile(info.Id, path.posix.join(root, 'module/config/config.py')),
    readDockerFile(info.Id, path.posix.join(root, 'main.py')),
    readDockerFile(info.Id, path.posix.join(root, 'module/config/__init__.py')),
    readDockerFile(info.Id, path.posix.join(root, 'assets/config/version.txt')),
    readDockerFile(info.Id, file),
  ])
  hasIdentity(defaults.text, source.text, main.text)
  validateGameConfig(config.text)
  const { mount, hostPath } = mapping(info, file)
  const singleFileBind = mount?.Type === 'bind' && mount.Destination === file
  const warnings = []
  const declared = parseConfigPath(init.text)
  const pathVerified = !!declared && path.posix.resolve(root, declared) === file
  if (!pathVerified) warnings.push('程序实际配置路径无法确认，请检查 CONFIG_PATH 与所选文件')
  const launch = await launchFor(info, root)
  const launchVerified = !!launch
  if (!launchVerified) warnings.push('请核对实际启动目录和入口后重新接入')
  let sameHost = true
  if (spec.configPath) {
    try {
      sameHost = !!hostPath && await hostFS.realpath(hostPath) === await hostFS.realpath(spec.configPath) && (await readLocal(spec.configPath)).text === config.text
    } catch { sameHost = false }
    if (!sameHost) warnings.push('手动路径与容器实际配置不一致，请核对挂载和所选实例')
  }
  let hostWritable = false, storage = null
  try {
    storage = await storageFor(info, file)
    const local = await readLocal(storage.identity.actual)
    await hostFS.access(local.actual, fs.constants.W_OK)
    if (!sameFile(local.identity, storage.identity) || local.text !== config.text) throw problem(409, '配置挂载已变化，请重新接入')
    hostWritable = true
  } catch (error) {
    warnings.push(error.status ? error.message : '请检查配置挂载与文件访问权限后重新载入')
  }
  const readonly = mount ? !mount.RW : !!info.HostConfig.ReadonlyRootfs
  if (readonly) warnings.push('配置挂载为只读，不能保存')
  if (!mount) warnings.push('配置保存在容器可写层；重建容器可能丢失，请配置持久化挂载')
  const busy = !!(info.State.Paused || info.State.Restarting || info.State.Dead || info.State.RemovalInProgress)
  if (busy) warnings.push('容器处于暂停、重启或异常状态，请稍后再试')
  const running = !!info.State.Running
  const name = info.Name.replace(/^\//, '')
  const environment = {}
  const allowed = ['MARCH7TH_CLOUD_GAME_ENABLE', 'MARCH7TH_CLOUD_GAME_USE_PAID_TIME', 'MARCH7TH_BROWSER_HEADLESS_ENABLE', 'MARCH7TH_BROWSER_HEADLESS_RESTART_ON_NOT_LOGGED_IN', 'MARCH7TH_BROWSER_DOWNLOAD_USE_MIRROR', 'MARCH7TH_LOG_LEVEL', 'MARCH7TH_AFTER_FINISH', 'MARCH7TH_BROWSER_TYPE']
  for (const item of info.Config.Env || []) {
    const split = item.indexOf('='); const key = item.slice(0, split)
    if (allowed.includes(key)) environment[key] = item.slice(split + 1)
  }
  return {
    kind: 'docker', label: name, root, configPath: hostPath, containerName: name,
    containerId: info.Id, imageId: info.Image, containerConfigPath: file, singleFileBind,
    available: true, running, status: info.State.Status, canRead: true,
    canWrite: !readonly && !busy && sameHost && hostWritable && pathVerified && launchVerified, canRestart: !busy && launchVerified && pathVerified, managerLabel: 'Docker',
    evidence: ['默认配置、配置模块与启动程序相互匹配', `Docker ${info.Id.slice(0, 12)}`, mount ? `${mount.Type} 挂载：${mount.Destination}` : '容器可写层'],
    warnings, environment, storage, definition: containerDefinition(info),
    identity: hash(JSON.stringify([containerDefinition(info), launch?.fingerprint || '', root, file, storage?.identity || null])),
    version: versionFile.text.trim(), defaults: defaults.text, config,
  }
}
export async function discoverDocker({ containerName, hostConfig } = {}) {
  const diagnostics = [], candidates = []
  let entries
  try {
    await localDocker()
    if (containerName) entries = [{ Names: containerRef(containerName) }]
    else entries = (await docker(['ps', '-a', '--format', '{{json .}}'])).trim().split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s)).filter(c => /march7th|(?:^|[-_ ])m7a(?:$|[-_ ])/i.test(`${c.Image || ''} ${c.Names || ''} ${c.Labels || ''}`))
  } catch { return { candidates, diagnostics: ['无法连接本机 Docker，或当前用户没有访问权限；可使用手动路径接入本机配置'] } }
  if (entries.length > 24) diagnostics.push('候选容器较多，仅检查前 24 个；其他容器请手动填写名称')
  for (const entry of entries.slice(0, 24)) {
    const name = entry.Names
    try {
      const info = await dockerInfo(name)
      const roots = [...new Set([info.Config.WorkingDir, '/m7a', ...(info.Mounts || []).filter(m => path.posix.basename(m.Destination) === 'config.yaml').map(m => path.posix.dirname(m.Destination))].filter(r => r?.startsWith('/')))]
      let found = false
      for (const root of roots.slice(0, 4)) {
        try {
          let configured = path.posix.join(root, 'config.yaml')
          try {
            const init = await readDockerFile(info.Id, path.posix.join(root, 'module/config/__init__.py'))
            const declared = parseConfigPath(init.text)
            if (declared) configured = path.posix.resolve(root, declared)
          } catch { /* 无声明的目录在正式结构验证时会被拒绝。 */ }
          const spec = { kind: 'docker', containerName: name, containerRoot: root, containerConfigPath: configured }
          if (hostConfig) spec.configPath = hostConfig
          const runtime = await inspectDocker(spec)
          if (hostConfig && (!runtime.canWrite && runtime.warnings.some(w => w.includes('手动路径')))) continue
          candidates.push({ ...spec, configPath: runtime.configPath, label: name, evidence: runtime.evidence, warnings: runtime.warnings })
          found = true; break
        } catch { /* 下一项独立验证，失败不认为该容器已被识别。 */ }
      }
      if (!found && containerName) diagnostics.push('指定容器未能通过三月七目录和配置校验，请检查安装目录与挂载')
    } catch { diagnostics.push(`无法检查候选容器 ${name}`) }
  }
  return { candidates, diagnostics }
}
export async function stopDocker(runtime) {
  if (!runtime.running) return null
  const fresh = await inspectDocker({ containerName: runtime.containerName, containerRoot: runtime.root, containerConfigPath: runtime.containerConfigPath, configPath: runtime.configPath })
  if (fresh.identity !== runtime.identity || !fresh.canWrite || !fresh.canRestart) throw problem(409, '容器身份或权限已变化')
  const token = { id: fresh.containerId, image: fresh.imageId, definition: fresh.definition }
  restores.add(token)
  try {
    await docker(['stop', '--time', '20', token.id], { timeout: 90000 })
    if ((await dockerInfo(token.id)).State.Running) throw problem(409, '容器未能停止，未保存配置')
  } catch (error) { error.restoreToken = token; throw error }
  return token
}
export async function restoreDocker(token) {
  if (!restores.has(token)) throw problem(403, '恢复凭据不正确')
  const info = await dockerInfo(token.id)
  if (info.Image !== token.image || containerDefinition(info) !== token.definition) throw problem(409, '容器身份已变化，未自动启动')
  if (!info.State.Running) await docker(['start', token.id], { timeout: 90000 })
  restores.delete(token)
}
