import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledChromiumPath, meetReadiness, systemChromePath } from './browser.mjs'
import { setGuestVolumes, volumePercent } from './audio.mjs'
import { onLog, plain as log } from './log.mjs'
import { machineProfile, systemUsage } from './machine.mjs'
import { Roster } from './orchestrator.mjs'
import { platformById, resolveLink } from './platforms/index.mjs'

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html')

const THUMB_TTL_MS = 1500
const RTC_TTL_MS = 1200
const SNAPSHOT_MS = 2000
const VERIFY_EVERY = 3 // every Nth snapshot includes the deep check

// One dashboard drives one call at a time.
const session = {
  status: 'idle', // idle | joining | running | stopping
  roster: null,
  verify: null,
  startedAt: null,
  lastError: null,
}


const sseClients = new Set()
const thumbCache = new Map() // slug -> {at, buffer, inFlight}
const rtcCache = new Map() // slug -> {at, data, inFlight}

const broadcast = (message) => {
  const payload = `data: ${JSON.stringify(message)}\n\n`
  for (const client of sseClients) client.write(payload)
}

onLog((entry) => broadcast({ type: 'log', entry }))

// The .app has no npm; download Chromium through playwright's CLI with our own
// runtime when the machine has no usable browser.
let browserInstall = null
let browserProgress = null // e.g. "42% of 165.5 MiB"
const ensureBrowser = () => {
  // Chromium is what guests run (see browser.mjs), so fetch it even when the
  // machine has Chrome installed.
  if (bundledChromiumPath() || browserInstall) return
  // playwright's exports map hides ./cli.js, so derive it from the package entry
  let cliPath
  try {
    cliPath = join(dirname(createRequire(import.meta.url).resolve('playwright')), 'cli.js')
  } catch {
    cliPath = null
  }
  if (!cliPath || !existsSync(cliPath)) {
    log.warn('cannot find the browser installer — reinstall Call Bots')
    return
  }
  log.warn('downloading bundled Chrome for Testing (one-time)…')
  browserInstall = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // playwright draws a progress bar; keep only the percentage for the window
  const relay = (stream) =>
    stream.on('data', (chunk) => {
      const text = String(chunk)
      // playwright reports MiB; show MB, which is what people expect
      const percent = [...text.matchAll(/(\d{1,3})%\s+of\s+([\d.]+)\s*MiB/gu)].pop()
      if (percent) {
        const mb = Math.round(Number(percent[2]) * 1.048576)
        browserProgress = `${percent[1]}% of ${mb} MB`
        return
      }
      const line = text.trim().split('\n').pop()
      if (line && !line.includes('|')) log.info(`[chromium] ${line}`)
    })
  relay(browserInstall.stdout)
  relay(browserInstall.stderr)
  browserInstall.on('exit', (code) => {
    log[code === 0 ? 'info' : 'warn'](
      code === 0 ? 'Bundled browser ready' : 'Browser download failed — check your connection and reopen Call Bots',
    )
    browserInstall = null
    browserProgress = null
  })
}

// One snapshot serves every asker for a moment, and one in flight is shared:
// a state read costs a round trip per bot, and for Meet guests that round trip
// is an Apple Event through a channel that carries one at a time. Two
// dashboards, or one polling hard, must not multiply that work — three guests
// under a one-second poll had every probe timing out at once.
const STATE_TTL_MS = 700
let snapshotCache = null // { at, value }
let snapshotInFlight = null
// And when the probes are slow — a machine saturated by the bots it runs —
// the last snapshot is served at once while a fresh one is taken behind it,
// so the dashboard shows something a few seconds old rather than nothing at
// all. Only the very first read, with nothing to serve, waits.
const stateSnapshot = async ({ withVerify = false } = {}) => {
  const fresh = snapshotCache && Date.now() - snapshotCache.at < STATE_TTL_MS
  if (!withVerify && fresh) return snapshotCache.value
  if (!snapshotInFlight) {
    snapshotInFlight = computeSnapshot({ withVerify })
      .then((value) => {
        snapshotCache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        snapshotInFlight = null
      })
  }
  return snapshotCache ? snapshotCache.value : snapshotInFlight
}

