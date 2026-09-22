import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchProcess, stopProcess } from './process.mjs'

const run = promisify(execFile)
export const executableOnPath = (name) => {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const path = join(dir, name)
    try { accessSync(path, constants.X_OK); return path } catch {}
  }
  return null
}
let current = null
let references = 0

async function createDisplay() {
  const binary = executableOnPath('Xvfb')
  const xauth = executableOnPath('xauth')
  if (!binary || !xauth) throw new Error('Linux Meet needs Xvfb and xauth — use the supplied Linux container')
  const dir = await mkdtemp(join(tmpdir(), 'call-bots-x11-'))
  const auth = join(dir, 'authority')
  let child
  try {
    await writeFile(auth, '', { mode: 0o600 })
    const cookie = randomBytes(16).toString('hex')
    await run(xauth, ['-f', auth, 'add', ':0', '.', cookie], { timeout: 5000 })
    // The server display number is allocated atomically by Xvfb (-displayfd).
    // Leave room for Chrome's tab-capture infobar above a 1080px page.
    child = launchProcess(binary, ['-displayfd', '3', '-screen', '0', '1920x1440x24', '-nolisten', 'tcp', '-auth', auth], {
      log: join(dir, 'xvfb.log'), extraPipe: true,
    })
    const display = await new Promise((resolve, reject) => {
      let value = ''
      const timer = setTimeout(() => reject(new Error('Xvfb did not start in time')), 15000)
      const fail = (error) => { clearTimeout(timer); reject(error) }
      child.once('error', fail)
      child.once('exit', () => fail(new Error('Xvfb exited before opening a display')))
      child.stdio[3].on('data', (chunk) => {
        value += chunk
        if (!value.includes('\n')) return
        clearTimeout(timer)
        const number = value.trim()
        if (!/^\d+$/u.test(number)) reject(new Error('Xvfb returned an invalid display'))
        else resolve(`:${number}`)
      })
    })
    await run(xauth, ['-f', auth, 'add', display, '.', cookie], { timeout: 5000 })
    return { child, dir, env: { DISPLAY: display, XAUTHORITY: auth } }
  } catch (error) {
    await stopProcess(child)
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function acquireDisplay(signal) {
  signal?.throwIfAborted()
  references += 1
  const pending = current ??= createDisplay()
  let released = false
  const release = async () => {
    if (released) return
    released = true
    references -= 1
    if (references || current !== pending) return
    current = null
    const display = await pending.catch(() => null)
    if (!display) return
    await stopProcess(display.child)
    await rm(display.dir, { recursive: true, force: true })
  }
  let abort
  try {
    const display = await Promise.race([
      pending,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Meet startup was cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      }),
    ])
    if (display.child.exitCode !== null || display.child.signalCode !== null) throw new Error('The bot virtual display stopped')
    return { ...display, release }
  } catch (error) {
    // The last cancelled waiter arranges cleanup when Xvfb finishes opening;
    // it must not keep a lobby Stop waiting on the display startup deadline.
    release().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
