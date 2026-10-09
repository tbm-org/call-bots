// Builds dist/Call Bots.app — a double-click macOS app that runs the
// dashboard with its own bundled Node runtime. macOS-only build (uses sips,
// iconutil, codesign, ditto).
import { execFileSync } from 'node:child_process'
import {
  chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { prepareSparkle } from './sparkle.mjs'
import { UPDATE } from './update-config.mjs'

const NODE_VERSION = '22.12.0'
const APP_NAME = 'Call Bots'

if (process.platform !== 'darwin') {
  console.error('the .app can only be built on macOS')
  process.exit(1)
}

const { projectRoot } = await import('../src/config.mjs')
const { version } = (await import(`file://${projectRoot}/package.json`, { with: { type: 'json' } })).default

const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const dist = join(projectRoot, 'dist')
const appRoot = join(dist, `${APP_NAME}.app`)
const contents = join(appRoot, 'Contents')
const resources = join(contents, 'Resources')
const cacheDir = join(projectRoot, '.data', 'build-cache')

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })
const step = (label) => console.log(`• ${label}`)

// --- 1. clean skeleton -------------------------------------------------------
step('creating bundle skeleton')
rmSync(appRoot, { recursive: true, force: true })
mkdirSync(join(contents, 'MacOS'), { recursive: true })
mkdirSync(join(resources, 'app'), { recursive: true })
mkdirSync(join(resources, 'node', 'bin'), { recursive: true })
mkdirSync(cacheDir, { recursive: true })

const sparkle = await prepareSparkle(cacheDir, step)
const frameworks = join(contents, 'Frameworks')
mkdirSync(frameworks, { recursive: true })
step('embedding Sparkle.framework')
run('ditto', [sparkle.framework, join(frameworks, 'Sparkle.framework')])

// --- 2. Info.plist + launcher ------------------------------------------------
writeFileSync(
  join(contents, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${UPDATE.bundleId}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>CallBots</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Controls private browser windows used to join Google Meet and Zoom calls.</string>
  <key>SUFeedURL</key><string>${UPDATE.feedUrl}</string>
  <key>SUPublicEDKey</key><string>${UPDATE.publicEdKey}</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>${UPDATE.scheduledCheckInterval}</integer>
  <key>SUAutomaticallyUpdate</key><false/>
  <key>SUAllowsAutomaticUpdates</key><false/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
  <key>SURequireSignedFeed</key><true/>
</dict>
</plist>
`,
)

// Native shell: WKWebView window that owns the bundled server's lifetime.
step('compiling native shell (swiftc)')
try {
  execFileSync('swiftc', ['--version'], { stdio: 'pipe' })
} catch {
  console.error('swiftc not found — install Xcode Command Line Tools: xcode-select --install')
  process.exit(1)
}
run('swiftc', [
  '-O',
  '-swift-version', '5',
  '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`,
  '-F', sparkle.root,
  '-framework', 'Sparkle',
  '-Xlinker', '-rpath',
  '-Xlinker', '@executable_path/../Frameworks',
  '-o', join(contents, 'MacOS', 'CallBots'),
  join(projectRoot, 'scripts', 'macos-app', 'main.swift'),
])

// The Apple Events helper for Meet guests: one Chrome process per guest,
// each addressed by pid, which no script layer can do (see
// src/guest-browser.mjs). Lives beside the app's source so the runtime finds
// it at <projectRoot>/native/aesend; a source checkout compiles the same file
// on demand instead.
step('compiling Apple Events helper (swiftc)')
mkdirSync(join(resources, 'app', 'native'), { recursive: true })
run('swiftc', [
  '-O',
  '-swift-version', '5',
  '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`,
  '-o', join(resources, 'app', 'native', 'aesend'),
  join(projectRoot, 'scripts', 'macos-app', 'aesend.swift'),
])

// --- 3. app payload ----------------------------------------------------------
step('copying app payload')
cpSync(join(projectRoot, 'src'), join(resources, 'app', 'src'), { recursive: true })
cpSync(join(projectRoot, 'package.json'), join(resources, 'app', 'package.json'))
cpSync(join(projectRoot, 'node_modules'), join(resources, 'app', 'node_modules'), {
  recursive: true,
  filter: (source) => !source.includes(`node_modules${'/'}.bin`),
})

