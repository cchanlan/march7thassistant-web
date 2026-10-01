import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
function authError(status, message) {
  return Object.assign(new Error(message), { status })
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw authError(400, '新密码需要 8～128 个字符')
  }
}
function revision(record) {
  return createHash('sha256').update(`${record.salt}:${record.hash}`).digest('hex')
}

export class AuthStore {
  constructor(directory, { initialize = false } = {}) {
    this.directory = directory
    this.file = path.join(directory, 'auth.json')
    this.accessFile = path.join(directory, 'access.txt')
    this.lock = path.join(directory, 'auth.lock')
    this.initialCreated = false
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    if (initialize && !fs.existsSync(this.file)) this.initialize()
    this.read()
  }

  read() {
    const text = fs.readFileSync(this.file, 'utf8')
    const record = JSON.parse(text)
    if (!record || typeof record.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(record.salt) || typeof record.hash !== 'string' || !/^[a-f0-9]{128}$/i.test(record.hash)) {
      throw new Error('认证文件格式不正确')
    }
    return { salt: record.salt, hash: record.hash, revision: revision(record) }
  }

  withLock(action) {
    try { fs.mkdirSync(this.lock, { mode: 0o700 }) } catch (error) {
      if (error.code === 'EEXIST') throw authError(409, '另一个改密操作正在进行，请稍后再试')
      throw error
    }
    try { return action() } finally {
      try { fs.rmdirSync(this.lock) } catch (error) {
        if (error.code !== 'ENOENT') console.error('[改密] 临时锁未能清理，请检查文件权限')
      }
    }
  }

  write(record) {
    const temporary = path.join(this.directory, `auth-${randomBytes(12).toString('hex')}.tmp`)
    let fd
    try {
      fd = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(fd, `${JSON.stringify({ salt: record.salt, hash: record.hash })}\n`)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      // auth.json 不是容器挂载配置，可以原子替换；失败时保留原来的密码。
      fs.renameSync(temporary, this.file)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }

  initialize() {
    this.withLock(() => {
      if (fs.existsSync(this.file)) return
      // 不把用户手改的领取文件当作密码配置，也不静默覆盖已有文件。
      if (fs.existsSync(this.accessFile)) throw new Error('认证文件缺失，请先检查初始密码领取文件')
      const password = randomBytes(18).toString('base64url')
      const salt = randomBytes(16).toString('hex')
      const hash = scryptSync(password, salt, 64).toString('hex')
      fs.writeFileSync(this.accessFile, `${password}\n`, { mode: 0o600, flag: 'wx' })
      try { this.write({ salt, hash }) } catch (error) {
        if (fs.readFileSync(this.accessFile, 'utf8') === `${password}\n`) fs.unlinkSync(this.accessFile)
        throw error
      }
      this.initialCreated = true
    })
  }

  async verify(password, record = this.read()) {
    if (typeof password !== 'string' || password.length > 256) return false
    const hash = await derive(password, record.salt, 64)
    return timingSafeEqual(hash, Buffer.from(record.hash, 'hex'))
  }

  async setPassword(password, expectedRevision) {
    validatePassword(password)
    const salt = randomBytes(16).toString('hex')
    const hash = (await derive(password, salt, 64)).toString('hex')
    return this.withLock(() => {
      if (this.read().revision !== expectedRevision) throw authError(409, '密码已更新，请重新操作')
      this.write({ salt, hash })
      // 自定义密码只保存哈希；领取文件即使清理失败也已不能用于登录。
      let accessRemoved = true
      try {
        const stat = fs.lstatSync(this.accessFile)
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('领取文件不是普通文件')
        fs.unlinkSync(this.accessFile)
      } catch (error) {
        if (error.code !== 'ENOENT') accessRemoved = false
      }
      return { revision: revision({ salt, hash }), accessRemoved }
    })
  }
}
