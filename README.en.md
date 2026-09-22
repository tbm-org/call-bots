# Call Bots

*По-русски: [README.md](README.md)*

Put bots into Aloqa or Google Meet calls from one computer. Each bot is a real
browser that opens the call link and publishes real audio and video. Bots join
as anonymous guests — in Aloqa and in Google Meet alike — so there is nothing
to provision. Meet is the rare case, and it stays out of the dashboard until
you paste a Meet link.

## One command

```bash
./run.sh --link "<call-link>" --bots 10
```

That is the whole setup. It installs its own Node, its own Chromium and
everything else into `./.server`, then sends the bots in. Run it again and it
starts in about a second. Works on macOS and Ubuntu.

```bash
./run.sh --link "<link>" --bots 3 --share 1                 # one bot shares its screen
./run.sh --link "<link>" --bots 10 --camera off --mic off   # arrive muted and dark
./run.sh --link "<link>" --bots 5 --video-codec vp9         # prefer a camera send codec
./run.sh --ui                                               # a window instead of the terminal
./run.sh --check                                            # set up, send no bots
./run.sh --clean                                            # remove everything it installed
```

`--ui` opens a dashboard on `http://127.0.0.1:4610` with a card per bot: mute,
camera, screen share, send codecs, remove, and the same for all of them at
once; the header shows the computer's live CPU, RAM and network throughput,
so the headroom for more bots is always in view. Pin the bot you keep coming
back to and its card moves to a row of its own above every batch, so it is
never a scroll away. A bot's stream monitor opens with the path ICE settled
on — `direct · STUN · UDP`, or `via TURN relay` when the media is detouring
through a relay — with the candidate types and DTLS state on hover. It binds
to localhost, so on a server reach it through a tunnel:

```bash
ssh -L 4610:127.0.0.1:4610 <user>@<server>
```

## Outgoing volume in Aloqa and Google Meet

Click the speaker icon on a bot card or **Volume** in the **All bots** bar to reveal the slider.
It stays collapsed by default. Adjust what other participants hear, live from
**0–200%**. **100%** is the original level;
**0%** sends silence. Above 100% amplifies the signal and may distort loud
recordings. The microphone mute button stays independent: changing a muted
bot's volume does not unmute it.

The all-bots slider sets the same level for the bots currently in the call;
**Mixed** means their levels differ. Each bot keeps its level through microphone
restarts and automatic rejoins. Newly added bots start at 100%, and settings
are not saved across sessions. Meet supports the same controls on Mac and Linux.
The sliders are disabled while the microphone controller is unavailable.

## Google Meet

Meet is a rare guest here, so it stays out of sight: paste a
`https://meet.google.com/abc-defg-hij` link and one line appears under the link
field. With an Aloqa link, or none, the dashboard says nothing about Meet at all.

Meet bots are guests and need no Google account: each bot opens a real Chrome
window, types its name and joins — or waits for you to admit it, exactly as an
Aloqa guest does. Terminal: that is what `join` already does. Guests get the
same card as every other bot: a live thumbnail of what they publish, the stream
monitor with per-stream codec, resolution and bitrate — each stream named after
the participant it belongs to, with Meet's audio marked "(likely)" because Meet
only pairs it by position — and the dark-camera watchdog.

On **macOS**, a guest needs:

- **Bundled Chrome for Testing.** The dashboard downloads the browser pinned
  by Call Bots. Guests use a private copy, prepared once per browser update,
  with separate profiles. Your own Chrome installation and sign-ins are not
  used. The packaged extension controls audio before Meet captures the
  microphone; the private connection never attaches a browser debugger.
- **One macOS Automation prompt**, the first time: *Call Bots wants access to
  control the Call Bots browser.* Click Allow. It appears before any bot window
  opens, and it is the **only** permission Call Bots asks for. If you are ever
  shown a Screen Recording prompt, deny it — nothing here needs to read your
  screen.

On a Mac, Meet browser windows open and stay **visible by default**, including
when more bots are added. There is no automatic show-and-hide cycle.
**Hide windows / Show windows** remains available if you explicitly want to
hide an already joined bot. Show the windows before starting screen sharing:
Mac Chrome requires the Meet page to be visible when capture begins.
Linux bots render inside a private virtual display and need no desktop window.

Every guest is its own Chrome process with its own camera clip and voice — the
five cycle through the bots exactly as they do for Aloqa. Its private
extension applies the volume before publishing audio, with Chrome's sandbox
kept enabled.

Plan on **about three guests per 8-core Mac**: each is a full Chrome process
encoding and decoding video at the size a real user's window is — the same
1920×1080 page area an Aloqa bot has — so what the call measures is what real
users would cause. Call Bots warns when a send goes past what the machine can
carry.

### Linux server