const computeSnapshot = async ({ withVerify = false } = {}) => {
  const roster = session.roster
  let rosterState = null
  if (roster) {
    rosterState = await roster.statusData().catch(() => null)
    if (withVerify && session.status === 'running') {
      session.verify = await roster.verifyData().catch(() => session.verify)
    }
  }
  return {
    type: 'state',
    state: {
      status: session.status,
      startedAt: session.startedAt,
      lastError: session.lastError,
      machine: machineProfile(),
      system: await systemUsage(),
      browserReady: bundledChromiumPath() !== null || systemChromePath() !== null,
      browserInstalling: browserInstall !== null,
      browserProgress,
      meet: await meetReadiness(),
      session: rosterState,
      verify: session.verify,
    },
  }
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) reject(new Error('body too large'))
      else chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const botLabel = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ')
    .slice(0, 40)

// 'vp9' shapes only. A codec name is refused rather than cleaned: a typo that
// silently reset a preference to the default would read as the codec working.
const codecName = (value) => {
  if (value === undefined || value === null || value === '') return null
  const name = String(value).trim().toLowerCase()
  if (!/^[a-z0-9-]{2,16}$/u.test(name)) {
    throw new Error(`not a codec name: ${String(value).slice(0, 24)}`)
  }
  return name
}

// Send the first bots in. The link carries the platform, origin and call.
const startSession = async (body) => {
  if (session.status !== 'idle') throw new Error(`a session is already ${session.status}`)
  const target = resolveLink(body.link ?? '')
  if (target.platform === 'meet') {
    const readiness = await meetReadiness()
    if (!readiness.ready) throw new Error(readiness.reason)
  }
  // Readiness may load the Linux driver asynchronously. Another request can
  // have started a session while that check was awaiting its dependencies.
  if (session.status !== 'idle') throw new Error(`a session is already ${session.status}`)
  const count = Math.max(1, Math.min(50, Number(body.guests) || 1))

  const roster = new Roster({
    baseUrl: target.origin,
    headed: false,
    browser: 'auto',
    noVideo: Boolean(body.noVideo),
    noAudio: Boolean(body.noAudio),
    startCam: body.camera !== false,
    startMic: body.mic !== false,
    label: botLabel(body.label),
    audioCodec: codecName(body.audioCodec),
    videoCodec: codecName(body.videoCodec),
    screenCodec: codecName(body.screenCodec),
    size: '1920x1080',
    fps: 12,
  })
  session.roster = roster
  session.status = 'joining'
  session.startedAt = Date.now()
  session.lastError = null
  session.verify = null
  thumbCache.clear()
  rtcCache.clear()

  ;(async () => {
    // Stop can arrive while the batch is still joining. From that moment
    // stopSession owns the session state, and finishing up here anyway would
    // clobber it — a spurious "no bot reached the call" after a deliberate
    // stop, or the status flipped back to running with no roster left to stop.
    const stopped = () => session.roster !== roster || roster.tearingDown
    // The cleanup paths below tear the roster down themselves, which trips
    // tearingDown — after that, only identity says whether this continuation
    // still owns the session. Cleanup also holds status at 'stopping': going
    // idle first would invite a retry whose fresh session the mutations after
    // the await would then wipe.
    const owns = () => session.roster === roster
    try {
      const result = await roster.add(count, target)
      if (stopped()) return
      if (roster.inCall().length === 0) {
        session.status = 'stopping'
        // The roster cards disappear during cleanup, so preserve their actual
        // failure in the session toast. This is especially important on a new
        // Mac where the user may need to allow Automation once.
        session.lastError = roster.guests.find((guest) => guest.lastError)?.lastError ??
          'no bot reached the call'
        await roster.teardownAll().catch(() => {})
        if (!owns()) return
        session.status = 'idle'
        session.roster = null
      } else {
        session.status = 'running'
        if (result.failed) log.warn(`${result.failed} bot(s) failed to join`)
      }
    } catch (error) {
      if (stopped()) return
      log.error(error.message)
      session.status = 'stopping'
      session.lastError = error.message
      await roster.teardownAll().catch(() => {})
      if (!owns()) return
      session.status = 'idle'
      session.roster = null
    }
    broadcast(await stateSnapshot({ withVerify: true }))
  })()
}

