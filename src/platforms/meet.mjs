import { meetPageCommand } from './meet-page.mjs'

// Google Meet — as a guest.
//
// A Meet bot joins anonymously: it types a name and asks to be let in, the way
// Aloqa guests do, and needs no account at all. (Signed-in account bots were a
// second way in until 2026-09-03; they needed one Google account per bot and
// a profile store to manage, and were removed for it.)
//
// Guest access depends on the meeting's access settings and, for Workspace,
// the administrator's policy. Open meetings can admit guests directly;
// others require the host or refuse anonymous entry. Read Meet's response
// instead of inferring access from the organizer's account type.
//
// Meet has no test ids and re-renders constantly, so this adapter never walks a
// fixed script. It reads the page once per tick — one evaluate, one forced
// layout — decides which of a handful of known screens it is looking at, and
// acts on that. A screen nobody anticipated shows up as `loading` and simply
// times out with the text Meet put on it, rather than hanging on a selector.

// Reaching the pre-join screen: a link that resolves at all resolves fast.
const ENTRY_TIMEOUT = 60_000
// After clicking "Join now". Direct entry is near-instant, so a minute here
// means something is wrong — and reporting that in a minute matters, because
// the alternative is the ten-minute lobby budget below and a message about
// admission that never applied.
const JOIN_TIMEOUT = 60_000
// The lobby parks a bot until a host clicks Admit, which takes as long as it
// takes someone to notice. Same reasoning as Aloqa: a bot waiting to be let in
// is doing exactly the right thing, and it gets admitted later anyway.
const ADMISSION_TIMEOUT = 600_000
const TOGGLE_TIMEOUT = 8_000
// Opening the present menu and publishing takes longer than a mute toggle.
const SHARE_TIMEOUT = 15_000

// Two cadences, because the two waits are nothing alike: entry resolves in
// seconds and deserves a fast poll, while the lobby is a human-scale wait and
// polling it four times a minute is plenty. At 500ms a full lobby wait would
// cost 1200 page reads on the machine the rest of this app warns is overloaded.
const POLL_FAST = 500
const POLL_LOBBY = 2_000

// Measured against live Google Meet on 2 Sep 2026, not assumed:
//
// rtc — WORKS, and it is the one that matters: the camera watchdog and the
//   dark-camera heal ladder run on it. A guest window reads its stats out of
//   chrome://webrtc-internals on Mac (see guest-browser.mjs). Linux captures
//   peer connections at document start and uses the shared stream monitor.
//
// screen — WORKS, for a guest. It did not for the signed-in account bots that
//   used to live here: those had our capture shim answering getDisplayMedia,
//   and Meet's own bundle threw DisconnectedError on the track it was handed,
//   on two separate meetings. A guest window has no shim — Meet asks Chrome
//   itself, Chrome picks the bot's scene tab by title without a picker, and
//   Meet presents it. Measured live: the presentation controls appear and a
//   second outbound video goes on the wire beside the camera.
//
// codecs — DOES NOT WORK. Meet negotiates its own list and then picks AV1 from
//   it whatever the preference says: a runtime switch to vp9 and a launch-time
//   h264 both left AV1 on the wire. Both are reported honestly rather than
//   silently ignored, but a control that can never land is not a control.
//   (If this is ever turned on, note that Guest's last resort for a codec that
//   will not settle is a rejoin — and a Meet rejoin puts the bot back in the
//   waiting room, so it would need a way to opt out of that.)
export const capabilities = Object.freeze({
  mic: true,
  camera: true,
  screen: true,
  rtc: true,
  codecs: false,
  volume: true,
})

export const SEL = {
  // A guest types a name here; a signed-in profile is never asked for one, so
  // for an account bot this field appearing IS the signed-out signal. The bare
  // text input is a last resort — Meet's pre-join screen has no other one.
  anonymousName:
    'input[aria-label*="your name" i], input[placeholder*="your name" i], input[type="text"]',
  leaveButton: '[aria-label*="Leave call" i], [aria-label*="Leave the call" i]',
  // data-is-muted is the reliable seam and is preferred when present; the
  // aria-label fallbacks cover surfaces Meet renders without it.
  mic: '[data-is-muted][aria-label*="microphone" i], button[aria-label*="microphone" i], [role="button"][aria-label*="microphone" i]',
  cam: '[data-is-muted][aria-label*="camera" i], button[aria-label*="camera" i], [role="button"][aria-label*="camera" i]',
  present: '[aria-label*="Present now" i], [aria-label*="Share screen" i]',
  // Measured live while a guest presented: the button that stops it carries no
  // aria-label at all — its text reads "cancel_presentationStop presenting",
  // the icon ligature glued to the words — so it is clicked by name below. The
  // toolbar's "You are presenting" is what states the share is running.
  stopPresent:
    '[aria-label*="Stop presenting" i], [aria-label*="Stop sharing" i], [aria-label*="You are presenting" i]',
  tile: '[data-participant-id]',
}