Linux Meet bots remain anonymous: no Google accounts or saved sign-ins are
needed. Use the supplied **Ubuntu 24.04, Linux x86_64 container**. Each bot runs
the bundled Chrome for Testing on a private virtual display, with its own
camera and voice. Controls travel through a private extension connection;
no browser debugger is attached. The dashboard has the same call controls,
thumbnails and stream monitor. **Show windows** is hidden on the server.
Volume controls are available; send-codec controls remain Aloqa-only.

Docker with Compose and permission to run this task's container are required.
From a checkout owned by a non-root user:

```bash
./scripts/linux-server.sh
```

The launcher builds the image and keeps running as its supervisor. It exposes
only `127.0.0.1:14610`, preserves **20 GiB of host available RAM**, and stops
only the container it started if that reserve is crossed or you press Ctrl-C.
Run it in a dedicated directory; it refuses to reuse an existing container
with the same project name. Persistent clips and run data stay in
`.server/container-data`. It never installs host packages, invokes sudo,
changes host security settings, or stops other services. An administrator can
run the launcher when the task owner has no Docker access; the browser still
runs as the non-root owner of the checkout. For a root-owned checkout, supply
an explicit non-root container identity, for example:

```bash
CALL_BOTS_UID=1000 CALL_BOTS_GID=1000 ./scripts/linux-server.sh
```

From your computer, open a tunnel and then visit `http://127.0.0.1:14610`:

```bash
ssh -N -L 14610:127.0.0.1:14610 <user>@<server>
```

The container uses its own IPC and a scoped seccomp profile to allow Chrome's
sandbox. If the host policy still blocks sandbox namespaces, have the
administrator provide a compatible isolated container environment. Do not
disable the sandbox or change a shared host's security policy to bypass it.

On a dedicated Linux x86_64 machine with dependencies already installed,
`./run.sh --no-deps --link "https://meet.google.com/abc-defg-hij" --bots 3`
also works. Install the bundled browser, Xvfb and xauth first; `doctor` reports
missing requirements. Meet always uses its private virtual display, including
with `--headed`. Use `--browser auto` or `chromium`, not system Chrome.
Windows and Linux ARM64 Meet drivers are not included.

Normal dashboard launches still bind to localhost. `CALL_BOTS_HOST=0.0.0.0`
is provided for container networking only; publish the port on host localhost,
since the dashboard has no authentication. Stop removes task processes and
temporary browser profiles, while retaining saved clips and diagnostic logs.

## What Meet will not do

Bots enter directly when permitted, or wait for the host to admit them. Camera,
microphone, participant checks, the RTC stream monitor and the dark-camera
watchdog all work the same as on Aloqa — a Meet bot whose camera goes dark gets
healed like any other.

One thing stays off for Meet, because Meet itself will not do it: **send
codecs**, since Meet negotiates its own list and picks AV1 from it whatever the
preference says. The control is hidden rather than left to fail, and the check
behind it is in `src/platforms/meet.mjs`. Screen sharing does work — a bot
shares the same scene an Aloqa bot does, picked up without a picker ever
appearing on your desktop — but **one bot at a time**: while one presents,
Meet removes the share control from everyone else, so a second bot asked to
share reports that it is blocked. Guest access depends on the meeting settings:
allow anonymous guests and admit them when prompted. Workspace administrators
can also restrict access; an account type alone does not determine it.

**Browser download or setup failed.** Reopen the dashboard to retry the pinned
browser download, or run `npx playwright install chromium` in a source
checkout. `doctor` reports missing requirements. Meet cannot substitute
system Chrome, which does not load the required private extension.

**Meet is always in English for the bots.** The guests' copy of Chrome starts
with an English interface because the adapter reads Meet's English controls; if
Meet ever shows something else, the bot says so rather than timing out.

## What a bot publishes

- **Camera** — footage of a person at a desk, 1920x1080 at 30fps. Five clips,
  one per bot, so a call looks like different people.
- **Microphone** — lively real recordings of Neil deGrasse Tyson and Shakira
  (English), and Efim Shifrin, Valdis Pelsh, and Roman Kartsev (Russian).
  Each bot loops one of the five excerpts: curiosity, comedy, and playful stories.
- **Screen share (Aloqa)** — a wildflower meadow at 1920x1080, captioned with
  the bot's name and a clock.

All of it ships with the app. To use your own, drop files in
`~/Library/Application Support/CallBots/fixtures` (macOS) — `screen.webm` for
the shared screen, or run `node scripts/import-videos.mjs <folder> --bundle` to
replace the camera clips. Sources and licences are in
[media/CREDITS.md](media/CREDITS.md).

To rebuild the bundled audio from the original recordings, run `npm run voices`
with FFmpeg installed. Speakers, sources, and excerpt boundaries are recorded in
[media/voices.json](media/voices.json). New bots pick up the rebuilt files;
custom `voice-1.wav` … `voice-5.wav` files in the fixtures folder take priority.

