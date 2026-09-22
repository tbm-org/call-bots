// Microphone capture -> gain -> outgoing track. The gain is AFTER native
// microphone processing, so automatic gain control cannot undo the slider.
// Nothing connects to the speakers, and getDisplayMedia is left alone.
(() => {
  const proto = window.MediaDevices?.prototype
  const original = proto?.getUserMedia
  if (!original || window.__botSetVolume__) return

  let setting = { volume: 100, revision: 0 }
  const graphs = new Set()
  const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 200

  const apply = (next) => {
    if (!valid(next?.volume) || !Number.isInteger(next.revision)) throw new Error('invalid audio volume')
    // A capture binding can resolve after a newer slider update.
    if (next.revision < setting.revision) return
    setting = { ...next }
    for (const graph of graphs) {
      const param = graph.gain.gain
      const now = graph.context.currentTime
      param.cancelAndHoldAtTime(now)
      param.linearRampToValueAtTime(setting.volume / 100, now + 0.02)
    }
  }

  window.__botSetVolume__ = async (next) => {
    if (!valid(next?.volume)) throw new Error('invalid audio volume')
    await Promise.all([...graphs].map(({ context }) => context.resume()))
    apply(next)
    return { ...setting }
  }
  window.__botAudioState__ = () => ({
    ...setting, captures: graphs.size,
    contexts: [...graphs].map((graph) => {
      const { context, source, gain, input, tracks } = graph
      if (!graph.meters) {
        graph.meters = [context.createAnalyser(), context.createAnalyser()]
        source.connect(graph.meters[0])
        gain.connect(graph.meters[1])
      }
      const rms = graph.meters.map((meter) => {
        const samples = new Float32Array(meter.fftSize)
        meter.getFloatTimeDomainData(samples)
        return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
      })
      return {
        state: context.state, time: context.currentTime, gain: gain.gain.value,
        input: { enabled: input.enabled, muted: input.muted, state: input.readyState, rms: rms[0] },
        outputRms: rms[1],
        outputs: [...tracks].map((track) => ({ enabled: track.enabled, state: track.readyState })),
      }
    }),
  })

  const wrap = async (input) => {
    const settings = input.getSettings()
    const context = new AudioContext({ sampleRate: settings.sampleRate, latencyHint: 'interactive' })
    let graph
    try {
      await context.resume()
      const source = window.__botCreateAudioSource__
        ? await window.__botCreateAudioSource__(context)
        : context.createMediaStreamSource(new MediaStream([input]))
      const gain = context.createGain()
      gain.gain.value = setting.volume / 100
      const destination = context.createMediaStreamDestination()
      destination.channelCount = Math.min(2, settings.channelCount || 1)
      source.connect(gain)
      gain.connect(destination)
      source.start?.()
      graph = { context, source, gain, input, tracks: new Set(), disposed: false }

      const dispose = () => {
        if (graph.disposed) return
        graph.disposed = true
        graphs.delete(graph)
        input.removeEventListener('ended', ended)
        input.removeEventListener('mute', muted)
        input.removeEventListener('unmute', unmuted)
        source.stop?.()
        source.disconnect()
        gain.disconnect()
        input.stop()
        context.close().catch(() => {})
      }
      const ended = () => {
        for (const track of [...graph.tracks]) {
          track.stop()
          track.dispatchEvent(new Event('ended'))
        }
        dispose()
      }
      const relay = (type) => {
        for (const track of graph.tracks) track.dispatchEvent(new Event(type))
      }
      const muted = () => relay('mute')
      const unmuted = () => relay('unmute')

      const decorate = (track) => {
        const stop = track.stop.bind(track)
        const clone = track.clone.bind(track)
        graph.tracks.add(track)
        // LiveKit uses capture device settings when it restarts a microphone.
        // Forward those operations to the real source, not the graph's virtual
        // destination (which has no deviceId or capture constraints).
        track.getSettings = () => ({ ...input.getSettings(), sampleRate: context.sampleRate })
        track.getConstraints = () => input.getConstraints()
        track.getCapabilities = () => input.getCapabilities()
        track.applyConstraints = (...args) => input.applyConstraints(...args)
        Object.defineProperty(track, 'label', { get: () => input.label })
        Object.defineProperty(track, 'muted', { get: () => input.muted })
        track.clone = () => decorate(clone())
        track.stop = () => {
          stop()
          graph.tracks.delete(track)
          if (graph.tracks.size === 0) dispose()
        }
        track.addEventListener('ended', () => track.stop(), { once: true })
        return track
      }

      input.addEventListener('ended', ended)
      input.addEventListener('mute', muted)
      input.addEventListener('unmute', unmuted)
      graph.dispose = ended
      graphs.add(graph)
      const output = decorate(destination.stream.getAudioTracks()[0])
      output.enabled = input.enabled
      output.contentHint = input.contentHint
      return output
    } catch (error) {
      graph?.dispose?.()
      input.stop()
      if (context.state !== 'closed') await context.close().catch(() => {})
      throw error
    }
  }

  proto.getUserMedia = async function (constraints) {
    if (!constraints?.audio) return original.call(this, constraints)
    apply(await window.__botReadVolume__())
    const stream = await original.call(this, constraints)
    try {
      for (const input of stream.getAudioTracks()) {
        const output = await wrap(input)
        stream.removeTrack(input)
        stream.addTrack(output)
      }
      return stream
    } catch (error) {
      // Never quietly send the unscaled input when the requested gain failed.
      for (const track of stream.getTracks()) track.stop()
      throw error
    }
  }
  window.addEventListener('pagehide', () => {
    for (const graph of [...graphs]) graph.dispose()
  })
})()
