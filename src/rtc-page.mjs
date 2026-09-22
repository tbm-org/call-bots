// Browser-only readouts, shared with the Linux Meet extension.
// The per-tick summary that rides the dashboard's 2s state snapshot. null only
// when the monitor is absent — the caller treats that as the reinstall signal.
export function pageSummary() {
  const api = window.__rtcStreamMonitor__
  if (!api) return null
  const m = api.model
  if (!m) return { pcs: 0 }
  // An installed monitor that has found nothing yet is the normal state right
  // after a join — the app has not built its connections. Ask it to look again
  // rather than reporting a dead call forever; the codec shim publishes the
  // page's connections, so a rescan lands them the moment they exist.
  if (!m.pcs) {
    try { api.rescan() } catch { /* a rescan that throws is not worth a lost tick */ }
  }
  const r1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null)
  // Distinct tracks, not streams: simulcast encodes one camera track several
  // times, and three layers must not read as three cameras.
  const distinct = (list, kind) => {
    const keys = new Set()
    for (const s of list) if (s.kind === kind) keys.add(s.track || s.id)
    return keys.size
  }
  return {
    pcs: m.pcs,
    via: Boolean(m.viaTransport),
    down: r1(m.down),
    up: r1(m.up),
    // Outbound VIDEO alone. The total rate cannot answer "is this bot's camera
    // reaching anyone" — a wedged encoder still leaves audio flowing, so `up`
    // stays healthy-looking at roughly the bitrate of speech.
    upV: r1(
      (m.outbound || [])
        .filter((s) => s.kind === 'video')
        .reduce((sum, s) => sum + (s.kbps ?? 0), 0),
    ),
    rtt: r1(m.rtt),
    loss: r1(m.loss),
    jit: r1(m.jitter),
    in: { a: distinct(m.inbound, 'audio'), v: distinct(m.inbound, 'video') },
    out: { a: distinct(m.outbound, 'audio'), v: distinct(m.outbound, 'video') },
    limit: m.limit ?? null,
  }
}

