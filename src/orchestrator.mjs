import { RUN_MARKER, createRunDir, meetReadiness, writeManifest } from './browser.mjs'
import { THEME_COUNT, ensureGuestFixtures, guestColorHex } from './fixtures.mjs'
import { Guest } from './guest.mjs'
import { plain as log } from './log.mjs'
import { concurrencyWarning } from './machine.mjs'
import { platformById } from './platforms/index.mjs'
import { findMarkedPids, killPids } from './procs.mjs'

// Launching browsers is the heavy part, so it stays paced. Waiting to be
// admitted is not, and must never hold a lane: a host running "Wait for
// admission" has to see every request at once, not two at a time with the rest
// queued behind them.
const LAUNCH_CONCURRENCY = 2

// How often every bot's camera is checked for having gone quiet. Comfortably
// under the watchdog's own window, and off the dashboard's poll on purpose:
// bots must heal in a headless run too, where nothing is ever watching.
const HEALTH_MS = 5000

const PROBE_TIMEOUT = 4000

// Resolves to `fallback` rather than hanging when a browser is too busy to
// answer. A slow bot should show as unknown, not freeze the whole window.
const bounded = (promise, fallback) =>
  Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), PROBE_TIMEOUT)),
  ])

const pool = async (items, worker, concurrency) => {
  const queue = [...items]
  const failures = []
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      try {
        await worker(item)
      } catch (error) {
        item.lastError ||= error.message
        failures.push({ item, error })
      }
    }
  })
  await Promise.all(lanes)
  return failures
}

// Holds every bot of one call and the run-owned resources behind them.
export class Roster {
  constructor(options) {
    this.options = options
    this.runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
    this.runDir = createRunDir(this.runId)
    this.options.runId = this.runId
    this.options.runDir = this.runDir
    this.guests = []
    this.counter = 0
    // Bots are sent in more than once — five now, seven when the call fills up.
    // Each send is its own batch, so the window can show them as the groups
    // they arrived in and take a whole group back out in one go.
    this.batches = []
    this.batchCounter = 0
    this.target = null
    this.meetingId = null
    this.tearingDown = false
    this.activeAdds = new Set()
    this.teardownPromise = null
    this.healthTimer = setInterval(() => {
      for (const guest of this.guests) guest.pollHealth().catch(() => {})
    }, HEALTH_MS)
    this.healthTimer.unref?.()
  }

  get callUrl() {
    return this.target?.url ?? null
  }

  get platform() {
    return this.target?.label ?? null
  }

