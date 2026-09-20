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

## Outgoing volume in Aloqa

Click the speaker icon on a bot card or **Volume** in the **All bots** bar to reveal the slider.
It stays collapsed by default. Adjust what other participants hear, live from
**0–200%**. **100%** is the original level;
**0%** sends silence. Above 100% amplifies the signal and may distort loud
recordings. The microphone mute button stays independent: changing a muted
bot's volume does not unmute it.

The all-bots slider sets the same level for the bots currently in the call;
**Mixed** means their levels differ. Each bot keeps its level through microphone
restarts and automatic rejoins. Newly added bots start at 100%, and settings
are not saved across sessions. Volume control is available in the Aloqa
dashboard only.

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

What a guest needs, all on the Mac running Call Bots:

- **Google Chrome installed.** Guests run in a private copy of it, built on the
  first send — about half a minute, one time, and it takes as much disk as
  Chrome itself (1.4 GB today) — because Meet turns away anonymous visitors
  from any browser it can tell is automated, and the windows are driven the
  way a person drives them.
- **One macOS Automation prompt**, the first time: *Call Bots wants access to
  control the Call Bots browser.* Click Allow. It appears before any bot window
  opens, and it is the **only** permission Call Bots asks for. If you are ever
  shown a Screen Recording prompt, deny it — nothing here needs to read your
  screen.
- **macOS.** There are no Meet bots on Linux: the guest windows are driven
  through Apple Events, which do not exist there.

The windows stay hidden, like every other bot's browser — the bot browser is
hidden as an application, so nothing of it is on screen or in the Dock's
window list, and a hidden bot sends and receives exactly what a visible one
does (measured for minutes at a time). **Show windows** on the Meet line
brings them all up when you want to watch one; **Hide windows** puts them
away again. From the terminal, `--headed` shows them.

Every guest is its own Chrome process with its own camera clip and voice — the
five cycle through the bots exactly as they do for Aloqa. (Chrome's fake
devices are per process, and addressing one process among several took a
small compiled helper that ships inside the app; CLAUDE.md has the story.)

Plan on **about three guests per 8-core Mac**: each is a full Chrome process
encoding and decoding video at the size a real user's window is — the same
1920×1080 page area an Aloqa bot has — so what the call measures is what real
users would cause. Call Bots warns when a send goes past what the machine can
carry.

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
share reports that it is blocked. And
Meet turns guests away from meetings created by a personal Google account — the
bot's card says so; Google Workspace meetings take guests when the admin allows.

**"Call Bots was prevented from modifying apps on your Mac."** Dismiss it — Call
Bots never modifies an app, and nothing here needs that permission. It is Google
Chrome finishing its own update: macOS blames whichever app launched Chrome, and
the guests' copy of Chrome is launched from here. To stop it recurring, open
Chrome by itself once and let the update finish, or grant **App Management** to
*GoogleUpdater* — not to Call Bots.

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

It builds and signs the ZIP and `appcast.xml`, then publishes both as GitHub
Release assets. It also publishes a signed feed on the `codex/updates` branch.
Apps from 0.8.3 read this feed directly from GitHub's raw CDN and download
archives through the public asset API. Older apps keep using the release feed.
