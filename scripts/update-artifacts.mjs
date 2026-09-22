import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { projectRoot } from '../src/config.mjs'
import { sha256File } from './sparkle.mjs'
import { UPDATE } from './update-config.mjs'

const cacheRoot = join(projectRoot, '.data', 'build-cache', 'updates')
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: projectRoot, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024, ...options,
})
const copy = (from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE)
export const compareVersions = (left, right) => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0)
    if (difference) return difference
  }
  return 0
}
export const releaseApi = (path) => JSON.parse(run('gh', ['api', `repos/${UPDATE.githubRepo}/${path}`]))
// GitHub's REST lookup by tag excludes drafts. The CLI also searches drafts
// and returns their stable release API URL, even while downloads are untagged.
export const releaseForTag = (tag) => {
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', UPDATE.githubRepo, '--json', 'apiUrl']))
  return JSON.parse(run('gh', ['api', release.apiUrl]))
}
const archiveName = (version) => `Call-Bots-${version}-macOS-arm64.zip`
const safeName = (name) => {
  if (!name || name !== basename(name) || /[\\\0]/u.test(name) || ['.', '..'].includes(name)) {
    throw new Error('Invalid update asset filename')
  }
  return name
}

let xmlTool
const appcastTool = () => {
  if (xmlTool) return xmlTool
  const source = join(projectRoot, 'scripts', 'macos-app', 'appcast.swift')
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16)
  mkdirSync(cacheRoot, { recursive: true })
  xmlTool = join(cacheRoot, `appcast-${process.arch}-${digest}`)
  if (!existsSync(xmlTool)) {
    const temporary = `${xmlTool}.${process.pid}`
    run('swiftc', ['-swift-version', '5', '-O', source, '-o', temporary])
    renameSync(temporary, xmlTool)
  }
  return xmlTool
}

export const readUpdateEntries = (appcast, version) => {
  const items = JSON.parse(run(appcastTool(), ['read', appcast]))
  const matches = items.filter((item) => item.version === version)
  if (items.length !== 1 || matches.length !== 1) throw new Error(`The appcast must contain only the update for ${version}`)
  const urls = new Set()
  const sources = new Set()
  const entries = matches[0].enclosures.map(({ attributes: a, isDelta }) => {
    const entry = { url: a.url, size: Number(a.length), signature: a['sparkle:edSignature'], from: a['sparkle:deltaFrom'] || null }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 ||
        !/^[A-Za-z0-9+/]{86}==$/u.test(entry.signature || '') ||
        Boolean(entry.from) !== isDelta || urls.has(entry.url)) {
      throw new Error('The appcast contains invalid or duplicate download metadata')
    }
    if (entry.from && (!/^\d+\.\d+\.\d+$/u.test(entry.from) || compareVersions(entry.from, version) >= 0 || sources.has(entry.from))) {
      throw new Error('The appcast contains an invalid or duplicate patch source')
    }
    if (entry.from) sources.add(entry.from)
    urls.add(entry.url)
    return entry
  })
  if (entries.filter((entry) => !entry.from).length !== 1) throw new Error('The appcast must retain one full-download fallback')
  return entries
}

export const rewriteUpdateUrls = ({ appcast, destination, replacements }) => {
  const mapping = `${destination}.urls-${process.pid}.json`
  try {
    writeFileSync(mapping, JSON.stringify(replacements))
    run(appcastTool(), ['rewrite', appcast, mapping, destination])
  } finally { rmSync(mapping, { force: true }) }
}

export const verifySignature = (signUpdate, file, signature) => {
  run(signUpdate, ['--account', UPDATE.keychainAccount, '--verify', file, ...(signature ? [signature] : [])])
}
const verifyDigest = async (file, asset) => {
  if (!/^sha256:[a-f0-9]{64}$/u.test(asset.digest || '') ||
      statSync(file).size !== asset.size || `sha256:${await sha256File(file)}` !== asset.digest) {
    throw new Error(`${asset.name} differs from its published size or SHA-256 digest`)
  }
}

