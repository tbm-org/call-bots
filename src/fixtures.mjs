import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bundledMediaDir, fixturesDir } from './config.mjs'
import { plain as log } from './log.mjs'
import { renderClip } from './render.mjs'
import { listVoices, synthesizeSpeech } from './tts.mjs'
import { encodeWav, hasSpeech, synthesizeToneBurst } from './wav.mjs'

export const THEME_COUNT = 5

// Card accents, one per theme, matching the clips.
const COLORS = ['#00e5ff', '#ff9a3c', '#0072ff', '#a8ff78', '#ed4264']
export const guestColorHex = (index) => COLORS[index % COLORS.length]

// Each bot talks continuously, so a call sounds like a real room rather than a
// chorus of the same clip. Passages are long enough (~140 words) that the loop
// is not obvious, and written the way people actually speak on a call.
const PASSAGES = [
  `Right, so where I got to yesterday was the migration itself. I pulled the numbers this
   morning and it is a much smaller change than we thought, maybe two days of work rather
   than the week we penciled in. The tricky part is the backfill, because we cannot run it
   during business hours without slowing everything down, so I would rather schedule it for
   the weekend and keep an eye on it. I have written the rollback as well, and I tested it
   against a copy of production, which is the part I actually care about. If nobody objects
   I will start on Monday and keep you posted as it goes. Nothing here should be visible to
   customers, and if it is, that is a bug and I want to hear about it straight away.`,

  `The thing that surprised me was how much of the delay was queueing rather than the work
   itself. Once I looked at the traces properly it was obvious, we were waiting on a single
   connection pool for most of the request, and the actual query was quick. So I widened the
   pool, added a timeout that actually fires, and the tail latency dropped by more than half.
   I do want to be careful about claiming victory too early, because we have only had it in
   staging for a day, and staging traffic is nothing like the real thing. My plan is to roll
   it out to ten percent, watch it for a day, and then go from there. If it holds up, the
   same fix probably applies to the other two services.`,

  `Honestly the design review went better than I expected. The main worry was that we were
   adding another moving part for very little benefit, and I think that was fair. So we cut
   the caching layer entirely and just made the underlying call faster, which is less clever
   but much easier to reason about later. I would rather have something boring that works
   than something elegant that pages us at three in the morning. There is one open question
   about how we handle partial failures, and I have written it up so we can decide properly
   rather than in the moment. Other than that I think we are ready to build it, and I would
   like to start this week if everyone is comfortable.`,

  `From the support side the pattern is pretty clear now. Almost every ticket this month is
   the same underlying issue, people lose their connection briefly, the client does not
   recover, and they end up refreshing the page and losing what they typed. That is a bad
   experience even though technically nothing is broken. I have collected about thirty
   examples with timestamps so we can match them against the server logs. What I would like
   is for the client to reconnect quietly and keep the draft, so the user never notices. I
   do not think that is a huge amount of work, but I could be wrong about that, so I would
   like an engineer to sanity check it before we promise anything.`,

  `Just a quick update from me, nothing dramatic. The documentation is about eighty percent
   done, and the parts that are missing are the ones I need someone else to confirm, mostly
   the deployment steps and the on call runbook. I have been testing the instructions by
   following them exactly on a fresh machine, which is tedious but it does find the gaps.
   Twice now I have hit a step that assumed something was already installed. Once that is
   sorted I will do a proper pass for tone and length, because right now it is far too long
   and nobody is going to read all of it. My aim is to have something we can hand to a new
   starter and expect them to succeed without asking anyone.`,
]

const clipPath = (theme, width, height, fps, seconds) =>
  join(fixturesDir, `clip-${theme + 1}-${width}x${height}-${fps}fps-${seconds}s.y4m`)

// Real footage beats the drawn clips. Videos imported on this machine with
// scripts/import-videos.mjs come first; the footage shipped inside the app is
// the fallback, so a fresh install already has faces.
const mediaDirs = [fixturesDir, bundledMediaDir]

const realClip = (theme) => {
  for (const dir of mediaDirs) {
    try {
      const match = readdirSync(dir)
        .filter((name) => name.startsWith(`clip-${theme + 1}-`) && name.endsWith('.mjpeg'))
        .sort()
        .pop()
      if (match) return join(dir, match)
    } catch {
      /* directory may not exist yet */
    }
  }
  return null
}

// Clips are rendered on demand: a two-bot call never pays for five of them.
export const ensureClip = async (theme, { size = '1920x1080', fps = 12, seconds = 6 } = {}, onProgress) => {
  const [width, height] = size.split('x').map(Number)
  if (!width || !height || width % 2 || height % 2) {
    throw new Error(`--size must be even WxH dimensions, got "${size}" (Chrome requires C420)`)
  }
  const real = realClip(theme)
  if (real) return real
  const out = clipPath(theme, width, height, fps, seconds)
  if (existsSync(out)) return out
  mkdirSync(fixturesDir, { recursive: true })
  const started = Date.now()
  log.info(`rendering camera video ${theme + 1} of ${THEME_COUNT} (${width}x${height})…`)
  const buffer = await renderClip({ theme, width, height, fps, seconds, onProgress })
  writeFileSync(out, buffer)
  log.info(
    `camera video ${theme + 1} ready (${(buffer.length / 1024 / 1024).toFixed(0)} MB, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s)`,
  )
  return out
}

// Imported soundtracks take priority over the bundled multilingual recordings.
// Only when neither exists does a bot fall back to speech synthesised here.
const realVoice = (theme) => {
  for (const dir of mediaDirs) {
    const file = join(dir, `voice-${theme + 1}.wav`)
    if (existsSync(file) && speaks(file)) return file
  }
  return null
}

// A voice file that is mostly silence sends a bot into a call that never says
// anything, and nothing on screen shows it. Anything that fails this is passed
// over in favour of speech synthesised here.
const speaks = (file) => {
  try {
    return hasSpeech(readFileSync(file))
  } catch {
    return false
  }
}

const ensureVoice = async (n, voices) => {
  const audio = join(fixturesDir, `bot-${n}.wav`)
  // Regenerate rather than trust a cached file: an old layout left silent ones.
  if (existsSync(audio) && speaks(audio)) return audio
  const passage = PASSAGES[(n - 1) % PASSAGES.length].replace(/\s+/gu, ' ').trim()
  const voice = voices.length ? voices[(n - 1) % voices.length] : null
  let speech = null
  try {
    speech = await synthesizeSpeech(passage, voice)
  } catch (error) {
    log.warn(`speech synthesis failed for bot ${n}: ${error.message}`)
  }
  // Fall back to tones only when the machine has no speech engine at all.
  if (!speech) speech = synthesizeToneBurst(n, 20)
  writeFileSync(audio, encodeWav(speech))
  if (!speaks(audio)) log.warn(`bot ${n} has little audible speech — it will be quiet in the call`)
  return audio
}

// Returns Map<slug, {video, audio}>. Bots cycle through the five clips.
export const ensureGuestFixtures = async (guests, options = {}) => {
  if (options.regen) rmSync(fixturesDir, { recursive: true, force: true })
  mkdirSync(fixturesDir, { recursive: true })
  const voices = await listVoices()

  const result = new Map()
  for (const guest of guests) {
    const theme = (guest.n - 1) % THEME_COUNT
    const video = await ensureClip(theme, options)
    const audio = realVoice(theme) ?? (await ensureVoice(guest.n, voices))
    result.set(guest.slug, { video, audio, theme })
  }
  return result
}
