import { readFile } from 'node:fs/promises'

import { launchGuest } from './browser.mjs'
import { installAudioControl, volumePercent } from './audio.mjs'
import { guestColorHex } from './fixtures.mjs'
import { failureReport, failureShot, mkLogger } from './log.mjs'
import { platformById } from './platforms/index.mjs'
import { installMonitor, rtcSnapshot, rtcSummary } from './rtc.mjs'
import { screenHtml, screenVideoPath } from './screen.mjs'

// What each codec role is called when a bot has to explain itself.
const ROLE_WORD = { audio: 'microphone', video: 'camera', screen: 'screenshare' }

// A camera that has published nothing for this long is not having a blip.
// Several monitor ticks, so a momentary 0 between keyframes cannot trip it.
const DARK_MS = 12_000
// Escalation, cheapest first — but only among steps that actually work. A
// republish used to lead, on the reasoning that it is the gentlest fix; across
// every wedge seen in the wild it healed nothing (0 of 7) while costing the bot
// a further window of darkness, so it is gone. Recycling the camera goes
// through the app's own buttons and has healed every wedge it met. A rejoin is
// the only step that rebuilds the peer connection, which is what a wedge takes
// down with it: the connection's bandwidth estimate collapses too (5 kbps was
// measured on a wedged bot), so anything published into the same connection has
// nothing to send with.
const HEAL_STEPS = ['recycle', 'rejoin']
export const DARK_NOTE = 'camera is publishing nothing — the call cannot see this bot'

// What to do about a bot's outbound video this tick. Pure: all the state it
// needs is passed in and all the state it changes is returned, so the part
// worth getting right can be tested without a browser or a call.
export const videoHealthStep = ({ inCall, camOn, upV, darkSince, attempts, now }) => {
  // Nothing to judge — not in the call, camera deliberately off, or no stats
  // yet. A bot that has not been measured is not a bot that is failing.
  if (!inCall || !camOn || upV === null || upV === undefined) {
    return { action: 'none', darkSince: null, attempts: 0 }
  }
  if (upV > 0) return { action: 'none', darkSince: null, attempts: 0 }
  const since = darkSince ?? now
  if (now - since < DARK_MS) return { action: 'none', darkSince: since, attempts }
  if (attempts >= HEAL_STEPS.length) {
    // Out of moves: say so once, then stop rather than thrash a bot that is
    // never coming back on its own.
    if (attempts === HEAL_STEPS.length) {
      return { action: 'giveup', darkSince: since, attempts: attempts + 1 }
    }
    return { action: 'none', darkSince: since, attempts }
  }
  // Each attempt restarts the clock, so the next escalation gets a full window
  // to see whether the last one worked.
  return { action: HEAL_STEPS[attempts], darkSince: now, attempts: attempts + 1 }
}

// Which of a bot's outbound stream rows belong to one codec role.
const roleStream = (role) => (stream) => {
  if (role === 'audio') return stream.kind === 'audio'
  if (role === 'screen') return stream.kind === 'video' && stream.role === 'screen'
  return stream.kind === 'video' && stream.role !== 'screen'
}

// One participant: an anonymous guest, in Aloqa or in Google Meet. Everything
// platform-specific — how to get in, where the device toggles are, how to read
// the participant grid — lives in the adapter under src/platforms; this class
// only sequences it.
export class Guest {
  constructor(guest, media, options) {
    this.user = guest // {n, label, slug, index}
    this.media = media
    this.options = options
    this.volume = 100
    this.volumeRevision = 0
    this.audioSetting = { volume: 100, revision: 0 }
    this.volumeQueue = Promise.resolve()
    // Preferred send codecs by role; null means the platform's own default.
    // A per-guest object on purpose: every guest of a batch shares one options
    // reference, and a runtime switch must never leak to the siblings.
    this.codecs = {
      audio: options.audioCodec ?? null,
      video: options.videoCodec ?? null,
      screen: options.screenCodec ?? null,
    }
    this.log = mkLogger(guest.label, guest.index)
    this.state = 'created'
    this.meetingId = null
    this.browser = null
    this.context = null
    this.page = null
    this.lastError = null
    this.waitingAdmission = false
    this.platform = null
    this.closeBrowser = null
    this.screenPage = null
    this.monitorInstall = null // in-flight stream-monitor install, so retries dedupe
    this.monitorWarned = false // warn once per breakage, not every status tick
    // Last device+stats read, whoever made it. The dashboard's poll and the
    // roster's health tick share it, so having the window open costs the
    // watchdog nothing and having it closed does not stop the watchdog.
    this.health = null
    // What the camera was last ASKED to be, so a camera that is off because
    // something dropped it can be told apart from one somebody turned off.
    this.wantCam = null
    this.camIntentAt = 0 // when wantCam last changed; a read older than this is not judged
    this.camFixAttempts = 0
    this.videoDarkSince = null // when the camera last stopped reaching anyone
    this.videoHealAttempts = 0
    this.healing = false // one heal at a time; the poll must never queue them
    // Claimed synchronously on entry to pollHealth. `healing` is set only
    // after two awaited page reads, and under load those can outlast the tick
    // interval — two ticks would then both pass the guard and spend an
    // escalation step each on the same fault.
    this.polling = false
    // Set when the bot is in the call but not doing what was asked of it —
    // a launch codec that turned out to send nothing, say. Not an error: the
    // bot works, just not on the codec it was sent with.
    this.note = null
  }

