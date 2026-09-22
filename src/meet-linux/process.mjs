import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'

const children = new Set()
const signal = (child, value) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, value) } catch {}
}
process.once('exit', () => { for (const child of children) signal(child, 'SIGKILL') })

export function launchProcess(binary, args, { env = process.env, log, extraPipe = false } = {}) {
  const fd = log ? openSync(log, 'a', 0o600) : null
  let child
  try {
    child = spawn(binary, args, {
      env, detached: true,
      stdio: ['ignore', 'ignore', fd ?? 'ignore', ...(extraPipe ? ['pipe'] : [])],
    })
  } finally { if (fd !== null) closeSync(fd) }
  children.add(child)
  // Attach an error handler immediately; the caller can also await 'spawn'.
  child.on('error', () => children.delete(child))
  child.once('exit', () => {
    // Even an exited browser leader can leave helper processes in its group.
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    children.delete(child)
  })
  return child
}

export function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); resolve() }
    child.once('exit', finish)
    child.once('error', finish)
    const timer = setTimeout(() => { signal(child, 'SIGKILL'); resolve() }, 3000)
    signal(child, 'SIGTERM')
  })
}