// Cache only exact published bytes. A locally rebuilt archive with the same
// version number is not a usable delta base, even if it looks identical.
const cachedAsset = async (asset, candidates = []) => {
  safeName(asset.name)
  if (!Number.isSafeInteger(asset.id) || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest || '')) {
    throw new Error(`GitHub has no verifiable identity for ${asset.name}`)
  }
  const directory = join(cacheRoot, `${asset.id}-${asset.digest.slice(7)}`)
  const destination = join(directory, asset.name)
  mkdirSync(directory, { recursive: true })
  for (const candidate of [destination, ...candidates]) {
    if (!existsSync(candidate)) continue
    try { await verifyDigest(candidate, asset) } catch { continue }
    if (candidate !== destination) copy(candidate, destination)
    return destination
  }
  const partial = `${destination}.${process.pid}.part`
  try {
    run('curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '4', '--retry-all-errors',
      '--connect-timeout', '15', '--max-time', '300', '--header', 'Accept: application/octet-stream',
      '--output', partial, asset.url,
    ])
    await verifyDigest(partial, asset)
    renameSync(partial, destination)
  } finally { rmSync(partial, { force: true }) }
  return destination
}

const assetFor = (entry, release) => {
  const asset = release.assets.find((value) =>
    entry.url === value.browser_download_url || entry.url === value.url ||
    (release.draft && entry.url === `https://github.com/${UPDATE.githubRepo}/releases/download/${release.tag_name}/${encodeURIComponent(value.name)}`),
  )
  if (!asset || asset.size !== entry.size) throw new Error(`Missing or mismatched published download: ${entry.url}`)
  safeName(asset.name)
  if (entry.from ? !asset.name.endsWith('.delta') : asset.name !== archiveName(release.tag_name.slice(1))) {
    throw new Error(`Unexpected update asset: ${asset.name}`)
  }
  return asset
}

export const verifyPublishedUpdate = async ({ release, appcast, signUpdate }) => {
  const version = release.tag_name.replace(/^v/u, '')
  const feedAsset = release.assets.find((asset) => asset.name === 'appcast.xml')
  if (!feedAsset) throw new Error('The published release is missing its appcast')
  const feed = await cachedAsset(feedAsset, appcast ? [appcast] : [])
  if (appcast) await verifyDigest(appcast, feedAsset)
  verifySignature(signUpdate, feed)
  const downloads = []
  for (const entry of readUpdateEntries(feed, version)) {
    const asset = assetFor(entry, release)
    const path = await cachedAsset(asset, appcast ? [join(dirname(appcast), asset.name)] : [])
    verifySignature(signUpdate, path, entry.signature)
    downloads.push({ ...entry, asset, path })
  }
  return { appcast: feed, downloads }
}

const zipInfo = (archive) => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], {
  input: run('unzip', ['-p', archive, 'Call Bots.app/Contents/Info.plist']),
}))

