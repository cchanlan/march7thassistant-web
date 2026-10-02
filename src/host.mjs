// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cchanlan
// Distributed under GNU GPL version 3 only, WITHOUT ANY WARRANTY. See LICENSE.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const containerMode = process.env.M7A_CONTAINER === '1';
const uidText = process.env.M7A_HOST_UID ?? '0';
if (containerMode && (!/^(0|[1-9]\d*)$/.test(uidText) || !Number.isSafeInteger(Number(uidText)) || Number(uidText) >= 0xffffffff)) {
  throw new Error('M7A_HOST_UID must be an unsigned Linux UID');
}
export const hostUid = containerMode ? Number(uidText) : process.getuid();
const FILE_LIMIT = 4 * 1024 * 1024;
const CONFIG_LIMIT = 1024 * 1024;
const WIRE_LIMIT = 16 * 1024 * 1024;
const MAX_PENDING = 64;
const MAX_ACTIVE = 8;
const O_PATH = 0x200000; // Linux-only application; Node does not expose O_PATH.
const types = { isFile: 0x8000, isDirectory: 0x4000, isSymbolicLink: 0xa000, isBlockDevice: 0x6000, isCharacterDevice: 0x2000, isFIFO: 0x1000, isSocket: 0xc000 };
let bridge = null;
let initializing = null;
let sequence = 0;
let scope = null;
let authorized = false;
let unsafeToStart = false;
let closing = false;
const pending = new Map();
const queue = [];

function failure(code, message, unsafe = false) {
  const error = new Error(message);
  error.code = code;
  if (unsafe) error.unsafeToStart = true;
  return error;
}
function hostPath(value) {
  const text = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof text !== 'string' || !path.isAbsolute(text) || text.includes('\0') || Buffer.byteLength(text) >= 4096) throw failure('EINVAL', 'Invalid host path');
  return text;
}
function limitValue(limit, max = FILE_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > max) throw failure('EINVAL', 'Invalid host read limit');
  return limit;
}
function safeStat(raw, bigint = false) {
  const stat = {};
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks']) {
    if (typeof raw?.[key] !== 'string' || !/^-?\d+$/.test(raw[key])) throw failure('EPROTO', 'Invalid host stat');
    stat[key] = bigint ? BigInt(raw[key]) : Number(raw[key]);
  }
  for (const name of ['atime', 'mtime', 'ctime', 'birthtime']) {
    if (typeof raw?.[`${name}Ns`] !== 'string' || !/^-?\d+$/.test(raw[`${name}Ns`])) throw failure('EPROTO', 'Invalid host timestamp');
    const ns = BigInt(raw[`${name}Ns`]);
    if (bigint) stat[`${name}Ns`] = ns;
    stat[`${name}Ms`] = bigint ? ns / 1000000n : Number(ns) / 1e6;
    stat[name] = new Date(Number(ns / 1000000n));
  }
  for (const [name, mask] of Object.entries(types)) stat[name] = () => Number(stat.mode & (bigint ? 0xf000n : 0xf000)) === mask;
  return stat;
}
function dirent(raw, parent, encoding = 'utf8') {
  const entry = { name: encoding === 'buffer' ? Buffer.from(raw.name) : Buffer.from(raw.name).toString(encoding), parentPath: parent, path: parent };
  for (const [name, mask] of Object.entries(types)) entry[name] = () => raw.type === mask;
  return entry;
}
function checkedBase64(text, limit) {
  if (typeof text !== 'string' || text.length % 4 || text.length > Math.ceil(limit / 3) * 4 || /[^A-Za-z0-9+/=]/.test(text)) throw failure('EPROTO', 'Invalid host response');
  const data = Buffer.from(text, 'base64');
  if (data.length > limit || data.toString('base64') !== text) throw failure('EPROTO', 'Invalid host response');
  return data;
}
function validScope(value) {
  return typeof value?.namespaces?.mount === 'string' && /^mnt:\[\d+\]$/.test(value.namespaces.mount)
    && typeof value?.namespaces?.pid === 'string' && /^pid:\[\d+\]$/.test(value.namespaces.pid)
    && ['dev', 'ino'].every(key => typeof value?.rootIdentity?.[key] === 'string' && /^\d+$/.test(value.rootIdentity[key]));
}
function sameScope(a, b) {
  return validScope(a) && validScope(b) && a.namespaces.mount === b.namespaces.mount && a.namespaces.pid === b.namespaces.pid
    && a.rootIdentity.dev === b.rootIdentity.dev && a.rootIdentity.ino === b.rootIdentity.ino;
}
function copyScope(value) { return { namespaces: { ...value.namespaces }, rootIdentity: { ...value.rootIdentity } }; }
function sameFile(a, b) { return String(a?.dev) === String(b?.dev) && String(a?.ino) === String(b?.ino); }

