import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { projectRoot } from '../src/config.mjs'
import { UPDATE } from './update-config.mjs'

const api = (path, body, allowMissing = false) => {
  const args = ['api', `repos/${UPDATE.githubRepo}/${path}`]
  if (body) args.push('--method', body.method ?? 'POST', '--input', '-')
  try {
    return JSON.parse(execFileSync('gh', args, {
      cwd: projectRoot, encoding: 'utf8',
      input: body ? JSON.stringify(body.data) : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
  } catch (error) {
    if (allowMissing && /\(HTTP 404\)/u.test(String(error.stderr))) return null
    throw error
  }
}

// Keep the release attachment for older apps. New apps read this signed copy
// directly from GitHub's CDN and download archives through its public asset API.
export const publishUpdateFeed = ({ version, appcast, signUpdate }) => {
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

  const current = api(`git/ref/heads/${UPDATE.feedBranch}`, undefined, true)
  const tree = api('git/trees', { data: {
    tree: [{ path: 'appcast.xml', mode: '100644', type: 'blob', content: xml }],
  } })
  if (current && api(`git/commits/${current.object.sha}`).tree.sha === tree.sha) return { xml, release }
  const commit = api('git/commits', { data: {
    message: `Publish update feed for v${version}`,
    tree: tree.sha, parents: current ? [current.object.sha] : [],
  } })
  if (current) {
    api(`git/refs/heads/${UPDATE.feedBranch}`, {
      method: 'PATCH', data: { sha: commit.sha, force: false },
    })
  } else {
    api('git/refs', { data: { ref: `refs/heads/${UPDATE.feedBranch}`, sha: commit.sha } })
  }
  return { xml, release }
}