  get label() {
    return this.user.label
  }

  // Meet has a native driver (Apple Events on Mac, a fixed-command extension
  // on Linux). Only the Aloqa Playwright context supports arbitrary page
  // instrumentation; Meet supplies its own stats, thumbnails and controls.
  get instrumented() {
    return Boolean(this.context)
  }

  async start(target) {
    this.startAbort = new AbortController()
    const platform = platformById(target?.platform)
    if (!platform) throw new Error(`no adapter for platform "${target?.platform}"`)
    this.platform = platform
    this.target = target
    const launched = await launchGuest(this.user, this.media, {
      ...this.options, signal: this.startAbort.signal, readVolume: () => ({ ...this.audioSetting }),
      windowsVisible: () => Boolean(this.options.headed),
    }, this.codecs)
    this.browser = launched.browser
    this.context = launched.context
    this.page = launched.page
    this.closeBrowser = launched.close
    if (platform.capabilities?.volume && !this.options.noAudio && this.context) {
      try {
        await installAudioControl(this.context, () => ({ ...this.audioSetting }))
      } catch (error) {
        await this.#closeBrowserProcess()
        throw error
      }
    }
    this.state = 'ready'
  }

  get volumeAvailable() {
    return this.platform?.capabilities?.volume === true && !this.options.noAudio &&
      (this.instrumented || this.page?.audioControlReady === true) && Boolean(this.page) && !this.page.isClosed()
  }

  setVolume(value) {
    const volume = volumePercent(value)
    // Bulk and per-card requests may overlap. Commit only acknowledged changes,
    // in order, so an older completion cannot overwrite a newer setting.
    const operation = this.volumeQueue.then(async () => {
      if (!this.volumeAvailable || this.state !== 'in-call') {
        throw new Error('outgoing volume is unavailable for this bot')
      }
      const page = this.page
      const apply = (setting) => typeof page.setVolume === 'function' ? page.setVolume(setting)
        : page.evaluate(async (value) => {
          if (!window.__botSetVolume__) throw new Error('audio volume control is unavailable in this page')
          return window.__botSetVolume__(value)
        }, setting)
      const next = { volume, revision: this.audioSetting.revision + 1 }
      // Captures started during this operation must see the pending setting.
      // A failed/late acknowledgement is rolled back with a newer revision,
      // so an old page reply can never overwrite the confirmed value.
      this.audioSetting = next
      try {
        const applied = await apply(next)
        if (page !== this.page || page.isClosed() || applied?.volume !== volume || applied.revision !== next.revision) {
          throw new Error('the microphone did not accept the volume change')
        }
      } catch (error) {
        this.audioSetting = { volume: this.volume, revision: next.revision + 1 }
        this.volumeRevision = this.audioSetting.revision
        await apply(this.audioSetting).catch(() => {})
        throw error
      }
      this.volume = volume
      this.volumeRevision = next.revision
      return { ok: true, ...next }
    })
    this.volumeQueue = operation.catch(() => {})
    return operation
  }