// Accessible-name patterns. Playwright's getByRole resolves both a text label
// and an aria-label, which is what makes these work across Meet's mix of real
// buttons and role="button" divs.
// Unanchored on purpose: Meet appends a keyboard hint to the accessible name
// of the join button, so anything anchored to the end of it misses.
const JOIN_NAME = /join now|ask to join|switch here|join anyway/iu
const ASK_NAME = /ask to join/iu
// These two stay anchored. An unanchored "close" or "reject" would match half
// the controls in the call and start clicking things nobody asked for.
const DISMISS_NAME = /^\s*(?:got it|dismiss|no thanks|not now)\s*$/iu
const CONSENT_NAME = /^\s*(?:reject all|reject|decline all)\s*$/iu
// Accepting this joins the call publishing nothing at all, which is precisely
// the failure this app exists to make visible. Never click it — recognising it
// is how a device fault gets reported as a device fault.
const NO_DEVICES_NAME = /continue without (?:microphone|mic|camera)/iu
// Its opposite, and the one to click. A guest window gets asked this outright
// rather than inheriting a granted permission, and a bot that never answers is
// left looking at the refusal the dialog is sitting on top of.
const USE_DEVICES_NAME = /\buse\b[^.]{0,20}\b(?:microphone|camera)\b/iu