  #manifest(extra = {}) {
    writeManifest(this.runDir, {
      runId: this.runId,
      baseUrl: this.options.baseUrl,
      platform: this.target?.platform ?? null,
      meetingId: this.meetingId,
      guests: this.guests.map((guest) => ({
        label: guest.label,
        state: guest.state,
        batch: guest.batch?.id ?? null,
      })),
      ...extra,
    })
  }

  inCall() {
    return this.guests.filter((guest) => guest.state === 'in-call')
  }

  bySlug(slug) {
    return this.guests.find((guest) => guest.user.slug === slug) ?? null
  }

  byBatch(id) {
    return this.guests.filter((guest) => guest.batch?.id === id)
  }

  // Sends `count` more bots into the call. The first call sets the target.
  // `overrides` applies to this batch only, so bots added later can arrive with
  // their camera or microphone in a different state from the ones already in.
  add(count, target = null, overrides = null) {
    if (this.tearingDown) return Promise.reject(new Error('roster is stopping'))
    // The record exists before the first await so a batch can be removed from
    // the moment it is asked for, not only once its bots have been built.
    this.batchCounter += 1
    const batch = { id: this.batchCounter, at: Date.now(), removed: false, operation: null }
    this.batches.push(batch)
    const operation = this.#add(count, batch, target, overrides)
    batch.operation = operation
    this.activeAdds.add(operation)
    operation.then(
      () => this.activeAdds.delete(operation),
      () => this.activeAdds.delete(operation),
    )
    return operation
  }

  async #add(count, batch, target = null, overrides = null) {
    if (target) {
      // Native Mac Meet windows stay visible by default. Preserve a later
      // explicit dashboard visibility choice when adding more bots.
      if (!this.target && target.platform === 'meet' && process.platform === 'darwin') this.options.headed = true
      this.target = target
    }
    if (!this.target) throw new Error('no call link — paste the call link first')

    const isMeet = this.target.platform === 'meet'
    if (isMeet) {
      const readiness = await meetReadiness()
      if (!readiness.ready) throw new Error(readiness.reason)
    }
    const total = this.guests.length + count
    const warning = concurrencyWarning(total, undefined, { meet: isMeet })
    if (warning) log.warn(warning)
    const label = String(overrides?.label ?? this.options.label ?? '').trim()

    const users = Array.from({ length: count }, () => {
      this.counter += 1
      const n = this.counter
      return {
        n,
        index: n - 1,
        // A label replaces the word "Bot", it does not stack onto it: a batch
        // labelled "QA" arrives as "QA 3", an unlabelled one as "Bot 3".
        label: label ? `${label} ${n}` : `Bot ${n}`,
        slug: `bot-${n}`,
      }
    })

    log.info(`preparing ${users.length} bot(s)`)
    let media
    try {
      media = await ensureGuestFixtures(users, this.options)
    } catch (error) {
      throw error
    }
    // Every browser in a batch competes with the ones still starting, so the
    // size of the batch is part of how long anything takes.
    const options = { ...this.options, ...(overrides ?? {}), batchSize: total }
    const guests = users.map(
      (user) => new Guest(user, media.get(user.slug), options),
    )
    for (const guest of guests) guest.batch = batch
    this.guests.push(...guests)
    this.#manifest()

    const failures = []
    const failed = (guest, error) => {
      // Guest.join records the short, user-facing cause before throwing a
      // diagnostic error with URLs and evidence paths. Keep that useful cause
      // for the dashboard instead of replacing it with internal detail.
      guest.lastError ||= error.message
      failures.push({ item: guest, error })
    }

    const launched = []
    await pool(
      guests,
      async (guest) => {
        // A stop while bots are still queued has to be terminal: a browser
        // launched after teardownAll has swept would outlive the stop and
        // walk into the call as a ghost nobody can remove. Removing this batch
        // is the same promise held over one group instead of all of them.
        if (this.tearingDown || batch.removed) return
        guest.log.info('launching browser')
        try {
          await guest.start(this.target)
          if (this.tearingDown || batch.removed) {
            await guest.teardown().catch(() => {})
            return
          }
          launched.push(guest)
        } catch (error) {
          failed(guest, error)
        }
      },
      LAUNCH_CONCURRENCY,
    )

    await Promise.all(
      launched.map(async (guest) => {
        if (this.tearingDown || batch.removed) return
        try {
          await guest.join(this.target)
          this.meetingId ??= guest.meetingId
        } catch (error) {
          failed(guest, error)
        }
      }),
    )
    for (const { item, error } of failures) item.log.error(error.message)
    this.#manifest()
    // A batch taken out while it was still arriving added nothing that lasted,
    // so it must not report bots as joined that the user has already removed.
    if (batch.removed) return { batch: batch.id, added: 0, failed: 0, removed: true }
    return {
      batch: batch.id,
      added: guests.length - failures.length,
      failed: failures.length,
      removed: false,
    }
  }

  // A bot that leaves is gone: close its browser and drop it from the roster
  // so nothing lingers in the window.
  async remove(slug) {
    const guest = this.bySlug(slug)
    if (!guest) return false
    await guest.teardown().catch((error) => guest.log.warn(`teardown failed: ${error.message}`))
    this.guests = this.guests.filter((candidate) => candidate !== guest)
    this.#manifest()
    return true
  }

  // The batch button: the bots that arrived together leave together, and the
  // group they were shown in stops existing. Returns the labels removed.
  async removeBatch(id) {
    const batch = this.batches.find((candidate) => candidate.id === id)
    if (!batch) return []
    // Flag it before closing anything: a batch can be removed while it is still
    // arriving, and every launch still queued in its add stands down on this
    // rather than walking a browser into the call after its group is gone.
    batch.removed = true
    const removed = new Set()
    const close = async () => {
      const mine = this.guests.filter((guest) => guest.batch === batch)
      for (const guest of mine) removed.add(guest)
      await Promise.all(
        mine
          .filter((guest) => guest.state !== 'closed')
          .map((guest) =>
            guest.teardown().catch((error) => guest.log.warn(`teardown failed: ${error.message}`)),
          ),
      )
    }
    await close()
    // Closing the browsers above fails any join still in flight, so the add
    // settles from here rather than sitting in an admission lobby. Wait for it —
    // it closes whatever it started — then take anything left standing.
    await batch.operation?.catch(() => {})
    await close()
    this.guests = this.guests.filter((guest) => guest.batch !== batch)
    this.batches = this.batches.filter((candidate) => candidate !== batch)
    this.#manifest()
    return [...removed].map((guest) => guest.label)
  }

  // Bots with a window of their own are shown or hidden together, and bots
  // added afterwards arrive the way the session is currently set.
  async setWindowsVisible(visible) {
    this.options.headed = Boolean(visible)
    const shown = await Promise.allSettled(
      this.guests
        .filter((guest) => guest.state !== 'closed')
        .map((guest) => guest.setWindowVisible(visible)),
    )
    const failed = shown.filter((result) => result.status === 'rejected')
    if (failed.length) throw new Error(`Could not ${visible ? 'show' : 'hide'} ${failed.length} bot browser(s): ${failed[0].reason.message}`)
    return shown.filter((result) => result.status === 'fulfilled' && result.value).length
  }

  // Asking each bot in turn costs a round trip per bot per poll, which stops
  // answering at all once there are enough of them on a busy machine. Ask them
  // all at once, and never let one stuck browser hold up the answer.
  async statusData() {
    const guests = await Promise.all(
      this.guests.map(async (guest, i) => {
        // A bot admitted after it stopped waiting is in the call whatever we
        // recorded, and its controls have to come back to life.
        await bounded(guest.recoverIfAdmitted(), null)
        const inCall = guest.state === 'in-call'
        const [{ mic, cam, screen }, rtc] = inCall
          ? await Promise.all([
              bounded(guest.controls(), { mic: 'unknown', cam: 'unknown', screen: 'unknown' }),
              bounded(guest.rtcSummary(), null),
            ])
          : [{ mic: null, cam: null, screen: null }, null]
        // Hand the health tick what was just read, so an open dashboard makes
        // the watchdog free rather than doubling its work.
        guest.health = { at: Date.now(), cam, rtc }
        return {
          index: i,
          slug: guest.user.slug,
          label: guest.label,
          color: guestColorHex((guest.user.n - 1) % THEME_COUNT),
          state: guest.state,
          waitingAdmission: guest.waitingAdmission,
          batch: guest.batch?.id ?? null,
          mic,
          cam,
          screen,
          rtc,
          codecs: guest.codecs,
          volume: guest.volume,
          volumeRevision: guest.volumeRevision,
          volumeAvailable: guest.volumeAvailable,
          note: guest.note,
          lastError: guest.lastError,
        }
      }),
    )
    // Only groups that still hold bots: a batch emptied one card at a time, or
    // one that failed before it built anything, is not a group any more.
    const batches = this.batches
      .map((batch) => ({
        id: batch.id,
        at: batch.at,
        size: this.guests.filter((guest) => guest.batch === batch).length,
      }))
      .filter((batch) => batch.size > 0)
    return {
      meetingId: this.meetingId,
      inviteLink: this.callUrl,
      platform: this.platform,
      capabilities: platformById(this.target?.platform)?.capabilities ?? null,
      windowsVisible: Boolean(this.options.headed),
      batches,
      guests,
    }
  }

  // One bot checks that the other tiles really render — buttons are not proof.
  async verifyData() {
    const verifier = this.inCall()[0]
    if (!verifier) return null
    const remote = await verifier.verifyRemote().catch(() => null)
    return { verifier: verifier.label, remote, at: Date.now() }
  }

  teardownAll() {
    if (this.teardownPromise) return this.teardownPromise
    this.tearingDown = true
    // Nothing left to heal, and a tick firing mid-teardown would poke pages
    // that are already closing.
    clearInterval(this.healthTimer)
    this.teardownPromise = this.#finishTeardown()
    return this.teardownPromise
  }

  async #finishTeardown() {
    log.info('closing bots…')
    await Promise.all(
      this.guests.map((guest) =>
        Promise.race([
          guest.teardown(),
          new Promise((resolve) => setTimeout(resolve, 30_000)),
        ]).catch((error) => guest.log.warn(`teardown failed: ${error.message}`)),
      ),
    )
    await this.#sweep()
    // A browser launch already in progress may react to the first sweep by
    // trying its fallback channel. Do not report Stop as complete until every
    // add operation has observed tearingDown and closed anything it launched.
    await Promise.allSettled([...this.activeAdds])
    await Promise.all(
      this.guests.filter((guest) => guest.state !== 'closed').map((guest) =>
        guest.teardown().catch((error) => guest.log.warn(`teardown failed: ${error.message}`)),
      ),
    )
    await this.#sweep()
    this.#manifest({ finishedAt: new Date().toISOString() })
    log.info('done')
  }

  // Belt and braces: a wedged browser.close() must never strand a publishing
  // browser, so kill anything still carrying this run's marker.
  async #sweep() {
    const pids = await findMarkedPids(`${RUN_MARKER}=${this.runId}`)
    if (pids.length === 0) return
    log.warn(`sweeping ${pids.length} leftover browser process(es)`)
    killPids(pids)
  }
}
