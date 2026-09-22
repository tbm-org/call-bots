// MAIN world, document_start: capture before Meet seals its constructors.
(() => {
  const Native = window.RTCPeerConnection
  const connections = new Set()
  window.__botPeerConnections__ = connections
  if (!Native) return
  const Wrapped = new Proxy(Native, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget)
      connections.add(pc)
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'closed') connections.delete(pc)
      })
      window.__rtcStreamMonitor__?.adopt(pc)
      return pc
    },
  })
  window.RTCPeerConnection = Wrapped
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped
})()