const stopSession = async () => {
  const roster = session.roster
  if (!roster || session.status === 'stopping') return
  session.status = 'stopping'
  // Take ownership before the first await: teardownAll flags tearingDown
  // synchronously, which halts queued launches and stands down the join
  // continuation in startSession. Broadcasting first would leave a gap of
  // seconds in which both could still act on the session being stopped.
  const teardown = roster.teardownAll().catch((error) => log.warn(error.message))
  broadcast(await stateSnapshot())
  await teardown
  session.roster = null
  session.verify = null
  session.status = 'idle'
  broadcast(await stateSnapshot())
}

// Bots are sent in more than once, so "all" is not the only group there is:
// `batch:<n>` addresses one send — the bots that arrived together.
const batchTarget = (slug) => {
  const match = /^batch:(\d+)$/u.exec(String(slug ?? ''))
  return match ? Number(match[1]) : null
}

const runAction = async (slug, action, value) => {
  const roster = session.roster
  if (!roster || !['joining', 'running'].includes(session.status)) throw new Error('no running session')
  const platform = platformById(roster.target?.platform)
  const capabilities = platform?.capabilities
  const label = platform?.label ?? 'this platform'
  if (['share-on', 'share-off'].includes(action) && capabilities?.screen === false) {
    throw new Error(`screen sharing is unavailable for ${label}`)
  }
  if (action === 'codec' && capabilities?.codecs === false) {
    throw new Error(`codec controls are unavailable for ${label}`)
  }
  if (action === 'volume') {
    volumePercent(value)
    if (!capabilities?.volume) throw new Error(`volume controls are unavailable for ${label}`)
  }
  // Validated before the loop: half a fleet switched and then a 400 about the
  // other half would leave no way to tell what actually happened.
  const codecArgs =
    action === 'codec'
      ? { role: String(value?.role ?? ''), codec: codecName(value?.codec) }
      : null
  if (codecArgs && !['audio', 'video', 'screen'].includes(codecArgs.role)) {
    throw new Error('the codec action needs a role: audio, video or screen')
  }
  const batch = batchTarget(slug)
  // Removing a batch is one gesture, not one per bot: the roster closes them
  // together, and it owns the group while a batch still arriving is taken out.
  if (batch !== null && action === 'leave') {
    const removed = await roster.removeBatch(batch)
    if (removed.length === 0) throw new Error(`no bot for "${slug}"`)
    return Object.fromEntries(removed.map((label) => [label, 'removed']))
  }
  const targets =
    slug === 'all'
      ? roster.inCall()
      : batch !== null
        ? roster.byBatch(batch).filter((guest) => guest.state === 'in-call')
        : [roster.bySlug(slug)].filter(Boolean)
  if (targets.length === 0) throw new Error(`no bot for "${slug}"`)
  if (action === 'volume') return setGuestVolumes(targets, value)
  const results = {}
  for (const guest of targets) {
    switch (action) {
      case 'mute':
        results[guest.label] = await guest.setMic(false)
        break
      case 'unmute':
        results[guest.label] = await guest.setMic(true)
        break
      case 'share-on':
        results[guest.label] = await guest.setScreen(true)
        break
      case 'share-off':
        results[guest.label] = await guest.setScreen(false)
        break
      case 'cam-on':
        results[guest.label] = await guest.setCam(true)
        break
      case 'cam-off':
        results[guest.label] = await guest.setCam(false)
        break
      case 'codec':
        results[guest.label] = await guest.setCodec(codecArgs.role, codecArgs.codec)
        // The panel poll must not spend a cache window showing the old codec
        // right after the switch it reports on.
        rtcCache.delete(guest.user.slug)
        break
      case 'leave':
        await roster.remove(guest.user.slug)
        results[guest.label] = 'removed'
        break
      default:
        throw new Error(`unknown action "${action}"`)
    }
  }
  return results
}

