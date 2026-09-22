# Call Bots

Bots that join Aloqa and Google Meet calls from one machine. Each bot is a real
browser publishing real WebRTC media from fake capture files.

Everything below about Google Meet was measured against live Meet on
2026-09-02, not inferred. Re-measure before trusting any of it again — Google
changes this without notice, and none of it is documented by them.

## Linux Meet

`src/meet-linux/` adds the Linux x86_64 driver: full bundled Chrome for Testing,
Xvfb, static extension commands and per-profile native messaging. Never attach
CDP or disable Chrome's sandbox. The Apple Events history below describes the
Mac driver; its old Linux restrictions do not describe the new extension path.
`meet-page.mjs` is shared by both drivers. The raw `aesend` helper accepts
multiline JavaScript; do not flatten functions that rely on semicolon insertion.
Container startup is `scripts/linux-server.sh`; it requires Docker access,
publishes only loopback port 14610, and guards a 20 GiB host RAM reserve.
Do not change host packages/security or unrelated services to make it run.

## Current Meet audio and Mac visibility

Both drivers use `src/meet-extension/` for the document-start gain shim and
fixed native volume commands. `Guest.audioSetting` owns the revision; restore
it before capture and acknowledge it before committing dashboard state.
Mac now copies pinned Chrome for Testing, not the user's Google Chrome.
Its audio-service sandbox cannot read arbitrary fake-input WAVs (measured
`Failed to read ... as input to the fake device`). Package the bot recording
inside its private extension and play it through the gain graph; retain native
capture for device settings/lifecycle. Do not disable the sandbox to fix this.
Mac Meet windows stay visible by default, including added bots. The user
rejected automatic reveal/hide after observing startup flashes. Keep only
explicit dashboard Show/Hide; focus the Meet window before starting a share.
The historical launch recipes below predate these changes.

## Why Google Meet refuses a guest bot

A Meet bot joins anonymously — types a name, asks to be let in. (Until
2026-09-03 there was a second way, a saved signed-in Chrome profile driven by
Playwright; it needed one Google account per bot and a profile store to manage
them, and was removed for it. The facts measured about it are kept below where
they still explain something.) The anonymous path is the one with a trap in it.

**Attaching a debugger is what gets blocked.** Not headless, not the profile,
not the browser build — the DevTools/CDP connection itself. Proven back to back
in the same minute, on the same live meeting, with the same Chrome launch:

| how the page was driven | result |
| --- | --- |
| plain incognito, read through Chrome's AppleScript `execute javascript` | `inputs: ["Your name"]`, "This call is open to anyone" |
| same launch **plus** `--remote-debugging-port` and `connectOverCDP` | "You can't join this video call" |

A signed-in bot was unaffected and could stay headless on Playwright. Google
tolerates automation that has an identity; it does not tolerate anonymous
automation.

Headless *also* fails, and was the first thing found — but it is downstream of
this. Do not spend time on it again.

### What was ruled out

Each changed on its own against a live meeting, everything else held. None of
them changed the answer:

- bundled Chromium vs real Google Chrome
- `navigator.webdriver` true vs false (spoofed via an init script)
- `--enable-automation` present vs removed
- a fresh profile, a copy of a signed-in profile, and a fresh profile seeded
  with the real Chrome's `Local State`
- an incognito window opened inside a signed-in profile
- the meeting host present in the call vs absent
- `?hl=en&authuser=0`, `?hl=en`, and a bare URL
- the `--use-file-for-fake-*-capture` flags present vs absent
- Chrome loading the URL from its command line vs a scripted navigation
- polling the page every 500 ms from the first moment vs waiting
- connecting 1.2 s after Chrome starts vs 9 s
- `--remote-debugging-port=0` vs a fixed port

Whether a meeting accepts anonymous visitors at all is a property of the
meeting. "This call is open to anyone" is Meet saying it does. **Always re-run
the no-CDP control immediately before and after any guest experiment** — a
result without a passing control either side of it means nothing. An hour was
lost to a meeting that quietly stopped taking guests mid-investigation and then
started again.

## How to drive a guest: like a person, not a debugger

Open the window the way a user does, and script it through Chrome's AppleScript
interface. **No `--remote-debugging-port`, no Playwright, no CDP.**

```bash
open -na "Google Chrome" --args --incognito --lang=en-US "https://meet.google.com/<code>?hl=en"
```

