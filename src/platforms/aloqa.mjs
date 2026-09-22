// Aloqa Web — anonymous guest join. Verified against aloqa-frontend develop
// @ 97a1746bb. If a deploy changes the UI, this file is the only one to edit.
//
// Behaviour here is unchanged from when Aloqa was the only platform: same
// selectors, same join sequence, same inverted aria-pressed device toggles.

const JOIN_TIMEOUT = 60_000
// A call on "Wait for admission" parks guests until a host clicks Admit, which
// takes as long as it takes someone to notice. Giving up on the direct-entry
// timeout abandons a bot that is sitting in the lobby doing exactly the right
// thing — and it gets admitted later anyway, leaving it in the call with the
// app believing it failed.
const ADMISSION_TIMEOUT = 600_000
const TOGGLE_TIMEOUT = 8_000
// Picking a capture source and publishing it takes longer than a mute toggle.
const SHARE_TIMEOUT = 15_000

export const capabilities = Object.freeze({
  mic: true,
  camera: true,
  screen: true,
  rtc: true,
  codecs: true,
  volume: true,
})

export const SEL = {
  // guest entry (/join/<token>) — anonymous, no account.
  // The form carries no testids; the name attribute and the form submit are the
  // stable seam, and the submit label varies with the room's entry mode.
  guestName: 'input[name="display_name"]',
  guestSubmit: 'form button[type="submit"]',
  guestSurface: '[data-testid="guest-call-surface"]',
  guestBlocked: '[data-testid="guest-join-blocked"]',

  // in-call surface (shared with the member UI)
  leaveButton: '[data-testid="call-controls-leave"]',
  leaveConfirm: '[data-testid="call-leave-confirm-submit"]',

  // device toggles: the PAIR wrapper holds the testid, the toggle is its first
  // button, and aria-pressed="true" means the device is OFF
  micPair: '[data-testid="mic-control-pair"]',
  camPair: '[data-testid="cam-control-pair"]',
  micRequest: '[data-testid="call-controls-mic-request"]',
  camRequest: '[data-testid="call-controls-camera-request"]',

  // screen share: a plain toggle, and unlike the device pairs above,
  // aria-pressed="true" here means it IS sharing. A call that forbids
  // sharing renders the button disabled.
  screenShare: '[data-testid="call-controls-screen-share"]',

  // participant grid
  tile: '[data-testid="participant-tile"]',
}

