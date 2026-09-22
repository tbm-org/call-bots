// The browser Google Meet guests actually get in with.
//
// Meet refuses anonymous joins from a browser with a debugger attached — same
// window, same meeting, same minute: readable through Apple Events, refused
// through CDP. So a guest gets no Playwright and no --remote-debugging-port. It
// is a real, ordinary window on a throwaway profile, scripted through Chrome's
// own `execute javascript`, which Meet cannot tell from the page's own code.
//
// One Chrome process per guest. Chrome's fake camera and microphone are
// process-wide flags, so guests sharing a process shared one clip and one
// voice; a process each gives every guest its own, cycling through the five
// clips and voices exactly as Aloqa bots do. Neither AppleScript nor
// JavaScript for Automation can do this — `tell application id` reaches ONE
// process per bundle id, and Application(pid) was measured to answer from that
// same process whatever pid it was given — but the Apple Event Manager itself
// addresses a process by pid without ambiguity. A small compiled helper,
// scripts/macos-app/aesend.swift, sends the handful of events needed with the
// target built from the pid and nothing in between: twelve concurrent calls
// to two processes, every answer from the right one. A pid that is gone is an
// error, never a launch of a stray Chrome.
//
// The processes still run from a copy of Chrome carrying its own bundle
// identity. The Automation grant macOS asks for is per target application, and
// it should name the bots' browser — not hand a script the run of the user's
// own Chrome.
//
// Not incognito, though it started that way: an incognito window refuses to
// inherit the camera and microphone grant seeded into the profile, and Meet
// then has nothing to offer but "Continue without microphone and camera". A
// fresh profile is already signed out, which is all a guest actually needs.
//
// See CLAUDE.md for the measurements behind every line of this.

import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { RUN_MARKER, SCREEN_TITLE, bundledChromiumPath } from './browser.mjs'
import { baseDir, projectRoot } from './config.mjs'
import { MeetBridge } from './meet-extension/bridge.mjs'
import { prepareExtension } from './meet-extension/extension.mjs'
import { guestColorHex } from './fixtures.mjs'
import { plain as log } from './log.mjs'

const run = promisify(execFile)

export const BUNDLE_ID = 'com.aloqa.call-bots.browser'
const BUNDLE_PATH = join(baseDir, 'Call Bots Browser.app')
// The dependency lock selects the exact browser revision on both platforms.
const sourceApp = () => bundledChromiumPath()?.split('/Contents/MacOS/')[0] ?? null
const bundleBinary = (app) => join(app, 'Contents/MacOS', basename(bundledChromiumPath()))
const BUNDLE_SOURCE = join(BUNDLE_PATH, 'Contents/Resources/call-bots-source.json')
const READY_TIMEOUT = 60_000
// How long a closing browser gets to exit on its own before it is killed.
const EXIT_WAIT = 6000

// ---------------------------------------------------------------------------
// The helper.

const HELPER_SOURCE = join(projectRoot, 'scripts', 'macos-app', 'aesend.swift')
// Built into the app bundle by scripts/build-macos-app.mjs; a source checkout
// compiles it once into the data directory and again when the source changes.
const HELPER_BUNDLED = join(projectRoot, 'native', 'aesend')
const HELPER_BUILT = join(baseDir, 'aesend')

let helperPromise = null
const ensureHelper = () => {
  helperPromise ??= (async () => {
    if (existsSync(HELPER_BUNDLED)) return HELPER_BUNDLED
    if (!existsSync(HELPER_SOURCE)) {
      throw new Error('the Call Bots app is missing its Apple Events helper — reinstall it')
    }
    const fresh = existsSync(HELPER_BUILT) && statSync(HELPER_BUILT).mtimeMs >= statSync(HELPER_SOURCE).mtimeMs
    if (fresh) return HELPER_BUILT
    try {
      await run('swiftc', ['--version'], { timeout: 30_000 })
    } catch {
      throw new Error(
        'Meet guests need the Call Bots helper, and this checkout cannot build it — ' +
          'install Xcode Command Line Tools (xcode-select --install) or use the packaged app',
      )
    }
    log.info('compiling the Apple Events helper for Meet guests — one time')
    mkdirSync(baseDir, { recursive: true })
    await run('swiftc', ['-O', '-o', HELPER_BUILT, HELPER_SOURCE], { timeout: 300_000 })
    return HELPER_BUILT
  })().catch((error) => {
    helperPromise = null
    throw error
  })
  return helperPromise
}

// One helper invocation: arguments, optional stdin, and a timeout that kills.
// Ten seconds is long for one Apple Event and short enough that a browser too
// busy to answer does not hold a queue slot for half a minute.
const invoke = (helper, args, { input = null, timeout = 10_000, owner = null } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(helper, args, {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, AESEND_TIMEOUT: String(Math.ceil(timeout / 1000)) },
    })
    owner?.helpers?.add(child)
    child.once('close', () => owner?.helpers?.delete(child))
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      reject(new Error('Apple Event timed out'))
    }, timeout + 1000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolve(out.replace(/\n$/u, ''))
      else reject(new Error(err.trim() || `helper exited ${code}`))
    })
    if (input !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })

// macOS refuses the Apple Event outright when Automation permission has not
// been granted — which must not be read as "the browser is not running". It is
// a different problem with a different fix, and it has to be said out loud.
const NOT_PERMITTED = /-1743|-1744|not authorized|not permitted/iu
const PERMISSION_HELP =
  'Call Bots needs permission to control the Call Bots browser — ' +
  'System Settings → Privacy & Security → Automation → Call Bots'
const GONE = /-1728\b/u
const NO_PROCESS = /-600\b|-609\b/u

// Chrome answers Apple Events one at a time per process, so sending more at
// once only queues them inside Chrome, where a caller that gave up waiting
// cannot take its request back. Queue them here instead, a few at a time, and
// refuse outright what has already waited longer than any caller would: with
// three guests and a dashboard polling every second, that is how every probe
// stopped timing out at once.
const SPEAK_AT_ONCE = 4
const SPEAK_QUEUE_MS = 6000
let speaking = 0
const speakQueue = []
const nextSpeaker = () => {
  while (speaking < SPEAK_AT_ONCE && speakQueue.length > 0) {
    const { resolve, reject, queuedAt } = speakQueue.shift()
    if (Date.now() - queuedAt > SPEAK_QUEUE_MS) {
      reject(new Error('the Call Bots browser is busy'))
      continue
    }
    speaking += 1
    resolve()
  }
}
const turnToSpeak = () =>
  new Promise((resolve, reject) => {
    speakQueue.push({ resolve, reject, queuedAt: Date.now() })
    nextSpeaker()
  })
const doneSpeaking = () => {
  speaking -= 1
  nextSpeaker()
}

