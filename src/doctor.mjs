import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { bundledChromiumPath, meetReadiness, systemChromePath } from './browser.mjs'
import { bundledMediaDir } from './config.mjs'
import { machineProfile } from './machine.mjs'
import { detectTtsEngine } from './tts.mjs'

const ok = (label, detail) => ({ ok: true, label, detail })
const bad = (label, detail) => ({ ok: false, label, detail })
const warn = (label, detail) => ({ ok: 'warn', label, detail })

export const collectChecks = async () => {
  const checks = []

  const [major] = process.versions.node.split('.').map(Number)
  checks.push(
    major >= 20
      ? ok('node', `v${process.versions.node}`)
      : bad('node', `v${process.versions.node} — need Node 20 or newer`),
  )

  const chrome = systemChromePath()
  const chromium = bundledChromiumPath()
  if (chrome) checks.push(ok('browser', `system Chrome (${chrome})`))
  else if (chromium) checks.push(ok('browser', 'bundled Chromium (Playwright)'))
  else checks.push(bad('browser', 'none found — install Google Chrome or run: npx playwright install chromium'))

  // Voices ship with the app, so a machine with no text-to-speech is fine —
  // it only matters for a bot beyond the shipped set on a machine that has no
  // imported voice either.
  const shipped = existsSync(join(bundledMediaDir, 'voice-1.wav'))
  const tts = await detectTtsEngine()
  if (shipped) {
    checks.push(ok('speech', 'bundled voices'))
  } else {
    checks.push(
      tts === 'tones'
        ? warn('speech', 'no voices bundled and no system text-to-speech — bots will publish tones')
        : ok('speech', `system text-to-speech via ${tts}`),
    )
  }

  const meet = await meetReadiness()
  checks.push(meet.ready
    ? ok('meet', meet.macOS ? `bundled Chrome for Testing found — about ${machineProfile().meetMax} Meet guests at once`
      : 'bundled browser and virtual display tools found; Chrome sandbox namespaces must be permitted')
    : warn('meet', meet.reason))

  const machine = machineProfile()
  checks.push(
    ok('machine', `${machine.memGB} GB RAM, ${machine.cores} cores — about ${machine.recommendedMax} guests at once`),
  )

  return checks
}

export const runDoctor = async () => {
  const checks = await collectChecks()
  const mark = { true: '✓', false: '✗', warn: '!' }
  for (const check of checks) {
    console.log(` ${mark[String(check.ok)]} ${check.label.padEnd(8)} ${check.detail}`)
  }
  const healthy = checks.every((check) => check.ok !== false)
  console.log(healthy ? '\nready' : '\nfix the ✗ items above, then run this again')
  return healthy
}
