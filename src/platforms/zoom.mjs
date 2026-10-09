import { zoomPageCommand } from './zoom-page.mjs'

export const isZoomHost = (host) => /(^|\.)(?:zoom\.us|zoom\.com)$/iu.test(host)
export const capabilities = Object.freeze({ mic: true, camera: true, screen: true, rtc: false, codecs: false, volume: true })

const parse = (url) => {
  if (!isZoomHost(url.hostname)) return null
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Zoom requires an HTTPS meeting link')
  const match = url.pathname.match(/^\/(?:j\/(\d{9,11})|wc\/(\d{9,11})\/(?:join|start))\/?$/u)
  if (!match) throw new Error('expected a Zoom meeting link like https://zoom.us/j/12345678901?pwd=…')
  const callId = match[1] || match[2]
  // The web client avoids the desktop-app launcher. pwd is an encrypted
  // invitation token, not the plaintext passcode: preserve it unchanged.
  const target = new URL(`https://app.zoom.us/wc/${callId}/join`)
  if (url.searchParams.has('pwd')) target.searchParams.set('pwd', url.searchParams.get('pwd'))
  target.searchParams.set('lang', 'en-US')
  return { origin: target.origin, url: target.href, callId }
}

export const pageCommand = async (page, command, args = {}) => {
  args = { label: page.zoomLabel || page.label, ...args }
  if (page.meetCommand) return page.meetCommand(command, args)
  const raw = await page.evaluate(`JSON.stringify((${zoomPageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(args)}))`)
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}
const read = (page) => pageCommand(page, 'read')
const click = (page, pattern) => pageCommand(page, 'click', { pattern })
const controls = async (page) => {
  const value = await read(page)
  return { mic: value.mic, cam: value.cam, screen: value.screen }
}
const setDevice = async ({ page, log }, which, on) => {
  const want = on ? 'on' : 'off'
  const deadline = Date.now() + 8000
  let clicked = false
  let current = 'unknown'
  while (!page.isClosed() && Date.now() < deadline) {
    const value = await read(page)
    current = value[which]
    if (current === want) return current
    if (current === 'request' && /host (?:has )?(?:disabled|stopped)|not allowed to (?:unmute|start)/iu.test(value.headline)) return current
    if (which === 'mic' && value.audio && on) await click(page, '^join (?:audio by computer|with computer audio|audio)$')
    else if (current !== 'unknown' && current !== 'request' && !clicked) {
      clicked = await click(page, which === 'mic' ? (on ? '^unmute\\b' : '^mute\\b') : (on ? '^start (?:my )?video\\b' : '^stop (?:my )?video\\b'))
    }
    await page.waitForTimeout(250)
  }
  log.warn(`Zoom ${which} did not reach ${want}`)
  return current
}
const join = async ({ page, target, displayName, options, log, fail, setWaitingAdmission }) => {
  await page.goto(target.url, { waitUntil: 'domcontentloaded' })
  const name = String(displayName ?? '').slice(0, 60)
  page.zoomLabel = name
  let phase = 'entry'
  let deadline = Date.now() + 60000
  let clickedAt = 0
  try {
    while (!page.isClosed()) {
      const value = await read(page).catch(() => null)
      if (value) {
        const text = value.headline
        const refusal = text.match(/(?:invalid meeting (?:id|number)|meeting (?:has ended|does not exist|is not available|is full)|removed by (?:the )?host|removed from (?:this|the) meeting|host has ended this meeting|host has denied|incorrect (?:meeting )?passcode|meeting is locked)[^\n]*/iu)
        if (refusal) return await fail('entry', `Zoom: ${refusal[0]}`)
        if (/automated bots (?:aren't|are not) allowed|detected (?:an? )?bot/iu.test(text)) return await fail('entry', 'Zoom blocked this automated guest; automatic browser joining cannot continue')
        if (/sign in to join|sign in.*(?:authorized|authenticated)|only authenticated/iu.test(text)) return await fail('entry', 'Zoom requires a signed-in account; allow guests for this meeting')
        if (value.challenge || /verify (?:that )?you(?: are|'re) (?:human|not a robot)|complete the (?:captcha|security check)/iu.test(text)) return await fail('entry', 'Zoom requires human verification; automatic guest joining cannot continue')
        if (value.inCall) {
          if (phase !== 'audio') { phase = 'audio'; deadline = Date.now() + 60000; setWaitingAdmission(false) }
          await click(page, '^got it$')
          if (value.audio && !options.noAudio) {
            if (Date.now() - clickedAt > 1500) {
              await click(page, '^join (?:audio by computer|with computer audio|audio)$')
              clickedAt = Date.now()
            }
          } else {
            log.info('joined Zoom')
            return { callId: target.callId }
          }
        } else if (value.waiting) {
          if (phase !== 'lobby') {
            phase = 'lobby'
            deadline = Date.now() + 600000
            setWaitingAdmission(true)
            log.info('waiting for the Zoom host')
          }
        } else if (value.password) return await fail('entry', 'Zoom needs a passcode; paste the full invitation link including ?pwd=…')
        else if (value.nameField && value.named !== name) await pageCommand(page, 'type-name', { name })
        else if (value.join && Date.now() - clickedAt > 3000) {
          // Honour muted/camera-off entry before asking for admission.
          if (value.mic === 'on' && (options.noAudio || options.startMic === false)) await setDevice({ page, log }, 'mic', false)
          if (value.cam === 'on' && (options.noVideo || options.startCam === false)) await setDevice({ page, log }, 'cam', false)
          await click(page, '^join(?: meeting)?$')
          clickedAt = Date.now()
          if (phase === 'entry') { phase = 'joining'; deadline = Date.now() + 60000 }
        }
        if (Date.now() > deadline) return await fail('entry', `Zoom ${phase === 'lobby' ? 'host did not admit the bot' : 'did not finish joining'}: ${text.slice(0, 500)}`)
      } else if (Date.now() > deadline) return await fail('entry', 'Zoom page did not become readable')
      await page.waitForTimeout(phase === 'lobby' ? 2000 : 500)
    }
    throw new Error('Zoom bot window closed while joining')
  } finally { setWaitingAdmission(false) }
}
const setScreen = async (ctx, on) => {
  const { page, log } = ctx
  let current = (await read(page)).screen
  const want = on ? 'on' : 'off'
  if (current === want || current === 'blocked' || current === 'unknown') return current
  if (on) { await ctx.prepareScreen(); await page.beginScreenCapture?.() }
  await click(page, on ? '^share(?: screen)?(?:\\b|$)' : '^stop shar')
  const deadline = Date.now() + 15000
  while (!page.isClosed() && Date.now() < deadline) {
    const value = await read(page)
    current = value.screen
    if (current === want) return want
    if (/host disabled.*shar|host has disabled.*shar|cannot share/iu.test(value.headline)) {
      await click(page, '^OK$')
      return 'blocked'
    }
    await page.waitForTimeout(300)
  }
  log.warn(`Zoom screen share did not reach ${want}`)
  return current
}
export default {
  id: 'zoom', label: 'Zoom', capabilities, armAfterJoin: true, parse, join, controls,
  micState: async (page) => (await read(page)).mic,
  camState: async (page) => (await read(page)).cam,
  screenState: async (page) => (await read(page)).screen,
  setMic: (ctx, on) => setDevice(ctx, 'mic', on),
  setCam: (ctx, on) => setDevice(ctx, 'cam', on),
  setScreen, remote: (page) => pageCommand(page, 'remote'),
  leave: async ({ page }) => {
    await click(page, '^leave(?: meeting)?$')
    // Some Zoom versions leave immediately; others render a confirmation.
    // A document disappearing after Leave is success, not a control failure.
    const deadline = Date.now() + 3000
    while (!page.isClosed() && Date.now() < deadline) {
      if (await click(page, '^leave meeting$').catch(() => false)) return
      const value = await read(page).catch(() => null)
      if (value && !value.inCall && !value.waiting) return
      await page.waitForTimeout(200)
    }
  },
}
