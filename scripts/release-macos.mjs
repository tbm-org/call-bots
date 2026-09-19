import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { projectRoot } from '../src/config.mjs'
import { prepareSparkle, sha256File } from './sparkle.mjs'
import { UPDATE } from './update-config.mjs'

process.on('uncaughtException', (error) => {
  console.error(`\nrelease failed: ${error.message}`)
  process.exit(1)
})

const targetVersion = process.argv[2]
const semver = (value) => /^\d+\.\d+\.\d+$/u.test(value ?? '')
if (!semver(targetVersion)) {
  console.error('usage: npm run release:mac -- 0.3.0')
  process.exit(1)
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
const output = (command, args) =>
  execFileSync(command, args, { cwd: projectRoot, encoding: 'utf8' }).trim()
const tryOutput = (command, args) => {
  try {
    return output(command, args)
  } catch {
    return null
  }
}
const step = (label) => console.log(`\n• ${label}`)
const fail = (message) => {
  throw new Error(message)
}
const versionParts = (value) => value.split('.').map(Number)
const compareVersions = (left, right) => {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const downloadFeed = async (destination, matches) => {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      execFileSync(
        'curl',
        [
          '--fail', '--location', '--silent', '--show-error',
          '--output', destination, UPDATE.feedUrl,
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      )
      const xml = readFileSync(destination, 'utf8')
      if (matches(xml)) return xml
    } catch {
      // GitHub's latest-release redirect can take a few seconds to change.
    }
    if (attempt < 20) await wait(3_000)
  }
  fail('the public update feed did not become current within one minute')
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail('macOS releases must be built on an Apple Silicon Mac')
}
if (output('git', ['branch', '--show-current']) !== 'main') fail('release from main')
if (output('git', ['status', '--porcelain'])) fail('commit or stash changes before releasing')
run('gh', ['auth', 'status'])

step('checking main and the release version')
run('git', ['fetch', 'origin', 'main', '--tags'])
const head = output('git', ['rev-parse', 'HEAD'])
const remoteHead = output('git', ['rev-parse', 'origin/main'])

const packagePath = join(projectRoot, 'package.json')
const currentVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version
const comparison = compareVersions(targetVersion, currentVersion)
if (comparison < 0) fail(`release version cannot be older than ${currentVersion}`)
const tag = `v${targetVersion}`
const arch = 'arm64'
const archiveName = `Call-Bots-${targetVersion}-macOS-${arch}.zip`
const tagCommit = tryOutput('git', ['rev-parse', `${tag}^{}`])
const releaseJson = tryOutput('gh', [
  'release', 'view', tag, '--repo', UPDATE.githubRepo,
  '--json', 'assets,isDraft,isPrerelease,url',
])
const existingRelease = releaseJson ? JSON.parse(releaseJson) : null
const resuming = comparison === 0

if (!resuming) {
  if (head !== remoteHead) fail('main must exactly match origin/main before releasing')
  if (tagCommit || existingRelease) fail(`${tag} already exists`)
} else {
  const subject = output('git', ['log', '-1', '--format=%s'])
  if (subject !== `Release ${tag}`) {
    fail(`${targetVersion} is current, but HEAD is not its release commit`)
  }
  if (tagCommit && tagCommit !== head) fail(`${tag} does not point to HEAD`)
  if (head !== remoteHead) {
    const ahead = tryOutput('git', ['rev-list', '--count', 'origin/main..HEAD'])
    const remoteIsAncestor =
      tryOutput('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']) !== null
    if (ahead !== '1' || !remoteIsAncestor) {
      fail('main has diverged from origin/main; resolve it before resuming')
    }
  }
}

const cacheDir = join(projectRoot, '.data', 'build-cache')
const sparkle = await prepareSparkle(cacheDir, step)
const publicKey = output(sparkle.generateKeys, [
  '--account', UPDATE.keychainAccount, '-p',
])
if (publicKey !== UPDATE.publicEdKey) {
  fail(`Keychain account ${UPDATE.keychainAccount} does not match the committed public key`)
}