Then read and act with `execute javascript` on the tab. This is a full working
join, verified end to end — it typed a name, clicked through, and landed in the
call:

```applescript
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t contains "<code>") then
        return execute t javascript "…returns JSON…"
      end if
    end repeat
  end repeat
end tell
```

Filling Meet's name field needs the React-safe form, not `input.value =`:

```js
var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
set.call(input, name)
input.dispatchEvent(new Event('input', { bubbles: true }))
input.dispatchEvent(new Event('change', { bubbles: true }))
```

Clicking is plain `element.click()` on the button whose `aria-label` or
`textContent` matches.

Requirements and consequences:

- Chrome needs **View → Developer → Allow JavaScript from Apple Events** on.
- macOS only. Guests cannot work this way on Linux.
- The window is real and visible. N guests means N windows on screen.
- No Playwright page object, so no `page.screenshot` for card thumbnails and no
  `addInitScript`. The RTC monitor can still go in, because `installMonitor`
  only needs an evaluate — `execute javascript` can carry it.
- **Pass `--lang=en-US` at launch.** A signed-out incognito window renders Meet
  in Chrome's own UI language regardless of `?hl=en`; one opened without it came
  up in Russian, where every English selector in the adapter misses. The in-call
  toolbar read `Выключить микрофон` / `Участники1` / `Показать экран`, and the
  leave button was `Выйти из звонка`, not `Leave call`.

### The working recipe, verified end to end

Meet showed `inputs: ["Your name"]` — the guest name field — through every step
below, with no debugger anywhere near it.

**1. A separate Chrome application bundle.** Apple Events reach only ONE process
per bundle id: start a second Chrome and `tell application "Google Chrome"`
answers for exactly one of them, and which one is not stable. A copy with its
own identity is addressed unambiguously and never collides with the user's
browser.

```bash
ditto "/Applications/Google Chrome.app" "$BUNDLE"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.aloqa.call-bots.browser" "$BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName CallBotsBrowser" "$BUNDLE/Contents/Info.plist"
xattr -cr "$BUNDLE"          # or codesign fails: "resource fork ... not allowed"
codesign --force --sign - "$BUNDLE"
```

A copy of whatever Google Chrome is installed — 1.4 GB in September 2026, not
the ~300 MB an older Chrome took — built once, cached, and rebuilt only when
Chrome's version changes. Measured on a first run: 24 s to build, and the bot
was in the call 25 s after that. Then address it as
`tell application id "com.aloqa.call-bots.browser"`.

**2. Seed the profile before first launch**, or `execute javascript` refuses
with *"Executing JavaScript through AppleScript is turned off"*. It is a
per-profile preference and there is no command-line flag for it:

```bash
mkdir -p "$DIR/Default"
echo '{"browser":{"allow_javascript_apple_events":true}}' > "$DIR/Default/Preferences"
```

**3. Launch it.** `--use-mock-keychain --password-store=basic` are not optional:
without them macOS asks for the login password to let this re-signed copy read
the real Chrome's "Chrome Safe Storage" keychain item. A throwaway incognito
profile has no use for it, and granting it would hand a re-signed Chrome copy
the real one's cookie key.

```
--user-data-dir=<temp>  --incognito  --lang=en-US
--no-first-run  --no-default-browser-check
--use-mock-keychain  --password-store=basic
--use-fake-device-for-media-stream
--use-file-for-fake-video-capture=<clip>  --use-file-for-fake-audio-capture=<voice>
```

**No `--remote-debugging-port`.** That is the whole point.

**4. Drive it with single-line JavaScript.** AppleScript string literals cannot
span lines, and a multi-line script comes back as `missing value` rather than an
error, which is a confusing half hour if you have not seen it before.

Filling Meet's name field needs the React-safe form, not `input.value =`:

```js
var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
set.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true }))
```

Clicking is plain `element.click()`.

### What this costs

