// Shared, self-contained DOM operations. macOS serializes this function into
// a raw Apple Event; Linux bundles it as a static extension script.
export function meetPageCommand(command, args = {}) {
  const sel = args.selectors
  const patterns = args.patterns
  const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length))
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible)
  const label = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\s+/gu, ' ').trim()
  const find = (pattern) => {
    const rx = new RegExp(pattern, 'iu')
    const control = all('button,[role=button],[role=menuitem]').find((el) => rx.test(label(el)))
    if (control) return control
    let best = null
    for (const el of document.querySelectorAll('*')) {
      if (!visible(el) || !rx.test(label(el))) continue
      if (!best || (el.compareDocumentPosition(best) & Node.DOCUMENT_POSITION_CONTAINS) || best.contains(el)) best = el
    }
    return best
  }
  const device = (selector) => {
    const candidates = all(selector)
    const el = candidates.find((item) => item.hasAttribute('data-is-muted')) || candidates[0]
    if (!el) return 'unknown'
    if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return 'request'
    const muted = el.getAttribute('data-is-muted')
    if (muted === 'true') return 'off'
    if (muted === 'false') return 'on'
    if (/turn on/iu.test(label(el))) return 'off'
    if (/turn off/iu.test(label(el))) return 'on'
    return 'unknown'
  }
  const playing = (video) => video && video.readyState >= 2 && video.videoWidth > 0 && !video.paused
  const junk = /^(your|my|own|self|local|remote|the|a|an|is|video|audio|camera|microphone|mic|screen|share|shared|sharing|view|feed|stream|preview|presentation|participant|placeholder|avatar|thumbnail|tile|muted|unmuted|off|on|pinned|speaker|you|excellent|good|fair|poor|connection|quality|network|status|speaking|guest|host|owner|admin|moderator|others|might|still|see|full)$/iu
  const tileName = (tile) => {
    const counts = new Map()
    for (const el of [...tile.querySelectorAll('*')].filter((item) => !item.children.length).slice(0, 120)) {
      // Meet's onboarding can mark the entire grid aria-hidden while its
      // participant labels remain rendered. Ignore controls, not that grid.
      if (!visible(el) || el.closest('button,[role=button],[role=menuitem],[role=img],[role=tooltip]')) continue
      const text = (el.textContent || '').replace(/\s+/gu, ' ').trim()
      if (!text || text.length > 40 || /^[\d\s:.%]+$/u.test(text) || /^[a-z0-9]+(_[a-z0-9]+)+$/u.test(text)) continue
      const parts = text.split(/[\s\-_,./]+/u).filter(Boolean)
      if (parts.length > 0 && parts.every((part) => junk.test(part))) continue
      counts.set(text, (counts.get(text) || 0) + 1)
    }
    return [...counts].find(([, count]) => count > 1)?.[0] || [...counts.keys()].at(-1) || ''
  }
  if (command === 'track-names') {
    const names = {}
    const tiles = all('[data-participant-id]').filter((tile) => !tile.parentElement?.closest('[data-participant-id]'))
    for (const tile of tiles) {
      const local = Boolean(tile.querySelector('[aria-label*=Reframe i],[aria-label*=Backgrounds i],[aria-label*=effects i]'))
      const name = local && window.__callBotsMeetLabel__ ? window.__callBotsMeetLabel__ : tileName(tile)
      if (!name) continue
      for (const video of tile.querySelectorAll('video')) {
        for (const track of video.srcObject?.getTracks?.() || []) names[track.id] = { name, local }
      }
    }
    return names
  }
  if (command === 'read') {
    // Meet's new lobby has working device controls and a Leave call button.
    // That button alone no longer proves that a host admitted this guest.
    const waiting = new RegExp(patterns.lobby, 'iu').test(document.body?.innerText || '')
    const leave = !waiting && all(sel.leaveButton).length > 0
    return {
      offline: navigator.onLine === false,
      leave,
      mic: device(sel.mic), cam: device(sel.cam),
      nameField: all(sel.anonymousName).length > 0,
      named: Boolean(all(sel.anonymousName)[0]?.value),
      joinButton: Boolean(find(patterns.join)),
      askToJoin: Boolean(find(patterns.ask)),
      dismissible: Boolean(find(patterns.dismiss)),
      useDevices: Boolean(find(patterns.useDevices)),
      consent: Boolean(find(patterns.consent)),
      noDevices: Boolean(find(patterns.noDevices)),
      presenting: all(sel.stopPresent).length > 0,
      canPresent: all(sel.present).length > 0,
      headline: leave || !args.withText ? '' : (document.body?.innerText || '').replace(/[\r\n]{2,}/gu, '\n').slice(0, 1500),
    }
  }
  if (command === 'click-name' || command === 'click-selector') {
    const candidates = command === 'click-selector' ? all(args.selector) : []
    const el = command === 'click-name' ? find(args.pattern)
      : candidates.find((item) => item.hasAttribute('data-is-muted')) || candidates[0]
    if (!el) return false
    el.click()
    return true
  }
  if (command === 'type-name') {
    const el = all(sel.anonymousName)[0]
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(args.name).slice(0, 60))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  if (command === 'remote') {
    const tiles = all(sel.tile).filter((tile) => !tile.parentElement?.closest(sel.tile))
    const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }
    if (!all(sel.leaveButton).length || new RegExp(patterns.lobby, 'iu').test(document.body?.innerText || '')) return summary
    const now = Date.now()
    const seen = window.__botMeetFrames__ ??= new Map()
    const connections = window.__botPeerConnections__
    const receiving = new Set()
    const sending = new Set()
    const trackNames = new Map((window.__rtcStreamMonitor__?.model?.elements || [])
      .filter((el) => !el.local && el.name).map((el) => [el.elTrack, el.name]))
    for (const pc of connections || []) {
      try { for (const receiver of pc.getReceivers()) if (receiver.track) receiving.add(receiver.track.id) } catch {}
      try { for (const sender of pc.getSenders()) if (sender.track) sending.add(sender.track.id) } catch {}
    }
    for (const tile of tiles) {
      const aria = tile.getAttribute('aria-label') || ''
      const videos = [...tile.querySelectorAll('video')]
      const video = videos.find(playing) || videos[0]
      const own = Boolean(tile.querySelector('[aria-label*=Reframe i],[aria-label*=Backgrounds i],[aria-label*=effects i]'))
      let remote = false
      let outgoing = false
      try { remote = video?.srcObject?.getTracks().some((track) => receiving.has(track.id)) || false } catch {}
      try { outgoing = video?.srcObject?.getTracks().some((track) => sending.has(track.id)) || false } catch {}
      // A remote participant with their camera off has no receiving video
      // track. Absence from the receivers cannot make that tile local.
      const local = !remote && (outgoing || tile.hasAttribute('data-self-name') || /\b(?:you|your)\b/iu.test(aria) || own)
      const raw = tile.getAttribute('data-self-name') || tile.getAttribute('data-sort-key') || tile.querySelector('[data-self-name]')?.getAttribute('data-self-name') || aria
      let trackName
      try { trackName = video?.srcObject?.getTracks().map((track) => trackNames.get(track.id)).find(Boolean) } catch {}
      const name = local && window.__callBotsMeetLabel__ ? window.__callBotsMeetLabel__
        : (raw ? raw.split('_')[0].trim() : tileName(tile)) || trackName
      if (name) summary.names.push(`${local ? '*' : ''}${name}`)
      if (local) { summary.local += 1; continue }
      summary.remote += 1
      if (!playing(video)) continue
      summary.remotePlaying += 1
      const id = tile.getAttribute('data-participant-id') || name || String(summary.remote)
      const last = seen.get(id)
      if (!last || now - last.at > 1000) {
        if (last && last.time === video.currentTime) summary.frozen += 1
        seen.set(id, { time: video.currentTime, at: now })
      }
    }
    if (!summary.local && all(sel.leaveButton).length) {
      summary.local = 1
      if (window.__callBotsMeetLabel__) summary.names.push(`*${window.__callBotsMeetLabel__}`)
    }
    return summary
  }
  if (command === 'thumbnail') {
    const sending = new Set()
    for (const pc of window.__botPeerConnections__ || []) {
      try {
        for (const { track } of pc.getSenders()) {
          if (track?.kind === 'video' && !track.getSettings().displaySurface) sending.add(track.id)
        }
      } catch {}
    }
    const own = [...document.querySelectorAll('[data-participant-id]')].find((tile) => tile.querySelector('[aria-label*=Reframe i],[aria-label*=Backgrounds i],[aria-label*=effects i]'))
    const video = [...document.querySelectorAll('video')].find((el) => playing(el) &&
      el.srcObject?.getVideoTracks?.().some((track) => sending.has(track.id))) ||
      [...(own?.querySelectorAll('video') || [])].find(playing)
    if (!video) return null
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = Math.max(1, Math.round(320 * video.videoHeight / video.videoWidth))
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.6)
  }
  if (command === 'report') return {
    url: location.href, title: document.title, readyState: document.readyState, documentStartedAt: performance.timeOrigin,
    visibility: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight },
    controls: all('button,[role=button]').map(label).slice(0, 60),
    inputs: all('input').map((el) => el.getAttribute('aria-label') || el.placeholder || el.type),
    tiles: all('[data-participant-id]').filter((tile) => !tile.parentElement?.closest('[data-participant-id]'))
      .slice(0, 20).map((tile) => ({
        name: tile.getAttribute('aria-label'),
        text: (tile.innerText || '').slice(0, 1200),
        leaves: [...tile.querySelectorAll('*')].filter((el) => !el.children.length && el.textContent.trim())
          .slice(-30).map((el) => ({ text: el.textContent.trim().slice(0, 100), hidden: Boolean(el.closest('[aria-hidden=true]')), role: el.getAttribute('role') })),
        videos: [...tile.querySelectorAll('video')].map((video) => ({ playing: playing(video), tracks: video.srcObject?.getTracks?.().map((track) => track.id) })),
      })),
    text: (document.body?.innerText || '').slice(0, 8000),
  }
  throw new Error(`Unknown Meet page command: ${command}`)
}