const alive = (proc) => proc.child.exitCode === null && proc.child.signalCode === null

// One Apple Event to one guest's browser.
const speak = async (proc, args, options = {}) => {
  if (!alive(proc)) throw new Error('the Call Bots browser is not running')
  const helper = await ensureHelper()
  await turnToSpeak()
  try {
    if (proc.stopping && args[0] !== 'quit') throw new Error('The bot browser is stopping')
    return await invoke(helper, [String(proc.child.pid), ...args], { ...options, owner: proc })
  } catch (error) {
    const message = String(error.message)
    if (NOT_PERMITTED.test(message)) throw new Error(PERMISSION_HELP)
    if (GONE.test(message)) throw new Error('this Meet guest window is gone')
    if (NO_PROCESS.test(message)) throw new Error('the Call Bots browser is not running')
    throw error
  } finally {
    doneSpeaking()
  }
}

// ---------------------------------------------------------------------------
// The bundle.

// A copy of Chrome with its own bundle identifier, so Apple Events can address
// the bots' browser without ever reaching the user's. Built once and kept.
const bundleVersion = async (app) => {
  try {
    const { stdout } = await run('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleShortVersionString',
      join(app, 'Contents/Info.plist'),
    ])
    return stdout.trim()
  } catch {
    return null
  }
}

// Built once, however many guests ask at once. Two bots starting together on
// a machine that has never run one both found no bundle and both started
// building it — two 1.4 GB copies into the same staging directory, one of them
// moving it into place while the other was still writing. Measured on a cold
// start: the first bot reached the call, the second sat in "created" for four
// and a half minutes and never arrived. Shared like the helper's build; a
// failure clears the memo so the next attempt is a real one.
let bundlePromise = null
export const ensureGuestBundle = () => {
  bundlePromise ??= buildGuestBundle().catch((error) => {
    bundlePromise = null
    throw error
  })
  return bundlePromise
}

