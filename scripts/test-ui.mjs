// Drives the real dashboard (src/ui.html) against synthetic server states, so
// a refactor cannot quietly lose a control the user depends on. The server is
// stubbed at the network seam: EventSource is replaced before the page loads,
// states are pushed through it, and /api/* is routed to fixtures.
//
// The one rule this file exists to pin: the Stop button is visible whenever
// there is a session to stop — while joining as much as while running. One bot
// stuck in an admission lobby holds "joining" for up to ten minutes, and that
// must never leave the window with no way out.
//
// It also pins the grouping: bots are sent into the same call more than once,
// each send is its own batch, and one button takes a whole batch back out
// without touching the batches around it or the per-bot controls. And the
// pins on top of that: a bot lifted out of its batch into the section above
// keeps every control it had, and never becomes a bot the server hears about.
//
//   node scripts/test-ui.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { launchChannel } from '../src/browser.mjs'

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/ui.html'),
  'utf8',
)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// The exact shape stateSnapshot() broadcasts.
const state = (status, session = null, extra = {}) => ({
  status,
  startedAt: status === 'idle' ? null : 1,
  lastError: null,
  machine: { memGB: 16, cores: 8, recommendedMax: 6, platform: 'test' },
  system: {
    cpu: 34.2,
    mem: { total: 16 * 1024 ** 3, avail: 6 * 1024 ** 3 },
    net: { down: 2100, up: 4300 },
  },
  browserReady: true,
  browserInstalling: false,
  browserProgress: null,
  meet: { chromeReady: true, macOS: true },
  session,
  verify: null,
  ...extra,
})

// `sizes` splits the same bots across sends, the way the server reports them
// after "5 bots, then 7 more". One send is the default.
const roster = (states, sizes = [states.length]) => {
  const batchOf = (index) => {
    let seen = 0
    for (const [batch, size] of sizes.entries()) {
      seen += size
      if (index < seen) return batch + 1
    }
    return sizes.length
  }
  return {
    meetingId: 'mtg-abc123',
    inviteLink: 'https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt',
    platform: 'Aloqa',
    capabilities: { mic: true, camera: true, screen: true, rtc: true, codecs: true },
    batches: sizes.map((size, i) => ({ id: i + 1, at: 1_755_000_000_000 + i * 60_000, size })),
    guests: states.map((guestState, i) => ({
      index: i,
      slug: `bot-${i + 1}`,
      label: `Bot ${i + 1}`,
      color: '#00e5ff',
      state: guestState,
      batch: batchOf(i),
      mic: guestState === 'in-call' ? 'on' : null,
      cam: guestState === 'in-call' ? 'on' : null,
      screen: guestState === 'in-call' ? 'off' : null,
      codecs: { audio: null, video: null, screen: guestState === 'in-call' ? 'vp8' : null },
      // Bot 2 was sent on a codec that turned out to carry nothing; the server
      // put it back on the platform's own and says so.
      note: i === 1 ? "h265 sent nothing from the camera — back on the call's own codec" : null,
      rtc: guestState === 'in-call'
        ? { pcs: 1, via: false, down: 1830, up: 940, rtt: 45, loss: 0.2, jit: 9, in: { a: 1, v: 2 }, out: { a: 1, v: 1 }, limit: null }
        : null,
      lastError: null,
    })),
  }
}

const meetRoster = (guestState = 'in-call', waitingAdmission = false) => ({
  meetingId: 'abc-defg-hij',
  inviteLink: 'https://meet.google.com/abc-defg-hij?hl=en',
  platform: 'Google Meet',
  capabilities: { mic: true, camera: true, screen: true, rtc: true, codecs: false },
  batches: [{ id: 1, at: 1_755_000_000_000, size: 1 }],
  guests: [{
    index: 0,
    slug: 'bot-1',
    label: 'Meet Tester',
    color: '#00e5ff',
    state: guestState,
    waitingAdmission,
    batch: 1,
    mic: guestState === 'in-call' ? 'on' : null,
    cam: guestState === 'in-call' ? 'on' : null,
    screen: null,
    rtc: null,
    codecs: { audio: null, video: null, screen: null },
    note: null,
    lastError: null,
  }],
})

