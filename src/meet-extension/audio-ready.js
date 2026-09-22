// Advertise readiness only after the document-start shim has read Guest's
// setting. Each later microphone acquisition reads it again.
;(async () => {
  try {
    await window.__botSetVolume__(await window.__botReadVolume__())
    window.postMessage({ type: 'call-bots-audio-ready' }, location.origin)
  } catch (error) {
    window.__botAudioError__ = error.message
    console.error('Call Bots audio:', error.message)
  }
})()