// The full model for one bot's expanded panel, sanitized in-page: built by
// allowlist so the heavy per-stream `raw` stats dictionaries can never leak
// into the wire format by omission. Participant names exist only on
// m.elements[].name — the stream→name join here mirrors the monitor's own
// updateCard(): match the element rendering the same track, and for outgoing
// streams that cannot be track-matched, a single distinct named local element
// is unambiguously this bot (same kind first, then any).
export function pageSnapshot() {
  const api = window.__rtcStreamMonitor__
  if (!api || !api.model) return null
  const m = api.model
  const els = m.elements || []
  const meetNames = window.__callBotsMeetCommand__?.('track-names') || {}
  const sending = new Map()
  for (const pc of window.__botPeerConnections__ || []) {
    try { for (const { track } of pc.getSenders()) if (track) sending.set(track.id, track) } catch {}
  }

  const linkedFor = (s) => {
    let linked = s.track ? els.find((e) => e.elTrack === s.track) : null
    if (!linked && s.dir === 'out') {
      const single = (list) => {
        const byName = new Map()
        for (const e of list) if (e.local && e.name) byName.set(e.name, e)
        return byName.size === 1 ? [...byName.values()][0] : null
      }
      linked = single(els.filter((e) => e.kind === (s.kind || 'video'))) ?? single(els)
    }
    return linked ?? null
  }

  const stream = (s) => {
    const linked = linkedFor(s)
    const directName = meetNames[s.track]?.name || linked?.name
    const likelyName = !directName ? api.meetAudioName?.(s, meetNames) : null
    const base = {
      id: s.id,
      kind: s.kind ?? null,
      dir: s.dir,
      ssrc: s.ssrc ?? null,
      mid: s.mid ?? null,
      track: s.track ?? null,
      name: s.dir === 'out' && window.__callBotsMeetLabel__
        ? window.__callBotsMeetLabel__ : directName ?? (likelyName ? `${likelyName} (likely)` : null),
      kbps: s.kbps ?? null,
      w: s.w ?? null,
      h: s.h ?? null,
      fps: s.fps ?? null,
      codec: (() => {
        if (!s.codec) return null
        const codec = {
          name: s.codec.name ?? null,
          clock: s.codec.clock ?? null,
          channels: s.codec.channels ?? null,
        }
        // RED never shows its face in stats — they attribute the stream to
        // the opus inside it. The wire testifies instead: full redundancy
        // roughly doubles the audio payload per packet (opus sits near
        // 60–120 bytes, RED near 180–240). Label it, so the rows and the
        // pickers tell the truth.
        if (
          s.dir === 'out' &&
          s.kind === 'audio' &&
          /^opus$/iu.test(codec.name ?? '') &&
          (s.raw?.packetsSent ?? 0) > 0
        ) {
          const payload = ((s.raw.bytesSent ?? 0) - (s.raw.headerBytesSent ?? 0)) / s.raw.packetsSent
          if (payload >= 160) codec.name = 'opus+red'
        }
        return codec
      })(),
      // The single sanctioned read of `raw`: cumulative wire bytes, which the
      // assembled model drops in favour of rates.
      bytes: s.raw ? (s.dir === 'in' ? s.raw.bytesReceived : s.raw.bytesSent) ?? null : null,
    }
    if (s.dir === 'in') {
      return Object.assign(base, {
        jitter: s.jitter ?? null,
        lossPct: s.lossPct ?? null,
        jbDelay: s.jbDelay ?? null,
        framesDropped: s.framesDropped ?? null,
        freezeCount: s.freezeCount ?? null,
        nack: s.nack ?? null,
        pli: s.pli ?? null,
        decoder: s.decoder ?? null,
        level: (s.track ? m.levels?.[s.track] : null) ?? s.audioLevel ?? null,
        // Cumulative receiver energy permits a stable RMS measurement across
        // intervals, even when the instantaneous speaking indicator is zero.
        audioEnergy: s.kind === 'audio' ? s.raw?.totalAudioEnergy ?? null : null,
        audioDuration: s.kind === 'audio' ? s.raw?.totalSamplesDuration ?? null : null,
      })
    }
    return Object.assign(base, {
      rid: s.rid ?? null,
      limit: s.limit ?? null,
      active: s.active ?? null,
      rtt: s.rtt ?? null,
      fraction: s.fraction ?? null,
      remoteJitter: s.remoteJitter ?? null,
      nack: s.nack ?? null,
      pli: s.pli ?? null,
      keyframes: s.keyframes ?? null,
      encoder: s.encoder ?? null,
      // A screen-capture track's label is a capture source, not a device
      // name — and a synthetic share (capture-shim.js) has no label at all,
      // only its tag in __botScreenTrackIds__.
      role:
        s.kind === 'video'
          ? window.__botScreenTrackIds__?.has(s.track) ||
            sending.get(s.track)?.getSettings?.().displaySurface ||
            /web-contents|screen|window|tab/iu.test(linked?.label ?? '')
            ? 'screen'
            : 'camera'
          : null,
      level: s.kind === 'audio' ? m.localAudio ?? null : null,
    })
  }

  // What this browser can SEND, for the dashboard's codec dropdowns — sender
  // capabilities only, so a decode-only codec is never offered as a choice.
  // The plumbing entries (retransmission, forward error correction, comfort
  // noise, DTMF) are not codecs anyone picks; audio 'red' stays, because
  // preferring it is how Opus redundancy is switched on.
  const sendCaps = (kind, dropped) => {
    const names = []
    for (const codec of window.RTCRtpSender?.getCapabilities?.(kind)?.codecs ?? []) {
      const name = (codec.mimeType || '').split('/')[1]?.toLowerCase()
      if (name && !dropped.includes(name) && !names.includes(name)) names.push(name)
    }
    return names
  }

  return {
    t: m.t,
    pcs: m.pcs,
    via: Boolean(m.viaTransport),
    caps: {
      audio: sendCaps('audio', ['red', 'cn', 'telephone-event']),
      video: sendCaps('video', ['rtx', 'red', 'ulpfec', 'flexfec-03']),
    },
    // Per-role, what this bot's CURRENT negotiation can carry — the dashboard
    // greys out the rest. null on a page without the codec shim.
    negotiated: window.__botCodecNegotiated__?.() ?? null,
    down: m.down ?? null,
    up: m.up ?? null,
    rtt: m.rtt ?? null,
    loss: m.loss ?? null,
    jitter: m.jitter ?? null,
    avail: m.avail ?? null,
    limit: m.limit ?? null,
    dtls: m.dtls ?? null,
    localCand: m.localCand
      ? { type: m.localCand.type ?? null, proto: m.localCand.proto ?? null, net: m.localCand.net ?? null, relay: m.localCand.relay ?? null }
      : null,
    remoteCand: m.remoteCand ? { type: m.remoteCand.type ?? null, proto: m.remoteCand.proto ?? null } : null,
    outbound: (m.outbound || []).map(stream),
    inbound: (m.inbound || []).map(stream),
    dataChannels: (m.dataChannels || []).map((d) => ({
      label: d.label ?? null,
      state: d.state ?? null,
      inKbps: d.inKbps ?? null,
      outKbps: d.outKbps ?? null,
    })),
  }
}
