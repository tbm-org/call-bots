import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { projectRoot } from '../src/config.mjs'
import { UPDATE } from './update-config.mjs'
import { readUpdateEntries, releaseApi, rewriteUpdateUrls, verifyPublishedUpdate, verifySignature } from './update-artifacts.mjs'

const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim()

// Keep the release attachment for older apps. New apps read this signed copy
// directly from GitHub's CDN and download archives through its public asset API.
export const publishUpdateFeed = async ({ version, appcast, signUpdate }) => {
  if (git('branch', '--show-current') !== 'main' || git('status', '--porcelain')) {
    throw new Error('Publish the update feed from a clean main branch')
  }
  const release = releaseApi('releases/latest')
  if (release.tag_name !== `v${version}` || release.draft || release.prerelease) {
    throw new Error(`v${version} must be the latest published release before updating the feed`)
  }
  const { downloads } = await verifyPublishedUpdate({ release, appcast, signUpdate })
  const directAppcast = join(dirname(appcast), 'direct-appcast.xml')
  rewriteUpdateUrls({
    appcast, destination: directAppcast,
    replacements: Object.fromEntries(downloads.map((entry) => [entry.url, entry.asset.url])),
  })
  execFileSync(signUpdate, ['--account', UPDATE.keychainAccount, directAppcast])
  verifySignature(signUpdate, directAppcast)
  const rewritten = readUpdateEntries(directAppcast, version)
  if (rewritten.length !== downloads.length || downloads.some((entry) => !rewritten.some((value) =>
    value.url === entry.asset.url && value.from === entry.from &&
    value.size === entry.size && value.signature === entry.signature,
  ))) throw new Error('Rewriting the feed changed or dropped update metadata')
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
