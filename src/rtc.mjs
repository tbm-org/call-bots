import { pageSummary, pageSnapshot } from './rtc-page.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The vendored RTC Stream Monitor (see src/vendor/) runs inside each bot's
// call page and does all the WebRTC work itself: it discovers every
// RTCPeerConnection, polls getStats() on its own 1s loop, and keeps a
// JSON-clone-safe snapshot at window.__rtcStreamMonitor__.model. This module
// only installs it and reads that snapshot out — the evaluates below never
// touch getStats, so polling them adds no WebRTC load to the page.
const VENDOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'vendor/rtc-stream-monitor.js')

// Read once per process, cached as a promise so concurrent installs during a
// batch join share one read.
let monitorSource = null
const monitorSrc = () => (monitorSource ??= readFile(VENDOR_PATH, 'utf8'))

// Inject the monitor into a call page and hide its overlay. Late injection is
// the monitor's own tested path: its prototype hooks register pre-existing
// peer connections the moment the app next calls getStats() on them (LiveKit
// polls constantly), with a deep scan as backup. Re-running the IIFE would
// TOGGLE the panel instead of installing, so the guard comes first.
export const installMonitor = async (page) => {
  const present = await page.evaluate(() => Boolean(window.__rtcStreamMonitor__))
  if (!present) await page.evaluate(await monitorSrc())
  // Two distinct effects, both idempotent: the `min` class makes the monitor's
  // loop skip rendering entirely (collection continues), and hiding the host
  // keeps the overlay out of /api/thumb screenshots. classList.add rather than
  // clicking #bmin — the button toggles, so a repeat could un-minimise.
  return page.evaluate(() => {
    const host = document.getElementById('rtc-stream-monitor-host')
    if (!host || !host.shadowRoot) return false
    host.shadowRoot.getElementById('panel')?.classList.add('min')
    host.style.display = 'none'
    return true
  })
}

export const rtcSummary = (page) => page.evaluate(pageSummary)
export const rtcSnapshot = (page) => page.evaluate(pageSnapshot)