// What /api/rtc/<slug> serves: the sanitized stream model read out of a bot's
// page, one row per RTP stream, names joined in-page. `limit` on the video
// exercises the encoder-limitation warning.
const RTC_SNAP = {
  t: 1_755_000_000_000, pcs: 1, via: false, down: 1830, up: 940, rtt: 45, loss: 0.2, jitter: 9,
  avail: 2500, limit: 'bandwidth', dtls: 'connected',
  caps: { audio: ['opus'], video: ['vp8', 'vp9', 'h264', 'av1'] },
  // h264 is sendable but not in this call's negotiation — its option greys out.
  negotiated: { audio: ['opus'], video: ['vp8', 'vp9', 'av1'], screen: [] },
  localCand: { type: 'host', proto: 'udp', net: 'wifi', relay: null },
  remoteCand: { type: 'srflx', proto: 'udp' },
  outbound: [
    { id: 'o1', kind: 'video', dir: 'out', ssrc: 111111, mid: '0', track: 't-local-v', name: 'Bot 1',
      kbps: 900, w: 1280, h: 720, fps: 24, codec: { name: 'VP8', clock: 90000, channels: null },
      bytes: 1_000_000, rid: null, limit: 'bandwidth', active: true, rtt: 45, fraction: 0.1,
      remoteJitter: 8, nack: 0, pli: 1, keyframes: 4, encoder: 'libvpx', role: 'camera', level: null },
    { id: 'o2', kind: 'audio', dir: 'out', ssrc: 222222, mid: '1', track: 't-local-a', name: 'Bot 1',
      kbps: 40, w: null, h: null, fps: null, codec: { name: 'opus', clock: 48000, channels: 2 },
      bytes: 200_000, rid: null, limit: null, active: true, rtt: 45, fraction: 0,
      remoteJitter: 6, nack: 0, pli: 0, keyframes: null, encoder: null, role: null, level: 0.4 },
    // an SFU-paused layer of the LIVE camera track: idle, must stay visible
    { id: 'o3', kind: 'video', dir: 'out', ssrc: 333322, mid: '0', track: 't-local-v', name: 'Bot 1',
      kbps: 0, w: 640, h: 360, fps: 0, codec: { name: 'VP8', clock: 90000, channels: null },
      bytes: 10_000, rid: 'q', limit: null, active: false, rtt: 45, fraction: 0,
      remoteJitter: 8, nack: 0, pli: 0, keyframes: 1, encoder: 'libvpx', role: 'camera', level: null },
    // a leftover publication whose whole track carries nothing: dead, hidden
    { id: 'o4', kind: 'video', dir: 'out', ssrc: 444422, mid: '5', track: 't-dead-v', name: 'Bot 1',
      kbps: 0, w: null, h: null, fps: 0, codec: { name: 'VP9', clock: 90000, channels: null },
      bytes: 9_000, rid: null, limit: null, active: false, rtt: null, fraction: null,
      remoteJitter: null, nack: 0, pli: 0, keyframes: 0, encoder: null, role: 'camera', level: null },
  ],
  inbound: [
    { id: 'i1', kind: 'video', dir: 'in', ssrc: 333333, mid: '2', track: 't-rem-v', name: 'Alice',
      kbps: 850, w: 1280, h: 720, fps: 24, codec: { name: 'VP8', clock: 90000, channels: null },
      bytes: 3_000_000, jitter: 7, lossPct: 0.2, jbDelay: 40, framesDropped: 2, freezeCount: 0,
      nack: 1, pli: 0, decoder: 'libvpx', level: null },
    { id: 'i2', kind: 'audio', dir: 'in', ssrc: 444444, mid: '3', track: 't-rem-a', name: 'Alice',
      kbps: 38, w: null, h: null, fps: null, codec: { name: 'opus', clock: 48000, channels: 2 },
      bytes: 400_000, jitter: 5, lossPct: 0, jbDelay: 35, framesDropped: null, freezeCount: null,
      nack: 0, pli: 0, decoder: null, level: 0.6 },
    // measured-inactive (0 kbps): a paused SFU layer — the panel must hide it
    { id: 'i3', kind: 'video', dir: 'in', ssrc: 555555, mid: '4', track: null, name: null,
      kbps: 0, w: 960, h: 540, fps: 0, codec: { name: 'VP9', clock: 90000, channels: null },
      bytes: 12_000, jitter: null, lossPct: null, jbDelay: null, framesDropped: null, freezeCount: null,
      nack: 0, pli: 0, decoder: null, level: null },
  ],
  dataChannels: [{ label: 'lossy', state: 'open', inKbps: 1, outKbps: 1 }],
}