  // Evidence for a failure, in whatever form this bot's page can give it: a
  // screenshot from a Playwright page, and from a Meet guest window — which
  // has no debugger to photograph it — a written record of what Meet showed.
  async #shot(name) {
    if (this.instrumented) return failureShot(this.page, this.options.runDir, this.user.slug, name)
    if (typeof this.page?.report !== 'function') return null
    const body = await this.page.report().catch(() => null)
    return body ? failureReport(this.options.runDir, this.user.slug, name, body) : null
  }

  #fail = async (name, message, { screenshot = true } = {}) => {
    // A bot closed mid-step fails at whatever it was doing, and the step's own
    // message blames the call platform for it: "the name field would not take
    // a name" is what a Stop during the name screen used to report. Say what
    // happened instead, and take no evidence from a page that is gone.
    const closed = Boolean(this.page?.isClosed?.())
    const shot = screenshot && !closed ? await this.#shot(name) : null
    if (closed) message = 'closed while it was joining'
    this.state = `error:${name}`
    this.lastError = message
    // A failure can race a teardown that has already dropped the page, and an
    // error handler that throws its own TypeError loses the real message.
    // A guest window reports its URL asynchronously; a Playwright page does not.
    const where = await Promise.resolve(this.page?.url?.() ?? 'page closed').catch(
      () => 'page closed',
    )
    const evidence = shot ? `, ${this.instrumented ? 'screenshot' : 'page report'}: ${shot}` : ''
    throw new Error(`[${this.label}] ${message} (url: ${where}${evidence})`)
  }

  // The context the adapter works against.
  #ctx(target) {
    return {
      page: this.page,
      target: target ?? this.target,
      displayName: this.label,
      log: this.log,
      fail: this.#fail,
      options: this.options,
      setWaitingAdmission: (waiting) => {
        this.waitingAdmission = Boolean(waiting)
      },
      prepareScreen: () => this.#prepareScreen(),
    }
  }

  async join(target) {
    const platform = this.platform ?? platformById(target.platform)
    if (!platform) throw new Error(`no adapter for platform "${target.platform}"`)
    this.platform = platform
    this.target = target
    this.state = 'joining'

    const { callId } = await platform.join(this.#ctx(target))
    this.meetingId = callId ?? null
    this.state = 'in-call'

    // Set both devices to what was asked for rather than assuming a bot arrives
    // with them off: coming through an admission lobby it may not, and a bot
    // sent in muted that quietly publishes audio is worse than one that fails.
    // The clips stay attached either way, so a camera switched on later still
    // shows real footage rather than Chrome's default pattern.
    if (platform.armAfterJoin) {
      if (!this.options.noVideo) {
        await this.setCam(this.options.startCam !== false).catch(() => 'unknown')
      }
      if (!this.options.noAudio) {
        await this.setMic(this.options.startMic !== false).catch(() => 'unknown')
      }
      await this.#settleDevices()
    }
    // After the devices settle, so the injection never competes with the
    // arming clicks. Losing the monitor is not losing the bot.
    if (platform.capabilities?.rtc !== false && this.instrumented) {
      await this.#ensureMonitor().catch(() => {})
      // The join navigated, and navigation re-seeds the page with the LAUNCH
      // codec preferences — anything switched while this bot was still on its
      // way has to be pushed again now that the call page is settled.
      await this.#syncCodecs().catch(() => {})
      // Only now can the wire be read, so only now can a launch codec be judged.
      await this.#proveLaunchCodecs().catch(() => {})
    }
    this.log.info('in call')
  }

  // Installs the vendored stream monitor into the call page. Deduped: the
  // status poll retries through here whenever the page lost it (a navigation,
  // a late admission), and two concurrent installs would re-run the monitor's
  // IIFE, which toggles its panel instead of installing.
  #ensureMonitor() {
    if (this.monitorInstall) return this.monitorInstall
    this.monitorInstall = installMonitor(this.page)
      .then((hidden) => {
        this.monitorWarned = false
        return hidden
      })
      .catch((error) => {
        if (!this.monitorWarned) {
          this.monitorWarned = true
          this.log.warn(`stream monitor install failed: ${error.message}`)
        }
        throw error
      })
      .finally(() => {
        this.monitorInstall = null
      })
    return this.monitorInstall
  }

  // Aloqa can switch a guest's microphone on by itself as the connection
  // finishes, landing after we have already set what was asked for — so a bot
  // sent in muted starts publishing a moment later. Re-assert until it sticks.
  async #settleDevices() {
    const wantCam = this.options.startCam !== false
    const wantMic = this.options.startMic !== false
    let corrected = false
    for (let round = 0; round < 3; round += 1) {
      await this.page.waitForTimeout(1500)
      const [mic, cam] = await Promise.all([
        this.micState().catch(() => 'unknown'),
        this.camState().catch(() => 'unknown'),
      ])
      let drifted = false
      if (!this.options.noAudio && mic !== 'unknown' && mic !== (wantMic ? 'on' : 'off')) {
        await this.setMic(wantMic).catch(() => {})
        drifted = true
      }
      if (!this.options.noVideo && cam !== 'unknown' && cam !== (wantCam ? 'on' : 'off')) {
        await this.setCam(wantCam).catch(() => {})
        drifted = true
      }
      if (!drifted) break
      corrected = true
    }
    if (corrected) this.log.warn('the call changed this bot\'s devices after joining — set them back')
  }

  // --- in-call devices ------------------------------------------------------

  micState() {
    return this.platform ? this.platform.micState(this.page) : Promise.resolve('unknown')
  }

  camState() {
    return this.platform ? this.platform.camState(this.page) : Promise.resolve('unknown')
  }

  // Show or hide the bot's own browser window, where the bot has one to show:
  // a Meet guest is a real window; an Aloqa bot is headless and has none.
  async setWindowVisible(visible) {
    this.options.headed = Boolean(visible)
    if (typeof this.page?.setVisible !== 'function') return false
    await this.page.setVisible(visible)
    return true
  }

  // Every control's state, in one read where the platform offers one.
  async controls() {
    if (!this.platform) return { mic: 'unknown', cam: 'unknown', screen: 'unknown' }
    if (this.platform.controls) return this.platform.controls(this.page)
    const [mic, cam, screen] = await Promise.all([this.micState(), this.camState(), this.screenState()])
    return { mic, cam, screen }
  }

  setMic(on) {
    return this.platform ? this.platform.setMic(this.#ctx(), on) : Promise.resolve('unknown')
  }

  // The watchdog stands down while a toggle is in flight, and its next tick
  // reads fresh: a health read taken just before the click still says the old
  // state, and judged against the new intent it looks like a camera somebody
  // else turned off — which the watchdog would then click a second time.
  async setCam(on) {
    const wasHealing = this.healing
    this.healing = true
    this.camIntentAt = Date.now()
    try {
      return await this.#setCamNow(on)
    } finally {
      this.healing = wasHealing
      this.health = null
      // A tick already in flight read the camera before the click landed.
      this.camIntentAt = Date.now()
    }
  }

  async #setCamNow(on) {
    if (!this.platform) return 'unknown'
    // Intent, recorded before the attempt: whether it lands or not, this is
    // what the camera is meant to be from here on.
    this.wantCam = on
    const state = await this.platform.setCam(this.#ctx(), on)
    // The same republish a share born under a stored preference gets (see
    // setScreen), for the same reason: seeding the preference only shapes the
    // SDP, while the SFU forwards the publication by the codec the client's
    // own publish request named. A camera arriving on a launch-time codec has
    // to go out the LiveKit way to be the codec everyone else receives.
    if (on && state === 'on' && this.codecs.video && this.platform.capabilities?.codecs !== false) {
      await this.#lkSwitch('video', this.codecs.video).catch(() => {})
      // At join this runs before the monitor is installed, so there is nothing
      // to read yet — join() proves the codec a moment later, once there is. A
      // camera switched on from the panel proves itself here and now.
      if (this.monitorInstall) await this.#proveCodec('video').catch(() => {})
    }
    return state
  }

  // --- send codecs ----------------------------------------------------------

  // Preferred send codec for one role: 'audio', 'video' (the camera) or
  // 'screen'. A codec only ever changes through a negotiation the call takes
  // part in — an in-place encoder switch sends fine but the SFU stops
  // forwarding the track, blacking the bot out for every other participant.
  // So: store the preference, offer the page a renegotiation (enough for apps
  // that honour negotiationneeded), and when the app ignores it, make a fresh
  // negotiation happen — restart the share for the screen role, rejoin the
  // call for the others. Result strings ride the same toast path as the other
  // actions.
  // A hand-picked codec is the user's call to make, so a switch that does not
  // land is reported rather than undone. But a toast is gone in seconds and
  // the card would go on showing the codec as though it were working, so the
  // outcome stays on the bot until the next pick.
  async setCodec(role, codec) {
    if (this.platform?.capabilities?.codecs === false) return 'unsupported'
    const result = await this.#applyCodec(role, codec)
    const name = this.codecs[role] ?? codec
    this.note =
      result === 'unsupported'
        ? `this browser cannot send ${name} — the ${ROLE_WORD[role]} is unchanged`
        : result === 'unavailable' || result === 'requested'
          ? `${name} never showed up on the wire for the ${ROLE_WORD[role]} — the stream rows show what the call took`
          : null
    return result
  }

  async #applyCodec(role, codec) {
    if (!['audio', 'video', 'screen'].includes(role)) {
      throw new Error(`unknown codec role "${role}" — audio, video or screen`)
    }
    const wanted = typeof codec === 'string' && codec.trim() ? codec.trim().toLowerCase() : null
    this.codecs = { ...this.codecs, [role]: wanted }
    if (!this.page || this.page.isClosed()) return 'unknown'
    const res = await this.page
      .evaluate((arg) => window.__botSetCodec__?.(arg.role, arg.codec) ?? null, {
        role,
        codec: wanted,
      })
      .catch(() => null)
    if (!res) return 'unknown'
    if (res.ok === false) return res.reason === 'unsupported' ? 'unsupported' : 'unknown'
    if (this.state !== 'in-call') return 'requested'

    // A LiveKit app takes exactly one consistent path: its own republish,
    // where the publish request names the codec and the SFU consents. The
    // shim reaches the Room through the page's component tree.
    const lk = await this.#lkSwitch(role, wanted)
    if (lk.ok) {
      if (wanted === null) return 'default'
      if (await this.#codecSettled(role, wanted, 10_000)) return 'applied'
      return res.negotiated === false ? 'unavailable' : 'requested'
    }
    if (lk.reason === 'unpublishable') return 'unavailable'

    if (role === 'screen') {
      const sharing = await this.screenState().catch(() => 'unknown')
      // Nothing to renegotiate until a share is up; the preference is stored
      // and applied the moment a share starts.
      if (sharing !== 'on') return wanted === null ? 'default' : 'requested'
      if (wanted !== null && (await this.#codecSettled(role, wanted))) return 'applied'
      // A share restart is a fresh publication carrying the preference.
      await this.setScreen(false).catch(() => {})
      await this.setScreen(true).catch(() => {})
      if (wanted === null) return 'default'
      if (await this.#codecSettled(role, wanted, 6000)) return 'applied'
      return res.negotiated === false ? 'unavailable' : 'requested'
    }

    // Apps that renegotiate on demand settle right here, no rejoin needed.
    if (wanted !== null && (await this.#codecSettled(role, wanted))) return 'applied'
    // Last resort: rejoin, so the preference lands at a join negotiation the
    // call itself answers.
    const rejoined = await this.#rejoinWithCodecs()
    if (!rejoined) return 'unknown'
    if (wanted === null) return 'default'
    if (await this.#codecSettled(role, wanted, 8000)) return 'applied'
    return res.negotiated === false ? 'unavailable' : 'requested'
  }

  async #lkSwitch(role, codec) {
    if (!this.page || this.page.isClosed()) return { ok: false, reason: 'no-page' }
    const result = await this.page
      .evaluate(
        (arg) => window.__botLkSwitch__?.(arg.role, arg.codec) ?? { ok: false, reason: 'no-shim' },
        { role, codec },
      )
      .catch(() => ({ ok: false, reason: 'evaluate' }))
    // The switch reports its own repairs; the notable ones belong in the
    // bot's log rather than swallowed with the result. Dead leftovers swept
    // are routine — every switch parks one — and stay quiet; a LIVE stray is
    // the double-ladder incident and is worth a warning. A restored capture
    // explains a resolution jump the panel would otherwise show unprompted.
    if (result.restored) {
      this.log.info('camera capture had degraded — restored to full size before republishing')
    }
    if (result.restoreError) {
      this.log.warn(`could not restore the degraded camera capture: ${result.restoreError}`)
    }
    if (result.swept?.live > 0) {
      this.log.warn(
        `stopped ${result.swept.live} stray sender(s) that were still encoding — a duplicate ladder was forming`,
      )
    }
    return result
  }

  // Leave and come straight back with the CURRENT preferences seeded at
  // document-start: the join offer then carries them, the call answers, and
  // every other participant keeps decoding a codec their side agreed to. The
  // launch-time init script reseeds launch values on navigation, so a fresh
  // script — added later, running later — asserts the runtime ones on top.
  // Devices and an active share are put back the way they were.
  async #rejoinWithCodecs() {
    const mic = await this.micState().catch(() => 'unknown')
    const cam = await this.camState().catch(() => 'unknown')
    const sharing = (await this.screenState().catch(() => 'unknown')) === 'on'
    try {
      // A guest window has no context to seed; its rejoin is a plain leave and
      // join, which is all the watchdog wants from it.
      if (this.context) {
        await this.context.addInitScript((codecs) => {
          if (!window.__botSetCodec__) return
          for (const [role, codec] of Object.entries(codecs)) window.__botSetCodec__(role, codec)
        }, { ...this.codecs })
      }
      await this.leave()
      await this.join(this.target)
    } catch (error) {
      this.log.warn(`rejoin failed: ${error.message}`)
      return false
    }
    if (mic === 'on' || mic === 'off') await this.setMic(mic === 'on').catch(() => {})
    if (cam === 'on' || cam === 'off') await this.setCam(cam === 'on').catch(() => {})
    if (sharing) await this.setScreen(true).catch(() => {})
    return true
  }

  // Polls the monitor snapshot until every outbound stream of the role reports
  // the codec. The monitor ticks once a second, so half-second polls inside a
  // small budget see the flip about as fast as it can be seen. RED never shows
  // in stats — Chrome attributes a RED stream to the opus inside it — so red
  // settles on the negotiated top codec instead.
  async #codecSettled(role, wanted, budgetMs = 2500) {
    const matches = roleStream(role)
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (wanted === 'red') {
        const top = await this.page
          .evaluate((r) => window.__botCodecTop__?.(r) ?? null, role)
          .catch(() => null)
        if (top === 'red') return true
        // The snapshot labels an engaged RED wrap from its payload signature
        // (no state anywhere admits to it) — trust the same label the panel
        // shows.
        const snap = await this.rtcSnapshot()
        const mine = (snap?.outbound ?? []).filter(
          (stream) => stream.kind === 'audio' && (stream.kbps ?? 0) > 0,
        )
        if (
          mine.length > 0 &&
          mine.every((stream) =>
            ['red', 'opus+red'].includes((stream.codec?.name ?? '').toLowerCase()),
          )
        ) {
          return true
        }
      } else {
        const snap = await this.rtcSnapshot()
        // Carrying rows only: a negotiation-based switch starts a fresh
        // stream while the old codec's row lingers at 0 kbps for a few
        // seconds — dying rows must not vote.
        const mine = (snap?.outbound ?? []).filter(
          (stream) => matches(stream) && (stream.kbps ?? 0) > 0,
        )
        if (
          mine.length > 0 &&
          mine.every((stream) => (stream.codec?.name ?? '').toLowerCase() === wanted)
        ) {
          return true
        }
      }
      await this.page.waitForTimeout(500).catch(() => {})
    }
    return false
  }

  // --- proving a launch codec -----------------------------------------------

  // A codec asked for at launch is only a REQUEST until the wire agrees. One
  // the call happily negotiates can still carry nothing — an encoder that
  // produces a single keyframe and then stalls publishes zero frames to every
  // other participant, and nothing on this side looks wrong: the bot's own
  // tile renders the raw camera track, upstream of the encoder, so the
  // self-view is bright while the call sees a dark square. Chrome's HEVC send
  // path on this stack is exactly that shape.
  //
  // So a launch codec is held to the same proof a runtime switch already gets:
  // does a stream in that codec actually carry bytes. One that does not is
  // handed back to the platform's own codec — a visible bot on the wrong
  // codec beats an invisible bot on the right one — and the bot says so.
  async #proveCodec(role) {
    const wanted = this.codecs[role]
    if (!wanted) return true
    if ((await this.#codecSettled(role, wanted, 10_000)) && (await this.#codecHolds(role, wanted))) {
      this.log.info(`${wanted} is carrying for the ${ROLE_WORD[role]}`)
      return true
    }
    this.log.warn(`${wanted} carries nothing for the ${ROLE_WORD[role]} — falling back`)
    this.codecs = { ...this.codecs, [role]: null }
    // The page preference goes first: cleared after the republish, the next
    // negotiation would put the dead codec straight back on the m-line.
    await this.page
      .evaluate((r) => window.__botSetCodec__?.(r, null) ?? null, role)
      .catch(() => null)
    await this.#lkSwitch(role, null).catch(() => {})
    this.note = `${wanted} sent nothing from the ${ROLE_WORD[role]} — back on the call's own codec`
    return false
  }

  // --- a camera that goes quiet mid-call ------------------------------------

  // The join-time proof judges only the codec a bot ARRIVES on. An encoder can
  // wedge later too, on any codec — both of the dark bots seen in the wild did,
  // one of them on plain vp8 — and from this side it looks like nothing at all:
  // the bot's own tile stays lit, because a self-view is the raw track upstream
  // of the encoder, and the card stays green because audio keeps flowing. Only
  // the outbound VIDEO rate tells the truth, so it is watched for as long as
  // the camera is meant to be on.
  //
  // Called from the roster's own 2s poll with what that poll already read, so
  // it costs no extra work; healing runs in the background and never holds it.
  // The watchdog's own entry point, driven by the roster on a fixed tick so a
  // bot heals whether or not anyone is watching it — a headless `join` run has
  // no dashboard at all, and its bots have to come back just the same.
  async pollHealth() {
    this.#recordBrowserFailure()
    // Native Meet drivers provide the same camera state, outbound video rate,
    // and toggle/rejoin operations that the watchdog needs for Aloqa.
    if (this.platform?.capabilities?.rtc === false) return
    if (this.state !== 'in-call' || !this.page || this.page.isClosed()) return
    if (this.healing || this.polling) return
    this.polling = true
    try {
      await this.#pollHealth()
    } finally {
      this.polling = false
    }
  }

  async #pollHealth() {
    const fresh = this.health && Date.now() - this.health.at < 4000
    const readAt = fresh ? this.health.at : Date.now()
    const cam = fresh ? this.health.cam : await this.camState().catch(() => 'unknown')
    const rtc = fresh ? this.health.rtc : await this.rtcSummary().catch(() => null)
    // Judged on a read taken before somebody toggled the camera, this tick
    // would put back what they just changed. Its successor reads fresh.
    if (this.camIntentAt > readAt) return
    // A camera nobody turned off has to be put back before anything else: the
    // video watchdog ignores an off camera on purpose, so a publication the
    // app dropped — a codec fallback's republish that failed, say — would
    // leave the bot dark for good with nothing watching. Bounded, because a
    // camera that refuses to come on must not be clicked at forever.
    if (cam === 'on') this.camFixAttempts = 0
    else if (this.wantCam === true && cam === 'off' && this.camFixAttempts < 3) {
      this.camFixAttempts += 1
      this.healing = true
      try {
        this.log.warn('camera is off but was never turned off — turning it back on')
        await this.setCam(true).catch(() => {})
      } finally {
        this.healing = false
        this.health = null // the state just changed; do not judge it on a stale read
      }
      return
    }
    await this.checkVideoHealth(cam, rtc)
  }

  async checkVideoHealth(cam, rtc) {
    // A heal in flight owns the clock (pollHealth guards the entry): without
    // that, ticks landing during a ten-second rejoin would spend escalation
    // steps the previous one never got a chance to prove — the bot would run
    // out of moves while its first move was still in progress.
    const step = videoHealthStep({
      inCall: this.state === 'in-call',
      camOn: cam === 'on',
      upV: rtc?.upV ?? null,
      darkSince: this.videoDarkSince,
      attempts: this.videoHealAttempts,
      now: Date.now(),
    })
    const recovered = this.videoDarkSince !== null && step.darkSince === null
    this.videoDarkSince = step.darkSince
    this.videoHealAttempts = step.attempts
    // Clear only the notice this watchdog wrote — a codec fallback's own note
    // is still true and must survive.
    if (recovered && this.note === DARK_NOTE) this.note = null
    if (step.action === 'none') return
    this.healing = true
    try {
      if (step.action === 'recycle') {
        this.log.warn('camera has published nothing for a while — turning it off and on')
        await this.setCam(false).catch(() => {})
        await this.setCam(true).catch(() => {})
      } else if (step.action === 'rejoin') {
        this.log.warn('camera still silent — rejoining the call on a fresh connection')
        await this.#rejoinWithCodecs().catch(() => false)
      } else {
        this.log.error('camera is publishing nothing — nobody in the call can see this bot')
        this.note = DARK_NOTE
      }
    } finally {
      this.healing = false
      // Each attempt gets a full window to prove itself, measured from when it
      // FINISHED rather than when it started — a rejoin alone takes about ten
      // seconds, and judging it on the two that were left would be no test.
      if (this.videoDarkSince !== null) this.videoDarkSince = Date.now()
    }
  }

  // Settling is not surviving. A codec can be on the wire for a single
  // keyframe and then stall: the stream row lives on, its cumulative bytes
  // live on, and what stops is FRAMES — so a burst reads exactly like a
  // working stream to anything that only asks "did bytes move". Chrome's HEVC
  // send path is that shape: one keyframe, then zero frames for the rest of
  // the call while the SFU begs for another. Ask again a few seconds later,
  // and ask the encoder whether it is still producing.
  async #codecHolds(role, wanted, waitMs = 4000) {
    await this.page.waitForTimeout(waitMs).catch(() => {})
    const snap = await this.rtcSnapshot()
    const mine = (snap?.outbound ?? []).filter(
      (stream) => roleStream(role)(stream) && (stream.kbps ?? 0) > 0,
    )
    if (mine.length === 0) return false
    // Audio has no frame rate, and a RED wrap never names itself in stats —
    // settling already established the codec there, so sustain is the whole
    // remaining question.
    if (role === 'audio') return true
    return (
      mine.every((stream) => (stream.codec?.name ?? '').toLowerCase() === wanted) &&
      mine.some((stream) => (stream.fps ?? 0) > 0)
    )
  }

  // Only roles with a live publication to judge. A camera that was never
  // turned on has nothing to prove yet; setCam proves it when it comes on.
  async #proveLaunchCodecs() {
    for (const role of ['video', 'audio']) {
      const wanted = this.codecs[role]
      if (!wanted) continue
      const device = role === 'video' ? this.camState() : this.micState()
      const on = await device.catch(() => 'unknown')
      if (on !== 'on') {
        // Nothing is publishing for this role, so there is nothing to judge —
        // setCam/setScreen prove it whenever the device does come on.
        this.log.info(`${wanted} unproven: the ${ROLE_WORD[role]} is ${on}`)
        continue
      }
      await this.#proveCodec(role)
    }
  }

  // Re-assert the stored preferences inside the page, skipping what the page
  // already has so a plain launch-time preference does not renegotiate twice.
  async #syncCodecs() {
    const wanted = Object.entries(this.codecs).filter(([, codec]) => codec !== null)
    if (wanted.length === 0) return
    const current = await this.page
      .evaluate(() => window.__botCodecState__?.()?.prefs ?? null)
      .catch(() => null)
    for (const [role, codec] of wanted) {
      if (current && current[role] === codec) continue
      await this.page
        .evaluate((arg) => window.__botSetCodec__?.(arg.role, arg.codec) ?? null, { role, codec })
        .catch(() => null)
    }
  }

  // A bot has no desktop, so it shares a page of its own: opened before the
  // share button is pressed, titled so Chrome's capture-source flag picks it,
  // and animated so anyone watching can see the feed is live.
  async #prepareScreen() {
    // A guest window has no Playwright context to open a page in. It opens a
    // window of its own in the same Chrome process instead, on the same scene
    // this app has always shared, built into a data: URL so it needs nothing
    // served. Chrome picks it by title when Meet asks to capture.
    if (!this.instrumented) {
      return this.page.prepareScene(
        screenHtml(this.label, guestColorHex(this.user.n - 1), null),
      )
    }
    if (this.screenPage && !this.screenPage.isClosed()) return this.screenPage
    const page = await this.context.newPage()
    const video = screenVideoPath()
    // Served from a path on the call's own origin that nothing else uses, so
    // the page and its footage are same-origin and no other request is touched.
    const base = `${this.options.baseUrl}/__call-bots-screen`
    // Context-wide, not page-scoped: the capture shim inside the CALL page
    // builds the synthetic share from this same clip URL.
    await this.context.route(`${base}*`, async (route) => {
      if (route.request().url().includes('asset=video') && video) {
        return route.fulfill({
          status: 200,
          contentType: 'video/webm',
          body: await readFile(video),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: screenHtml(
          this.label,
          guestColorHex(this.user.n - 1),
          video ? `${base}?asset=video` : null,
        ),
      })
    })
    await page.goto(base)
    await this.page.bringToFront()
    this.screenPage = page
    return page
  }

  screenState() {
    return this.platform?.screenState
      ? this.platform.screenState(this.page)
      : Promise.resolve('unknown')
  }

  async setScreen(on) {
    if (!this.platform?.setScreen || this.platform.capabilities?.screen === false) return 'unknown'
    const state = await this.platform.setScreen(this.#ctx(), on)
    // A share born under a stored screen preference republishes to it right
    // away, the LiveKit way — the publication is seconds old and cheap to
    // swap, and the SFU consents to the codec in the process.
    if (on && state === 'on' && this.codecs.screen) {
      await this.#lkSwitch('screen', this.codecs.screen).catch(() => {})
      if (this.monitorInstall) await this.#proveCodec('screen').catch(() => {})
    }
    return state
  }

  // Buttons are not proof: check that remote <video> elements really play.
  async verifyRemote() {
    if (!this.platform) return null
    return this.platform.remote(this.page)
  }

  // Small per-tick network summary for the dashboard's state snapshot. null
  // means nothing to show — and when the cause is a page that lost its monitor
  // (navigated, or admitted after a timeout), a reinstall is kicked off so the
  // next tick heals on its own.
  async rtcSummary() {
    if (this.platform?.capabilities?.rtc === false || this.state !== 'in-call' || !this.page) {
      return null
    }
    // Native drivers collect their own stats: webrtc-internals on macOS,
    // document-start peer-connection capture in the Linux extension.
    if (!this.instrumented) return this.page.rtcSummary?.().catch(() => null) ?? null
    const summary = await rtcSummary(this.page).catch(() => null)
    if (summary === null) this.#ensureMonitor().catch(() => {})
    return summary
  }

  // Full sanitized stream model for the expanded card panel.
  async rtcSnapshot() {
    if (this.platform?.capabilities?.rtc === false || this.state !== 'in-call' || !this.page) {
      return null
    }
    if (!this.instrumented) return this.page.rtcSnapshot?.().catch(() => null) ?? null
    return rtcSnapshot(this.page).catch(() => null)
  }

  // A bot that gave up waiting and was admitted afterwards is in the call, so
  // its controls have to work again. Cheap to check and only asked about bots
  // that are not already in.
  async recoverIfAdmitted() {
    this.#recordBrowserFailure()
    if (!this.platform || !this.page || this.state === 'in-call') return
    if (!String(this.state).startsWith('error:join')) return
    const summary = await this.platform.remote(this.page).catch(() => null)
    if (!summary || summary.local === 0) return
    this.log.info('admitted after all — back in the call')
    this.state = 'in-call'
    this.lastError = null
  }

  #recordBrowserFailure() {
    if (!this.page?.isClosed() || !this.page.failureReason || this.state === 'closed' || this.state === 'leaving') return
    if (this.state !== 'error:browser') this.log.error(this.page.failureReason)
    this.state = 'error:browser'
    this.lastError = this.page.failureReason
    this.waitingAdmission = false
  }

  async leave() {
    // Never trust our own record here: a bot admitted after it timed out is
    // really in the call, and closing its browser without leaving strands it
    // there as a participant nobody can remove.
    if (!this.platform || !this.page) return
    this.state = 'leaving'
    try {
      await this.platform.leave(this.#ctx())
    } catch {
      this.log.warn('leave button did not respond; closing the browser instead')
    }
    this.state = 'ready'
  }

  async shot(name = 'manual') {
    return this.#shot(name)
  }

  async #closeBrowserProcess() {
    const close = this.closeBrowser
    this.closeBrowser = null
    if (close) {
      await Promise.race([
        Promise.resolve().then(close).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ])
    }
    this.browser = null
    this.context = null
    this.page = null
  }

  async teardown() {
    this.startAbort?.abort()
    // A guest has neither a browser nor a context — its window is the only
    // thing to close, and closeBrowser is what knows how.
    if (!this.browser && !this.context && !this.closeBrowser) {
      this.waitingAdmission = false
      return
    }
    try {
      try {
        await this.leave()
      } catch (error) {
        this.log.warn(`teardown failed: ${error.message}`)
      }
      await this.#closeBrowserProcess()
    } finally {
      this.waitingAdmission = false
      this.state = 'closed'
      this.log.info('closed')
    }
  }
}