## Good to know

- **How many.** `--check` reports what your machine can carry — about 6
  publishing bots on a 16 GB laptop, more with `--camera off --mic off`. Past
  that, CPU contention degrades the media itself.
- **Getting in.** On entry mode **Open** bots walk straight in. On **Wait for
  admission** they queue in the lobby and wait up to ten minutes for you. Meet
  guests likewise enter directly when allowed or wait for the host — and a
  Meet bot that is let straight in reports a failure in a minute rather than
  sitting out the ten-minute lobby budget that never applied to it.
- **Screen sharing** is `--share <n|all>` — that many bots start sharing once
  they are in. It needs Meeting settings → Screen share → **Allowed**. If it
  was previously *On request*, send the bots again: Aloqa does not lift that one
  for anyone already in the call.
- **Send codecs.** `--audio-codec`, `--video-codec` and `--screen-codec` choose
  what a bot *sends* (`opus`; `vp8`/`vp9`/`h264`/`av1`/`h265`). In the
  dashboard, camera and screenshare dropdowns sit on each bot's stream monitor
  and in the all-bots bar (audio is opus-only, so it has no picker) —
  switchable at any moment, mid-call included. To send bots in *on* a codec
  instead of switching them afterwards, the **Codecs** link beside the
  *Join with* label brings out the same two pickers next to the camera and
  microphone toggles — folded away by default, so the bar stays one row. They
  ride the next send and leave the bots already in the call alone. A codec that turns out to carry nothing — H265 stalls on
  some machines — is handed back to the call's own codec at the join, and the
  bot's card says so. An encoder can also wedge later, mid-call and on any
  codec; a camera that publishes nothing for twelve seconds is turned off
  and on, then rejoined on a fresh connection, and if neither works the card
  says the call cannot see that bot. A bot going dark is never silent about it: its own tile stays lit
  either way, because a self-view never reaches the network. A bot's own
  dropdowns list only what its call actually negotiates, so every choice
  offered is one that can land. A codec only ever changes through a
  negotiation the call takes part in — anything else would black the bot out
  for every other participant. On Aloqa the bot republishes its track the
  LiveKit way, so a switch lands in a second or two; other platforms
  renegotiate, and failing that the bot briefly rejoins. A switch leaves
  nothing behind it: the sender the old publication used is stopped rather
  than left to encode a second copy of the picture, so switching all day does
  not end with a bot publishing two ladders at twice the bitrate. And a
  switch made while the picture has sunk under CPU load puts the capture back
  to full size first — republishing as-is would fix the new track's ceiling
  at whatever frame it caught, with no way back up — so a bot switched at a
  bad moment still climbs to full HD. The stream rows show what was really
  negotiated. H264/H265 availability depends on the browser the bots run in.
- **A Mac app**, if you would rather not use a terminal: `npm run build:app`
  builds a versioned ZIP in `dist/` (Apple Silicon). Version `0.3.0` must be
  installed manually once and opened with right-click → Open because it is
  ad-hoc signed. After that the app checks every time it opens and once daily
  while it stays open; use **Call Bots → Check for Updates…** to check
  immediately.
- **Selector drift** is isolated in `src/platforms/aloqa.mjs` and
  `src/platforms/meet.mjs`. Verify changes in a real call.

## Releasing a Mac version

From a clean `main` branch, pass the new version to one command:

```bash
npm run release:mac -- 0.3.0
```

It builds the full ZIP and signed Sparkle patches (`.delta`) from compatible
published Mac versions, including 0.7.3. The preparation step caches the exact
published archives under `.data/build-cache/updates` and verifies their sizes,
SHA-256 hashes and signatures; it never rebuilds old versions as patch sources.
It prints each patch's size and savings and writes
`dist/release-<version>/update-sizes.json`.

The ZIP, every patch and the signed `appcast.xml` are uploaded to a draft release
and verified before publication. The command then commits the signed feed to
`updates/appcast.xml` on `main`. If interrupted, rerun the same command: an
unfinished draft is rebuilt, while an already published release has all its
downloads verified before feed publication resumes.

Users keep using **Check for Updates…**. Sparkle selects a matching patch and
downloads only changed content; sizes depend on what changed. The self-contained
ZIP remains about 210 MB for first installations and as a fallback when no
suitable patch exists or patching fails. Media quality is unchanged. See
[Sparkle's delta update documentation](https://sparkle-project.org/documentation/delta-updates/).

Apps from 0.8.4 read the main feed directly from GitHub's raw CDN and download
the ZIP or patches through the public asset API. The fixed `codex/updates` tag
still lets 0.8.3 upgrade to 0.8.4, which may require its existing one-time full
download. Earlier apps, including 0.7.3, keep using the release feed and can
select patches there.
