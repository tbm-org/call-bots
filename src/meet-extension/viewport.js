// Isolated content script: Chrome's capture infobar changes innerHeight
// without changing the outer window. Keep the call's content area stable.
let resizeTimer
const resize = () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (innerWidth !== 1920 || innerHeight !== 1080) {
      chrome.runtime.sendMessage({ type: 'meet-viewport' }).catch(() => {})
    }
  }, 100)
}
window.addEventListener('resize', resize)
resize()