// The footage travels with the app: whoever downloads it gets real faces and
// voices on their first call, with nothing to import and no network needed.
const media = join(projectRoot, 'media')
if (existsSync(media)) {
  const { readFileSync } = await import('node:fs')
  const { speechCoverage, MIN_SPEECH_COVERAGE } = await import('../src/wav.mjs')
  // A silent voice is invisible until someone joins the call and hears nothing,
  // so it must not get as far as a shipped app.
  const mute = readdirSync(media)
    .filter((name) => name.startsWith('voice-') && name.endsWith('.wav'))
    .map((name) => ({ name, coverage: speechCoverage(readFileSync(join(media, name))) }))
    .filter(({ coverage }) => coverage < MIN_SPEECH_COVERAGE)
  if (mute.length > 0) {
    console.error('\nthese voices are mostly silence — bots using them would say nothing:')
    for (const { name, coverage } of mute) {
      console.error(`  ${name} — ${(coverage * 100).toFixed(0)}% of it carries sound`)
    }
    console.error('\ndelete them and re-run, or re-import footage that has audio')
    process.exit(1)
  }
  const clips = readdirSync(media).filter((name) => name.endsWith('.mjpeg')).length
  step(`copying ${clips} bundled clip(s)`)
  cpSync(media, join(resources, 'app', 'media'), { recursive: true })
} else {
  console.warn('! no media/ folder — the app will ship with drawn clips instead of real footage')
  console.warn('  populate it with: node scripts/import-videos.mjs <folder-of-videos>')
}

// --- 4. bundled Node runtime -------------------------------------------------
const tarName = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`
const tarPath = join(cacheDir, tarName)
if (!existsSync(tarPath)) {
  step(`downloading Node v${NODE_VERSION} (${arch})`)
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${tarName}`)
  if (!response.ok) throw new Error(`node download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tarPath))
} else {
  step(`using cached Node v${NODE_VERSION} (${arch})`)
}
const extractDir = join(cacheDir, 'node-extract')
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
run('tar', ['-xzf', tarPath, '-C', extractDir, `node-v${NODE_VERSION}-darwin-${arch}/bin/node`])
cpSync(
  join(extractDir, `node-v${NODE_VERSION}-darwin-${arch}`, 'bin', 'node'),
  join(resources, 'node', 'bin', 'node'),
)
chmodSync(join(resources, 'node', 'bin', 'node'), 0o755)

// --- 5. icon (rendered with our own browser stack) ---------------------------
step('rendering icon')
const { chromium } = await import('playwright')
const { systemChromePath } = await import('../src/browser.mjs')
const browser = await chromium.launch({
  channel: systemChromePath() ? 'chrome' : undefined,
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`
  <body style="margin:0;background:transparent">
  <div style="width:1024px;height:1024px;border-radius:232px;
              background:linear-gradient(160deg,#1a2030,#0b0d12);
              display:grid;place-items:center;
              box-shadow:inset 0 0 0 10px rgba(255,255,255,.05)">
    <div style="width:600px;height:600px;display:grid;gap:30px;
                grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr">
      <div style="border-radius:60px;background:linear-gradient(150deg,#2f8fb0,#1f6f8b)"></div>
      <div style="border-radius:60px;background:linear-gradient(150deg,#b03868,#8b1f4f)"></div>
      <div style="border-radius:60px;background:linear-gradient(150deg,#54a33f,#3a7d2c)"></div>
      <div style="border-radius:60px;background:linear-gradient(150deg,#8a6cc4,#6b4fa0)"></div>
    </div>
  </div>`)
const iconPng = join(cacheDir, 'icon-1024.png')
await page.screenshot({ path: iconPng, omitBackground: true })
await browser.close()

const iconset = join(cacheDir, 'AppIcon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const [size, name] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'], [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'], [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]) {
  run('sips', ['-z', String(size), String(size), iconPng, '--out', join(iconset, name)])
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'AppIcon.icns')])

// --- 6. sign (ad-hoc) + zip --------------------------------------------------
step('ad-hoc code signing')
// Sparkle ships with valid nested signatures. Preserve them and sign only our
// outer bundle; --deep signing here would rewrite Sparkle's own helpers.
run('codesign', ['--verify', '--deep', '--strict', join(frameworks, 'Sparkle.framework')])
run('codesign', ['--force', '--sign', '-', appRoot])
run('codesign', ['--verify', '--deep', '--strict', appRoot])

step('zipping')
const zipPath = join(dist, `Call-Bots-${version}-macOS-${arch}.zip`)
rmSync(zipPath, { force: true })
run('ditto', ['-c', '-k', '--keepParent', appRoot, zipPath])

const sizeMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`
const { statSync } = await import('node:fs')
const du = execFileSync('du', ['-sk', appRoot]).toString().split('\t')[0]
console.log(`\nbuilt: ${appRoot} (${(Number(du) / 1024).toFixed(0)} MB)`)
console.log(`zip:   ${zipPath} (${sizeMb(statSync(zipPath).size)})`)
console.log('\nnote: ad-hoc signed. Recipients of the zip must right-click → Open on first launch')
console.log('(or: xattr -dr com.apple.quarantine "/Applications/Call Bots.app")')