const REFUSALS = [
  /You can'?t join this (?:video )?call/iu,
  /denied your request/iu,
  /No one responded to your request/iu,
  /Check your meeting code/iu,
  /Your?'?ve been removed/iu,
  /You'?ve been removed/iu,
  /removed from the (?:meeting|call)/iu,
  /not allowed to join/iu,
  /meeting is full/iu,
  /call is full/iu,
  /Your browser (?:is ?n'?t|is not) supported/iu,
  /This meeting (?:has ended|is over)/iu,
  /Return to home screen/iu,
]

const SIGNED_OUT = /Sign in to (?:join|continue)|Choose an account to continue|Use your Google Account/iu
const LOBBY = /Asking to be let in|Waiting for (?:the host|someone)|You'?ll join(?: the call)? when someone lets you in|let you in|Please wait until a meeting host brings you into the call/iu
const DEVICE_TROUBLE = /(?:camera|microphone) is (?:in use|blocked|not available)|no camera found|can'?t (?:find|use) your (?:camera|microphone)/iu

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/u
const ALIAS_RE = /^(?:lookup|_meet)\/([A-Za-z0-9._~%-]{1,120})$/u

// meet.google.com is ours whatever the path, so a wrong shape throws with an
// example rather than falling through to Aloqa's catch-all matcher.
const parse = (url) => {
  if (url.hostname !== 'meet.google.com') return null
  // Meet prefixes account-scoped URLs with /u/<n>; the profile holds exactly
  // one account, so the prefix carries no information for us.
  const path = url.pathname.replace(/^\/u\/\d+/u, '').replace(/^\/+|\/+$/gu, '')
  const code = path.toLowerCase()
  const alias = path.match(ALIAS_RE)
  const slug = CODE_RE.test(code) ? code : alias ? `${alias[0]}` : null
  if (!slug) {
    throw new Error(
      `expected a Meet link like meet.google.com/abc-defg-hij, got ${url.pathname || '/'}`,
    )
  }
  // hl pins the URL language. No authuser: a guest has no account for it to
  // select, and a profile has exactly one, so it can only ever be wrong.
  return {
    origin: url.origin,
    url: `${url.origin}/${slug}?hl=en`,
    callId: CODE_RE.test(code) ? code : (alias?.[1] ?? slug),
  }
}

// Smart quotes normalised so the patterns above can spell it "can't".
const plain = (value) => String(value ?? '').replace(/[‘’ʼ]/gu, "'")

const refusalIn = (headline) => {
  const text = plain(headline)
  for (const pattern of REFUSALS) {
    if (!pattern.test(text)) continue
    return (text.split('\n').find((line) => pattern.test(line)) ?? text).trim().slice(0, 180)
  }
  return null
}

// A signed-in Meet page renders in the ACCOUNT's language, which overrides the
// hl in the link. Structural signals still work there, so a page that clearly
// has Meet's device toggles but matches none of the English controls is a
// language problem, not a broken selector — and saying so beats timing out.
const looksNonEnglish = (read) =>
  !read.leave &&
  !read.joinButton &&
  !read.nameField &&
  (read.mic !== 'unknown' || read.cam !== 'unknown')

// Meet answers a code it will not open by quietly landing the account on its
// own home screen instead of saying anything. Left unrecognised that is a
// sixty-second wait ending in "the preview never appeared", which sends the
// user looking at the adapter instead of at their meeting code.
const HOME_PATH = /^\/(?:u\/\d+\/)?(?:home)?$/u

const classify = (read, url) => {
  if (read.leave) return { stage: 'in-call' }

  let host = ''
  let path = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    path = parsed.pathname
  } catch {}
  if (host === 'accounts.google.com') return { stage: 'signin' }
  // The same field means opposite things to the two kinds of bot: a guest is
  // being asked to introduce itself, an account bot has lost its session. Meet
  // leaves the field on screen after it is filled, so only an EMPTY one is
  // still asking — otherwise a guest retypes its name forever.
  if (read.nameField && !read.named) return { stage: 'name-entry' }
  if (host === 'meet.google.com' && HOME_PATH.test(path)) {
    return {
      stage: 'refused',
      detail: 'Meet sent this account to its home screen — check the meeting code, ' +
        'or invite this account to the meeting',
    }
  }
  if (SIGNED_OUT.test(plain(read.headline))) return { stage: 'signin' }

  // Before the refusal check: Meet draws this dialog OVER whatever is
  // underneath, so the page can read as refused while the only thing actually
  // wrong is that nobody answered the question.
  if (read.useDevices) return { stage: 'devices-ask' }

  const refusal = refusalIn(read.headline)
  if (refusal) return { stage: 'refused', detail: refusal }
  if (read.offline) return { stage: 'offline' }

  // Recognised before the join button, because Meet renders this dialog OVER
  // the pre-join screen and the join button underneath it stays visible.
  // Meet offers this on the ordinary pre-join screen, beside working device
  // toggles, and offers it during the load before those toggles exist. It is a
  // fault only when nothing else is on offer and no device ever appears — which
  // the join loop decides by waiting, not by one reading.
  if (read.noDevices && !read.useDevices && read.mic === 'unknown' && read.cam === 'unknown') {
    return { stage: 'maybe-no-devices' }
  }
  if (DEVICE_TROUBLE.test(plain(read.headline))) return { stage: 'no-devices' }
  if (read.consent) return { stage: 'consent' }
  if (LOBBY.test(plain(read.headline))) return { stage: 'lobby' }
  if (read.joinButton) return { stage: 'prejoin' }
  return { stage: 'loading' }
}

// Shared DOM commands: static extension code on Linux, Apple Events on macOS.
const pageCommand = async (page, command, args = {}) => {
  const input = {
    ...args,
    selectors: SEL,
    patterns: {
      join: JOIN_NAME.source, ask: ASK_NAME.source, dismiss: DISMISS_NAME.source,
      consent: CONSENT_NAME.source, noDevices: NO_DEVICES_NAME.source,
      useDevices: USE_DEVICES_NAME.source, lobby: LOBBY.source,
    },
  }
  if (page.meetCommand) return page.meetCommand(command, input)
  const source = `JSON.stringify((${meetPageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(input)}))`
  // aesend carries JavaScript as a raw Apple Event string (not an AppleScript
  // string literal), so preserve newlines and JavaScript's statement boundaries.
  const raw = await page.evaluate(source)
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { throw new Error(`Meet page command failed: ${raw.slice(0, 160)}`) }
}
const readPage = (page, { withText = false } = {}) => pageCommand(page, 'read', { withText })
const clickNamed = (page, pattern) => pageCommand(page, 'click-name', { pattern: pattern.source }).then((value) => value === true).catch(() => false)
const clickSelector = (page, selector) => pageCommand(page, 'click-selector', { selector }).then((value) => value === true).catch(() => false)
const typeName = (page, name) => pageCommand(page, 'type-name', { name: String(name ?? '') }).then((value) => value === true).catch(() => false)