const thumbnail = async (slug) => {
  const guest = session.roster?.bySlug(slug)
  if (!guest?.page || guest.state === 'closed') return null
  // A Meet guest has no Playwright page, but it does have a real window — it
  // photographs the screen where that window is instead.
  const shoot = guest.instrumented
    ? () => guest.page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 })
    : () => guest.page.screenshot?.() ?? Promise.resolve(null)
  const cached = thumbCache.get(slug)
  const now = Date.now()
  if (cached?.buffer && now - cached.at < THUMB_TTL_MS) return cached.buffer
  if (cached?.inFlight) return cached.inFlight
  const inFlight = Promise.race([
    shoot(),
    new Promise((resolve) => setTimeout(() => resolve(null), 9000)),
  ])
    .then((buffer) => {
      thumbCache.set(slug, { at: Date.now(), buffer, inFlight: null })
      return buffer
    })
    .catch(() => {
      thumbCache.set(slug, { at: Date.now(), buffer: null, inFlight: null })
      return null
    })
  thumbCache.set(slug, { at: cached?.at ?? 0, buffer: cached?.buffer ?? null, inFlight })
  return inFlight
}

// Full stream model for one bot's expanded monitor panel. Same guard, TTL
// cache and in-flight dedupe as thumbnail(): several dashboards polling the
// same bot cost one page read per TTL window.
const rtcData = async (slug) => {
  const guest = session.roster?.bySlug(slug)
  if (!guest?.page || guest.state !== 'in-call') return null
  const cached = rtcCache.get(slug)
  const now = Date.now()
  if (cached?.data && now - cached.at < RTC_TTL_MS) return cached.data
  if (cached?.inFlight) return cached.inFlight
  const inFlight = Promise.race([
    guest.rtcSnapshot(),
    new Promise((resolve) => setTimeout(() => resolve(null), 4500)),
  ])
    .then((data) => {
      rtcCache.set(slug, { at: Date.now(), data, inFlight: null })
      return data
    })
    .catch(() => {
      rtcCache.set(slug, { at: Date.now(), data: null, inFlight: null })
      return null
    })
  rtcCache.set(slug, { at: cached?.at ?? 0, data: cached?.data ?? null, inFlight })
  return inFlight
}