if (resuming && existingRelease && !existingRelease.isDraft) {
  step('verifying the already-published release')
  const verifyDir = join(projectRoot, '.data', `release-verification-${targetVersion}`)
  rmSync(verifyDir, { recursive: true, force: true })
  mkdirSync(verifyDir, { recursive: true })
  const published = join(verifyDir, 'appcast.xml')
  const expectedUrl =
    `https://github.com/${UPDATE.githubRepo}/releases/download/${tag}/${archiveName}`
  const xml = await downloadFeed(
    published,
    (value) =>
      value.includes(expectedUrl) &&
      value.includes(`<sparkle:version>${targetVersion}</sparkle:version>`),
  )
  run(sparkle.signUpdate, ['--account', UPDATE.keychainAccount, '--verify', published])
  const signature = xml.match(/sparkle:edSignature="([^"]+)"/u)?.[1]
  const remoteArchive = existingRelease.assets.find((asset) => asset.name === archiveName)
  const remoteAppcast = existingRelease.assets.find((asset) => asset.name === 'appcast.xml')
  if (!signature || !remoteArchive || !remoteAppcast) {
    fail('the published release is missing its archive or appcast')
  }
  const downloadedArchive = join(verifyDir, archiveName)
  run('curl', [
    '--fail', '--location', '--retry', '5', '--retry-all-errors',
    '--output', downloadedArchive, expectedUrl,
  ])
  run(sparkle.signUpdate, [
    '--account', UPDATE.keychainAccount, '--verify', downloadedArchive, signature,
  ])
  const downloadedDigest = `sha256:${await sha256File(downloadedArchive)}`
  if (
    statSync(downloadedArchive).size !== remoteArchive.size ||
    downloadedDigest !== remoteArchive.digest
  ) {
    fail('the published archive differs from its GitHub asset metadata')
  }
  console.log(`\nreleased: ${existingRelease.url}`)
  console.log(`feed:     ${UPDATE.feedUrl}`)
  process.exit(0)
}

