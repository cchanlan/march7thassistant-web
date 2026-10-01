import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { AuthStore, validatePassword } from './src/auth.mjs'
import { Targets, publicRuntime } from './src/targets.mjs'
import { problem } from './src/io.mjs'
import { same } from './src/schema.mjs'

if (process.platform !== 'linux') throw new Error('本项目目前仅支持 Linux')
const root = fileURLToPath(new URL('.', import.meta.url))
const stateDir = path.resolve(process.env.M7A_STATE_DIR || path.join(root, '.state'))
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 18077)
const cookieName = `m7a_session_${port}`
const readOnly = process.env.M7A_READ_ONLY === '1'
const publicOrigin = process.env.M7A_PUBLIC_ORIGIN ? new URL(process.env.M7A_PUBLIC_ORIGIN).origin : ''
const auth = new AuthStore(stateDir, { initialize: true })
const targets = new Targets(stateDir, process.env.M7A_SEARCH_ROOTS?.split(path.delimiter).filter(Boolean))
const backups = path.join(stateDir, 'backups')
fs.mkdirSync(backups, { recursive: true, mode: 0o700 })
const sessions = new Map(), attempts = new Map()
const SESSION_MS = 12 * 60 * 60 * 1000
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i.address.includes(':') ? `[${i.address}]` : i.address)])
let saving = false, changingPassword = false, discovering = false, authInFlight = 0
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]])
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem(415, '请使用页面提交')
  const chunks = []; let length = 0
  for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024) throw problem(413, '提交内容过大'); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw problem(400, '提交格式不正确') }
}
function verifyRequest(req) {
  let origin
  try {
    const url = new URL(`http://${req.headers.host}`)
    if (url.username || url.password || (!allowedHosts.has(url.hostname) && (!publicOrigin || url.host !== new URL(publicOrigin).host))) throw new Error()
    origin = publicOrigin || url.origin
  } catch { throw problem(403, '访问地址未授权') }
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw problem(403, '请从设置页面操作')
}
function sessionFor(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))
  const id = cookie?.slice(cookieName.length + 1)
  const session = sessions.get(id)
  if (!session || session.expires < Date.now() || session.authRevision !== auth.read().revision) { if (id) sessions.delete(id); return null }
  return session
}
function setCookie(res, id, clear = false) {
  res.setHeader('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${publicOrigin.startsWith('https:') ? '; Secure' : ''}`)
}
function authAttempt(req, scope) {
  const key = `${scope}:${req.socket.remoteAddress}`; const now = Date.now()
  let limit = attempts.get(key)
  if (!limit || now > limit.until) limit = { count: 0, until: now + 10 * 60 * 1000 }
  if (limit.count >= 10 || authInFlight >= 4 || (attempts.size >= 1000 && !attempts.has(key))) throw problem(429, '尝试次数较多，请稍后再试')
  limit.count++; attempts.set(key, limit); return key
}
function displayRuntime(runtime) {
  const result = publicRuntime(runtime)
  if (readOnly) { result.canWrite = false; result.warnings = [...result.warnings, '当前面板处于只读模式'] }
  return result
}
async function getConfig(id, session) {
  if (saving) throw problem(409, '正在保存，请稍后再试')
  const bundle = await targets.bundle(id)
  const snapshot = randomBytes(16).toString('hex')
  if (!session.snapshots) session.snapshots = new Map()
  if (session.snapshots.size >= 8) session.snapshots.delete(session.snapshots.keys().next().value)
  session.snapshots.set(snapshot, { targetId: id, binding: bundle.binding, metadata: bundle.metadata.fingerprint, values: bundle.doc.toJS({ maxAliasCount: 0 }) })
  return { fields: bundle.fields, groups: bundle.metadata.schema.groups, instances: bundle.metadata.schema.instances, version: bundle.metadata.version, target: bundle.target, runtime: displayRuntime(bundle.runtime), csrf: session.csrf, snapshot }
}
function checkChanges(bundle, changes, snapshot) {
  if (bundle.binding !== snapshot.binding || bundle.metadata.fingerprint !== snapshot.metadata) throw problem(409, '实例或字段定义已更新，请重新载入设置')
  const fields = new Map(bundle.fields.map(f => [f.key, f])); const data = bundle.doc.toJS({ maxAliasCount: 0 }); const seen = new Set()
  for (const change of changes) {
    if (!change || typeof change.key !== 'string' || seen.has(change.key) || !Object.prototype.hasOwnProperty.call(change, 'value')) throw problem(400, '提交设置不正确')
    seen.add(change.key)
    const field = fields.get(change.key)
    try { bundle.metadata.schema.validateChange(field, change.value) } catch (e) { throw problem(400, e.message) }
    if (!Object.prototype.hasOwnProperty.call(snapshot.values, change.key) || !same(snapshot.values[change.key], data[change.key])) throw problem(409, `${field.label}已被更新，请重新载入后修改`)
  }
}
async function saveConfig(payload, session) {
  if (readOnly) throw problem(403, '当前面板处于只读模式')
  if (saving || changingPassword) throw problem(409, '操作进行中，请稍后再试')
  if (!payload || !Array.isArray(payload.changes) || !payload.changes.length || payload.changes.length > 600) throw problem(400, '请先修改设置')
  const snapshot = session.snapshots?.get(payload.snapshot)
  if (!snapshot || snapshot.targetId !== payload.targetId) throw problem(409, '目标或页面快照不匹配，请重新载入')
  saving = true
  let token, originalRuntime, saved = false, failed = false, failure, backup
  try {
    const before = await targets.bundle(payload.targetId)
    originalRuntime = before.runtime
    if (!before.runtime.available || !before.runtime.canWrite) throw problem(409, before.runtime.warnings?.[0] || '实例当前不可安全写入，请先通过原部署方式停止程序')
    checkChanges(before, payload.changes, snapshot)
    if (before.runtime.fileOnly) {
      if (before.runtime.running === true || payload.confirmStopped !== true) throw problem(409, '请确认程序已停止，再保存配置文件')
    } else if (before.runtime.running) {
      if (!before.runtime.canRestart || payload.confirmRestart !== true) throw problem(409, '请确认停止实例、保存并恢复运行')
      try { token = await targets.stop(before) } catch (error) { if (!error.restored) token = error.restoreToken; throw error }
    }
    const fresh = await targets.bundle(payload.targetId)
    if (fresh.runtime.running === true || (!fresh.runtime.fileOnly && fresh.runtime.running !== false) || !fresh.runtime.canWrite) throw problem(409, '实例未确认停止，未写入配置')
    checkChanges(fresh, payload.changes, snapshot)
    const next = fresh.metadata.schema.applyChanges(fresh.doc, payload.changes)
    backup = `${payload.targetId}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.yaml`
    fs.writeFileSync(path.join(backups, backup), fresh.config.text, { mode: 0o600, flag: 'wx' })
    await targets.write(fresh, next)
    saved = true
    session.snapshots.delete(payload.snapshot)
    console.log(`[保存] 实例 ${payload.targetId}，${payload.changes.length} 项，备份 ${backup}`)
  } catch (error) { failure = error } finally {
    if (token && originalRuntime) {
      if (failure?.unsafeToStart) {
        failed = true
        console.error('[恢复] 配置完整性未确认，实例保持停止，请核对备份', backup)
      } else {
        try { await targets.restore(originalRuntime, token) } catch (error) { failed = true; console.error('[恢复]', originalRuntime.kind, error.code || error.status || 'failed') }
      }
      targets.abandon(originalRuntime, token)
    }
    saving = false
  }
  const recovery = failure?.unsafeToStart ? `请先从备份 ${backup} 恢复配置，再按原部署方式启动实例` : originalRuntime?.kind === 'docker' ? `请执行 docker start ${originalRuntime.containerName}` : '请按原部署方式启动实例并检查服务日志'
  if (failure) { if (failed) throw problem(503, `保存未完成；${recovery}`); throw failure }
  return { saved, backup, restarted: !!token && !failed, restartFailed: failed, message: failed ? `配置已保存；${recovery}` : token ? '设置已保存，实例已恢复运行' : '配置文件已保存' }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  try {
    verifyRequest(req)
    const url = new URL(req.url, 'http://localhost'); const route = url.pathname; const session = sessionFor(req)
    if (req.method === 'GET' && staticFiles.has(route)) { const [file, type] = staticFiles.get(route); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(fs.readFileSync(path.join(root, 'public', file))) }
    if (req.method === 'GET' && route === '/api/session') return json(res, 200, { authenticated: !!session, csrf: session?.csrf })
    if (req.method === 'POST' && route === '/api/login') {
      const payload = await body(req)
      if (typeof payload?.password !== 'string' || payload.password.length > 256) throw problem(400, '请输入登录密码')
      const attempt = authAttempt(req, 'login'), record = auth.read(); let valid
      authInFlight++; try { valid = await auth.verify(payload.password, record) } finally { authInFlight-- }
      if (auth.read().revision !== record.revision) throw problem(409, '密码已更新，请使用新密码登录')
      if (!valid) throw problem(401, '密码不正确')
      attempts.delete(attempt); if (session) sessions.delete(session.id)
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value)
      const id = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex')
      sessions.set(id, { id, csrf, expires: Date.now() + SESSION_MS, authRevision: record.revision })
      setCookie(res, id); return json(res, 200, { csrf })
    }
    if (!session) throw problem(401, '请先登录')
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw problem(403, '请重新登录后操作')
    if (req.method === 'POST' && route === '/api/logout') { sessions.delete(session.id); setCookie(res, '', true); return json(res, 200, { ok: true }) }
    if (req.method === 'POST' && route === '/api/password') {
      if (saving || changingPassword) throw problem(409, '操作进行中，请稍后再试')
      const payload = await body(req)
      if (saving || changingPassword) throw problem(409, '操作进行中，请稍后再试')
      if (typeof payload?.currentPassword !== 'string' || payload.currentPassword.length > 256) throw problem(400, '请输入当前密码')
      validatePassword(payload.newPassword)
      if (payload.newPassword !== payload.confirmPassword) throw problem(400, '两次新密码不一致')
      const attempt = authAttempt(req, 'password'), record = auth.read()
      if (record.revision !== session.authRevision) throw problem(401, '请重新登录')
      changingPassword = true; authInFlight++
      try {
        if (!await auth.verify(payload.currentPassword, record)) throw problem(400, '当前密码不正确')
        if (!sessions.has(session.id)) throw problem(401, '请重新登录')
        const result = await auth.setPassword(payload.newPassword, record.revision)
        sessions.clear(); attempts.delete(attempt); setCookie(res, '', true)
        if (!result.accessRemoved) console.error('[改密] 初始领取文件清理失败，请检查文件权限')
        return json(res, 200, { ok: true, message: '密码已修改，请重新登录' })
      } finally { changingPassword = false; authInFlight-- }
    }
    if (req.method === 'GET' && route === '/api/targets') return json(res, 200, { targets: targets.list() })
    if (req.method === 'POST' && route === '/api/discover') {
      if (discovering) throw problem(409, '正在发现实例，请稍后再试')
      if (session.lastDiscovery && Date.now() - session.lastDiscovery < 5000) throw problem(429, '请稍后再次发现')
      const payload = await body(req)
      if (discovering) throw problem(409, '正在发现实例，请稍后再试')
      discovering = true; session.lastDiscovery = Date.now()
      try { return json(res, 200, await targets.discover(payload?.roots, session.id)) } finally { discovering = false }
    }
    if (req.method === 'POST' && route === '/api/targets') {
      const payload = await body(req); if (saving) throw problem(409, '正在保存，请稍后再试')
      return json(res, 200, { target: await targets.accept(payload?.candidateKey, session.id) })
    }
    if (req.method === 'POST' && route === '/api/targets/manual') {
      const payload = await body(req); if (saving) throw problem(409, '正在保存，请稍后再试')
      return json(res, 200, { target: await targets.manual(payload) })
    }
    if (req.method === 'DELETE' && route.startsWith('/api/targets/')) {
      if (saving) throw problem(409, '正在保存，请稍后再试')
      targets.remove(route.slice('/api/targets/'.length)); return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && route === '/api/config') return json(res, 200, await getConfig(url.searchParams.get('target'), session))
    if (req.method === 'GET' && route === '/api/status') {
      try { return json(res, 200, displayRuntime(await targets.inspect(targets.record(url.searchParams.get('target')).spec))) }
      catch (error) { return json(res, 200, { available: false, running: null, status: 'unavailable', canRead: false, canWrite: false, canRestart: false, warnings: [error.status ? error.message : '无法检查实例，请检查路径、权限或部署状态'] }) }
    }
    if (req.method === 'POST' && route === '/api/config') return json(res, 200, await saveConfig(await body(req), session))
    if (req.method === 'GET' && route === '/api/export') {
      if (saving) throw problem(409, '正在保存，请稍后再试')
      const bundle = await targets.bundle(url.searchParams.get('target'))
      res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="config.yaml"' }); return res.end(bundle.config.text)
    }
    throw problem(404, '页面不存在')
  } catch (error) {
    if (!error.status) console.error('[请求]', error.code || error.name || 'failed')
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '操作未完成，请检查路径、权限与服务日志' }); else res.end()
  }
})
server.requestTimeout = 180000; server.headersTimeout = 15000
server.on('error', error => { console.error('[启动]', error.code); process.exitCode = 1 })
server.listen(port, host, () => {
  console.log(`三月七 Linux 配置面板已启动：${host}:${port}`)
  if (auth.initialCreated) console.log('初始密码领取文件：.state/access.txt；不要把领取文件当作密码配置')
  console.log('忘记密码：在面板目录运行 node tools/reset-password.mjs')
})
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) if (session.expires < now) sessions.delete(id)
  for (const [key, attempt] of attempts) if (attempt.until < now) attempts.delete(key)
}, 60000).unref()
function shutdown() { server.close(() => process.exit(0)) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