function disconnect(instance, code = 'EHOSTDOWN') {
  if (bridge !== instance) return;
  bridge = null; scope = null; authorized = false;
  clearTimeout(instance.handshakeTimer);
  instance.rejectHandshake?.(failure(code, 'Host bridge unavailable'));
  instance.rejectHandshake = null;
  if ([...pending.values()].some(request => request.writing)) unsafeToStart = true;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(failure(code, 'Host bridge disconnected', request.writing || unsafeToStart));
  }
  pending.clear(); queue.length = 0;
  instance.child.stdin.destroy(); instance.child.stdout.destroy();
  // EOF is the normal close; SIGTERM also triggers the bridge's worker-group cleanup.
  instance.child.kill('SIGTERM');
  const force = setTimeout(() => instance.child.kill('SIGKILL'), 1000);
  force.unref();
  instance.child.once('exit', () => clearTimeout(force));
}
function dispatch(instance) {
  if (bridge !== instance || !instance.ready || instance.backpressure) return;
  while (queue.length && instance.active < MAX_ACTIVE) {
    const request = queue.shift();
    if (!pending.has(request.id)) continue;
    instance.active++;
    request.sent = true;
    try {
      instance.backpressure = !instance.child.stdin.write(request.line, 'utf8');
      request.line = null;
      if (instance.backpressure) return;
    } catch { disconnect(instance); return; }
  }
}
function consume(instance, chunk) {
  if (bridge !== instance) return;
  instance.buffer = instance.buffer.length ? Buffer.concat([instance.buffer, chunk]) : chunk;
  while (bridge === instance) {
    const end = instance.buffer.indexOf(10);
    if (end < 0) {
      if (instance.buffer.length > WIRE_LIMIT) disconnect(instance, 'EPROTO');
      return;
    }
    if (end > WIRE_LIMIT) { disconnect(instance, 'EPROTO'); return; }
    let message;
    try { message = JSON.parse(instance.buffer.subarray(0, end).toString('utf8')); } catch { disconnect(instance, 'EPROTO'); return; }
    instance.buffer = instance.buffer.subarray(end + 1);
    if (!instance.ready) {
      const hello = message?.result;
      if (message?.id !== 0 || message.error || hello?.version !== 1 || hello.pid !== process.pid || hello.startTime !== instance.startTime || !validScope(hello.scope)
        || hello.scope.namespaces.pid !== instance.selfScope.namespaces.pid || hello.scope.namespaces.mount === instance.selfScope.namespaces.mount
        || sameFile(hello.scope.rootIdentity, instance.selfScope.rootIdentity)) { disconnect(instance, 'EAUTH'); return; }
      clearTimeout(instance.handshakeTimer);
      scope = copyScope(hello.scope); instance.ready = true;
      instance.resolveHandshake(copyScope(scope)); instance.rejectHandshake = null;
      dispatch(instance); continue;
    }
    if (!Number.isSafeInteger(message?.id)) { disconnect(instance, 'EPROTO'); return; }
    const request = pending.get(message.id);
    if (!request || !request.sent || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) { disconnect(instance, 'EPROTO'); return; }
    pending.delete(message.id); instance.active--; clearTimeout(request.timer);
    if (message.error) {
      if (request.writing || message.error.unsafeToStart) unsafeToStart = true;
      const error = failure(typeof message.error.code === 'string' ? message.error.code : 'EIO', 'Host operation failed', request.writing || message.error.unsafeToStart);
      if (message.error.rollbackFailed) error.rollbackFailed = true;
      request.reject(error);
    } else request.resolve(message.result);
    dispatch(instance);
  }
}
async function localStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw failure('EINVAL', 'Invalid process identity');
  const text = (await localRead(`/proc/${pid}/stat`, 8192)).toString('utf8');
  const close = text.lastIndexOf(')');
  const fields = close >= 0 ? text.slice(close + 2).trim().split(/\s+/) : [];
  if (fields.length < 20 || ['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(fields[19])) throw failure('ESTALE', 'Process identity changed');
  return fields[19];
}
async function localScope() {
  const [mount, pid, root] = await Promise.all([fsp.readlink('/proc/self/ns/mnt'), fsp.readlink('/proc/self/ns/pid'), fsp.stat('/', { bigint: true })]);
  return { namespaces: { mount, pid }, rootIdentity: { dev: String(root.dev), ino: String(root.ino) } };
}
export async function initializeHost() {
  if (!containerMode) return localScope();
  if (bridge?.ready) return copyScope(scope);
  if (initializing) return initializing;
  if (closing) throw failure('EHOSTDOWN', 'Host bridge is closing');
  initializing = (async () => {
    const [startTime, selfScope] = await Promise.all([localStart(process.pid), localScope()]);
    // Node stays in the image and observes the shared host PID namespace.
    // Fail rather than treating an unreadable /proc as an empty host.
    await Promise.all([localRead('/proc/1/stat', 8192), fsp.readlink('/proc/1/ns/mnt'), fsp.readlink('/proc/1/ns/pid'), fsp.stat('/proc/1/root', { bigint: true }), fsp.access('/proc/net/unix', fs.constants.R_OK)]);
    const binary = process.env.M7A_HOST_BRIDGE || fileURLToPath(new URL('../tools/host-bridge/m7a-host-bridge', import.meta.url));
    if (!path.isAbsolute(binary) || binary.includes('\0')) throw failure('EINVAL', 'Invalid host bridge binary');
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, windowsHide: true });
    const instance = { child, startTime, selfScope, buffer: Buffer.alloc(0), ready: false, active: 0, backpressure: false };
    bridge = instance; authorized = false;
    const handshake = new Promise((resolve, reject) => { instance.resolveHandshake = resolve; instance.rejectHandshake = reject; });
    instance.handshakeTimer = setTimeout(() => disconnect(instance, 'ETIMEDOUT'), 5000);
    child.stdout.on('data', chunk => consume(instance, chunk));
    child.stdout.on('error', () => disconnect(instance));
    child.stdin.on('error', () => disconnect(instance));
    child.stdin.on('drain', () => { instance.backpressure = false; dispatch(instance); });
    child.on('error', () => disconnect(instance));
    child.on('exit', () => disconnect(instance));
    return handshake;
  })();
  try { return await initializing; } finally { initializing = null; }
}
async function request(op, params = {}, timeout = 9000, writing = false) {
  await initializeHost();
  const instance = bridge;
  if (!instance?.ready || closing) throw failure('EHOSTDOWN', 'Host bridge unavailable', writing);
  if (pending.size >= MAX_PENDING) throw failure('EBUSY', 'Host request queue is full', writing);
  if (++sequence >= Number.MAX_SAFE_INTEGER) sequence = 1;
  const id = sequence;
  const line = `${JSON.stringify({ id, op, params })}\n`;
  if (Buffer.byteLength(line) > WIRE_LIMIT) throw failure('EFBIG', 'Host request limit', writing);
  return new Promise((resolve, reject) => {
    const entry = { id, line, resolve, reject, writing, sent: false };
    entry.timer = setTimeout(() => disconnect(instance, 'ETIMEDOUT'), timeout);
    pending.set(id, entry); queue.push(entry); dispatch(instance);
  });
}
export async function closeHost() {
  closing = true;
  try {
    if (initializing) { try { await initializing; } catch {} }
    const instance = bridge;
    if (!instance) return;
    const exited = new Promise(resolve => {
      if (instance.child.exitCode !== null || instance.child.signalCode !== null) return resolve();
      instance.child.once('exit', resolve);
      const timer = setTimeout(resolve, 1500); timer.unref();
    });
    disconnect(instance); await exited;
  } finally { closing = false; }
}
export async function getHostScope() { return initializeHost(); }
export async function authorizeHost(identity) {
  const current = await initializeHost();
  if (!identity || identity.pid !== process.pid || identity.startTime !== await localStart(process.pid) || !sameScope(identity.scope, current)) {
    authorized = false; throw failure('EAUTH', 'Host authorization rejected');
  }
  if (containerMode) {
    await request('authorize', { pid: identity.pid, startTime: identity.startTime, scope: identity.scope });
    authorized = true;
  }
  return copyScope(current);
}
export function canControlHost() {
  return !containerMode || Boolean(bridge?.ready && authorized && !unsafeToStart);
}
function requireControl() {
  if (unsafeToStart) throw failure('EUNSAFE', 'Host mutations are locked', true);
  if (containerMode && (!bridge?.ready || !authorized)) throw failure('EAUTH', 'Host is not authorized');
}
const remoteFS = {
  realpath: async (file, options) => {
    const result = await request('realpath', { path: hostPath(file) });
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding === 'buffer' ? Buffer.from(result) : encoding ? Buffer.from(result).toString(encoding) : result;
  },
  stat: async (file, options) => {
    try { return safeStat(await request('stat', { path: hostPath(file) }), options?.bigint === true); }
    catch (error) { if (options?.throwIfNoEntry === false && error.code === 'ENOENT') return undefined; throw error; }
  },
  lstat: async (file, options) => {
    try { return safeStat(await request('lstat', { path: hostPath(file) }), options?.bigint === true); }
    catch (error) { if (options?.throwIfNoEntry === false && error.code === 'ENOENT') return undefined; throw error; }
  },
  readlink: async (file, options) => {
    const result = await request('readlink', { path: hostPath(file) });
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding === 'buffer' ? Buffer.from(result) : encoding ? Buffer.from(result).toString(encoding) : result;
  },
  access: async (file, mode = fs.constants.F_OK) => { await request('access', { path: hostPath(file), mode }); },
  readdir: async (file, options) => {
    if (options?.recursive) throw failure('ENOTSUP', 'Recursive host readdir is not supported');
    const parent = hostPath(file), items = await request('readdir', { path: parent });
    const encoding = (typeof options === 'string' ? options : options?.encoding) || 'utf8';
    if (!Array.isArray(items)) throw failure('EPROTO', 'Invalid host directory response');
    return items.map(item => options?.withFileTypes ? dirent(item, parent, encoding) : encoding === 'buffer' ? Buffer.from(item.name) : Buffer.from(item.name).toString(encoding));
  },
  opendir: async (file, options) => {
    const entries = await remoteFS.readdir(file, { ...options, withFileTypes: true });
    let index = 0, closed = false;
    const directory = {
      path: hostPath(file),
      async read() { if (closed) throw failure('ERR_DIR_CLOSED', 'Directory is closed'); return entries[index++] ?? null; },
      async close() { if (closed) throw failure('ERR_DIR_CLOSED', 'Directory is closed'); closed = true; entries.length = 0; },
      async *[Symbol.asyncIterator]() { try { let item; while ((item = await directory.read())) yield item; } finally { if (!closed) await directory.close(); } },
    };
    return directory;
  },
};
export const hostFS = containerMode ? Object.freeze(remoteFS) : fsp;
async function openRegular(file, flags) {
  const anchor = await fsp.open(file, O_PATH | fs.constants.O_NOFOLLOW);
  let handle;
  try {
    const pinned = await anchor.stat({ bigint: true });
    if (!pinned.isFile()) throw failure('EINVAL', 'Expected a regular file');
    handle = await fsp.open(`/proc/self/fd/${anchor.fd}`, flags | fs.constants.O_NONBLOCK);
    if (!sameFile(pinned, await handle.stat({ bigint: true }))) throw failure('ESTALE', 'File identity changed');
    return handle;
  } catch (error) { if (handle) await handle.close(); throw error; }
  finally { await anchor.close(); }
}
async function localRead(file, limit) {
  const handle = await openRegular(await fsp.realpath(file), fs.constants.O_RDONLY);
  try { return await readHandle(handle, limit); }
  finally { await handle.close(); }
}
async function readHandle(handle, limit) {
  const buffer = Buffer.alloc(limit + 1); let offset = 0;
  while (offset <= limit) {
    const { bytesRead } = await handle.read(buffer, offset, limit + 1 - offset, offset);
    if (!bytesRead) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  throw failure('EFBIG', 'Host file exceeds size limit');
}
export async function readHostFile(file, limit = FILE_LIMIT) {
  const name = hostPath(file); limitValue(limit);
  if (!containerMode) return (await localRead(name, limit)).toString('utf8');
  return checkedBase64((await request('readFile', { path: name, limit })).data, limit).toString('utf8');
}
export async function hostFileIdentity(file) {
  const name = hostPath(file);
  if (containerMode) return request('fileIdentity', { path: name });
  const actual = await fsp.realpath(name);
  const handle = await fsp.open(actual, O_PATH | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw failure('EINVAL', 'Expected a regular file');
    if (!sameFile(stat, await fsp.stat(actual, { bigint: true }))) throw failure('ESTALE', 'File identity changed');
    return { actual, dev: String(stat.dev), ino: String(stat.ino) };
  } finally { await handle.close(); }
}
export async function readHostConfig(file) {
  const name = hostPath(file);
  if (containerMode) {
    const raw = await request('readConfig', { path: name });
    return { text: checkedBase64(raw.data, CONFIG_LIMIT).toString('utf8'), actual: raw.actual, stat: safeStat(raw.stat), identity: raw.identity };
  }
  const actual = await fsp.realpath(name);
  const handle = await openRegular(actual, fs.constants.O_RDONLY);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw failure('EINVAL', 'Expected a regular configuration');
    const text = (await readHandle(handle, CONFIG_LIMIT)).toString('utf8');
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, await fsp.stat(actual, { bigint: true })) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw failure('ESTALE', 'Configuration changed');
    return { text, actual, stat: await handle.stat(), identity: { actual, dev: String(after.dev), ino: String(after.ino) } };
  } finally { await handle.close(); }
}
async function writeFully(handle, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
    if (!bytesWritten) throw failure('EIO', 'Configuration write failed');
    offset += bytesWritten;
  }
  await handle.truncate(data.length); await handle.sync();
}
const localWrites = new Set();
export async function writeHostConfig(file, original, next, expectedPath, expectedIdentity) {
  let handle, old, touched = false, lock;
  try {
    const name = hostPath(file), expected = hostPath(expectedPath);
    if (typeof original !== 'string' || typeof next !== 'string' || Buffer.byteLength(original) > CONFIG_LIMIT || Buffer.byteLength(next) > CONFIG_LIMIT || !expectedIdentity || !/^\d+$/.test(String(expectedIdentity.dev)) || !/^\d+$/.test(String(expectedIdentity.ino))) throw failure('EINVAL', 'Invalid configuration write');
    requireControl();
    if (containerMode) {
      await request('writeConfig', { path: name, original: Buffer.from(original).toString('base64'), next: Buffer.from(next).toString('base64'), expectedPath: expected, expectedIdentity: { dev: String(expectedIdentity.dev), ino: String(expectedIdentity.ino) } }, 10000, true);
      return;
    }
    const actual = await fsp.realpath(name);
    if (actual !== expected) throw failure('ESTALE', 'Configuration path changed');
    lock = `${expectedIdentity.dev}:${expectedIdentity.ino}`;
    if (localWrites.has(lock)) { lock = null; throw failure('EBUSY', 'Configuration is already being written'); }
    localWrites.add(lock);
    handle = await openRegular(actual, fs.constants.O_RDWR);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(opened, expectedIdentity)) throw failure('ESTALE', 'Configuration identity changed');
    old = await readHandle(handle, CONFIG_LIMIT);
    if (!old.equals(Buffer.from(original)) || await fsp.realpath(name) !== actual || !sameFile(opened, await fsp.lstat(actual, { bigint: true }))) throw failure('ESTALE', 'Configuration changed');
    touched = true; await writeFully(handle, Buffer.from(next));
    if (await fsp.realpath(name) !== actual || !sameFile(opened, await fsp.lstat(actual, { bigint: true }))) throw failure('ESTALE', 'Configuration identity changed');
  } catch (cause) {
    unsafeToStart = true;
    let rollbackFailed = false;
    if (touched && handle && old) { try { await writeFully(handle, old); } catch { rollbackFailed = true; } }
    const error = failure(cause?.code || 'EIO', 'Configuration write failed', true);
    if (rollbackFailed || cause?.rollbackFailed) error.rollbackFailed = true;
    throw error;
  } finally {
    let closeFailed = false;
    if (handle) { try { await handle.close(); } catch { unsafeToStart = true; closeFailed = true; } }
    if (lock) localWrites.delete(lock);
    if (closeFailed) throw failure('EIO', 'Configuration close failed', true);
  }
}

