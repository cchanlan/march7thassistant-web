import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { AuthStore, validatePassword } from '../src/auth.mjs'

if (process.argv.includes('--help')) {
  console.log('用法：在网页目录执行 node tools/reset-password.mjs，然后按提示输入新密码。')
  process.exit(0)
}
if (process.argv.length > 2 || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('请在交互终端执行 node tools/reset-password.mjs，不要把密码写进命令参数。')
  process.exit(1)
}

const directory = path.resolve(process.env.M7A_STATE_DIR || fileURLToPath(new URL('../.state/', import.meta.url)))
let hidden = false
const output = new Writable({
  write(chunk, encoding, done) {
    if (!hidden) process.stdout.write(chunk, encoding)
    done()
  },
})
output.isTTY = true
output.columns = process.stdout.columns
const reader = readline.createInterface({ input: process.stdin, output, terminal: true })
let closed = false
reader.on('close', () => { closed = true })
reader.on('SIGINT', () => reader.close())
function question(prompt, secret = false) {
  if (closed) return Promise.reject(new Error('操作已取消'))
  process.stdout.write(prompt)
  hidden = secret
  return new Promise((resolve, reject) => {
    const onClose = () => { hidden = false; process.stdout.write('\n'); reject(new Error('操作已取消')) }
    reader.once('close', onClose)
    reader.question('', answer => {
      reader.removeListener('close', onClose)
      hidden = false
      if (secret) process.stdout.write('\n')
      resolve(answer)
    })
  })
}

try {
  const store = new AuthStore(directory)
  const before = store.read()
  console.log('重置将注销所有网页登录，不影响三月七运行实例。')
  const password = await question('新密码（8～128 个字符，输入不显示）：', true)
  validatePassword(password)
  const confirmation = await question('再次输入新密码：', true)
  if (password !== confirmation) throw new Error('两次新密码不一致，未修改密码')
  const answer = await question('确认重置网页密码？输入 y 确认：')
  if (answer.trim().toLowerCase() !== 'y') throw new Error('操作已取消，未修改密码')
  const result = await store.setPassword(password, before.revision)
  console.log('密码已重置，请使用新密码登录网页，无需重启服务。')
  if (!result.accessRemoved) console.error('初始密码领取文件未能清理，请检查文件权限。')
} catch (error) {
  if (error.code === 'ENOENT') console.error('未找到认证文件，请检查网页目录或 M7A_STATE_DIR。')
  else if (error.code) console.error(`重置未完成，请检查文件权限（${error.code}）。`)
  else console.error(error.message)
  process.exitCode = 1
} finally { reader.close() }
