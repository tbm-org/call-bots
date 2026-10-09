// Self-contained: serialized into Apple Events on macOS and packaged in the
// private browser extension on Linux. Keep DOM logic identical on both hosts.
export function zoomPageCommand(command, args = {}) {
  const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length))
  const roots = [document]
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  }
  const query = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)])
  const all = (selector) => query(selector).filter(visible)
  const label = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').replace(/\s+/gu, ' ').trim()
  const button = (pattern) => all('button,[role=button],a').find((el) => new RegExp(pattern, 'iu').test(label(el)))
  const text = () => (document.body?.innerText || '').replace(/[‘’]/gu, "'")
  const name = () => all('#input-for-name, #inputname, input[autocomplete="name"], input[placeholder*="name" i]')[0]
  const mic = () => button('^(?:unmute|mute)(?:\\b|$)')
  const cam = () => button('^(?:start|stop) (?:my )?video(?:\\b|$)')
  const state = (el, off) => !el ? 'unknown' : el.disabled || el.getAttribute('aria-disabled') === 'true'
    ? 'request' : off.test(label(el)) ? 'off' : 'on'
  const waiting = () => /please wait.*(?:host|let you in)|waiting for (?:the )?host|you are in (?:the )?waiting room|host will let you in/iu.test(text())
  const inCall = () => !waiting() && Boolean(button('^leave(?: meeting)?$')) && Boolean(mic() || cam() || button('^join audio'))
  const screen = () => button('^stop shar') ? 'on' : button('^share(?: screen)?(?:\\b|$)') ? 'off' : inCall() ? 'blocked' : 'unknown'
  if (command === 'read') return {
    headline: text().slice(0, 5000), inCall: inCall(), waiting: waiting(),
    nameField: Boolean(name()), named: name()?.value || '',
    challenge: all('iframe[title*="challenge" i]').length > 0,
    password: all('input[type=password], #input-for-pwd').length > 0,
    join: Boolean(button('^join(?: meeting)?$')),
    audio: Boolean(button('^join (?:audio by computer|with computer audio|audio)$')),
    mic: state(mic(), /^unmute/iu), cam: state(cam(), /^start/iu), screen: screen(),
  }
  if (command === 'click') {
    const el = button(args.pattern)
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false
    el.click()
    return true
  }
  if (command === 'type-name') {
    const el = name()
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(args.name).slice(0, 60))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  if (command === 'remote') {
    const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }
    if (!inCall()) return summary
    // Zoom can render remote video into canvases. Do not invent WebRTC rates
    // or mark canvas tiles as playing just because they exist.
    const ownName = args.label || window.__callBotsMeetLabel__
    const tiles = all('.video-avatar__avatar-footer, .video-avatar__footer')
    for (const tile of tiles) {
      const name = (tile.innerText || '').trim()
      if (!name || /connecting to audio/iu.test(name)) continue
      const local = /\(me\)|\(you\)/iu.test(name) || name === ownName
      summary[local ? 'local' : 'remote'] += 1
      summary.names.push(`${local ? '*' : ''}${name}`)
    }
    const count = label(button('^open the (?:manage )?participants list')).match(/pane,?\s*\[?(\d+)/iu)?.[1]
    if (count) summary.remote = Math.max(0, Number(count) - 1)
    summary.names = [...new Set(summary.names)]
    summary.local = 1
    return summary
  }
  if (command === 'thumbnail') {
    if (state(cam(), /^start/iu) !== 'on') return null
    const video = query('video').find((el) => el.srcObject?.getVideoTracks?.().some((track) => track.getSettings().deviceId))
    const canvas = document.createElement('canvas')
    canvas.width = 320
    if (video?.readyState >= 2 && video.videoWidth) {
      canvas.height = Math.round(320 * video.videoHeight / video.videoWidth)
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    } else {
      // Zoom composites video into a shared canvas inside an open shadow root.
      // Crop the bot's named tile; never substitute another participant.
      const ownName = args.label || window.__callBotsMeetLabel__
      if (!ownName) return null
      const footer = all('.video-avatar__avatar-footer').find((el) => el.innerText.trim() === ownName)
      const tile = footer?.closest('.video-avatar__avatar')?.getBoundingClientRect()
      if (!tile?.width || !tile.height) return null
      const source = query('canvas[id^="video-player-canvas-"]').find((el) => {
        const rect = el.getBoundingClientRect()
        return el.width > 0 && rect.width > 0 && tile.left >= rect.left && tile.top >= rect.top && tile.right <= rect.right + 1 && tile.bottom <= rect.bottom + 1
      })
      if (!source) return null
      const rect = source.getBoundingClientRect()
      const sx = source.width / rect.width, sy = source.height / rect.height
      canvas.height = Math.round(320 * tile.height / tile.width)
      canvas.getContext('2d').drawImage(source, (tile.left - rect.left) * sx, (tile.top - rect.top) * sy, tile.width * sx, tile.height * sy, 0, 0, canvas.width, canvas.height)
    }
    return canvas.toDataURL('image/jpeg', 0.6)
  }
  if (command === 'report') return {
    url: location.href, title: document.title, readyState: document.readyState, documentStartedAt: performance.timeOrigin,
    visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight },
    media: query('video,canvas').map((el) => ({ tag: el.tagName, id: el.id, cls: el.className, width: el.videoWidth || el.width, height: el.videoHeight || el.height, time: el.currentTime, parent: el.parentElement?.className, tracks: el.srcObject?.getTracks?.().map((track) => ({ kind: track.kind, state: track.readyState, settings: track.getSettings() })) })),
    controls: all('button,[role=button],a').map(label).slice(0, 80),
    inputs: all('input').map((el) => el.getAttribute('aria-label') || el.placeholder || el.id || el.type),
    text: text().slice(0, 8000),
  }
  throw new Error(`Unknown Zoom page command: ${command}`)
}