// The same browser choice the app makes, so this passes on an installation
// that has only system Chrome and never downloaded the bundled Chromium.
const browser = await chromium.launch({ channel: launchChannel(), headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })

  // The page connects to /api/events on load; hand it a silent stand-in the
  // test can push states through instead.
  await context.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        window.__es = this
      }
      close() {}
    }
  })

  const stops = []
  const actions = []
  await context.route('**/*', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path === '/api/start') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    }
    if (request.method() === 'POST' && path === '/api/add') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"added":2,"failed":0,"removed":false}',
      })
    }
    if (request.method() === 'POST' && path === '/api/stop') {
      stops.push(path)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    }
    if (request.method() === 'POST' && path === '/api/action') {
      actions.push(request.postDataJSON())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"results":{}}',
      })
    }
    if (request.method() === 'GET' && path.startsWith('/api/rtc/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RTC_SNAP),
      })
    }
    if (path === '/') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    }
    return route.fulfill({ status: 204, body: '' })
  })

  const page = await context.newPage()
  await page.goto('http://call-bots.test/')

  const push = (nextState) =>
    page.evaluate((s) => {
      window.__es.onmessage({ data: JSON.stringify({ type: 'state', state: s }) })
    }, nextState)

  const stopBtn = page.locator('#stopBtn')
  const goBtn = page.locator('#goBtn')

  // What a control asks the server for is the whole of its behaviour here.
  const actionOf = async (locator) => {
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/action'),
    )
    await locator.click()
    return (await sent).postDataJSON()
  }

  console.log('\nidle')
  await push(state('idle'))
  check('no Stop button before a session', !(await stopBtn.isVisible()))
  check('the header shows the machine: CPU, RAM, network',
    (await page.locator('#sysCpu').textContent()) === 'CPU 34%' &&
      (await page.locator('#sysMem').textContent()) === 'RAM 10.0 GB · 6.0 GB free' &&
      (await page.locator('#sysNet').textContent()) === '↓ 2.1 Mbps ↑ 4.3 Mbps',
    JSON.stringify(await page.locator('#sysCpu, #sysMem, #sysNet').allTextContents()))
  await push(state('idle', null, { system: { cpu: 97, mem: null, net: null } }))
  check('a slammed CPU wears the danger tone, empty fields hide their chips',
    (await page.locator('#sysCpu.-danger').count()) === 1 &&
      !(await page.locator('#sysMem').isVisible()) && !(await page.locator('#sysNet').isVisible()))
  await push(state('idle', null, { system: null }))
  check('an older server without system data leaves the header clean',
    !(await page.locator('#sysCpu').isVisible()))
  await push(state('idle'))
  check('Send bots is offered', (await goBtn.textContent()) === 'Send bots')
  check('Send bots is enabled', !(await goBtn.isDisabled()))
  check('no all-bots bar', !(await page.locator('#allbar').isVisible()))

  console.log('\nGoogle Meet stays out of the way until it is asked for')
  // Meet is a rare platform. The rule this section defends is that a dashboard
  // doing Aloqa work contains no Meet pixels at all.
  await push(state('idle'))
  check('an empty link shows nothing about Meet',
    !(await page.locator('#meetBar').isVisible()))
  await page.locator('#link').fill('https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt')
  check('an Aloqa link shows nothing about Meet',
    !(await page.locator('#meetBar').isVisible()))

  await page.locator('#link').fill('https://meet.google.com/abc-defg-hij')
  check('a Meet link shows one line about Meet',
    await page.locator('#meetBar').isVisible())
  // Guests need nothing set up, and there is nothing else: no accounts, no
  // panel to manage them, no mode to pick.
  check('the line says guests need no setup',
    (await page.locator('#meetBarText').textContent()).includes('no setup'),
    await page.locator('#meetBarText').textContent())
  check('and nothing about Google accounts remains in the page',
    (await page.locator('#accountsBtn, #accountsModal, [data-meet-mode]').count()) === 0)
  check('a guest batch is sendable', !(await goBtn.isDisabled()))
  check('and the empty state talks about admitting guests',
    /admit them in Meet/u.test(await page.locator('#emptyText').textContent()),
    await page.locator('#emptyText').textContent())
  check('and a guest keeps its custom label', await page.locator('#labelField').isVisible())
  check('while the codecs Meet ignores stay hidden', !(await page.locator('#codecToggle').isVisible()))
  await page.setViewportSize({ width: 980, height: 800 })
  check('the header fits the app window at its minimum width',
    await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth),
    await page.locator('header').evaluate((header) => `${header.scrollWidth}/${header.clientWidth}`))
  await page.setViewportSize({ width: 1280, height: 800 })

  // A machine without what guests run on says so instead of failing a send.
  await push(state('idle', null, { meet: { chromeReady: false, macOS: true } }))
  check('without Google Chrome the line says so and the send waits',
    (await page.locator('#meetBarText').textContent()).includes('Google Chrome') && await goBtn.isDisabled(),
    await page.locator('#meetBarText').textContent())
  await push(state('idle', null, { meet: { chromeReady: true, macOS: false } }))
  check('off macOS the line says so and the send waits',
    (await page.locator('#meetBarText').textContent()).includes('macOS') && await goBtn.isDisabled(),
    await page.locator('#meetBarText').textContent())
  await push(state('idle'))
  check('with both present the send is back', !(await goBtn.isDisabled()))

  await push(state('joining', meetRoster('joining', true)))
  check('Meet cards carry the bot label',
    (await page.locator('.card .who .nm').textContent()) === 'Meet Tester')
  check('Meet keeps mic, camera, leave, and Stop available while awaiting admission',
    await page.locator('.card [data-act=mic]').isVisible() &&
      await page.locator('.card [data-act=cam]').isVisible() &&
      await page.locator('.card [data-act=leave]').isVisible() && await stopBtn.isVisible())
  // The monitor is the point of the parity work — it is what the camera
  // watchdog reads. Presenting is the one thing live Meet refuses.
  check('Meet cards carry the stream monitor and the share control',
    await page.locator('.card [data-rtc-toggle]').isVisible() &&
      await page.locator('.card [data-act=share]').isVisible())
  check('the dashboard notifies the user about lobby admission',
    (await page.locator('.toast.-warn').allTextContents()).some((text) => text.includes('awaiting admission')))
  await push(state('running', meetRoster()))
  check('Meet keeps the fleet mic, camera and share controls, without codecs',
    await page.locator('#allbar').isVisible() &&
      await page.locator('#allbar [data-all=mute]').isVisible() &&
      await page.locator('#allbar [data-all=cam-off]').isVisible() &&
      await page.locator('#allbar [data-capability=screen]').isVisible() &&
      !(await page.locator('#allbar [data-capability=codecs]').isVisible()))
  check('another guest batch can be added to a running Meet session', !(await goBtn.isDisabled()))
  check('the Meet line offers to show the hidden bot windows while bots are in',
    await page.locator('#windowsBtn').isVisible() &&
      (await page.locator('#windowsBtn').textContent()) === 'Show windows')

  await push(state('idle'))
  await page.locator('#count').fill('2')
  await page.locator('#link').fill('https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt')
  check('switching back to Aloqa restores its label and puts Meet away again',
    await page.locator('#labelField').isVisible() &&
      await page.locator('#codecToggle').isVisible() &&
      !(await page.locator('#meetBar').isVisible()))
  await page.locator('#botLabel').fill('  Mahmud  ')
  check('the send codecs stay out of the way until asked for',
    !(await page.locator('#joinCodecs').isVisible()))
  // The bar aligns its groups to flex-end, so a shared row is a shared BOTTOM
  // edge — tops differ by however tall each group is.
  const barRows = () =>
    page.locator('.bar').evaluate((bar) => {
      const rows = new Set()
      for (const child of bar.children) {
        const box = child.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) continue // hidden: not on any row
        rows.add(Math.round(box.bottom))
      }
      return rows.size
    })
  check('the bar is a single row without them', (await barRows()) === 1, `rows: ${await barRows()}`)
  await page.locator('#codecToggle').click()
  check('the Codecs trigger shows them beside the device toggles',
    await page.locator('.bar [data-join-codec="video"]').isVisible() &&
      await page.locator('.bar [data-join-codec="screen"]').isVisible())
  check('each picker is captioned above it, like every other group in the bar',
    await page.locator('.bar .jcodecs').evaluate((box) => {
      const caps = [...box.querySelectorAll('.lbl')]
      return caps.length === 2 &&
        caps.every((cap) => {
          const picker = cap.parentElement.querySelector('.codec')
          return cap.getBoundingClientRect().bottom <= picker.getBoundingClientRect().top
        })
    }))
  await page.locator('[data-join-codec="video"]').click()
  const joinRows = await page.locator('.cmenu .crow').evaluateAll(
    (rows) => rows.map((row) => row.textContent.replace('✓', '').trim()),
  )
  check('the launch picker leads with the way back to the platform\'s own pick',
    joinRows[0] === 'Auto' && joinRows.includes('VP9'), JSON.stringify(joinRows))
  await page.locator('.cmenu .crow', { hasText: 'VP9' }).click()
  check('the picker shows what the next send will carry, marked as a pin',
    (await page.locator('[data-join-codec="video"]').textContent()) === 'VP9' &&
      (await page.locator('[data-join-codec="video"].-forced').count()) === 1)
  check('a role left alone stays on the platform’s own pick',
    (await page.locator('[data-join-codec="screen"]').textContent()) === 'Auto' &&
      (await page.locator('[data-join-codec="screen"].-forced').count()) === 0)
  await page.locator('#codecToggle').click()
  check('hidden again, but a pinned choice still shows on the trigger',
    !(await page.locator('#joinCodecs').isVisible()) &&
      (await page.locator('#codecToggle.-on').count()) === 1)
  const startRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/start'),
  )
  await goBtn.click()
  const startBody = (await startRequest).postDataJSON()
  check('the label is sent when starting', startBody.label === 'Mahmud')
  check('the chosen codecs ride the send, untouched roles stay on the platform',
    startBody.videoCodec === 'vp9' && startBody.screenCodec === null,
    JSON.stringify({ video: startBody.videoCodec, screen: startBody.screenCodec }))
  await page.waitForFunction(() => !document.querySelector('#goBtn').disabled)

  console.log('\njoining — bots are landing, one is still in the lobby')
  await push(state('joining', roster(['in-call', 'joining'])))
  check('the status pill says joining', (await page.locator('#statusPill').textContent()) === 'joining')
  const stopVisibleMidJoin = await stopBtn.isVisible()
  check('Stop is available mid-join', stopVisibleMidJoin)
  check('a card exists per bot', (await page.locator('.card').count()) === 2)
  check('sending more is paused', await goBtn.isDisabled())
  check('the link is locked to the call', await page.locator('#link').isDisabled())
  check('all-bots actions wait for running', !(await page.locator('#allbar').isVisible()))
  check('removing a batch waits for running too',
    await page.locator('[data-batch-remove]').first().isDisabled())
  check('no stream stats before a bot is in the call',
    !(await page.locator('.card[data-slug="bot-2"] .rtcbar').isVisible()))
  check('the stream monitor waits for the call too',
    await page.locator('.card[data-slug="bot-2"] [data-rtc-toggle]').isDisabled())

  if (stopVisibleMidJoin) {
    const stopRequest = page.waitForRequest((request) => request.url().endsWith('/api/stop'))
    await stopBtn.click()
    await stopRequest
  }
  check('clicking Stop mid-join calls /api/stop', stops.length === 1,
    stopVisibleMidJoin ? '' : 'no button to click')
  check('the stop is accepted without an error toast', (await page.locator('.toast.-err').count()) === 0)

  console.log('\nstopping')
  await push(state('stopping', roster(['leaving', 'leaving'])))
  check('Stop hides once the stop is underway', !(await stopBtn.isVisible()))

  console.log('\nrunning')
  await push(state('running', roster(['in-call', 'in-call'])))
  check('Stop is available while running', await stopBtn.isVisible())
  check('the all-bots bar appears', await page.locator('#allbar').isVisible())
  check('the button now adds bots', (await goBtn.textContent()) === 'Add bots')
  check('adding is enabled', !(await goBtn.isDisabled()))
  const addRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/add'),
  )
  await goBtn.click()
  check('the label is sent when adding more bots',
    (await addRequest).postDataJSON().label === 'Mahmud')
  await page.waitForFunction(() => !document.querySelector('#goBtn').disabled)
  check('the bots are shown as the one batch they arrived in',
    (await page.locator('.batch').count()) === 1)

  console.log('\nstream monitor')
  check('an in-call card shows its compact stats bar',
    await page.locator('.card[data-slug="bot-1"] .rtcbar').isVisible())
  check('the bar shows the receive rate from the snapshot',
    (await page.locator('.card[data-slug="bot-1"] [data-rtc=down]').textContent()) === '1.8 Mbps')
  const monitorBtn = page.locator('.card[data-slug="bot-1"] [data-rtc-toggle]')
  await monitorBtn.click()
  check('opening the monitor expands the card', await page
    .locator('.card[data-slug="bot-1"]')
    .evaluate((card) => card.classList.contains('rtc-open')))
  await page.waitForFunction(
    () => document.querySelectorAll('.card[data-slug="bot-1"] .srow').length === 5,
  )
  check('one row per living stream, sending and receiving', true)
  const panelText = await page.locator('.card[data-slug="bot-1"] .rtcpanel').textContent()
  check('a dead publication is hidden, the paused layer of a live track stays as idle',
    panelText.includes('Sending · 3') && panelText.includes('idle'))
  check('a 0 kbps receiving stream is hidden and the count matches',
    (await page.locator('.card[data-slug="bot-1"] .rtcpanel').textContent()).includes('Receiving · 2'))
  check('streams carry the names joined inside the bot page',
    (await page.locator('.card[data-slug="bot-1"] .rtcpanel').textContent()).includes('Alice'))
  check('the encoder limitation is surfaced',
    await page.locator('.card[data-slug="bot-1"] .rwarn').isVisible())
  check('a bot whose launch codec carried nothing says so on its card',
    (await page.locator('.card[data-slug="bot-2"] [data-note]').textContent())
      === "h265 sent nothing from the camera — back on the call's own codec" &&
      !(await page.locator('.card[data-slug="bot-1"] [data-note]').isVisible()),
    await page.locator('.card[data-slug="bot-2"] [data-note]').textContent())
  const pathEl = page.locator('.card[data-slug="bot-1"] [data-rtc-path]')
  check('the panel says which path ICE settled on',
    (await pathEl.textContent()) === 'direct · LAN · UDP',
    await pathEl.textContent())
  check('the hover carries the monitor\'s own transport detail',
    (await pathEl.getAttribute('title')) === 'local host (wifi) · remote srflx · DTLS connected',
    await pathEl.getAttribute('title'))

  console.log('\ncodec controls')
  const codecBar = page.locator('.card[data-slug="bot-1"] [data-codec-bar]')
  const menu = page.locator('.cmenu')
  check('the codec bar appears with the snapshot', await codecBar.isVisible())
  check('one picker per role, and none for the opus-only microphone',
    (await codecBar.locator('[data-codec-role]').count()) === 2 &&
      (await codecBar.locator('[data-codec-role="audio"]').count()) === 0)
  await codecBar.locator('[data-codec-role="video"]').click()
  const videoRows = await menu.locator('.crow').evaluateAll(
    (rows) => rows.map((row) => row.textContent.replace('✓', '').trim()),
  )
  check('the menu offers exactly what the call can carry, in the fixed order',
    JSON.stringify(videoRows) === '["VP9","VP8","AV1"]',
    JSON.stringify(videoRows))
  check('rows are bare uppercase codec names',
    videoRows.every((row) => row === row.toUpperCase() && !/cam|mic|screen/iu.test(row)))
  check('the menu is app-drawn and fully on screen',
    await menu.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return getComputedStyle(node).position === 'fixed' &&
        box.top >= 0 && box.bottom <= window.innerHeight
    }))
  check('the card holds its hover lift while its menu is open',
    await page.locator('.card[data-slug="bot-1"]').evaluate((card) =>
      card.classList.contains('menu-open') &&
        getComputedStyle(card).transform !== 'none'))
  await push(state('running', roster(['in-call', 'in-call'])))
  check('a state push never yanks an open menu away',
    (await menu.count()) === 1 &&
      (await codecBar.locator('[data-codec-role="video"].-open').count()) === 1)
  await page.keyboard.press('Escape')
  check('Escape closes the menu', (await menu.count()) === 0)
  check('with nothing forced the picker reads the codec in use',
    (await codecBar.locator('[data-codec-role="video"]').textContent()) === 'VP8' &&
      !(await codecBar.locator('[data-codec-role="video"]').evaluate((node) => node.classList.contains('-forced'))))
  check('a forced codec wears the accent mark',
    (await codecBar.locator('[data-codec-role="screen"]').textContent()) === 'VP8' &&
      (await codecBar.locator('[data-codec-role="screen"]').evaluate((node) => node.classList.contains('-forced'))))
  await codecBar.locator('[data-codec-role="video"]').click()
  check('the menu ticks the codec in effect',
    (await menu.locator('.crow.-on').textContent()).replace('✓', '').trim() === 'VP8')
  await page.keyboard.press('Escape')
  await codecBar.locator('[data-codec-role="screen"]').click()
  check('a role with no live sender still offers everything the browser can send',
    (await menu.locator('.crow').count()) === 4)
  const codecAction = await (async () => {
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/action'),
    )
    await menu.locator('.crow', { hasText: 'VP9' }).first().click()
    return (await sent).postDataJSON()
  })()
  check('picking a codec posts the action for that one bot',
    codecAction.slug === 'bot-1' && codecAction.action === 'codec' &&
      codecAction.value?.role === 'screen' && codecAction.value?.codec === 'vp9',
    JSON.stringify(codecAction))
  await page.waitForFunction(
    () => !document.querySelector('[data-codec-role="screen"]')?.dataset.busy,
  )
  await push(state('running', roster(['in-call', 'in-call'])))
  check('the picker returns to the codec the server holds for the bot',
    (await codecBar.locator('[data-codec-role="screen"]').textContent()) === 'VP8')
  const captions = await codecBar.locator('[data-codec-live]').evaluateAll(
    (nodes) => nodes.map((node) => node.textContent),
  )
  check('captions are plain role names — the codec lives in the button',
    captions.length === 2 && captions[0] === 'Cam' && captions[1] === 'Screen',
    JSON.stringify(captions))
  await monitorBtn.click()
  check('closing the monitor collapses the card', !(await page
    .locator('.card[data-slug="bot-1"]')
    .evaluate((card) => card.classList.contains('rtc-open'))))
  check('closing it stops the polling',
    await page.evaluate(() => ![...S.rtc.values()].some((entry) => entry.timer)))

  console.log('\nrunning — 3 more bots sent into the same call')
  await push(state('running', roster(['in-call', 'in-call', 'in-call', 'in-call', 'in-call'], [2, 3])))
  check('a group per send', (await page.locator('.batch').count()) === 2)
  check('the first send keeps its own bots',
    (await page.locator('[data-batch="1"] .card').count()) === 2)
  check('the second send is a group of its own',
    (await page.locator('[data-batch="2"] .card').count()) === 3)
  check('a group says how many bots it holds',
    (await page.locator('[data-batch="2"] .bhead .sub').textContent()).startsWith('3 bots'))
  check('one remove button per group', (await page.locator('[data-batch-remove]').count()) === 2)
  check('every bot still has its own controls',
    (await page.locator('.card [data-act=leave]').count()) === 5)

  console.log('\npinned bots')
  const pinned = page.locator('#pinned')
  const pinOf = (slug) => page.locator(`.card[data-slug="${slug}"] [data-pin]`)
  check('nothing is pinned to begin with', !(await pinned.isVisible()))
  const quiet = actions.length
  await pinOf('bot-4').click()
  check('pinning is the panel\'s own business — the server is never told',
    actions.length === quiet)
  check('the bot lands in the section above every batch',
    (await pinned.isVisible()) && (await pinned.locator('.card[data-slug="bot-4"]').count()) === 1)
  check('and leaves the grid of the send it came in with',
    (await page.locator('[data-batch="2"] .card').count()) === 2)
  check('the send still counts it as one of its own',
    (await page.locator('[data-batch="2"] .bhead .sub').textContent()).startsWith('3 bots'))
  await push(state('running', roster(['in-call', 'in-call', 'in-call', 'in-call', 'in-call'], [2, 3])))
  check('a state push leaves the pin where it is',
    (await pinned.locator('.card[data-slug="bot-4"]').count()) === 1)
  const fromPinned = await actionOf(pinned.locator('.card[data-slug="bot-4"] [data-act=mic]'))
  check('a pinned card still drives its own bot',
    fromPinned.slug === 'bot-4' && fromPinned.action === 'mute', JSON.stringify(fromPinned))
  await pinOf('bot-1').click()
  const pinOrder = await pinned.locator('.card').evaluateAll(
    (cards) => cards.map((card) => card.dataset.slug),
  )
  check('pinned bots keep the roster order, not the order they were pinned',
    JSON.stringify(pinOrder) === '["bot-1","bot-4"]', JSON.stringify(pinOrder))
  await pinOf('bot-2').click()
  check('a send with every bot pinned says so instead of showing a heading over a gap',
    (await page.locator('[data-batch="1"] .card').count()) === 0 &&
      (await page.locator('[data-batch="1"] .bnote').isVisible()))
  await pinOf('bot-2').click()
  check('unpinning puts the card back among the bots it arrived with',
    (await page.locator('[data-batch="1"] .card').evaluateAll(
      (cards) => cards.map((card) => card.dataset.slug),
    )).join() === 'bot-2' && !(await page.locator('[data-batch="1"] .bnote').isVisible()))

  // A pin is worth nothing if reloading the window loses it, and worse than
  // nothing if it survives into the next call, where bot-1 is a different bot.
  const rejoin = await context.newPage()
  const pushTo = (target, nextState) =>
    target.evaluate((s) => {
      window.__es.onmessage({ data: JSON.stringify({ type: 'state', state: s }) })
    }, nextState)
  await rejoin.goto('http://call-bots.test/')
  await pushTo(rejoin, state('running', roster(['in-call', 'in-call', 'in-call', 'in-call', 'in-call'], [2, 3])))
  check('a pin survives reopening the panel on the same call',
    (await rejoin.locator('#pinned .card').evaluateAll(
      (cards) => cards.map((card) => card.dataset.slug),
    )).join() === 'bot-1,bot-4')
  await pushTo(rejoin, state('running', roster(['in-call', 'in-call'], [2]), { startedAt: 2 }))
  check('the next call starts with none — its bot-1 is a different bot',
    !(await rejoin.locator('#pinned').isVisible()))
  await rejoin.close()

  await page.locator('#unpinAll').click()
  check('Unpin all empties the section and hands every card back to its send',
    !(await pinned.isVisible()) &&
      (await page.locator('[data-batch="1"] .card').count()) === 2 &&
      (await page.locator('[data-batch="2"] .card').count()) === 3)
  // Left pinned on purpose: the batch below is removed with this bot in it.
  await pinOf('bot-4').click()

  const perBot = await actionOf(page.locator('[data-batch="2"] .card [data-act=mic]').first())
  check('a card control still acts on that one bot',
    perBot.slug === 'bot-3' && perBot.action === 'mute', JSON.stringify(perBot))
  const forAll = await actionOf(page.locator('[data-all=mute]'))
  check('the all-bots bar still acts on every bot',
    forAll.slug === 'all' && forAll.action === 'mute', JSON.stringify(forAll))
  const codecForAll = await (async () => {
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/action'),
    )
    await page.locator('[data-all-codec="video"]').click()
    await page.locator('.cmenu .crow', { hasText: 'H264' }).click()
    return (await sent).postDataJSON()
  })()
  check('the all-bots codec selects act on every bot too',
    codecForAll.slug === 'all' && codecForAll.action === 'codec' &&
      codecForAll.value?.role === 'video' && codecForAll.value?.codec === 'h264',
    JSON.stringify(codecForAll))
  const forBatch = await actionOf(page.locator('[data-batch="2"] [data-batch-remove]'))
  check('one button removes the whole batch',
    forBatch.slug === 'batch:2' && forBatch.action === 'leave', JSON.stringify(forBatch))
  check('removing a batch raises no error', (await page.locator('.toast.-err').count()) === 0)

  console.log('\nthe removed batch is gone, the first one is untouched')
  await push(state('running', roster(['in-call', 'in-call'], [2])))
  check('the removed group disappears', (await page.locator('.batch').count()) === 1)
  check('its cards go with it', (await page.locator('.card').count()) === 2)
  check('the bots that stayed are still there',
    (await page.locator('[data-batch="1"] .card').count()) === 2)
  check('the remove button comes back for the next removal',
    !(await page.locator('[data-batch="1"] [data-batch-remove]').isDisabled()))
  check('a pinned bot removed with its batch takes its pin with it',
    !(await pinned.isVisible()) && (await page.evaluate(() => !S.pinned.has('bot-4'))))

  console.log('\nidle again — the session ended')
  await push(state('idle'))
  check('Stop hides with the session', !(await stopBtn.isVisible()))
  check('the cards are cleared', (await page.locator('.card').count()) === 0)
  check('the groups are cleared too', (await page.locator('.batch').count()) === 0)
  check('the empty state returns', await page.locator('#empty').isVisible())
  check('stream monitor state goes with the cards',
    await page.evaluate(() => S.rtc.size === 0))
  check('the pins go with the session too', await page.evaluate(() => S.pinned.size === 0))
  check('the fleet codec pickers forget the old session too',
    (await page.locator('[data-all-codec="video"]').textContent()) === 'Auto' &&
      (await page.locator('[data-all-codec="audio"]').count()) === 0)

  console.log('\nreopen')
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('http://call-bots.test/')
  check('the label is restored after reopening',
    (await reopened.locator('#botLabel').inputValue()).trim() === 'Mahmud')
  await reopened.close()
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
