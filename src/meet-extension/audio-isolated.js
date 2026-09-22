// Never accept commands or source from the page: it can only read the current
// setting. Live writes arrive through the authenticated native connection.
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin) return
  const message = event.data
  if (message?.type === 'call-bots-audio-ready') {
    chrome.runtime.sendMessage({ type: 'audio-ready' }).catch(() => {})
    return
  }
  if (message?.type !== 'call-bots-volume-read' || !Number.isSafeInteger(message.id)) return
  let response
  try { response = await chrome.runtime.sendMessage({ type: 'read-volume' }) }
  catch (error) { response = { error: error.message } }
  window.postMessage({ type: 'call-bots-volume-reply', id: message.id, ...response }, location.origin)
})