// Every mutating endpoint here does something a web page must never be able to
// trigger: Add account opens a real Chrome window, Remove deletes a saved
// session, Quit kills the app. None of them has ever asked who was calling, and
// the README tells people to forward this port over SSH.
//
// A cross-origin fetch carrying JSON is already stopped by the preflight this
// server does not answer; a plain <form> with enctype="text/plain" is not, and
// that is the hole. Browsers put an Origin on every cross-origin POST, so an
// Origin that is not local is a page, not the dashboard. No Origin at all means
// curl, the CLI or a test — those were never the risk.
const localCaller = (request) => {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    // Any local port, not just this one: a tunnel is free to forward 4610 to
    // whatever port it likes, and breaking that would be a worse bug.
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

export const startServer = async ({ port = 4610, open = true, host = process.env.CALL_BOTS_HOST || '127.0.0.1' }) => {
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('CALL_BOTS_HOST must be 127.0.0.1, ::1, or 0.0.0.0')
  let snapshots = 0

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    try {
      // Whatever a mutation does, the next read must see it.
      if (request.method !== 'GET') snapshotCache = null
      if (request.method !== 'GET' && !localCaller(request)) {
        json(response, 403, { ok: false, error: 'this dashboard only takes requests from itself' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(readFileSync(UI_PATH))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, (await stateSnapshot()).state)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        response.write('retry: 1500\n\n')
        sseClients.add(response)
        request.on('close', () => sseClients.delete(response))
        response.write(`data: ${JSON.stringify(await stateSnapshot({ withVerify: true }))}\n\n`)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/thumb/')) {
        const buffer = await thumbnail(decodeURIComponent(url.pathname.split('/').pop()))
        if (!buffer) {
          response.writeHead(204)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        response.end(buffer)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/rtc/')) {
        const data = await rtcData(decodeURIComponent(url.pathname.split('/').pop()))
        if (!data) {
          response.writeHead(204)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(data))
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/report/')) {
        const guest = session.roster?.bySlug(decodeURIComponent(url.pathname.split('/').pop()))
        if (!guest?.page?.report) throw new Error('Meet diagnostics are unavailable for this bot')
        const report = await guest.page.report()
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end(report)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/start') {
        await startSession(await readBody(request))
        json(response, 200, { ok: true })
        broadcast(await stateSnapshot())
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/add') {
        const body = await readBody(request)
        if (!session.roster || session.status !== 'running') {
          throw new Error('start a session first')
        }
        const count = Math.max(1, Math.min(50, Number(body.guests) || 1))
        // A request that says nothing about the label keeps the session's —
        // bots added to a call named "QA" should not arrive as "Bot 4". One
        // that sends a label, even an empty one, means it: the dashboard's
        // field is always sent, so clearing it still clears the name.
        const result = await session.roster.add(count, null, {
          startCam: body.camera !== false,
          startMic: body.mic !== false,
          ...(body.label === undefined ? {} : { label: botLabel(body.label) }),
          audioCodec: codecName(body.audioCodec),
          videoCodec: codecName(body.videoCodec),
          screenCodec: codecName(body.screenCodec),
        })
        broadcast(await stateSnapshot())
        json(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(request)
        const results = await runAction(body.slug, body.action, body.value)
        // removing the last guest ends the session, so the link can change
        if (session.roster && session.roster.guests.length === 0) {
          await stopSession()
        }
        broadcast(await stateSnapshot())
        json(response, 200, { ok: true, results })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/windows') {
        const body = await readBody(request)
        if (!(await meetReadiness()).windowsSupported) throw new Error('Bot windows are on a private virtual display on this server')
        if (!session.roster) throw new Error('no running session')
        const shown = await session.roster.setWindowsVisible(body.visible !== false)
        json(response, 200, { ok: true, windows: shown })
        broadcast(await stateSnapshot())
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        stopSession()
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/quit') {
        json(response, 200, { ok: true })
        log.info('quit requested')
        stopSession()
          .catch(() => {})
          .finally(() => process.exit(0))
        return
      }
      json(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(response, 400, { ok: false, error: error.message })
    }
  })

  setInterval(async () => {
    if (sseClients.size === 0) return
    snapshots += 1
    broadcast(await stateSnapshot({ withVerify: snapshots % VERIFY_EVERY === 0 }))
  }, SNAPSHOT_MS).unref()

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} is busy — Call Bots may already be running`)
          : error,
      )
    })
    server.listen(port, host, resolve)
  })
  const address = `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}`
  log.info(`ready at ${address}`)
  ensureBrowser()
  if (open) {
    const opener =
      process.platform === 'darwin'
        ? ['open', [address]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', address]]
          : ['xdg-open', [address]]
    execFile(opener[0], opener[1], () => {})
  }

  const shutdown = async () => {
    log.info('shutting down…')
    await stopSession().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Launched by the app: outlive it and the bots stay in the call with nobody
  // able to see or stop them, and the port stays taken, so the next launch of
  // the app finds the old server answering and quietly uses it — an update
  // would appear to do nothing. Ordinary quits are already handled; this is
  // for the crash and the kill, which no signal handler here would ever see.
  const supervisor = Number(process.env.CALL_BOTS_SUPERVISOR)
  if (Number.isInteger(supervisor) && supervisor > 1) {
    const watch = setInterval(() => {
      try {
        process.kill(supervisor, 0)
      } catch {
        clearInterval(watch)
        log.warn('the Call Bots window is gone — closing the bots and stopping')
        shutdown()
      }
    }, 2000)
    watch.unref()
  }
  return server
}
