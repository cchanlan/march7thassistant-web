import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseConfig } from './schema.mjs'
import { containerMode, hostFileIdentity, readHostConfig, writeHostConfig } from './host.mjs'

export const execute = promisify(execFile)
export const hash = value => createHash('sha256').update(value).digest('hex')
export const problem = (status, message) => Object.assign(new Error(message), { status })
export function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value)) throw problem(400, '请填写服务器上的完整路径')
  return path.normalize(value)
}
export function inside(root, file) {
  const rel = path.relative(root, file)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}
function descriptorIdentity(fd, actual) {
  const stat = fs.fstatSync(fd, { bigint: true })
  if (!stat.isFile()) throw problem(400, '请选择普通配置文件')
  return { actual, dev: String(stat.dev), ino: String(stat.ino) }
}
export async function fileIdentity(file) {
  if (containerMode) return hostFileIdentity(absolutePath(file))
  const actual = fs.realpathSync(absolutePath(file))
  const fd = fs.openSync(actual, 'r')
  try { return descriptorIdentity(fd, actual) } finally { fs.closeSync(fd) }
}
export function sameFile(a, b) {
  return typeof a?.dev === 'string' && a.dev.length > 0 && typeof a.ino === 'string' && a.ino.length > 0 && !!b && a.dev === b.dev && a.ino === b.ino
}
export async function readLocal(file) {
  if (containerMode) return readHostConfig(absolutePath(file))
  const requested = absolutePath(file)
  const actual = fs.realpathSync(requested)
  const fd = fs.openSync(actual, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw problem(400, '请选择不超过 1 MiB 的普通配置文件')
    return { text: fs.readFileSync(fd, 'utf8'), actual, stat, identity: descriptorIdentity(fd, actual) }
  } finally { fs.closeSync(fd) }
}
export function validateGameConfig(text) {
  let doc
  try { doc = parseConfig(text) } catch { throw problem(400, '配置文件不是有效的 YAML 映射') }
  const data = doc.toJS({ maxAliasCount: 0 })
  const keys = ['power_enable', 'instance_names', 'instance_type', 'cloud_game_enable', 'scheduled_time', 'notification_enable', 'currencywars_enable', 'daily_enable', 'reward_enable', 'game_title_name']
  if (keys.filter(key => Object.prototype.hasOwnProperty.call(data, key)).length < 3) throw problem(400, '无法确认为三月七配置，请选择程序实际使用的 config.yaml')
  return doc
}
export function atomicJSON(file, data) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}
export async function writeLocal(file, original, next, expectedPath, expectedIdentity) {
  if (containerMode) return writeHostConfig(absolutePath(file), original, next, expectedPath, expectedIdentity)
  const actual = fs.realpathSync(absolutePath(file))
  if (actual !== expectedPath) throw problem(409, '配置路径已变化，请重新接入')
  const fd = fs.openSync(actual, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
  const write = text => {
    const buffer = Buffer.from(text)
    let offset = 0
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
    fs.ftruncateSync(fd, buffer.length)
    fs.fsyncSync(fd)
  }
  let touched = false
  try {
    const identity = descriptorIdentity(fd, actual)
    if ((expectedIdentity && !sameFile(identity, expectedIdentity)) || !sameFile(identity, await fileIdentity(file)) || fs.readFileSync(fd, 'utf8') !== original) throw problem(409, '配置文件已变化，请重新载入')
    // 保留 inode，兼容单文件挂载；必须先核验实际打开的文件身份。
    touched = true
    write(next)
  } catch (error) {
    if (touched) {
      try { write(original) } catch {
        error.unsafeToStart = true
        console.error('[保存] 配置恢复失败，禁止自动启动，请从本地备份恢复')
      }
    }
    throw error
  } finally { fs.closeSync(fd) }
}