// ---------------------------------------------------------------------------
// Devices.

const deviceState = async (page, which) => {
  const read = await readPage(page).catch(() => null)
  if (!read) return 'unknown'
  return which === 'mic' ? read.mic : read.cam
}

const setDevice = async ({ page, log }, kind, which, on) => {
  const selector = which === 'mic' ? SEL.mic : SEL.cam
  let current = await deviceState(page, which)
  // Meet draws the toolbar a beat after the leave control that marks the call
  // as joined; a toggle asked for in that beat is not missing, just late. A
  // page that has closed will never draw it, and waiting five seconds per
  // device on a bot that is already gone only delays a teardown.
  for (let waited = 0; current === 'unknown' && waited < 5_000; waited += 250) {
    if (page.isClosed?.()) return 'unknown'
    await page.waitForTimeout(250)
    current = await deviceState(page, which)
  }
  if (current === 'request') {
    log.warn(`${kind} is host-restricted — cannot toggle`)
    return 'request'
  }
  if (current === 'unknown') {
    log.warn(`${kind} button not found — not in the Meet call?`)
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want

  if (!(await clickSelector(page, selector))) {
    log.warn(`${kind} button did not accept a click`)
    return deviceState(page, which)
  }

  const deadline = Date.now() + TOGGLE_TIMEOUT
  while (Date.now() < deadline) {
    const state = await deviceState(page, which)
    if (state === want) return want
    if (state === 'request') {
      log.warn(`${kind} was taken over by the host mid-toggle`)
      return 'request'
    }
    await page.waitForTimeout(150)
  }
  log.warn(`${kind} did not reach "${want}" within ${TOGGLE_TIMEOUT}ms`)
  return deviceState(page, which)
}

// ---------------------------------------------------------------------------
// Screen share.
//
// Both native drivers share their own scene tab using Chrome's tab capture.

const screenOf = (read) => {
  if (read.presenting) return 'on'
  if (read.canPresent) return 'off'
  // In the call with no present control at all is Meet saying the host turned
  // presenting off for everyone.
  return read.leave ? 'blocked' : 'unknown'
}

const screenState = async (page) => {
  const read = await readPage(page).catch(() => null)
  return read ? screenOf(read) : 'unknown'
}

// All three controls from one read. The dashboard asks for every bot every
// couple of seconds, and for a guest each read is an Apple Event through a
// channel that carries one at a time: three reads a bot a poll is what
// congested it with three guests until every probe timed out.
const controls = async (page) => {
  const read = await readPage(page).catch(() => null)
  if (!read) return { mic: 'unknown', cam: 'unknown', screen: 'unknown' }
  return { mic: read.mic, cam: read.cam, screen: screenOf(read) }
}

const setScreen = async (ctx, on) => {
  const { page, log } = ctx
  const current = await screenState(page)
  if (current === 'blocked') {
    log.warn('this call does not allow presenting — the host restricted it')
    return 'blocked'
  }
  if (current === 'unknown') {
    log.warn('present control not found — not in the Meet call?')
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want

  if (!on) {
    if (!(await clickNamed(page, STOP_NAME))) await clickSelector(page, SEL.stopPresent)
  } else {
    await ctx.prepareScreen()
    await page.beginScreenCapture?.()
    if (!(await clickSelector(page, SEL.present))) {
      log.warn('the present control did not accept a click')
      return screenState(page)
    }
    await clickNamed(page, /a tab|chrome tab|entire screen|a window/iu)
  }

  const deadline = Date.now() + SHARE_TIMEOUT
  while (Date.now() < deadline && !page.isClosed()) {
    if ((await screenState(page)) === want) return want
    await page.waitForTimeout(300)
  }
  log.warn(`screen share did not reach "${want}" in time`)
  return screenState(page)
}

// The stop control is named, not labelled — see SEL.stopPresent.
const STOP_NAME = /^(?:cancel_presentation)?stop (?:presenting|sharing)$/iu

const REFUSED_GUEST =
  'this meeting is refusing anonymous guests. Ask the host to allow guests ' +
  'in the meeting access settings and admit the bot; a Workspace administrator ' +
  'may also restrict guest access.'

const join = async (ctx) => {
  const { page, target, log, fail, options, setWaitingAdmission, displayName } = ctx
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    await fail(
      'entry',
      /timeout/iu.test(error.message)
        ? 'the Meet page did not load in time — this machine may be overloaded'
        : error.message,
    )
  }

  let phase = 'entry' // entry -> joining -> lobby
  let deadline = Date.now() + ENTRY_TIMEOUT
  let armed = false
  let dismissals = 0
  let nonEnglishSince = null
  let noDevicesSince = null
  let clickedAt = 0
  let sawMeet = false // anything but a blank page, ever
  let reloaded = false
  let loadingSince = null

  for (;;) {
    // A bot closed while it was still joining — a Stop mid-batch, a card
    // removed — must end here rather than poll a window that is gone. Every
    // read of a closed page fails, and every failure was treated as "try
    // again next tick", so the loop ran on to its deadline: ten minutes for a
    // bot in the lobby, with the roster's teardown waiting on this promise the
    // whole time. Stop sat at "stopping" until it gave up, measured at over
    // two minutes with nothing left to do.
    if (page.isClosed?.()) {
      setWaitingAdmission?.(false)
      throw new Error(`[${displayName}] closed while it was joining`)
    }

    if (Date.now() > deadline) {
      setWaitingAdmission?.(false)
      const message =
        phase === 'lobby'
          ? 'nobody admitted this guest — admit it in Meet, or allow guest access'
          : phase === 'joining'
            ? 'Meet accepted the click but the call never opened'
            : 'the Google Meet preview never appeared (wrong link, blocked account, or changed UI)'
      await fail(phase === 'entry' ? 'entry' : 'join', message)
    }


    // A page that has drawn nothing by the halfway mark gets one more load:
    // a request Meet dropped on the way in, or a window still on its new-tab
    // page, otherwise costs the full minute and ends in a message that blames
    // the link. Only ever for a page that showed nothing at all; a preview
    // that is slow to finish is not reloaded out from under the bot. Before
    // the read, because a page that cannot be read at all is the case.
    if (phase === 'entry' && !sawMeet && !reloaded && Date.now() > deadline - ENTRY_TIMEOUT / 2) {
      reloaded = true
      log.info('Meet has drawn nothing yet — loading the page again')
      await page.goto(target.url, { waitUntil: 'domcontentloaded' }).catch(() => {})
    }

    const read = await readPage(page, { withText: true }).catch(() => null)
    if (!read) {
      // The page went away under us mid-read; the next tick either finds it
      // again or runs out the clock with a real message.
      await page.waitForTimeout(POLL_FAST)
      continue
    }
    // Sync on a Playwright page, async on a guest window.
    const url = await Promise.resolve(page.url()).catch(() => '')
    const { stage, detail } = classify(read, url)
    if (stage === 'loading') loadingSince ??= Date.now()
    else loadingSince = null
    // Occasionally Meet returns to "Getting ready" after a join click and
    // never opens a lobby. Retry that stalled load once; a real admission
    // wait is a different stage and must be left alone.
    if (loadingSince && Date.now() - loadingSince > JOIN_TIMEOUT && !reloaded) {
      reloaded = true
      log.info('Meet stopped loading — opening the meeting again')
      setWaitingAdmission?.(false)
      phase = 'entry'
      armed = false
      clickedAt = 0
      loadingSince = null
      await page.goto(target.url, { waitUntil: 'domcontentloaded' })
      deadline = Date.now() + ENTRY_TIMEOUT
      continue
    }
    if (stage !== 'loading') sawMeet = true
    if (process.env.CALL_BOTS_DEBUG_MEET) {
      console.error('[meet]', stage, JSON.stringify({ ...read, headline: read.headline.slice(0, 90) }))
    }

    if (stage === 'in-call') {
      setWaitingAdmission?.(false)
      // Meet greets a fresh profile with onboarding cards that sit over the
      // controls the rest of this adapter needs to click.
      if (read.dismissible && dismissals < 4) {
        dismissals += 1
        await clickNamed(page, DISMISS_NAME)
      }
      return { callId: target.callId }
    }

    if (stage === 'signin') {
      // A guest being asked to sign in has been turned away, not logged out —
      // there is no session here to have expired.
      await fail('entry', REFUSED_GUEST)
    }

    if (stage === 'devices-ask') {
      await clickNamed(page, USE_DEVICES_NAME)
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'name-entry') {
      // Meet remembers the name, so a second pass finds the field already
      // filled; fill() replaces rather than appends.
      if (!(await typeName(page, displayName))) {
        await fail('entry', 'the Google Meet name field would not take a name')
      }
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'refused') {
      setWaitingAdmission?.(false)
      const why = /can'?t join this/iu.test(detail ?? '')
        ? REFUSED_GUEST
        : `Google Meet refused this guest: ${detail}`
      await fail(phase === 'entry' ? 'entry' : 'join', why)
    }

    if (stage === 'offline') {
      // Worth its own message: "the preview never appeared" sends someone
      // hunting through Meet for a fault that is on this machine.
      await fail('entry', 'this machine lost its network connection — Meet cannot load')
    }

    // Held for a while before it counts: the offer shows up mid-load, before
    // Meet has drawn the device toggles that prove there was never a fault.
    if (stage === 'maybe-no-devices') {
      noDevicesSince ??= Date.now()
      if (Date.now() - noDevicesSince < 15_000) {
        await page.waitForTimeout(POLL_FAST)
        continue
      }
    } else {
      noDevicesSince = null
    }

    if (stage === 'no-devices' || stage === 'maybe-no-devices') {
      await fail(
        'entry',
        'Chrome gave this bot no camera or microphone — Meet offered to join without them, ' +
          'which would put a silent invisible bot in the call',
      )
    }

    if (stage === 'consent') {
      await clickNamed(page, CONSENT_NAME)
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'prejoin') {
      if (read.dismissible && dismissals < 4) {
        dismissals += 1
        await clickNamed(page, DISMISS_NAME)
        continue
      }
      // Meet remembers the last device state per profile, so set what was asked
      // for BEFORE entry — otherwise admission briefly publishes the wrong one.
      // Guest re-asserts both once the in-call controls exist.
      if (!armed) {
        armed = true
        if (!options.noVideo) await setDevice(ctx, 'camera', 'cam', options.startCam !== false)
        if (!options.noAudio) await setDevice(ctx, 'mic', 'mic', options.startMic !== false)
      }
      // Read the label from THIS tick, not from before the click: Meet swaps
      // "Join now" for "Ask to join" while it is still resolving membership,
      // and a stale read leaves a bot sitting in a lobby nobody is told about.
      const asking = read.askToJoin
      // One click, then let Meet work. Still sitting on the pre-join screen
      // eight seconds later means the click did not take, and re-clicking is
      // the recovery — but firing it every tick is not.
      if (Date.now() - clickedAt > 8_000 && (await clickNamed(page, JOIN_NAME))) {
        clickedAt = Date.now()
        if (phase === 'entry') {
          phase = asking ? 'lobby' : 'joining'
          deadline = Date.now() + (asking ? ADMISSION_TIMEOUT : JOIN_TIMEOUT)
          if (asking) {
            setWaitingAdmission?.(true)
            log.info('waiting in the Google Meet lobby — admit this guest')
          } else {
            log.info('joining Google Meet')
          }
        }
      }
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'lobby' && phase !== 'lobby') {
      // Direct entry that turned into a wait after the fact: Meet decided this
      // account needs admitting only once it had the click.
      phase = 'lobby'
      deadline = Date.now() + ADMISSION_TIMEOUT
      setWaitingAdmission?.(true)
      log.info('waiting in the Google Meet lobby — admit this guest')
    }

    if (stage === 'loading' && looksNonEnglish(read)) {
      nonEnglishSince ??= Date.now()
      if (Date.now() - nonEnglishSince > 15_000) {
        await fail(
          'entry',
          'Meet is not in English here, and Call Bots reads its English controls — ' +
            'the bots\' browser is started in English, so this is a Meet quirk worth a report',
        )
      }
    } else {
      nonEnglishSince = null
    }


    await page.waitForTimeout(phase === 'lobby' ? POLL_LOBBY : POLL_FAST)
  }
}

const remote = (page) => pageCommand(page, 'remote')

export default {
  id: 'meet',
  label: 'Google Meet',
  capabilities,
  armAfterJoin: true,
  parse,
  join,
  micState: (page) => deviceState(page, 'mic'),
  camState: (page) => deviceState(page, 'cam'),
  setMic: (ctx, on) => setDevice(ctx, 'mic', 'mic', on),
  setCam: (ctx, on) => setDevice(ctx, 'camera', 'cam', on),
  screenState,
  controls,
  setScreen,
  remote,
  leave: async ({ page, log }) => {
    // Called for every bot on teardown, including ones that never got in.
    if (await clickSelector(page, SEL.leaveButton)) log.info('left Google Meet')
  },
}