// Match realtime-service guestcode.Normalize: nine ASCII letters, ignoring
// case and any ASCII spaces or dashes. Canonicalise before opening the page;
// older opaque tokens must retain their exact spelling.
const SHORT_CODE_RE = /^[A-Za-z]{9}$/u
const LEGACY_TOKEN_RE = /^[A-Za-z0-9._~-]{16,512}$/u
const normalizeToken = (token) => {
  const letters = token.trim().replace(/[- ]/gu, '')
  if (SHORT_CODE_RE.test(letters)) {
    const code = letters.toLowerCase()
    return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`
  }
  return LEGACY_TOKEN_RE.test(token) ? token : null
}

// Aloqa runs on any origin, so this is the catch-all: a path shaped like a call
// invite is ours. Returns null when the link is for someone else entirely.
const parse = (url) => {
  if (url.pathname === '/invite' || url.pathname.startsWith('/invite/')) {
    throw new Error('that is a workspace invite — paste the call\'s invite link (…/join/abc-def-ghi)')
  }
  const match = url.pathname.match(/^\/(?:join|guest\/c)\/([^/?#]+)\/?$/u)
  if (!match) return null
  const token = normalizeToken(decodeURIComponent(match[1]))
  if (!token) throw new Error('that invite token looks malformed — expected …/join/abc-def-ghi')
  return { origin: url.origin, url: `${url.origin}/join/${encodeURIComponent(token)}` }
}

// Bots join as guests, which have no lobby: name form -> call surface.
const join = async ({ page, target, displayName, log, fail }) => {
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    // The raw Playwright timeout names the symptom, never the cause, and the
    // cause at this point is almost always too many bots for the machine.
    await fail(
      'entry',
      /timeout/iu.test(error.message)
        ? 'the page did not load in time — this machine is overloaded, send fewer bots'
        : error.message,
    )
  }

  const nameField = page.locator(SEL.guestName)
  const blocked = page.locator(SEL.guestBlocked)
  try {
    await nameField.or(blocked).first().waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    await fail('entry', 'the invite link page never resolved (dead or wrong link?)')
  }
  if (await blocked.isVisible().catch(() => false)) {
    const why = ((await blocked.textContent().catch(() => '')) ?? '').trim().slice(0, 120)
    await fail('blocked', `join refused: ${why}`)
  }

  await nameField.fill(displayName)
  const submit = page.locator(SEL.guestSubmit)
  await submit.waitFor({ state: 'visible', timeout: 10_000 })
  await submit.click()

  // Entry mode Open lets a guest straight in; Wait for admission parks it. Watch
  // for the call surface, the lobby, and a refusal together, and stretch the
  // deadline once the lobby is confirmed.
  const surface = page.locator(SEL.guestSurface)
  const lobby = page.getByText(/Waiting for approval/iu)
  const startedAt = Date.now()
  let admitted = false
  let inLobby = false
  while (!admitted) {
    if (await surface.isVisible().catch(() => false)) {
      admitted = true
      break
    }
    if (await blocked.isVisible().catch(() => false)) {
      const why = ((await blocked.textContent().catch(() => '')) ?? '').trim().slice(0, 120)
      await fail('blocked', `join refused: ${why}`)
    }
    if (!inLobby && (await lobby.isVisible().catch(() => false))) {
      inLobby = true
      log.info('in the lobby — waiting to be admitted')
    }
    if (Date.now() - startedAt > (inLobby ? ADMISSION_TIMEOUT : JOIN_TIMEOUT)) {
      await fail(
        'join',
        inLobby
          ? 'nobody admitted the bot — admit it in the call, or use entry mode Open'
          : 'the call never opened after submitting the name',
      )
    }
    await page.waitForTimeout(500)
  }

  // /guest/meeting/<id> — the only place the meeting id is exposed to us
  return { callId: page.url().match(/\/guest\/meeting\/([A-Za-z0-9_-]+)/u)?.[1] ?? null }
}

// The PAIR wrapper carries the testid; its first button is the toggle and
// aria-pressed="true" means the device is OFF. A host force-mute replaces the
// toggle with a request button — detect it, never blind-click.
const deviceState = async (page, pairSelector, requestSelector) => {
  if (await page.locator(requestSelector).isVisible().catch(() => false)) return 'request'
  const toggle = page.locator(`${pairSelector} button`).first()
  if (!(await toggle.isVisible().catch(() => false))) return 'unknown'
  const pressed = await toggle.getAttribute('aria-pressed')
  if (pressed === 'true') return 'off'
  if (pressed === 'false') return 'on'
  return 'unknown'
}

const setDevice = async ({ page, log }, kind, pairSelector, requestSelector, on) => {
  const current = await deviceState(page, pairSelector, requestSelector)
  if (current === 'request') {
    log.warn(`${kind} is host-restricted (request mode) — cannot toggle`)
    return 'request'
  }
  if (current === 'unknown') {
    log.warn(`${kind} toggle not found — not in call?`)
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want
  await page.locator(`${pairSelector} button`).first().click()
  try {
    await page.waitForFunction(
      ({ sel, value }) =>
        document.querySelector(`${sel} button`)?.getAttribute('aria-pressed') === value,
      { sel: pairSelector, value: on ? 'false' : 'true' },
      { timeout: TOGGLE_TIMEOUT },
    )
  } catch {
    log.warn(`${kind} did not reach "${want}" within ${TOGGLE_TIMEOUT}ms`)
  }
  return deviceState(page, pairSelector, requestSelector)
}

const screenState = async (page) => {
  const button = page.locator(SEL.screenShare)
  if (!(await button.isVisible().catch(() => false))) return 'unknown'
  if (await button.isDisabled().catch(() => false)) return 'blocked'
  const pressed = await button.getAttribute('aria-pressed')
  if (pressed === 'true') return 'on'
  if (pressed === 'false') return 'off'
  return 'unknown'
}

const setScreen = async (ctx, on) => {
  const { page, log } = ctx
  const current = await screenState(page)
  if (current === 'blocked') {
    log.warn('this call does not allow screen sharing — Meeting settings, Screen share')
    return 'blocked'
  }
  if (current === 'unknown') {
    log.warn('screen share control not found — not in call?')
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want
  if (on) await ctx.prepareScreen()
  await page.locator(SEL.screenShare).click()
  try {
    await page.waitForFunction(
      (arg) => document.querySelector(arg.sel)?.getAttribute('aria-pressed') === arg.value,
      { sel: SEL.screenShare, value: on ? 'true' : 'false' },
      { timeout: SHARE_TIMEOUT },
    )
  } catch {
    log.warn('screen share did not reach "' + want + '" in time')
  }
  return screenState(page)
}

export default {
  id: 'aloqa',
  label: 'Aloqa',
  capabilities,
  // Guests have no lobby, so devices start off and are armed after joining.
  armAfterJoin: true,
  parse,
  join,
  micState: (page) => deviceState(page, SEL.micPair, SEL.micRequest),
  camState: (page) => deviceState(page, SEL.camPair, SEL.camRequest),
  setMic: (ctx, on) => setDevice(ctx, 'mic', SEL.micPair, SEL.micRequest, on),
  setCam: (ctx, on) => setDevice(ctx, 'camera', SEL.camPair, SEL.camRequest, on),
  screenState,
  setScreen,

  // Buttons are not proof: check that remote <video> elements really play.
  remote: (page) =>
    page.evaluate((sel) => {
      const tiles = [...document.querySelectorAll(sel.tile)]
      const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }
      for (const tile of tiles) {
        const local = tile.getAttribute('data-local') === 'true'
        const name = tile.querySelector('[data-testid="participant-name"]')?.textContent?.trim()
        if (name) summary.names.push(`${local ? '*' : ''}${name}`)
        if (tile.getAttribute('data-video-frozen') === 'true') summary.frozen += 1
        if (local) {
          summary.local += 1
          continue
        }
        summary.remote += 1
        const video = tile.querySelector('[data-testid="participant-video"]')
        if (video && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
          summary.remotePlaying += 1
        }
      }
      return summary
    }, SEL),

  leave: async ({ page, log }) => {
    // Called for every bot on teardown, including ones that never got in.
    if (!(await page.locator(SEL.leaveButton).isVisible().catch(() => false))) return
    await page.locator(SEL.leaveButton).click({ timeout: 5000 })
    const confirm = page.locator(SEL.leaveConfirm)
    const appeared = await confirm
      .waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true)
      .catch(() => false)
    if (appeared) await confirm.click({ timeout: 3000 })
    log.info('left the call')
  },
}