const buildGuestBundle = async () => {
  const source = sourceApp()
  if (!source) throw new Error('Meet needs bundled Chrome for Testing — reopen the dashboard to download it')
  const version = await bundleVersion(source)
  const identity = JSON.stringify({ source, version, executable: basename(bundledChromiumPath()) })
  if (existsSync(bundleBinary(BUNDLE_PATH)) && existsSync(BUNDLE_SOURCE) && readFileSync(BUNDLE_SOURCE, 'utf8') === identity) {
    return BUNDLE_PATH
  }
  log.info('preparing the private Chrome for Testing browser for Meet — one time per browser update')
  const staging = `${BUNDLE_PATH}.building`
  rmSync(staging, { recursive: true, force: true })
  await run('ditto', [source, staging], { timeout: 600_000 })
  const plist = join(staging, 'Contents/Info.plist')
  await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${BUNDLE_ID}`, plist])
  await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName CallBotsBrowser', plist])
  // Without this codesign refuses: "resource fork, Finder information, or
  // similar detritus not allowed".
  await run('xattr', ['-cr', staging], { timeout: 120_000 })
  writeFileSync(join(staging, 'Contents/Resources/call-bots-source.json'), identity)
  await run('codesign', ['--force', '--sign', '-', staging], { timeout: 300_000 })
  rmSync(BUNDLE_PATH, { recursive: true, force: true })
  await run('mv', [staging, BUNDLE_PATH])
  await registerBundle()
  return BUNDLE_PATH
}

// One LaunchServices registration for the bundle id, at the path that exists.
// A stale record — a staging copy, an old build — is the wrong thing in the
// Automation prompt and in Launch Services' idea of what the bundle is.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const registerBundle = async () => {
  await run(LSREGISTER, ['-u', `${BUNDLE_PATH}.building`], { timeout: 60_000 }).catch(() => {})
  await run(LSREGISTER, ['-f', BUNDLE_PATH], { timeout: 60_000 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Windows.

// Guest windows give Meet the same page area an Aloqa bot has — a 1920×1080
// viewport — cascaded a little so a person can tell them apart. Meet sizes
// what it asks the server for by the tiles it draws, so a smaller window would
// receive smaller video and a load test would measure less than real users
// cause; the bots are here to be real users. (Small tiled windows were tried:
// remote video fell to 640×360 at ~250 kbps per stream, against 960×540 at
// ~900 kbps in a three-person call at this size — exactly the saving a test
// must not make.) The window is the viewport plus Chrome's tab strip and
// toolbar, measured at 87 px on the guests' profile. Stacked windows keep
// rendering because the browser is launched with occlusion backgrounding off;
// without that, Meet would pause video in every window but the top one.
const WINDOW_W = 1920
const WINDOW_H = 1080 + 87
const CASCADE = 36
let slots = 0
// The screen the bots are on, asked of one of their own pages — no permission,
// and no guessing. Cached: it cannot change often enough to matter and every
// window placement would otherwise pay for it.
let screenSize = null
const screenOf = async (proc, windowId) => {
  if (screenSize) return screenSize
  const raw = await speak(proc, ['exec', windowId], {
    input: 'screen.availWidth + " " + screen.availHeight',
  }).catch(() => '')
  const [w, h] = String(raw).trim().split(' ').map(Number)
  screenSize = Number.isFinite(w) && Number.isFinite(h) && w > 400 && h > 300
    ? { w, h }
    : { w: WINDOW_W, h: WINDOW_H }
  return screenSize
}

let warnedSmallScreen = false
// A cascade that runs off the bottom of the screen is worse than no cascade:
// Chrome clamps the window to what fits, the page area shrinks with it, and
// Meet quietly asks for smaller video — the bot then measures less load than
// a real user would cause, which is the whole thing these windows are sized
// to avoid. So the offset wraps inside the screen, and a screen too small for
// the full page area says so once rather than under-reporting in silence.
const placeWindow = async (proc, windowId, slot) => {
  const screen = await screenOf(proc, windowId)
  const width = Math.min(WINDOW_W, screen.w)
  const height = Math.min(WINDOW_H, screen.h)
  const room = { x: Math.max(0, screen.w - width), y: Math.max(0, screen.h - height - 40) }
  const steps = Math.max(1, Math.floor(Math.min(room.x, room.y) / CASCADE) + 1)
  const step = slot % steps
  const x = step * CASCADE
  const y = 40 + step * CASCADE
  if (!warnedSmallScreen && (width < WINDOW_W || height < WINDOW_H)) {
    warnedSmallScreen = true
    log.warn(
      `this screen fits ${width}x${height} of the ${WINDOW_W}x${WINDOW_H} a bot window wants — ` +
        'Meet will send these bots smaller video than it sends a full-screen participant',
    )
  }
  await speak(proc, ['bounds', windowId, String(x), String(y), String(width), String(height)]).catch(() => {})
}

// Stream stats for a guest come from chrome://webrtc-internals, kept open in a
// second, minimised window of its process. It sees every peer connection in
// the process — including the ones Meet hides in module closures, which
// nothing injected into the page can reach — and, unlike a page, Chrome's
// scripting interface is allowed to read it. It polls getStats itself, once a
// second, and renders the results into tables whose ids spell out what they
// hold: <rid>-<lid>-table-<statId>-<field>.
const INTERNALS = 'chrome://webrtc-internals/'

// The dashboard's card thumbnail, drawn in the page. The bot's own tile first —
// it is the one carrying Meet's own-video controls (Reframe, Backgrounds,
// effects), which no remote tile has — and only then the biggest playing
// video, because in a grid of three the biggest can be somebody else's dark
// camera.
const GRAB_VIDEO = [
  '(function(){',
  'var playing=function(v){return v&&v.readyState>=2&&v.videoWidth>0&&!v.paused};',
  'var best=null,area=0;',
  '[].slice.call(document.querySelectorAll("[data-participant-id]")).forEach(function(t){',
  '  if(best)return;',
  '  if(!t.querySelector("[aria-label*=Reframe i],[aria-label*=Backgrounds i],[aria-label*=effects i]"))return;',
  '  var v=t.querySelector("video");if(playing(v))best=v});',
  'if(!best)[].slice.call(document.querySelectorAll("video")).forEach(function(v){',
  '  if(!playing(v))return;',
  '  var r=v.getBoundingClientRect();var a=r.width*r.height;if(a>area){area=a;best=v}});',
  'if(!best)return "";',
  'var w=320,h=Math.max(1,Math.round(w*best.videoHeight/best.videoWidth));',
  'var c=document.createElement("canvas");c.width=w;c.height=h;',
  'try{c.getContext("2d").drawImage(best,0,0,w,h);return c.toDataURL("image/jpeg",0.6)}catch(e){return ""}',
  '})()',
].join('')

// Who is behind each track the page is playing, read from the tiles. A remote
// participant's <video> carries the receiver track, whose id is exactly the
// `trackIdentifier` webrtc-internals prints for that inbound stream, and the
// participant's name is a leaf text inside the same tile (`data-participant-id`)
// — measured on a live call, and the same match the RTC stream monitor
// extension makes on Meet. The self tile is told by its own-video controls.
// Names are cleaned the way the extension cleans them: no timers, no
// Material icon ligatures, no control labels, nothing over forty characters.
const TILE_NAMES = [
  '(function(){',
  'var JUNK=/^(video|audio|camera|microphone|mic|screen|presentation|participant|remote|local|you|muted|unmuted|off|on|pinned|speaker)$/i;',
  'var WORD=/^(your|my|own|self|local|remote|the|a|an|is|video|audio|camera|microphone|mic|screen|share|shared|sharing|view|feed|stream|preview|presentation|participant|placeholder|avatar|thumbnail|tile|muted|unmuted|off|on|pinned|speaker|you|excellent|good|fair|poor|weak|strong|unstable|connection|quality|signal|network|status|reconnecting|connecting|connected|disconnected|speaking|raised|hand|reaction|guest|host|owner|admin|moderator|others|might|still|see|full)$/i;',
  'var allJunk=function(t){var p=t.split(/[\\s\\-_,./]+/).filter(Boolean);if(!p.length||p.length>4)return false;for(var i=0;i<p.length;i++)if(!WORD.test(p[i]))return false;return true};',
  'var clean=function(t){if(!t)return null;t=String(t).replace(/\\s+/g," ").trim();if(!t||t.length>90)return null;if(/^[\\d\\s:.%]+$/.test(t))return null;if(/^[a-z0-9]+(_[a-z0-9]+)+$/.test(t))return null;',
  '  if(t.length>40||JUNK.test(t)||allJunk(t))return null;t=t.replace(/[,;]\\s*(muted|unmuted|camera (on|off)|video (on|off)|presenting|speaking|pinned|guest|host)\\b.*$/i,"").replace(/\\s*\\((presenting|speaking|pinned|screen share)\\)\\s*$/i,"").replace(/([a-z0-9])(guest|host|owner|admin|moderator|speaker|presenter)$/i,"$1").trim();',
  '  return(t&&t.length<=40&&!JUNK.test(t)&&!allJunk(t))?t:null};',
  'var CTRL="button,[role=button],[role=menuitem],[role=tab],[role=img],[role=status],[role=tooltip],[aria-hidden=true]";',
  'var nameOf=function(tile){var counts={},order=[],kids=tile.querySelectorAll("*");for(var i=0;i<kids.length&&i<120;i++){var k=kids[i];if(k.children&&k.children.length)continue;try{if(k.closest(CTRL))continue}catch(e){}var v=clean(k.textContent);if(!v)continue;if(!counts[v]){counts[v]=0;order.push(v)}counts[v]++}',
  '  for(var j=0;j<order.length;j++)if(counts[order[j]]>1)return order[j];return order.length===1?order[0]:(order.length?order[order.length-1]:null)};',
  'var out={};[].slice.call(document.querySelectorAll("[data-participant-id]")).forEach(function(tile){if(tile.parentElement&&tile.parentElement.closest("[data-participant-id]"))return;',
  '  var local=!!tile.querySelector("[aria-label*=Reframe i],[aria-label*=Backgrounds i],[aria-label*=effects i]");var name=nameOf(tile);',
  '  [].slice.call(tile.querySelectorAll("video")).forEach(function(v){try{(v.srcObject?v.srcObject.getTracks():[]).forEach(function(t){out[t.id]={name:name,local:local}})}catch(e){}})});',
  'return JSON.stringify(out)})()',
].join('')

// Everything a failure record needs off the page, in one evaluate.
const PAGE_REPORT = [
  '(function(){',
  'var vis=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0};',
  'var label=function(e){return(e.getAttribute("aria-label")||e.textContent||"").replace(/\\s+/g," ").trim().slice(0,60)};',
  'var controls=[];[].slice.call(document.querySelectorAll("button,[role=button]")).forEach(function(b){if(controls.length>=14)return;if(!vis(b))return;var l=label(b);if(l&&controls.indexOf(l)<0)controls.push(l)});',
  'var inputs=[];[].slice.call(document.querySelectorAll("input")).forEach(function(i){if(!vis(i))return;var l=i.getAttribute("aria-label")||i.placeholder||i.name||i.type;if(l)inputs.push(l)});',
  'return JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,visibility:document.visibilityState,',
  '  controls:controls,inputs:inputs,text:((document.body&&document.body.innerText)||"").replace(/[\\r\\n]{2,}/g,"\\n").slice(0,1500)})})()',
].join('')

// One read of the whole page: which connection belongs to which page URL, and
// the handful of fields the dashboard shows. Everything else on the page is
// SDP and candidate grids the reader never touches.
const INTERNALS_READ = [
  '(function(){',
  'var heads={};',
  '[].slice.call(document.querySelectorAll(".tab-head")).forEach(function(e){',
  '  var t=e.textContent.trim();var m=t.match(/rid: (\\d+), lid: (\\d+)/);',
  '  if(m)heads[m[1]+"-"+m[2]]=t.split(" [")[0]});',
  'var stats={};',
  '[].slice.call(document.querySelectorAll("[id*=-table-]")).forEach(function(e){',
  '  var m=e.id.match(/^(\\d+-\\d+)-table-(.+)-(\\w+)$/);if(!m)return;',
  '  var f=m[3];if(!/^(type|kind|bytesSent|bytesReceived|packetsReceived|currentRoundTripTime|packetsLost|jitter|state|nominated|mediaSourceId|trackIdentifier|frameWidth|frameHeight|framesPerSecond|codecId|ssrc|mid|rid|nackCount|pliCount|jitterBufferDelay|jitterBufferEmittedCount|framesDropped|freezeCount|decoderImplementation|audioLevel|qualityLimitationReason|localCandidateId|remoteCandidateId|candidateType|protocol|dtlsState|mimeType|clockRate|channels|availableOutgoingBitrate|selectedCandidatePairId)$/.test(f))return;',
  '  var k=m[1]+"|"+m[2];if(!stats[k])stats[k]={pc:m[1]};',
  '  var v=e.textContent.trim();if(v.indexOf(f)===0)v=v.slice(f.length);v=v.replace(/\\s*\\uD83D\\uDD17\\s*$/,"").trim();',
  '  stats[k][f]=v});',
  'return JSON.stringify({heads:heads,stats:stats})',
  '})()',
].join('')

// ---------------------------------------------------------------------------
// Processes.

// Every guest's process, so a run that dies can still take them down.
const processes = new Set()
// Profile directories not yet removed. A stopped process leaves the set of
// live processes at once, but its profile may still be on disk for a few
// seconds while Chrome finishes unlinking — and a caller that exits in that
// window (`call-bots join` does, the moment teardown resolves) would strand
// it. Tracked separately so the exit hook can take them, whichever way the
// process goes.
const pendingProfiles = new Set()
const removeProfile = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true })
    pendingProfiles.delete(dir)
    return true
  } catch {
    return false
  }
}

// These AppKit calls address only our PID and do not request Automation access.
// Read actual isHidden state: a failed hide must never look successful.
const visibility = (proc, visible) => {
  const operation = (proc.visibilityQueue || Promise.resolve()).then(async () => {
    if (proc.stopping || !alive(proc)) throw new Error('The bot browser is closed')
    const helper = await ensureHelper()
    const result = await invoke(helper, [String(proc.child.pid), visible ? 'unhide' : 'hide'], { owner: proc })
    if (result !== (visible ? 'visible' : 'hidden')) throw new Error(`The bot browser could not be ${visible ? 'shown' : 'hidden'}`)
    return visible
  })
  proc.visibilityQueue = operation.catch(() => {})
  return operation
}

const startProcess = async (media, options, guest) => {
  clearStaleProfiles()
  const [bundle] = await Promise.all([ensureGuestBundle(), ensureHelper()])
  options.signal?.throwIfAborted()
  const userDataDir = mkdtempSync(join(tmpdir(), 'call-bots-meet-guests-'))
  pendingProfiles.add(userDataDir)
  let proc
  let bridge
  try {
    mkdirSync(join(userDataDir, 'Default'), { recursive: true })
    const allow = { 'https://meet.google.com:443,*': { setting: 1 } }
    writeFileSync(join(userDataDir, 'Default', 'Preferences'), JSON.stringify({
      browser: { allow_javascript_apple_events: true },
      profile: { content_settings: { exceptions: { media_stream_camera: allow, media_stream_mic: allow } } },
    }))
    const socket = join(userDataDir, 'driver.sock')
    const token = randomBytes(32).toString('hex')
    bridge = new MeetBridge(socket, token, options.readVolume)
    await bridge.listen()
    const extension = await prepareExtension(userDataDir, socket, token, guest.label, guestColorHex((guest.n || 1) - 1), {
      macOS: true, audio: !options.noAudio ? media?.audio : null,
    })
    options.signal?.throwIfAborted()
    const child = spawn(bundleBinary(bundle), [
      `--user-data-dir=${userDataDir}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
      '--no-startup-window', '--lang=en-US', '--no-first-run', '--no-default-browser-check',
      '--enable-logging', `--log-file=${join(options.runDir || userDataDir, `${guest.n || 1}-chrome.log`)}`,
      '--use-mock-keychain', '--password-store=basic', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--use-fake-device-for-media-stream',
      `--auto-select-tab-capture-source-by-title=${SCREEN_TITLE}`,
      ...(media && !options.noVideo ? [`--use-file-for-fake-video-capture=${media.video}`] : []),
      `${RUN_MARKER}=${options.runId}`,
    ], { stdio: 'ignore', detached: true })
    proc = { child, userDataDir, bridge, helpers: new Set() }
    processes.add(proc)
    bridge.onWindowCreated = () => {
      if (!(options.windowsVisible?.() ?? options.headed) && !proc.stopping) {
        visibility(proc, false).catch((error) => log.warn(error.message))
      }
    }
    bridge.onDisconnect = (error) => { proc.failureReason = error.message; stop(proc).catch(() => {}) }
    child.once('error', (error) => { proc.failureReason = error.message; bridge.close(error) })
    child.once('exit', () => { bridge.close(new Error('The Meet browser exited')); proc.removeAbort?.() })
    const abort = () => { stop(proc).catch(() => {}) }
    options.signal?.addEventListener('abort', abort, { once: true })
    proc.removeAbort = () => options.signal?.removeEventListener('abort', abort)
    if (options.signal?.aborted) abort()
    const deadline = Date.now() + READY_TIMEOUT
    while (Date.now() < deadline && alive(proc) && !proc.stopping) {
      options.signal?.throwIfAborted()
      const count = await speak(proc, ['count'], { timeout: 120_000 }).catch((error) => {
        if (error.message === PERMISSION_HELP) throw error
        return null
      })
      if (count !== null && Number(count) >= 0) {
        let timer
        try {
          await Promise.race([bridge.ready, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('The Meet audio extension did not connect')), 30000)
          })])
        } finally { clearTimeout(timer) }
        options.signal?.throwIfAborted()
        if (proc.stopping) throw new Error('The Meet browser stopped while starting')
        return proc
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('The Call Bots browser did not start')
  } catch (error) {
    bridge?.close(error)
    if (proc) await stop(proc)
    else removeProfile(userDataDir)
    throw error
  }
}

