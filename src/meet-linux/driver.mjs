import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundledChromiumPath, RUN_MARKER, SCREEN_TITLE } from '../browser.mjs'
import { guestColorHex } from '../fixtures.mjs'
import { MeetBridge } from '../meet-extension/bridge.mjs'
import { acquireDisplay } from './display.mjs'
import { prepareExtension } from '../meet-extension/extension.mjs'
import { launchProcess, stopProcess } from './process.mjs'

// A page-shaped driver, using only fixed extension commands. No Playwright or
// CDP connection is made to the Meet browser, even when collecting RTC stats.
export class LinuxGuestWindow {
  constructor() {
    this.closed = false
    this.closePromise = null
    this.child = null
    this.display = null
    this.bridge = null
    this.dir = null
    this.delayWaiters = new Set()
    this.failureReason = null
  }

  static async open(media, options, guest) {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux Meet currently requires Linux x86_64')
    if (options.browser && !['auto', 'chromium'].includes(options.browser)) {
      throw new Error('Linux Meet uses bundled Chrome for Testing — choose --browser auto or chromium')
    }
    const binary = bundledChromiumPath()
    if (!binary) throw new Error('Linux Meet needs the bundled browser — run npx playwright install chromium')
    const page = new LinuxGuestWindow()
    try {
      options.signal?.throwIfAborted()
      // A short path also keeps the Unix socket below Linux's 108-byte limit.
      page.dir = await mkdtemp(join(tmpdir(), 'call-bots-meet-'))
      page.display = await acquireDisplay(options.signal)
      options.signal?.throwIfAborted()
      const profile = join(page.dir, 'profile')
      await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 })
      const allow = { 'https://meet.google.com:443,*': { setting: 1 } }
      await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
        profile: { content_settings: { exceptions: { media_stream_camera: allow, media_stream_mic: allow } } },
      }))
      const socket = join(page.dir, 'driver.sock')
      const token = randomBytes(32).toString('hex')
      page.bridge = new MeetBridge(socket, token, options.readVolume)
      page.bridge.onDisconnect = (error) => page.fail(error)
      await page.bridge.listen()
      const extension = await prepareExtension(profile, socket, token, guest.label, guestColorHex(guest.n - 1))
      options.signal?.throwIfAborted()
      if (page.display.child.exitCode !== null || page.display.child.signalCode !== null) throw new Error('The virtual display stopped during browser setup')
      const args = [
        `--user-data-dir=${profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
        '--lang=en-US', '--no-first-run', '--no-default-browser-check', '--password-store=basic',
        '--mute-audio', '--autoplay-policy=no-user-gesture-required',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
        '--ozone-platform=x11', '--window-size=1920,1167', '--use-fake-device-for-media-stream',
        `--auto-select-tab-capture-source-by-title=${SCREEN_TITLE}`,
        ...(media && !options.noVideo ? [`--use-file-for-fake-video-capture=${media.video}`] : []),
        ...(media && !options.noAudio ? [`--use-file-for-fake-audio-capture=${media.audio}`] : []),
        `${RUN_MARKER}=${options.runId}`, 'about:blank',
      ]
      const logFile = join(options.runDir || page.dir, `${guest.slug}-chrome.log`)
      page.child = launchProcess(binary, args, { log: logFile, env: { ...process.env, ...page.display.env } })
      page.display.child.once('exit', page.displayGone = () => page.fail(new Error('The Meet virtual display stopped')))
      page.child.once('exit', () => {
        const error = new Error('Meet Chrome exited — check this bot\'s browser log')
        page.bridge.close(error)
        page.fail(error)
      })
      page.child.once('error', (error) => { page.bridge.close(error); page.fail(error) })
      const aborted = () => { page.close().catch(() => {}) }
      options.signal?.addEventListener('abort', aborted, { once: true })
      page.removeAbortListener = () => options.signal?.removeEventListener('abort', aborted)
      if (options.signal?.aborted) aborted()
      let timer
      try {
        await Promise.race([
          page.bridge.ready,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Meet browser extension did not connect within 30 seconds')), 30000) }),
        ])
      } catch (error) {
        const detail = (await readFile(logFile, 'utf8').catch(() => '')).slice(-3000)
        throw new Error(`${error.message}${detail ? `\n${detail}` : ''}`)
      } finally { clearTimeout(timer) }
      if (page.closed) throw new Error('Meet browser closed while starting')
      return page
    } catch (error) {
      await page.close()
      throw error
    }
  }

  get audioControlReady() { return this.bridge?.audioReady === true }
  setVolume(setting) { return this.bridge.request('volume', setting) }
  audioState() { return this.bridge.request('audio-state') }

  meetCommand(command, input = {}) { return this.bridge.request('page', { command, input }) }
  url() { return this.bridge.request('url') }
  isClosed() { return this.closed }

  fail(error) {
    if (this.closed) return
    this.failureReason = error.message
    this.close().catch(() => {})
  }

  async goto(url) {
    const before = await this.meetCommand('report').catch(() => null)
    await this.bridge.request('goto', { url })
    const deadline = Date.now() + 45000
    while (!this.closed && Date.now() < deadline) {
      const report = await this.meetCommand('report').catch(() => null)
      if (report && report.documentStartedAt !== before?.documentStartedAt &&
          new URL(report.url).origin === new URL(url).origin && ['interactive', 'complete'].includes(report.readyState)) {
        await this.bridge.request('size')
        let sized
        for (let attempt = 0; attempt < 10 && !this.closed; attempt += 1) {
          sized = await this.meetCommand('report')
          if (sized.viewport.width === 1920 && sized.viewport.height === 1080) return
          await this.waitForTimeout(100)
        }
        if (!sized) throw new Error('Meet closed while sizing its window')
        if (sized.viewport.width !== 1920 || sized.viewport.height !== 1080) {
          throw new Error(`Meet viewport is ${sized.viewport.width}×${sized.viewport.height}; expected 1920×1080`)
        }
        return
      }
      await this.waitForTimeout(250)
    }
    throw new Error(this.closed ? 'Meet browser closed while navigating' : `Meet page did not load (${await this.url().catch(() => 'no browser')})`)
  }

  waitForTimeout(ms) {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.delayWaiters.delete(finish); resolve() }
      const timer = setTimeout(finish, ms)
      this.delayWaiters.add(finish)
    })
  }

  async prepareScene() {
    const tab = await this.bridge.request('scene')
    // Size only after the extension page has committed, retrying actual reads.
    let failure
    for (let attempt = 0; attempt < 40 && !this.closed; attempt += 1) {
      try { await this.bridge.request('size-scene'); return tab }
      catch (error) { failure = error.message; await this.waitForTimeout(100) }
    }
    throw new Error(`The shared scene did not open${failure ? `: ${failure}` : ''}`)
  }
  rtcSummary() { return this.meetCommand('rtc-summary') }
  rtcSnapshot() { return this.meetCommand('rtc-snapshot') }
  async report() {
    const report = await this.meetCommand('report').catch(async (error) => ({ url: await this.url().catch(() => ''), error: error.message }))
    report.audio = await this.audioState().catch((error) => ({ error: error.message }))
    return JSON.stringify(report, null, 2)
  }
  async screenshot() {
    const image = await this.meetCommand('thumbnail')
    return typeof image === 'string' && image.startsWith('data:image/jpeg;base64,')
      ? Buffer.from(image.split(',')[1], 'base64') : null
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.removeAbortListener?.()
    for (const finish of [...this.delayWaiters]) finish()
    this.bridge?.close()
    this.closePromise = (async () => {
      await stopProcess(this.child)
      if (this.display) {
        if (this.displayGone) this.display.child.removeListener('exit', this.displayGone)
        await this.display.release()
      }
      if (this.dir) await rm(this.dir, { recursive: true, force: true })
    })()
    return this.closePromise
  }
}