- **macOS only.** Guests cannot work this way on Linux.
- **One Chrome process per guest, addressed by pid through a compiled
  helper.** `--use-file-for-fake-*` is process-wide, so a process each is what
  gives every guest its own clip and voice, cycling through the five as Aloqa
  bots do. No script layer can address a process: `tell application id`
  reaches one process per bundle id, and JavaScript for Automation's
  `Application(pid)` was measured answering from the first process whatever
  pid it was given. The Apple Event Manager itself has no such trouble, so
  `scripts/macos-app/aesend.swift` builds the target descriptor from the pid
  and sends the dozen events the driver needs (`count`, `window-id`,
  `new-window`, `url`, `set-url`, `exec` with the JavaScript on stdin,
  `minimize`, `bounds`, `get-bounds`, `close`, `hide`, `unhide`, `quit`).
  `hide`/`unhide` are not Apple Events but `NSRunningApplication`, which
  needs no permission; the bots' browser is hidden as an application by
  default (`--headed` shows it, the dashboard toggles it). Measured: twelve
  concurrent calls to two processes, every answer from the right one. The app
  build compiles it to `<projectRoot>/native/aesend`; a source checkout
  compiles it with `swiftc` into the data directory on first use. Chrome's
  window ids are *text* in its dictionary — a unique-id form carrying an
  integer is "no such object" (-1728). Errors keep their Apple Event numbers:
  -1743 is the Automation grant, -600 no such process. The grant is per target
  bundle, so more processes of the same bundle cost no new prompts. Each
  process is ~200 MB more than a window would have been.
- **About three guests on an 8-core M3 with 16 GB.** Each is a Chrome window
  encoding AV1 and decoding everyone else. Three sat at a load average of 9;
  a fourth took it to 48, Apple Events took seconds each, every probe timed
  out and the dashboard went blank. `machineProfile().meetMax` is
  `cores / 2.5` and the orchestrator warns past it. Two savings were tried
  and taken back out, because a load test must not measure less than real
  users cause: small tiled windows (Meet sizes what it requests by the tiles
  it draws — remote video fell to 640×360 at ~250 kbps per stream) and a
  720p camera clip. Guest windows now give Meet a 1920×1080 page area like
  an Aloqa bot's viewport, cascaded, with
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
  so the covered ones keep rendering (Meet pauses video in a hidden window).
  Measured at that size in a three-person call: 960×540 at ~900 kbps per
  remote stream, ~2.3 Mbps down per guest, three guests at a load average
  of 11 on the 8-core M3.