// A polite quit, then the process's actual exit — so the orchestrator's sweep
// never finds a browser still on its way out and reports it as a leftover —
// and a kill for one that lingers: a throwaway profile has nothing to save.
const stop = (proc) => proc.stopPromise ??= stopProcess(proc)
const stopProcess = async (proc) => {
  proc.stopping = true
  proc.removeAbort?.()
  proc.bridge?.close()
  for (const helper of proc.helpers || []) helper.kill('SIGTERM')
  processes.delete(proc)
  if (processes.size === 0) slots = 0
  if (alive(proc)) {
    await speak(proc, ['quit'], { timeout: 5_000 }).catch(() => {})
    const gone = Date.now() + EXIT_WAIT
    while (Date.now() < gone && alive(proc)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  if (alive(proc)) kill(proc, 'SIGTERM')
  const dead = Date.now() + 2000
  while (Date.now() < dead && alive(proc)) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (alive(proc)) {
    kill(proc, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  // Chrome keeps unlinking its own files for several seconds after the kill,
  // and a removal that lands inside that window loses — measured as one
  // profile left behind per run at 2.5 s of retries. The first few attempts
  // are awaited, so a caller that shuts down straight afterwards leaves
  // nothing behind: `call-bots join` exits on Ctrl-C the moment teardown
  // resolves, and background timers die with the process. The rest run on
  // unref'd timers, and the next start clears whatever a crashed run left.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (removeProfile(proc.userDataDir)) return
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  const later = (attempt = 0) => {
    if (removeProfile(proc.userDataDir) || attempt >= 16) return
    setTimeout(() => later(attempt + 1), 1000).unref?.()
  }
  later()
}

const kill = (proc, signal) => {
  try {
    process.kill(-proc.child.pid, signal)
  } catch {
    try {
      proc.child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

// Profiles a previous run could not remove — it crashed, or Chrome outlived
// its sweep. Nothing else refers to them once their browser is gone.
const clearStaleProfiles = () => {
  const dir = tmpdir()
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('call-bots-meet-guests-'))
  } catch {
    return
  }
  const held = new Set([...processes].map((proc) => proc.userDataDir))
  for (const name of names) {
    const path = join(dir, name)
    if (held.has(path)) continue
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Still held by something; the next start tries again.
    }
  }
}

// The browsers are detached so a group kill can target each precisely, which
// also means nothing kills them for us. A run that dies without tearing down
// would otherwise leave its windows on screen for good.
let exitHooked = false
const killOnExit = () => {
  if (exitHooked) return
  exitHooked = true
  const bail = () => {
    for (const proc of processes) kill(proc, 'SIGTERM')
    processes.clear()
    // Including the profiles of processes already stopped whose directory
    // Chrome had not finished releasing. Synchronous on purpose: this runs
    // inside process 'exit', where nothing asynchronous ever gets a turn.
    for (const dir of [...pendingProfiles]) removeProfile(dir)
  }
  process.once('exit', bail)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      bail()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

// ---------------------------------------------------------------------------
// The window.

// How long one read of webrtc-internals serves every asker. The dashboard's
// state request and the health tick both want a summary; two reads a few
// milliseconds apart would make the later one a rate over no time at all.
const FRESH_MS = 1500
// The gap between a window's first two reads, which together make its first
// real rate. Longer than a refresh of webrtc-internals, or the pair could
// straddle none and report a bot sending nothing.
const FIRST_SAMPLE_MS = 2500
// A rate is taken over this much history, not just the last two reads:
// webrtc-internals refreshes its tables about once a second, and unevenly
// while its window sits minimised, so two reads 1.5 s apart can straddle no
// refresh (a rate of zero) or two (double). Over a wider window both even out.
const RATE_WINDOW_MS = 6000

export class GuestWindow {
  constructor(proc, windowId, tag, label = null) {
    this.proc = proc
    this.windowId = windowId
    this.label = label
    this.visible = true
    this.sceneWindow = null
    // Names proved for tracks, kept until the track leaves the stats: a tile
    // that the grid unmounts for a moment must not turn its row back into
    // "Video · 1234" and back.
    this.names = new Map()
    this.namesAt = 0
    // Rides in the URL fragment, which Meet ignores and webrtc-internals
    // prints, so this window's connections can be told from any other's.
    this.tag = tag
    this.closed = false
    this.delayWaiters = new Set()
    this.statsWindow = null
    this.statsPromise = null
    // Cumulative bytes per stream over the last RATE_WINDOW_MS of reads,
    // shared by both readers: every read is another sample for the other.
    this.samples = new Map()
    this.cache = { summary: null, summaryAt: 0, snapshot: null, snapshotAt: 0 }
    this.inFlight = { summary: null, snapshot: null }
  }

  static async open(media, options, { tag = 'guest', label = null, n = 1 } = {}) {
    if (process.platform !== 'darwin') {
      throw new Error('This Meet window driver requires macOS')
    }
    killOnExit()
    const proc = await startProcess(media, options, { label, n })
    let windowId
    try {
      windowId = (await speak(proc, ['new-window'])).trim()
      if (!/^\d+$/u.test(windowId)) throw new Error('the Call Bots browser opened no window')
    } catch (error) {
      await stop(proc)
      throw error
    }
    if (process.env.CALL_BOTS_DEBUG_MEET) {
      console.error('[guest-browser] pid', proc.child.pid, 'window', windowId, 'for', tag)
    }
    await placeWindow(proc, windowId, slots++)
    const window = new GuestWindow(proc, windowId, tag, label)
    window.selectedVisibility = options.windowsVisible ?? (() => Boolean(options.headed))
    // Meet starts visible on Mac. Only an explicit dashboard visibility
    // choice hides it; there is no automatic reveal-and-hide startup cycle.
    try { await window.setVisible(options.windowsVisible?.() ?? Boolean(options.headed)) }
    catch (error) { await window.close(); throw error }
    return window
  }

  // Show or hide this guest's whole browser — its Meet window and the stats
  // window with it. The application is hidden, not the window minimised, so
  // nothing of it sits in the Dock either.
  async setVisible(visible) {
    if (this.isClosed()) throw new Error('The bot browser is closed')
    this.visible = await visibility(this.proc, Boolean(visible))
  }

  // Refresh the track → name map from the tiles, at most every few seconds,
  // or sooner when a stream the panel shows has no name yet.
  async #refreshNames(inboundTracks) {
    const unnamed = inboundTracks.some((track) => track && !this.names.has(track))
    if (!unnamed && Date.now() - this.namesAt < 5000) return
    this.namesAt = Date.now()
    const read = await this.evaluate(TILE_NAMES).catch(() => null)
    if (!read || typeof read !== 'object') return
    for (const [track, who] of Object.entries(read)) {
      if (who?.name && !who.local) this.names.set(track, who.name)
    }
  }

  #tagged(url) {
    return url.includes('#') ? url : `${url}#cb-${this.tag}`
  }

  #speak(args, options) {
    return speak(this.proc, args, options)
  }

  #exec(windowId, source) {
    return this.#speak(['exec', windowId], { input: source })
  }

  // The second window of this guest's process, on webrtc-internals. Memoised
  // while in flight; a failure is not, so the next read tries again rather
  // than costing the guest its stats for the whole call.
  async #ensureStatsWindow() {
    if (this.closed) return null
    if (this.statsWindow) return this.statsWindow
    const mine = (this.statsPromise ??= (async () => {
      const id = (await this.#speak(['new-window'])).trim()
      if (!this.visible) await this.setVisible(false)
      if (!/^\d+$/u.test(id)) throw new Error('the Call Bots browser did not open a window')
      await this.#speak(['set-url', id, INTERNALS])
      // Nobody needs to see it; it keeps polling while minimised.
      await this.#speak(['minimize', id]).catch(() => {})
      if (!this.visible) await this.setVisible(false)
      if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window', id, 'for', this.tag)
      return id
    })().catch((error) => {
      if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window failed:', error.message)
      if (this.statsPromise === mine) this.statsPromise = null
      return null
    }))
    this.statsWindow = await mine
    return this.statsWindow
  }

  async #readInternals() {
    const windowId = await this.#ensureStatsWindow()
    if (!windowId) return null
    let out = ''
    try {
      out = await this.#exec(windowId, INTERNALS_READ)
    } catch (error) {
      // Closed by hand, say: forgotten, so the next read opens another rather
      // than asking a gone window forever.
      if (/window is gone/u.test(error.message)) {
        this.statsWindow = null
        this.statsPromise = null
      }
      return null
    }
    try {
      return JSON.parse(out)
    } catch {
      return null
    }
  }

  // The same shape the stream monitor's summary takes, so the card needs no
  // second code path; and the expanded stream panel in the shape the
  // monitor's snapshot takes, so the dashboard needs no second renderer.
  // Everything here is what webrtc-internals already prints; this only
  // arranges it.
  rtcSummary() {
    return this.#shared('summary', () => this.#readSummary())
  }

  rtcSnapshot() {
    return this.#shared('snapshot', () => this.#readSnapshot())
  }

  // One read serves every asker for a moment, and a read in flight is shared
  // rather than raced: a second Apple Event behind the first would only slow
  // both down, and its answer would be a rate over nothing.
  #shared(kind, read) {
    if (this.cache[kind] !== null && Date.now() - this.cache[`${kind}At`] < FRESH_MS) {
      return Promise.resolve(this.cache[kind])
    }
    if (this.inFlight[kind]) return this.inFlight[kind]
    this.inFlight[kind] = read()
      .then((value) => {
        this.cache[kind] = value
        this.cache[`${kind}At`] = Date.now()
        return value
      })
      .finally(() => {
        this.inFlight[kind] = null
      })
    return this.inFlight[kind]
  }

  #mine(page) {
    const marker = `#cb-${this.tag}`
    return new Set(
      Object.entries(page.heads)
        .filter(([, url]) => url.includes(marker))
        .map(([pc]) => pc),
    )
  }

  async #readSnapshot() {
    if (this.closed) return null
    const page = await this.#readInternals()
    if (!page) return null
    const mine = this.#mine(page)
    if (mine.size === 0) return null
    const now = Date.now()
    const rate = (key, bytes) => this.#rate(key, bytes, now)
    const r1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)
    const num = (value) => (value === undefined || value === '' ? null : Number(value))
    const byId = (pc, id) => (id ? page.stats[`${pc}|${id}`] ?? null : null)
    const codecOf = (stat) => {
      const codec = byId(stat.pc, stat.codecId)
      if (!codec?.mimeType) return null
      return {
        name: String(codec.mimeType).split('/').pop(),
        clock: num(codec.clockRate),
        channels: num(codec.channels),
      }
    }

    const outbound = []
    const inbound = []
    let rtt = null
    let jitter = null
    let loss = null
    let avail = null
    let limit = null
    let dtls = null
    let localCand = null
    let remoteCand = null

    for (const [key, stat] of Object.entries(page.stats)) {
      if (!mine.has(stat.pc)) continue
      const id = key.split('|')[1]
      if (stat.type === 'outbound-rtp') {
        const kbps = r1(rate(key, num(stat.bytesSent) || 0))
        const reason = stat.qualityLimitationReason
        if (reason && reason !== 'none') limit = reason
        outbound.push({
          id, kind: stat.kind ?? null, dir: 'out', ssrc: num(stat.ssrc), mid: stat.mid ?? null,
          track: stat.mediaSourceId ?? null, name: null, kbps,
          w: num(stat.frameWidth), h: num(stat.frameHeight), fps: num(stat.framesPerSecond),
          codec: codecOf(stat), bytes: num(stat.bytesSent), rid: stat.rid ?? null,
          limit: reason && reason !== 'none' ? reason : null, idle: kbps === 0,
        })
      } else if (stat.type === 'inbound-rtp') {
        const kbps = r1(rate(key, num(stat.bytesReceived) || 0))
        const lost = num(stat.packetsLost) ?? 0
        const got = num(stat.packetsReceived) ?? 0
        if (stat.kind === 'video' && jitter === null && stat.jitter) jitter = num(stat.jitter) * 1000
        inbound.push({
          id, pc: stat.pc, kind: stat.kind ?? null, dir: 'in', ssrc: num(stat.ssrc), mid: stat.mid ?? null,
          track: stat.trackIdentifier ?? null, name: null, kbps,
          w: num(stat.frameWidth), h: num(stat.frameHeight), fps: num(stat.framesPerSecond),
          codec: codecOf(stat), bytes: num(stat.bytesReceived),
          jitter: stat.jitter ? r1(num(stat.jitter) * 1000) : null,
          lossPct: got + lost > 0 ? r1((lost / (got + lost)) * 100) : null,
          jbDelay: null, framesDropped: num(stat.framesDropped), freezeCount: num(stat.freezeCount),
          nack: num(stat.nackCount), pli: num(stat.pliCount),
          decoder: stat.decoderImplementation ?? null, level: num(stat.audioLevel),
        })
      } else if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated === 'true') {
        rtt = stat.currentRoundTripTime ? num(stat.currentRoundTripTime) * 1000 : rtt
        avail = num(stat.availableOutgoingBitrate)
        const local = byId(stat.pc, stat.localCandidateId)
        const remote = byId(stat.pc, stat.remoteCandidateId)
        if (local) localCand = { type: local.candidateType ?? null, proto: local.protocol ?? null, net: null }
        if (remote) remoteCand = { type: remote.candidateType ?? null, proto: remote.protocol ?? null }
      } else if (stat.type === 'transport' && stat.dtlsState) {
        dtls = stat.dtlsState
      }
    }
    await this.#refreshNames(inbound.map((s) => s.track))
    for (const track of [...this.names.keys()]) {
      if (!inbound.some((s) => s.track === track)) this.names.delete(track)
    }
    for (const s of outbound) s.name = this.label
    for (const s of inbound) s.name = this.names.get(s.track) ?? null
    // Meet plays remote audio through detached elements with no tile to read
    // a name from. Its audio and video media sections come in matching rank
    // order, so when one connection holds equally many audio slots and exactly
    // named video slots, the pairing by rank names the audio — marked as the
    // approximation it is, and refused when anything about it is ambiguous.
    const byPc = new Map()
    for (const s of inbound) {
      if (!byPc.has(s.pc)) byPc.set(s.pc, { audio: [], video: [] })
      byPc.get(s.pc)[s.kind === 'audio' ? 'audio' : 'video'].push(s)
    }
    for (const { audio, video } of byPc.values()) {
      const numeric = (s) => (/^\d+$/u.test(String(s.mid ?? '')) ? Number(s.mid) : null)
      const audioSlots = audio.filter((s) => !s.name && s.track && numeric(s) !== null).sort((a, b) => numeric(a) - numeric(b))
      const videoSlots = video.filter((s) => s.name && s.track && numeric(s) !== null).sort((a, b) => numeric(a) - numeric(b))
      const names = new Set(videoSlots.map((s) => s.name))
      if (audioSlots.length === 0 || audioSlots.length !== video.length || videoSlots.length !== video.length) continue
      if (names.size !== videoSlots.length) continue
      audioSlots.forEach((s, index) => {
        s.name = `${videoSlots[index].name} (likely)`
      })
    }
    const lossValues = inbound.map((s) => s.lossPct).filter((v) => v !== null)
    if (lossValues.length > 0) loss = r1(Math.max(...lossValues))
    const up = r1(outbound.reduce((sum, s) => sum + (s.kbps ?? 0), 0))
    const down = r1(inbound.reduce((sum, s) => sum + (s.kbps ?? 0), 0))
    const via = localCand?.type === 'relay' || remoteCand?.type === 'relay'
    return {
      t: now, pcs: mine.size, via, viaTransport: via,
      caps: { audio: [], video: [] },
      negotiated: {
        audio: [...new Set(outbound.filter((s) => s.kind === 'audio').map((s) => s.codec?.name).filter(Boolean))],
        video: [...new Set(outbound.filter((s) => s.kind === 'video').map((s) => s.codec?.name).filter(Boolean))],
        screen: [],
      },
      down, up, rtt: r1(rtt), loss, jitter: r1(jitter),
      avail: avail === null ? null : r1(avail / 1000), limit, dtls, localCand, remoteCand,
      outbound, inbound, dataChannels: [],
    }
  }

  async #readSummary() {
    if (this.closed) return null
    let page = await this.#readInternals()
    if (!page) return null
    // A rate is the difference between two reads, so a first read on its own
    // reports every stream at zero — and a dashboard opened the moment a bot
    // lands would show it sending nothing. Take the baseline, wait a beat and
    // read again; once per window.
    if (this.samples.size === 0) {
      if (this.#tally(page) === null) return null
      await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_MS))
      page = (await this.#readInternals()) ?? page
    }
    return this.#tally(page)
  }

  // Kilobits per second of a cumulative byte counter over the last window of
  // reads. Clamped: a counter that went backwards is a new stream, not debt.
  #rate(key, bytes, now) {
    const samples = this.samples.get(key) ?? []
    samples.push({ bytes, at: now })
    while (samples.length > 2 && now - samples[1].at >= RATE_WINDOW_MS) samples.shift()
    this.samples.set(key, samples)
    const first = samples[0]
    return now > first.at ? Math.max(0, ((bytes - first.bytes) * 8) / (now - first.at)) : 0
  }

  #tally(page) {
    const mine = this.#mine(page)
    if (mine.size === 0) return null

    const now = Date.now()
    const rate = (key, bytes) => this.#rate(key, bytes, now)
    const r1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)

    let up = 0
    let upV = 0
    let down = 0
    let rtt = null
    let jitter = null
    let loss = null
    let via = false
    let limit = null
    // Distinct sources and tracks, not streams: Meet sends a camera as three
    // simulcast layers, and three layers must not read as three cameras.
    const out = { a: new Set(), v: new Set() }
    const inbound = { a: new Set(), v: new Set() }
    const byId = (pc, id) => (id ? page.stats[`${pc}|${id}`] ?? null : null)

    for (const [key, stat] of Object.entries(page.stats)) {
      if (!mine.has(stat.pc)) continue
      if (stat.type === 'outbound-rtp') {
        const kbps = rate(key, Number(stat.bytesSent) || 0)
        up += kbps
        if (stat.kind === 'video') upV += kbps
        if (kbps > 0) out[stat.kind === 'video' ? 'v' : 'a'].add(stat.mediaSourceId || key)
        const reason = stat.qualityLimitationReason
        if (reason && reason !== 'none' && kbps > 0) limit = reason
      } else if (stat.type === 'inbound-rtp') {
        const kbps = rate(key, Number(stat.bytesReceived) || 0)
        down += kbps
        if (kbps > 0) inbound[stat.kind === 'video' ? 'v' : 'a'].add(stat.trackIdentifier || key)
        if (stat.kind === 'video' && jitter === null && stat.jitter) jitter = Number(stat.jitter) * 1000
        // Worst loss among what is being received, as a percentage of packets
        // that should have arrived — the same figure the monitor's summary
        // carries, so the card's quality dot judges a guest by the same rule.
        const lost = Number(stat.packetsLost) || 0
        const got = Number(stat.packetsReceived) || 0
        if (got + lost > 0) loss = Math.max(loss ?? 0, (lost / (got + lost)) * 100)
      } else if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        if (stat.currentRoundTripTime) rtt = Number(stat.currentRoundTripTime) * 1000
        if (stat.nominated === 'true') {
          const local = byId(stat.pc, stat.localCandidateId)
          const remote = byId(stat.pc, stat.remoteCandidateId)
          if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') via = true
        }
      }
    }
    return {
      pcs: mine.size,
      via,
      down: r1(down),
      up: r1(up),
      upV: r1(upV),
      rtt: r1(rtt),
      loss: loss === null ? null : r1(loss),
      jit: r1(jitter),
      in: { a: inbound.a.size, v: inbound.v.size },
      out: { a: out.a.size, v: out.v.size },
      limit,
    }
  }

  async url() {
    if (this.closed) return 'about:blank'
    return this.#speak(['url', this.windowId]).catch(() => 'about:blank')
  }

  async goto(target) {
    const url = this.#tagged(target)
    const wanted = url.split('#')[0]
    const host = new URL(wanted).host
    // Setting the address on a window Chrome has only just made can lose to
    // the new tab page still committing underneath it — the tab stays on
    // chrome://newtab and the bot polls a page that will never be Meet. So the
    // address is checked, and set again until it holds; and the tab reports
    // the new address while the old document is still the one answering, so
    // what is asked is where the document itself says it is.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.#speak(['set-url', this.windowId, url])
      const settled = Date.now() + 2500
      while (Date.now() < settled) {
        await this.waitForTimeout(250)
        const current = await this.url().catch(() => '')
        if (current.startsWith(wanted)) {
          const deadline = Date.now() + 45_000
          while (Date.now() < deadline) {
            const seen = await this.evaluate('location.host+" "+document.readyState').catch(() => null)
            const [where, state] = String(seen ?? '').split(' ')
            if (where === host && (state === 'interactive' || state === 'complete')) {
              if (!this.visible) await this.setVisible(false)
              return
            }
            await this.waitForTimeout(250)
          }
          return
        }
      }
    }
    throw new Error('the Meet guest window would not navigate')
  }

  // `source` is a single expression; anything structured is stringified in the
  // page and parsed here. Chrome hands back the value as text, and nothing at
  // all for undefined.
  async evaluate(source) {
    if (this.closed) throw new Error('this Meet guest window is closed')
    const out = await this.#exec(this.windowId, source)
    if (out === '' || out === 'missing value' || out === 'undefined' || out === 'null') return null
    try {
      return JSON.parse(out)
    } catch {
      return out
    }
  }

  waitForTimeout(ms) {
    if (this.isClosed()) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.delayWaiters.delete(finish); resolve() }
      const timer = setTimeout(finish, ms)
      this.delayWaiters.add(finish)
    })
  }

  async beginScreenCapture() {
    // Mac Chrome requires the requesting page in the foreground. Do not
    // override a user's explicit Hide windows choice or hide it afterward.
    if (!this.visible) throw new Error('Show the bot windows before starting screen sharing')
    await this.proc.bridge.request('focus-meet')
    const deadline = Date.now() + 3000
    while (!this.isClosed() && Date.now() < deadline) {
      if (await this.evaluate('document.visibilityState') === 'visible') return
      await this.waitForTimeout(100)
    }
    throw new Error('The Meet window could not become visible for screen sharing')
  }

  // The picture this bot presents when it shares. Meet asks Chrome to capture
  // something, and the browser was started with
  // --auto-select-tab-capture-source-by-title, so it silently picks the tab
  // whose title matches — this one — and never puts a picker on the user's
  // desktop. The page carries its own moving clock, so the capture is a live
  // picture rather than a still, and it is self-contained: a data: URL needs
  // no server, which the terminal path does not have.
  async prepareScene(html) {
    if (this.closed) return null
    if (this.sceneWindow) {
      const still = await this.#speak(['url', this.sceneWindow]).catch(() => null)
      if (still) return this.sceneWindow
      this.sceneWindow = null
    }
    const id = Number(await this.#speak(['new-window']))
    if (!this.visible) await this.setVisible(false)
    if (!Number.isFinite(id)) throw new Error('the Call Bots browser would not open a window for the share')
    await this.#speak(['set-url', id, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`])
    // Tab capture sends the tab at the size it is drawn, so a default-sized
    // window shares a small picture: measured 328x175 on the wire, where a
    // person sharing a screen sends something like their display. Same page
    // area as the guest's own window, for the same reason.
    await this.#speak(['bounds', id, '0', '40', String(WINDOW_W), String(WINDOW_H)]).catch(() => {})
    this.sceneWindow = id
    if (!this.visible) await this.setVisible(false)
    return id
  }

  // What this window is showing, for a failure record. The same evidence a
  // screenshot would carry, in the form a window with no debugger can give:
  // where it is, what Meet drew, and which of its controls exist.
  async report() {
    const raw = await this.evaluate(PAGE_REPORT).catch((error) => `{"error":${JSON.stringify(error.message)}}`)
    const page = typeof raw === 'object' && raw !== null ? raw : { error: String(raw ?? 'no answer') }
    const lines = [
      `audio:      ${JSON.stringify(await this.audioState().catch((error) => ({ error: error.message })))}`,
      `url:        ${page.url ?? '(unknown)'}`,
      `title:      ${page.title ?? ''}`,
      `readyState: ${page.readyState ?? ''}   visibility: ${page.visibility ?? ''}`,
      `controls:   ${(page.controls ?? []).join(' · ') || '(none)'}`,
      `inputs:     ${(page.inputs ?? []).join(' · ') || '(none)'}`,
      '',
      'what the page said:',
      page.text ?? '(nothing rendered)',
    ]
    if (page.error) lines.unshift(`could not read the page: ${page.error}`, '')
    return lines.join('\n')
  }

  // The dashboard's card thumbnail: the bot's own tile — in a call, its camera
  // as Meet renders it — drawn to a canvas in the page and handed back as a
  // JPEG. Nothing else, and deliberately: photographing the window's rectangle
  // instead used to be the fallback, and it asked macOS for Screen Recording
  // the moment the first bot launched, before any tile existed to grab. That
  // permission lets an app read the whole screen; nothing here needs it, and
  // now that the bot windows are hidden the rectangle would hold whatever of
  // the user's desktop sits at those coordinates rather than the bot at all.
  // No tile yet means no thumbnail yet, and the card keeps its placeholder.
  async screenshot() {
    if (this.closed) return null
    const grabbed = await this.evaluate(GRAB_VIDEO).catch(() => null)
    if (typeof grabbed === 'string' && grabbed.startsWith('data:image/jpeg;base64,')) {
      return Buffer.from(grabbed.slice('data:image/jpeg;base64,'.length), 'base64')
    }
    return null
  }

  get audioControlReady() { return this.proc.bridge.audioReady && !this.isClosed() }
  get failureReason() { return this.proc.failureReason }
  setVolume(setting) { return this.proc.bridge.request('volume', setting) }
  audioState() { return this.proc.bridge.request('audio-state') }
  isClosed() { return this.closed || this.proc.stopping || !alive(this.proc) }

  // The whole process goes with the window: it was this guest's alone.
  async close() {
    if (this.closed) return
    this.closed = true
    for (const finish of [...this.delayWaiters]) finish()
    await stop(this.proc)
  }
}
