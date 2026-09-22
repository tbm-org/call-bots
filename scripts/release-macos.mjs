import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { projectRoot } from '../src/config.mjs'
import { prepareSparkle } from './sparkle.mjs'
import { UPDATE } from './update-config.mjs'
import { publishUpdateFeed } from './publish-update-feed.mjs'
import { compareVersions, prepareUpdateArtifacts, releaseForTag, verifyPublishedUpdate } from './update-artifacts.mjs'

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
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const downloadFeed = async (destination, matches, source = UPDATE.feedUrl) => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const url = new URL(source)
      url.searchParams.set('check', String(Date.now()))
      const timeout = Math.max(1, Math.min(15, Math.ceil((deadline - Date.now()) / 1000)))
      execFileSync(
        'curl',
        [
          '--fail', '--location', '--silent', '--show-error',
          '--connect-timeout', '10', '--max-time', String(timeout),
          '--header', 'Accept: application/octet-stream',
          '--output', destination, url.href,
        ],
        { cwd: projectRoot, stdio: 'pipe' },
      )
      const xml = readFileSync(destination, 'utf8')
      if (matches(xml)) return xml
    } catch {
      // A newly published feed can take a few seconds to reach the CDN.
    }
    if (Date.now() + 3_000 < deadline) await wait(3_000)
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
  const releaseCommit = tagCommit ?? head
  const subject = output('git', ['log', '-1', '--format=%s', releaseCommit])
  if (subject !== `Release ${tag}`) {
    fail(`${targetVersion} is current, but its release commit was not found`)
  }
  // Feed publication and fixes to release tooling can follow the version tag.
  // Application sources must still match the release being resumed.
  const releaseIsAncestor = tryOutput('git', ['merge-base', '--is-ancestor', releaseCommit, head]) !== null
  const changes = output('git', ['diff', '--name-only', releaseCommit, head]).split('\n').filter(Boolean)
  const releaseFiles = new Set([
    UPDATE.feedPath, 'scripts/release-macos.mjs', 'scripts/update-artifacts.mjs',
    'scripts/publish-update-feed.mjs', 'scripts/macos-app/appcast.swift',
  ])
  if (!releaseIsAncestor || changes.some((path) => !releaseFiles.has(path))) {
    fail(`only release tooling and the generated update feed may change after ${tag} when resuming`)
  }
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
  step('verifying every already-published update asset')
  const release = releaseForTag(tag)
  const verified = await verifyPublishedUpdate({ release, signUpdate: sparkle.signUpdate })
  const verifyDir = join(projectRoot, '.data', `release-verification-${targetVersion}`)
  mkdirSync(verifyDir, { recursive: true })
  const direct = await publishUpdateFeed({ version: targetVersion, appcast: verified.appcast, signUpdate: sparkle.signUpdate })
  await downloadFeed(join(verifyDir, 'published-direct-appcast.xml'), (value) => value === direct.xml)
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

  step('creating signed updates from exact published archives')
  const releaseDir = join(projectRoot, 'dist', `release-${targetVersion}`)
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(releaseDir, { recursive: true })
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
  const { appcast, files } = await prepareUpdateArtifacts({
    version: targetVersion, archive, releaseDir, sparkle, notes: readFileSync(notes, 'utf8'),
  })
  const xml = readFileSync(appcast, 'utf8')

  step('committing and tagging the release')
  if (!resuming) {
    run('git', ['add', 'package.json', 'package-lock.json'])
    run('git', ['commit', '-m', `Release ${tag}`])
    committed = true
  }
  if (!tagCommit) run('git', ['tag', '-a', tag, '-m', `Call Bots ${tag}`])
  run('git', ['push', '--atomic', 'origin', 'main', tag])

  step('uploading the full installer, patches and feed to a draft release')
  if (existingRelease?.isDraft) {
    run('gh', ['release', 'delete', tag, '--repo', UPDATE.githubRepo, '--yes'])
  }
  run('gh', [
    'release', 'create', tag,
    ...files,
    appcast,
    '--repo', UPDATE.githubRepo,
    '--verify-tag',
    '--draft',
    '--title', `Call Bots ${tag}`,
    '--notes-file', notes,
  ])

  step('verifying every uploaded asset before publication')
  await verifyPublishedUpdate({
    release: releaseForTag(tag), appcast, signUpdate: sparkle.signUpdate,
  })
  run('gh', ['release', 'edit', tag, '--repo', UPDATE.githubRepo, '--draft=false', '--latest'])

  step('verifying the public release feed')
  const published = join(releaseDir, 'published-appcast.xml')
  const release = releaseForTag(tag)
  const remoteAppcast = release.assets.find((asset) => asset.name === 'appcast.xml')
  await downloadFeed(published, (value) => value === xml, remoteAppcast.url)
  step('publishing the direct update feed')
  const direct = await publishUpdateFeed({ version: targetVersion, appcast, signUpdate: sparkle.signUpdate })
  await downloadFeed(join(releaseDir, 'published-direct-appcast.xml'), (value) => value === direct.xml)

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