- **A cascade that runs off the screen costs the test its point.** Guest
  windows are 1920x1167 (a 1920x1080 page area plus Chrome's chrome), and
  cascading each one 36 px down pushed the third past the bottom of a
  1920x1243 display — Chrome clamps the window, the page area shrinks with
  it, and Meet quietly sends that bot smaller video. The offset now wraps
  inside `screen.availWidth/availHeight`, read once from one of the bots' own
  pages (no permission, no guessing), and a screen too small for the full page
  area logs it once rather than under-measuring in silence. Verified: three
  guests all at 1920x1080 inner, all receiving 1280x720.
- **Windows, N of them — hidden by default.** Hiding costs nothing:
  minimised for half a minute and hidden as an application for 150 s, both
  guests kept sending ~2.1 Mbps and receiving 1280×720 at 30 fps, thumbnails
  included. `document.visibilityState` reads `hidden` in a hidden window, and
  Meet would pause video for it, but nothing does with
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
  on the launch line. Hidden from before the page loads, the document keeps
  reading `visible` until the first show/hide.
- **Permission prompts the first time.** One Automation prompt — the app asking
  to control the *Call Bots browser* — because driving Chrome without a debugger
  *is* Apple Events. It is sent deliberately as the first event after the
  browser comes up, before any guest window exists, with two minutes for a
  person to answer it. **That is the only prompt there should ever be.** A
  Screen Recording prompt means something asked for `screencapture`: the card
  thumbnail used to photograph the window's rectangle when its canvas grab
  came back empty, which is every poll before a bot is in the call — so the
  dialog appeared the moment guests launched, asking for the run of the whole
  screen to draw a picture nothing had yet. That fallback is gone. Grants are
  per calling app: the terminal has them, the packaged `Call Bots.app` gets
  its own. **Never gate anything on
  System Events**: an earlier build checked liveness through it, the packaged
  app had no grant, macOS put up a dialog, and every Apple Event sat behind it
  until its timeout — a guest was left on Meet's name screen, untouched, while
  the same code ran clean from a shell. Liveness now comes from
  `lsappinfo find bundleid=…`, which is LaunchServices' own answer and needs no
  permission. Check grants with: `sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db
  "select client, indirect_object_identifier, auth_value from access where
  service='kTCCServiceAppleEvents'"`.
- **No Playwright page**, so no `addInitScript`. The card thumbnail is drawn
  in-page: the largest playing `<video>` (the bot's own tile) onto a canvas,
  returned as a JPEG data URL — no Screen Recording permission, and it shows
  exactly what the bot publishes. There is no fallback: no tile yet means no
  thumbnail yet, and the card keeps its placeholder. (Photographing the
  window instead would now capture whatever of the user's desktop sits at
  those coordinates, since the bot windows are hidden.) Nothing injected into a Meet page can see its peer connections —
  Meet takes `RTCPeerConnection` into a module closure while its bundle parses,
  and an injection during the load still loses the race — and `--load-extension`
  is dead in branded Chrome 152 (`chrome://extensions` stays empty, silently).
  **Stream stats come from `chrome://webrtc-internals` instead**, kept open in
  one extra window of the shared browser: it sees every connection in the
  process, Chrome lets AppleScript run JavaScript on it, and it renders live
  tables with ids `<rid>-<lid>-table-<statId>-<field>` (`bytesSent`, `kind`,
  `currentRoundTripTime`, `mediaSourceId`…). Each guest's page URL carries
  `#cb-<slug>`, which Meet ignores and the `.tab-head` prints, so a guest's
  own connections can be told from the others'.

Note `open -na "Google Chrome" --args ...` does **not** start a process — it
adds a tab to the existing incognito window and drops the `--args`. Only
spawning the binary directly makes a new process.

### The ways to a guest's own camera that do not work (measured 2026-09-03)

Before the helper, four other routes were measured against the live meeting.
Each is still true; none is worth an evening again.

- **`Application(pid)` in JavaScript for Automation.** With two processes of
  the bots' bundle it answered *both* pids from the same process —
  sequentially, concurrently, and by window id, every call landed in the first
  process launched. Both processes number their windows identically
  (`windows[0].id()` was the same in each), so a misrouted event even finds a
  matching window: bot-1's mute muted bot-2, bot-2 never had stats. The script
  layers resolve by bundle id; only a raw target descriptor carries the pid.
- **A bare DevTools client** — `--remote-debugging-port=0`, a hand-written
  WebSocket client sending only `Page.navigate` and `Runtime.evaluate`, no
  Playwright, no domain enabling — got "You can't join this video call" in
  2.5 s. It is the open port Meet objects to, not what is sent over it.
- **Media substituted in the page.** A canvas fed by the guest's MJPEG frames
  and an audio graph playing its voice, served by the dashboard on
  `127.0.0.1` (which needs `local_network_access` granted in the profile or
  `--disable-features=LocalNetworkAccessChecks`: a Meet page fetching
  loopback otherwise sits pending forever behind a permission prompt nobody
  answers). The tracks were real and ready in every run. Meet never took
  them: `getUserMedia` overridden on the instance and on
  `MediaDevices.prototype`, `RTCPeerConnection` wrapped, `addTrack`,
  `addTransceiver` and `replaceTrack` hooked, every iframe realm hooked at
  insertion and again through the `contentWindow` getter — zero calls to any
  of them, in any realm, while the call ran. Meet's media stack does not go
  through the page's WebIDL surface at all.
- **Hooks installed before Meet's bundle**, to rule out "too late": navigate
  to `https://meet.google.com/robots.txt` (same origin, no scripts), install
  the hooks, `fetch` the meeting page with the profile's cookies,
  `history.replaceState` to the meeting URL, `document.open()` and write it
  in — the Window survives, so the hooks do. This *works* as far as it goes,
  and two things had to be learned for it: every meet.google.com response
  carries `require-trusted-types-for 'script'`, so the HTML, the parser
  (`DOMParser`) and each script go through a Trusted Types policy (any name
  is accepted); and the script-src is a per-response nonce with
  `'strict-dynamic'`, so the written page's own `<script>` tags are refused
  and Meet stalls on "Getting ready…". Non-parser-inserted scripts are exempt
  under `'strict-dynamic'`, so the runnable scripts are lifted out and
  replayed as created elements in document order, each external one loaded
  before the next, with `document.readyState` held at `loading` and
  `DOMContentLoaded`/`load` dispatched at the end. Meet then boots fully —
  name field, mic and camera controls, joins the call — with the hooks in
  place from its first instruction. And still zero calls.

## Other Meet facts worth not rediscovering

- **Presenting DOES work for a guest** (measured 2026-09-03), though it never
  did for the signed-in account bots: those had our capture shim answering
  `getDisplayMedia`, and Meet's own bundle threw `DisconnectedError` on the
  track it was handed. A guest window has no shim, so Meet asks Chrome itself.
  The browser is launched with
  `--auto-select-tab-capture-source-by-title=Call Bots shared screen`, the bot
  opens a window of its own on the same scene page this app has always shared
  (as a `data:` URL, so the terminal path needs no server), and Chrome picks
  that tab silently — no picker on anyone's desktop. Two things about the DOM:
  the button that stops it carries **no aria-label**, only the text
  `cancel_presentationStop presenting` with the icon ligature glued on, so it
  is clicked by name; and the toolbar's `You are presenting` is what states
  the share is running. Measured on the wire: 1972×1052 at first, which Meet
  then scales down while the scene barely changes — the same thing it does to
  a person sharing a static screen. **One presenter at a time**: while a bot
  is presenting, Meet takes the share control away from every other
  participant — the toolbar reads "Tester 1 is presenting" and the More
  options menu has no share entry at all — so a second bot asked to share
  reports `blocked`, which is the truth about the call rather than a fault.
  Aloqa lets every bot share at once; this is the one place the fleet share
  buttons mean something different.
- **Send codecs do not work.** Meet negotiates its own list and picks AV1 from
  it whatever the preference says — a runtime switch to vp9 and a launch-time
  h264 both left AV1 on the wire.
- **The stream monitor only works because of a bridge.** Meet keeps its
  `RTCPeerConnection`s in module closures, out of reach of the monitor's scan
  from `window`; it reported "no connection" on a live call. `src/codec-shim.js`
  publishes its registry as `window.__botPeerConnections__` to fix that, which
  is why the codec shim stays installed for account bots even though codec
  *control* is off. Guests have no shim and so no monitor.
- **Today's self tile has no self marker** — no `data-self-name`, no
  `aria-label`, no "you". Matching *sent* tracks does not identify it either,
  because Meet's effects pipeline publishes a different track than the self view
  renders. Remote tiles are the ones playing a `getReceivers()` track.
- **Meet renders in the browser's UI language for a guest**, which is why the
  guests' Chrome is started with `--lang=en-US`; the adapter reads English
  control labels. (A signed-in account's own language setting overrode even
  that, back when accounts were a way in.)
- **Stream rows can be named without touching a peer connection.** A remote
  participant's tile (`[data-participant-id]`) holds a `<video>` whose
  `srcObject` track id is exactly the `trackIdentifier` webrtc-internals
  prints for that inbound stream, and the participant's name is a leaf text
  inside the tile (measured: "Tester 2", "Mahmud Nosirov"). The self tile
  says "Others might still see your full video." and carries the own-video
  controls. Remote audio plays through detached `<audio>` elements with no
  tile, but Meet's audio and video media sections come in matching rank
  order, so equal-sized slot sets pair by numeric mid and the audio takes the
  video's name marked "(likely)" — the same approximation, with the same
  fail-closed guards, as the RTC stream monitor extension makes. Outgoing rows
  take the bot's own label.
- **Address windows by id, never by position.** `repeat with _c in windows`
  hands back `item i of windows`, a reference by position, and Chrome orders
  `windows` front-to-back — a window made or raised between the lookup and
  the use moved every position along. That was every "mix-up" of 2026-09-02:
  a guest navigating another's window, a guest's failure closing a window
  that was never its own, two windows tagged for one bot. `window id N` is an
  object specifier Chrome resolves when the line runs. Likewise take a new
  window's id from the creation (`set _w to make new window` / `id of _w`):
  diffing the window list before and after fails silently under load, when a
  listing that errored read as an empty list.
- **The participant check reads tiles, not attributes.** Today's Meet tile
  carries no `data-self-name` and no `aria-label`, so `verify` reported every
  participant nameless, and it took `tile.querySelector('video')` — the first
  of the several Meet paints one participant into, which need not be the one
  with the picture — so every remote read as not playing. It now takes the
  name from the tile's leaf text (the same read the stream rows use) and
  counts a tile as playing when any of its videos is: measured
  `remote 1, remotePlaying 1, names ["Tester 2","*Tester 1"]`.
- **No `//` comments inside a source that goes through `oneLine()`.** It
  collapses the script to one line, so everything after such a comment is
  commented out; the whole evaluate then comes back as `missing value`, which
  reads like a permissions or timing fault and is neither. `HELPERS` says so
  and `REMOTE_SOURCE` now says so too — it cost a build to relearn.
- **The app's server must not outlive the app.** `applicationWillTerminate`
  runs for an ordinary quit, not for a crash or a kill, so the node server
  survived — bots still in the call, nobody able to see or stop them, and port
  4610 still taken. The next launch then found the old server answering and
  used it, so an updated app quietly ran the code it replaced. (Three test runs
  here measured an old build for exactly that reason.) The shell now passes
  `CALL_BOTS_SUPERVISOR` and the server stops when that pid is gone: measured
  three seconds after a `kill -9` of the app, with the bots closed and the
  port free. `pkill -f "MacOS/CallBots"` kills only the shell — quit through
  the app or `POST /api/quit`.
- **A launch failure must not leave a bot in `created`.** Removing the Google
  account path left one call to `guest.releaseProfile()` in the orchestrator's
  catch — the method was gone, so the handler threw a TypeError of its own, the
  real error was lost, and the bot sat in `created` for ever while the session
  said it was running. Found on a cold start, where the first launch is slow
  enough to fail; it would have hit any failing launch, on either platform.
- **A closed page must end a join, not be polled.** Every read of a closed
  window fails, and the join loop treated each failure as "try again next
  tick" — so a bot closed mid-join (a Stop during a batch, a card removed)
  ran on to its deadline, ten minutes for one in the lobby, with the roster's
  teardown awaiting that promise the whole time. Stop sat at "stopping"
  indefinitely and the window could not start another session; only quitting
  the app cleared it. `page.isClosed()` is checked at the top of the loop and
  inside the device waits, and `#fail` reports "closed while it was joining"
  rather than the step's own message, which used to blame Meet for it.
- **`pkill -x "Call Bots"` matches nothing** — the binary inside the bundle is
  `CallBots`, no space. Use `pkill -f "MacOS/CallBots"`, or `POST /api/quit`,
  which is what the app's own menu does and which rescued a wedged instance in
  five seconds.
- **osascript stuck inside an Apple Event ignores SIGTERM.** Thirty of them
  were alive at once under load, each holding a queue slot for 25 s.
  `killSignal: 'SIGKILL'`, a 10 s timeout, and a queue that sends three at a
  time and refuses what has waited longer than 6 s.
- **webrtc-internals refreshes its tables about once a second, unevenly**
  while its window is minimised: two reads 1.5 s apart can straddle no
  refresh (a rate of zero) or two (double). Rates are taken over a six-second
  window of samples, and the first read takes a 2.5 s baseline.
- **Chrome holds a profile with a `SingletonLock` symlink** pointing at
  `<hostname>-<pid>`. That target is not a real path, so `existsSync()` follows
  it, finds nothing and reports no lock — it has to be read with `readlink`.
- **"Call Bots was prevented from modifying apps on your Mac"** is Chrome
  finishing its own update, attributed to whatever launched Chrome. Call Bots
  needs no such permission; deny it.

To get a meeting code for testing, open `meet.google.com` signed in to any
Google account, click `New meeting` (a button), then `Create a meeting for
later` (a **menuitem**, not a button), and read the code out of
`document.body.innerText`.

## Releasing

Write `release-notes/<version>.md` first — that is what the update dialog
shows a person, and a release that changes what the app does cannot say only
"a new version is available". Without one the script falls back to that line.

`npm run release:mac -- <version>` sets the version itself, builds, signs and
publishes; Sparkle reads `updates/appcast.xml` on `main` through GitHub's raw CDN
and downloads archives through its public asset API. Publishing the feed adds
a commit after the release tag. Keep the `codex/updates` compatibility tag:
0.8.3 reads it to upgrade to 0.8.4. The release attachment keeps the original
feed for older apps. A version has to be
given on the command line — nothing infers one. Check the latest published version on
GitHub before choosing the next version.

Delta sources must be exact published ZIPs verified against GitHub's digest and
the signed release feed; never rebuild historical versions to make patches.

## Verification

Do not add or run automated tests. Verify changes in a real call when needed.