let versionChanged = false
let committed = false
try {
  if (resuming) {
    step(`resuming ${tag}`)
  } else {
    step(`setting version ${targetVersion}`)
    // npm refuses to "change" a version to the one already there, and that
    // refusal would end the release before it built anything — which is what
    // happens to anyone who sets the version by hand first, or who reruns a
    // release that fell over after this step.
    if (currentVersion === targetVersion) {
      console.log(`  package.json is already ${targetVersion}`)
    } else {
      run('npm', ['version', targetVersion, '--no-git-tag-version'])
      versionChanged = true
    }
  }

  step('building the app')
  run('npm', ['run', 'build:app'])

  const app = join(projectRoot, 'dist', 'Call Bots.app')
  const archive = join(projectRoot, 'dist', archiveName)
  const executable = join(app, 'Contents', 'MacOS', 'CallBots')
  const info = join(app, 'Contents', 'Info.plist')
  if (!existsSync(archive)) fail(`build did not create ${archiveName}`)
  run('codesign', ['--verify', '--deep', '--strict', app])
  if (!output('file', [executable]).includes('arm64')) fail('launcher is not arm64')
  if (!output('otool', ['-L', executable]).includes('Sparkle.framework')) {
    fail('launcher is not linked to Sparkle.framework')
  }
  for (const [key, expected] of [
    ['CFBundleVersion', targetVersion],
    ['NSAppleEventsUsageDescription',
      'Controls private browser windows used to join Google Meet calls.'],
    ['SUFeedURL', UPDATE.feedUrl],
    ['SUPublicEDKey', UPDATE.publicEdKey],
  ]) {
    const actual = output('plutil', ['-extract', key, 'raw', '-o', '-', info])
    if (actual !== expected) fail(`${key} is ${actual}, expected ${expected}`)
  }

  step('creating the signed update feed')
  const releaseDir = join(projectRoot, 'dist', `release-${targetVersion}`)
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(releaseDir, { recursive: true })
  const releaseArchive = join(releaseDir, archiveName)
  copyFileSync(archive, releaseArchive)
  // What a person sees in the update dialog and on the release page. A
  // release that changes what the app does — this one removed the Google
  // account path — cannot say only "a new version is available", so notes
  // written for the version win, and the generic line is the fallback for a
  // release that genuinely has nothing to explain.
  const notes = join(releaseDir, `${basename(archiveName, '.zip')}.md`)
  const written = join(projectRoot, 'release-notes', `${targetVersion}.md`)
  writeFileSync(
    notes,
    existsSync(written)
      ? readFileSync(written, 'utf8')
      : `# Call Bots ${targetVersion}\n\nA new version of Call Bots is available.\n`,
  )
  console.log(`  notes: ${existsSync(written) ? written : 'generic (none written for this version)'}`)
  const appcast = join(releaseDir, 'appcast.xml')
  run(sparkle.generateAppcast, [
    '--account', UPDATE.keychainAccount,
    '--download-url-prefix',
    `https://github.com/${UPDATE.githubRepo}/releases/download/${tag}/`,
    '--embed-release-notes',
    '--maximum-deltas', '0',
    '--maximum-versions', '1',
    '--versions', targetVersion,
    '-o', appcast,
    releaseDir,
  ])
  run(sparkle.signUpdate, ['--account', UPDATE.keychainAccount, '--verify', appcast])

  const xml = readFileSync(appcast, 'utf8')
  const signature = xml.match(/sparkle:edSignature="([^"]+)"/u)?.[1]
  const expectedUrl = `https://github.com/${UPDATE.githubRepo}/releases/download/${tag}/${archiveName}`
  if (
    !signature ||
    !xml.includes(expectedUrl) ||
    !xml.includes(`<sparkle:version>${targetVersion}</sparkle:version>`)
  ) {
    fail('generated appcast is missing its version, archive URL, or signature')
  }
  run(sparkle.signUpdate, [
    '--account', UPDATE.keychainAccount, '--verify', releaseArchive, signature,
  ])

  step('committing and tagging the release')
  if (!resuming) {
    run('git', ['add', 'package.json', 'package-lock.json'])
    run('git', ['commit', '-m', `Release ${tag}`])
    committed = true
  }
  if (!tagCommit) run('git', ['tag', '-a', tag, '-m', `Call Bots ${tag}`])
  run('git', ['push', '--atomic', 'origin', 'main', tag])

  step('publishing the GitHub release')
  if (existingRelease?.isDraft) {
    run('gh', ['release', 'delete', tag, '--repo', UPDATE.githubRepo, '--yes'])
  }
  run('gh', [
    'release', 'create', tag,
    releaseArchive,
    appcast,
    '--repo', UPDATE.githubRepo,
    '--verify-tag',
    '--latest',
    '--title', `Call Bots ${tag}`,
    '--notes-file', notes,
  ])

  step('verifying the public feed')
  const published = join(releaseDir, 'published-appcast.xml')
  await downloadFeed(published, (value) => value === xml)
  const assets = JSON.parse(output('gh', [
    'release', 'view', tag, '--repo', UPDATE.githubRepo, '--json', 'assets',
  ])).assets
  const remoteArchive = assets.find((asset) => asset.name === archiveName)
  const expectedDigest = `sha256:${await sha256File(releaseArchive)}`
  if (
    !remoteArchive ||
    remoteArchive.size !== statSync(releaseArchive).size ||
    remoteArchive.digest !== expectedDigest
  ) {
    fail('published archive is missing or differs from the signed local archive')
  }

  console.log(`\nreleased: https://github.com/${UPDATE.githubRepo}/releases/tag/${tag}`)
  console.log(`feed:     ${UPDATE.feedUrl}`)
} catch (error) {
  if (versionChanged && !committed) {
    try {
      run('git', ['restore', '--', 'package.json', 'package-lock.json'])
    } catch {
      // Preserve the original release error; the worktree shows what remains.
    }
  }
  throw error
}