// Resolve each component through held directory fds. A symlink with an absolute
// target restarts at the process root; '..' never escapes it. No string prefix
// substitution through /proc/PID/root (which misinterprets absolute symlinks).
async function resolveProcessFile(root, file) {
  const handles = [root], components = [], todo = file.split('/');
  let links = 0;
  try {
    while (todo.length) {
      const component = todo.shift();
      if (!component || component === '.') continue;
      if (component === '..') {
        if (handles.length > 1) { await handles.pop().close(); components.pop(); }
        continue;
      }
      const parent = handles[handles.length - 1];
      const candidate = `/proc/self/fd/${parent.fd}/${component}`;
      const item = await fsp.open(candidate, O_PATH | fs.constants.O_NOFOLLOW);
      const stat = await item.stat({ bigint: true });
      if (stat.isSymbolicLink()) {
        try {
          if (++links > 40) throw failure('ELOOP', 'Too many symbolic links');
          const target = await fsp.readlink(candidate);
          if (!sameFile(stat, await fsp.lstat(candidate, { bigint: true }))) throw failure('ESTALE', 'Process file changed');
          if (target.startsWith('/')) {
            while (handles.length > 1) await handles.pop().close();
            components.length = 0;
          }
          todo.unshift(...target.split('/'));
          if (todo.length > 4096) throw failure('ELOOP', 'Symbolic link resolution limit');
        } finally { await item.close(); }
        continue;
      }
      if (todo.length) {
        if (!stat.isDirectory()) { await item.close(); throw failure('ENOTDIR', 'Expected a directory'); }
        handles.push(item); components.push(component);
      } else {
        try {
          if (!stat.isFile()) throw failure('EINVAL', 'Expected a regular process file');
          return { actual: `/${[...components, component].join('/')}`, dev: String(stat.dev), ino: String(stat.ino) };
        } finally { await item.close(); }
      }
    }
    throw failure('EINVAL', 'Expected a regular process file');
  } finally {
    while (handles.length > 1) await handles.pop().close();
  }
}
export async function hostProcessFileIdentity(pid, file, expectedStartTime) {
  const name = hostPath(file);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || typeof expectedStartTime !== 'string' || !/^\d+$/.test(expectedStartTime)) throw failure('EINVAL', 'Invalid process identity');
  if (containerMode) return request('processFileIdentity', { pid, path: name, startTime: expectedStartTime });
  if (await localStart(pid) !== expectedStartTime) throw failure('ESTALE', 'Process identity changed');
  const root = await fsp.open(`/proc/${pid}/root`, O_PATH | fs.constants.O_DIRECTORY);
  try {
    const before = await root.stat({ bigint: true });
    const identity = await resolveProcessFile(root, name);
    if (await localStart(pid) !== expectedStartTime || !sameFile(before, await fsp.stat(`/proc/${pid}/root`, { bigint: true }))) throw failure('ESTALE', 'Process identity changed');
    return identity;
  } finally { await root.close(); }
}
function controlTimeout(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 19000) throw failure('EINVAL', 'Invalid host control timeout');
  return timeout;
}
export async function hostSystemctl(args, timeout = 3500, uid = null) {
  if (!containerMode) throw failure('ENOTSUP', 'Native systemctl must use the local command adapter');
  if (!Array.isArray(args) || args.length > 512 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw failure('EINVAL', 'Invalid systemctl arguments');
  controlTimeout(timeout);
  if (uid !== null && (!Number.isSafeInteger(uid) || uid < 0 || uid >= 0xffffffff)) throw failure('EINVAL', 'Invalid manager UID');
  const action = args.find(arg => ['start', 'stop'].includes(arg));
  if (action) requireControl();
  const result = await request('systemctl', { args, timeout, uid }, timeout + 1500);
  if (result.code !== 0 || result.signal) throw failure(result.timedOut ? 'ETIMEDOUT' : 'EIO', 'Host manager command failed');
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > FILE_LIMIT) throw failure('EPROTO', 'Invalid host manager response');
  return result.stdout;
}
function pm2Method(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > FILE_LIMIT || buffer[0] !== 0x12) throw failure('EINVAL', 'Invalid PM2 frame');
  let at = 1; const parts = [];
  for (let i = 0; i < 2; i++) {
    if (at + 4 > buffer.length) throw failure('EINVAL', 'Invalid PM2 frame');
    const size = buffer.readUInt32BE(at); at += 4;
    if (size < 2 || at + size > buffer.length) throw failure('EINVAL', 'Invalid PM2 frame');
    const text = buffer.subarray(at, at + size).toString('utf8'); at += size;
    try { parts.push(text.startsWith('j:') ? JSON.parse(text.slice(2)) : text.startsWith('s:') ? text.slice(2) : undefined); } catch { throw failure('EINVAL', 'Invalid PM2 frame'); }
  }
  const call = parts[0];
  if (at !== buffer.length || call?.type !== 'call' || !['getMonitorData', 'stopProcessId', 'startProcessId'].includes(call.method) || !Array.isArray(call.args) || call.args.length !== 1
    || typeof parts[1] !== 'string' || !parts[1] || parts[1].length > 256
    || (call.method === 'getMonitorData' ? !call.args[0] || typeof call.args[0] !== 'object' || Array.isArray(call.args[0]) || Object.keys(call.args[0]).length : !Number.isSafeInteger(call.args[0]) || call.args[0] < 0)) throw failure('EPERM', 'PM2 method rejected');
  return call.method;
}
function remaining(deadline) {
  const left = deadline - performance.now();
  if (left <= 0) throw failure('ETIMEDOUT', 'PM2 request timed out');
  return Math.max(1, Math.ceil(left));
}
async function withDeadline(action, deadline) {
  let timer;
  const delay = remaining(deadline);
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('ETIMEDOUT', 'PM2 request timed out')), delay); })]);
  } finally { clearTimeout(timer); }
}
async function verifyLocalDaemon(daemon, socket, deadline) {
  remaining(deadline);
  if (await localStart(daemon.pid) !== daemon.startTime) throw failure('ESTALE', 'PM2 process changed');
  remaining(deadline);
  const status = await readHostFile(`/proc/${daemon.pid}/status`, 65536);
  remaining(deadline);
  const uid = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
  if (!uid || Number(uid[1]) !== daemon.uid || Number(uid[2]) !== daemon.uid) throw failure('EPERM', 'PM2 owner mismatch');
  const network = await readHostFile('/proc/net/unix', FILE_LIMIT);
  remaining(deadline);
  const listener = network.split('\n').map(row => /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(.+)$/.exec(row.trim())).find(row => row?.[1] === daemon.socketInode);
  if (!listener || listener[2] !== socket) throw failure('ESTALE', 'PM2 socket changed');
  let owned = false, scanned = 0;
  remaining(deadline);
  const dir = await fsp.opendir(`/proc/${daemon.pid}/fd`);
  for await (const entry of dir) {
    remaining(deadline);
    if (++scanned > 16384) throw failure('EFBIG', 'PM2 descriptor scan limit');
    try { if (await fsp.readlink(`/proc/${daemon.pid}/fd/${entry.name}`) === `socket:[${daemon.socketInode}]`) { owned = true; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  remaining(deadline);
  if (!owned) throw failure('ESTALE', 'PM2 socket owner changed');
}
export async function hostPm2Request(daemon, buffer, timeout = 3500) {
  const method = pm2Method(buffer); controlTimeout(timeout);
  const deadline = performance.now() + timeout;
  if (method !== 'getMonitorData') requireControl();
  if (!daemon || daemon.state !== 'running' || !Number.isSafeInteger(daemon.pid) || daemon.pid <= 0 || !Number.isSafeInteger(daemon.uid) || daemon.uid < 0 || daemon.uid >= 0xffffffff || typeof daemon.startTime !== 'string' || !/^\d+$/.test(daemon.startTime) || typeof daemon.socketInode !== 'string' || !/^\d+$/.test(daemon.socketInode)) throw failure('EINVAL', 'Invalid PM2 daemon identity');
  hostPath(daemon.home);
  if (containerMode) {
    const result = await request('pm2', { daemon: { state: daemon.state, home: daemon.home, pid: daemon.pid, uid: daemon.uid, startTime: daemon.startTime, socketInode: daemon.socketInode }, buffer: buffer.toString('base64'), timeout }, timeout + 1500);
    return checkedBase64(result.buffer, FILE_LIMIT);
  }
  // Local Node has no SO_PEERCRED API. Preserve the native adapter's /proc
  // listener-inode + owning-pid/fd proof and recheck the canonical socket around
  // connect; container mode additionally enforces SO_PEERCRED in the C bridge.
  const { socketPath, before } = await withDeadline(async () => {
    const home = await fsp.realpath(daemon.home);
    remaining(deadline);
    const socketPath = path.join(home, 'rpc.sock');
    if (home !== daemon.home || await fsp.realpath(socketPath) !== socketPath) throw failure('ESTALE', 'PM2 socket path changed');
    remaining(deadline);
    const before = await fsp.lstat(socketPath, { bigint: true });
    if (!before.isSocket() || Number(before.uid) !== daemon.uid) throw failure('EPERM', 'PM2 socket owner mismatch');
    await verifyLocalDaemon(daemon, socketPath, deadline);
    return { socketPath, before };
  }, deadline);
  const socketBudget = remaining(deadline);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let parts = [], size = 0, settled = false, responseReceived = false;
    const timer = setTimeout(() => finish(failure('ETIMEDOUT', 'PM2 request timed out')), socketBudget);
    function finish(error, data) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(data); }
    socket.on('error', () => finish(failure('EIO', 'PM2 request failed')));
    socket.on('connect', async () => {
      try {
        if (!sameFile(before, await fsp.lstat(socketPath, { bigint: true }))) throw failure('ESTALE', 'PM2 socket changed');
        await verifyLocalDaemon(daemon, socketPath, deadline);
        if (!settled) socket.write(buffer);
      } catch (error) { finish(error); }
    });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > FILE_LIMIT) return finish(failure('EFBIG', 'PM2 response limit'));
      parts.push(chunk); const data = Buffer.concat(parts, size);
      if (!data.length || data[0] !== 0x12) return finish(failure('EPROTO', 'Invalid PM2 response'));
      let at = 1;
      for (let i = 0; i < 2; i++) {
        if (at + 4 > data.length) return;
        const n = data.readUInt32BE(at); at += 4;
        if (n > FILE_LIMIT || n < 2) return finish(failure('EPROTO', 'Invalid PM2 response'));
        if (at + n > data.length) return; at += n;
      }
      if (at !== data.length) return finish(failure('EPROTO', 'Invalid PM2 response'));
      responseReceived = true; socket.pause();
      (async () => {
        if (!sameFile(before, await fsp.lstat(socketPath, { bigint: true }))) throw failure('ESTALE', 'PM2 socket changed');
        await verifyLocalDaemon(daemon, socketPath, deadline); finish(null, data);
      })().catch(error => finish(error));
    });
    socket.on('end', () => { if (!settled && !responseReceived) finish(failure('EPROTO', 'Incomplete PM2 response')); });
  });
}