const publishedBases = async ({ version, sparkle, log }) => {
  const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${UPDATE.githubRepo}/releases?per_page=100`]))
  const releases = pages.flat().filter((release) =>
    !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/u.test(release.tag_name) &&
    compareVersions(release.tag_name.slice(1), version) < 0,
  ).sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))
  const bases = []
  for (const release of releases) {
    const from = release.tag_name.slice(1)
    const archive = release.assets.find((asset) => asset.name === archiveName(from))
    if (!archive) continue
    const path = await cachedAsset(archive, [
      join(projectRoot, 'dist', `release-${from}`, archive.name),
      join(projectRoot, '.data', `release-verification-${from}`, archive.name),
    ])
    const info = zipInfo(path)
    if (info.CFBundleIdentifier !== UPDATE.bundleId || info.SUPublicEDKey !== UPDATE.publicEdKey) {
      log(`  ${from}: incompatible bundle or signing key; full download remains available`)
      continue
    }
    if (info.CFBundleVersion !== from) throw new Error(`Published ${from} has a different bundle version`)
    const feedAsset = release.assets.find((asset) => asset.name === 'appcast.xml')
    if (!feedAsset) throw new Error(`Published ${from} has no signed appcast for verifying its archive`)
    const feed = await cachedAsset(feedAsset, [join(projectRoot, 'dist', `release-${from}`, 'appcast.xml')])
    verifySignature(sparkle.signUpdate, feed)
    const full = readUpdateEntries(feed, from).find((entry) => !entry.from)
    if (assetFor(full, release).id !== archive.id) throw new Error(`Published ${from} references another archive`)
    verifySignature(sparkle.signUpdate, path, full.signature)
    bases.push({ version: from, path, name: archive.name })
    log(`  verified published ${from}`)
  }
  return bases
}

// Preparing archives and feeds has no Git writes, version changes or uploads.
// The release command owns publication only after every local asset verifies.
export const prepareUpdateArtifacts = async ({ version, archive, releaseDir, notes, sparkle, log = console.log }) => {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Expected a three-part release version')
  const info = zipInfo(archive)
  if (info.CFBundleVersion !== version || info.CFBundleIdentifier !== UPDATE.bundleId || info.SUPublicEDKey !== UPDATE.publicEdKey) {
    throw new Error('The new archive does not match the requested version, bundle or update key')
  }
  mkdirSync(releaseDir, { recursive: true })
  const fullArchive = join(releaseDir, archiveName(version))
  if (archive !== fullArchive) copy(archive, fullArchive)
  const bases = await publishedBases({ version, sparkle, log })
  const staging = mkdtempSync(join(releaseDir, '.delta-sources-'))
  const appcast = join(releaseDir, 'appcast.xml')
  try {
    copy(fullArchive, join(staging, archiveName(version)))
    for (const base of bases) copy(base.path, join(staging, base.name))
    writeFileSync(join(staging, archiveName(version).replace(/\.zip$/u, '.md')), notes)
    // A stale feed must not make generate_appcast reuse old signatures or URLs.
    rmSync(appcast, { force: true })
    run(sparkle.generateAppcast, [
      '--account', UPDATE.keychainAccount,
      '--download-url-prefix', `https://github.com/${UPDATE.githubRepo}/releases/download/v${version}/`,
      '--embed-release-notes', '--delta-compression', 'lzma',
      '--maximum-deltas', String(bases.length), '--maximum-versions', '1', '--versions', version,
      '-o', appcast, staging,
    ], { stdio: 'inherit' })
    verifySignature(sparkle.signUpdate, appcast)
    const entries = readUpdateEntries(appcast, version)
    const files = []
    const patches = []
    const replacements = {}
    const fullBytes = statSync(fullArchive).size
    for (const entry of entries) {
      const generatedName = safeName(decodeURIComponent(new URL(entry.url).pathname.split('/').pop()))
      const prefix = `https://github.com/${UPDATE.githubRepo}/releases/download/v${version}/`
      if (entry.url !== `${prefix}${encodeURIComponent(generatedName)}` ||
          (entry.from ? !generatedName.endsWith('.delta') : generatedName !== archiveName(version))) {
        throw new Error('Generated update has an unexpected download URL')
      }
      if (entry.from && (!bases.some((base) => base.version === entry.from) || entry.size >= fullBytes)) {
        throw new Error('Generated patch has an unknown source or is not smaller than the full download')
      }
      // GitHub can rename uploaded filenames containing spaces. Sparkle's
      // default delta name includes "Call Bots", so use stable asset names.
      const name = entry.from
        ? `Call-Bots-${version}-from-${entry.from}-macOS-arm64.delta`
        : generatedName
      const path = join(releaseDir, name)
      if (entry.from) {
        copy(join(staging, generatedName), path)
        replacements[entry.url] = `${prefix}${name}`
      }
      if (statSync(path).size !== entry.size) throw new Error(`${name} has the wrong appcast size`)
      verifySignature(sparkle.signUpdate, path, entry.signature)
      files.push(path)
      if (entry.from) {
        const savings = 100 * (1 - entry.size / fullBytes)
        patches.push({ from: entry.from, name, bytes: entry.size, savingsPercent: savings })
        log(`  ${entry.from} → ${version}: ${entry.size.toLocaleString()} bytes (${savings.toFixed(3)}% smaller)`)
      }
    }
    if (Object.keys(replacements).length) {
      rewriteUpdateUrls({ appcast, destination: appcast, replacements })
      run(sparkle.signUpdate, ['--account', UPDATE.keychainAccount, appcast])
      verifySignature(sparkle.signUpdate, appcast)
      const rewritten = readUpdateEntries(appcast, version)
      if (rewritten.length !== entries.length || entries.some((entry) => !rewritten.some((value) =>
        value.url === (replacements[entry.url] || entry.url) && value.from === entry.from &&
        value.size === entry.size && value.signature === entry.signature,
      ))) throw new Error('Renaming patch assets changed or dropped update metadata')
    }
    const omitted = bases.filter((base) => !patches.some((patch) => patch.from === base.version)).map((base) => base.version)
    for (const from of omitted) log(`  ${from}: Sparkle did not produce a suitable smaller patch; using the full archive`)
    const report = { version, fullBytes, patches, fullDownloadOnly: omitted }
    writeFileSync(join(releaseDir, 'update-sizes.json'), `${JSON.stringify(report, null, 2)}\n`)
    log(`  full installer/fallback: ${fullBytes.toLocaleString()} bytes`)
    return { appcast, files, report }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
