// The gain shim runs in Meet's world at document start. Only the isolated
// adapter can reach extension APIs; this narrow channel reads a setting.
(() => {
  let sequence = 0
  const pending = new Map()
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'call-bots-volume-reply') return
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    clearTimeout(entry.timer)
    if (event.data.error) entry.reject(new Error(event.data.error))
    else entry.resolve(event.data.value)
  })
  window.__botReadVolume__ = () => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The audio controller did not answer')) }, 8000)
    pending.set(id, { resolve, reject, timer })
    window.postMessage({ type: 'call-bots-volume-read', id }, location.origin)
  })
})()
