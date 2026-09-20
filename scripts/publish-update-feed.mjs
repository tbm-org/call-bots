import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { projectRoot } from '../src/config.mjs'
import { UPDATE } from './update-config.mjs'

const api = (path) => JSON.parse(execFileSync('gh', ['api', `repos/${UPDATE.githubRepo}/${path}`], {
  cwd: projectRoot, encoding: 'utf8',
}))
const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim()

// Keep the release attachment for older apps. New apps read this signed copy
// directly from GitHub's CDN and download archives through its public asset API.
export const publishUpdateFeed = ({ version, appcast, signUpdate }) => {
  if (git('branch', '--show-current') !== 'main' || git('status', '--porcelain')) {
    throw new Error('Publish the update feed from a clean main branch')
  }
  const release = api('releases/latest')
  if (release.tag_name !== `v${version}` || release.draft || release.prerelease) {
    throw new Error(`v${version} must be the latest published release before updating the feed`)
  }
  const archiveName = `Call-Bots-${version}-macOS-arm64.zip`
  const archive = release.assets.find((asset) => asset.name === archiveName)
  const legacyXml = readFileSync(appcast, 'utf8')
  const oldUrl = `https://github.com/${UPDATE.githubRepo}/releases/download/v${version}/${archiveName}`
  if (!archive || !legacyXml.includes(`url="${oldUrl}"`) || !legacyXml.includes(`length="${archive.size}"`)) {
    throw new Error('The appcast does not match the published archive')
  }
  execFileSync(signUpdate, ['--account', UPDATE.keychainAccount, '--verify', appcast])
  const directAppcast = join(dirname(appcast), 'direct-appcast.xml')
  writeFileSync(directAppcast, legacyXml.replace(`url="${oldUrl}"`, `url="${archive.url}"`))
  execFileSync(signUpdate, ['--account', UPDATE.keychainAccount, directAppcast])
  execFileSync(signUpdate, ['--account', UPDATE.keychainAccount, '--verify', directAppcast])
  const xml = readFileSync(directAppcast, 'utf8')

  const feed = join(projectRoot, UPDATE.feedPath)
  if (!existsSync(feed) || readFileSync(feed, 'utf8') !== xml) {
    mkdirSync(dirname(feed), { recursive: true })
    writeFileSync(feed, xml)
    git('add', '--', UPDATE.feedPath)
    git('commit', '-m', `Publish update feed for v${version}`)
  }
  git('push', 'origin', 'main')
  return { xml, release }
}
