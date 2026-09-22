// This extension controls only the one throwaway browser that loaded it.
// Commands contain data, never JavaScript source or debugger requests.
importScripts('config.js')
let port
let connecting = false
let closing = false
let meetTab = null
let sceneTab = null
let audioDocument = null
let requestSequence = 0
const pendingReads = new Map()

function readVolume() {
  return new Promise((resolve, reject) => {
    if (!port || closing) { reject(new Error('The audio controller is disconnected')); return }
    const requestId = ++requestSequence
    const timer = setTimeout(() => { pendingReads.delete(requestId); reject(new Error('The audio controller did not answer')) }, 5000)
    pendingReads.set(requestId, { resolve, reject, timer })
    port.postMessage({ op: 'read-volume', requestId })
  })
}

const saveTabs = () => chrome.storage.session.set({ meetTab, sceneTab })
const restoreTabs = async () => {
  const saved = await chrome.storage.session.get(['meetTab', 'sceneTab'])
  meetTab = saved.meetTab ?? meetTab
  sceneTab = saved.sceneTab ?? sceneTab
}

async function sizeWindow(tabId) {
  // Xvfb has no window manager decorations, but Chrome still has its own UI.
  const [read] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ width: outerWidth - innerWidth, height: outerHeight - innerHeight }),
  })
  const tab = await chrome.tabs.get(tabId)
  await chrome.windows.update(tab.windowId, {
    state: 'normal', left: 0, top: 0,
    width: 1920 + (read?.result?.width || 0), height: 1080 + (read?.result?.height || 87),
  })
}

async function command(op, args) {
  if (op === 'focus-meet') {
    if (meetTab === null) throw new Error('The Meet tab has not opened')
    const tab = await chrome.tabs.get(meetTab)
    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true })
    await chrome.tabs.update(meetTab, { active: true })
    return true
  }
  if (op === 'volume' || op === 'audio-state') {
    if (op === 'audio-state') {
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' })
      const id = meetTab ?? tabs[0]?.id
      if (id === undefined || id === null) throw new Error('The Meet tab has not opened')
      const reads = await chrome.scripting.executeScript({
        target: { tabId: id, allFrames: true }, world: 'MAIN',
        func: () => ({ state: window.__botAudioState__?.() ?? null, error: window.__botAudioError__ ?? null,
          reader: typeof window.__botReadVolume__, url: location.href }),
      })
      return { ready: !!audioDocument, frames: reads.map((read) => ({ frameId: read.frameId, ...read.result })) }
    }
    if (meetTab === null || !audioDocument) throw new Error('The microphone controller is not ready')
    const documentId = audioDocument
    const results = await chrome.scripting.executeScript({
      target: { tabId: meetTab, allFrames: true }, world: 'MAIN',
      func: async (operation, setting) => {
        if (!window.__botSetVolume__) return null
        if (operation === 'volume') return window.__botSetVolume__(setting)
        return window.__botAudioState__()
      },
      args: [op, args],
    })
    if (documentId !== audioDocument || !results.some((read) => read.documentId === documentId)) {
      throw new Error('Meet navigated while changing the volume; try again')
    }
    const active = results.filter((read) => read.result != null || read.error)
    if (active.some((read) => read.error)) throw new Error('A microphone did not accept the volume change')
    if (op === 'volume' && active.some((read) => read.result.volume !== args.volume || read.result.revision !== args.revision)) {
      throw new Error('A newer microphone setting replaced this change')
    }
    const top = active.find((read) => read.documentId === documentId)?.result
    if (!top) throw new Error('The microphone controller is not ready')
    return op === 'volume' ? top : { ...top, frames: active.map((read) => read.result) }
  }
  if (op === 'goto') {
    const url = new URL(args.url)
    if (url.origin !== 'https://meet.google.com') throw new Error('Only HTTPS Google Meet links are supported')
    if (meetTab !== null) {
      try { await chrome.tabs.get(meetTab) } catch { meetTab = null }
    }
    if (meetTab === null) {
      const win = await chrome.windows.create({ url: url.href, width: 1920, height: 1167, focused: true })
      meetTab = win.tabs[0].id
    } else {
      await chrome.tabs.update(meetTab, { url: url.href, active: true })
    }
    await saveTabs()
    return true
  }
  if (op === 'url') return meetTab === null ? '' : (await chrome.tabs.get(meetTab)).url
  if (op === 'page') {
    if (meetTab === null) throw new Error('The Meet tab has not opened')
    const [read] = await chrome.scripting.executeScript({
      target: { tabId: meetTab }, world: 'MAIN',
      func: (name, input) => {
        if (!window.__callBotsMeetCommand__) throw new Error('Meet page is still loading')
        return window.__callBotsMeetCommand__(name, input)
      },
      args: [args.command, args.input || {}],
    })
    if (read?.error) throw new Error(read.error.message || 'Meet page command failed')
    if (!read || read.result === undefined) throw new Error('Meet page is still loading')
    return read.result
  }
  if (op === 'size') { await sizeWindow(meetTab); return true }
  if (op === 'scene') {
    if (sceneTab !== null) {
      try { await chrome.tabs.get(sceneTab); return sceneTab } catch { sceneTab = null }
    }
    await chrome.storage.session.remove('sceneReady')
    const win = await chrome.windows.create({ url: chrome.runtime.getURL('scene.html'), width: 1920, height: 1167, focused: false })
    sceneTab = win.tabs[0].id
    await saveTabs()
    return sceneTab
  }
  if (op === 'size-scene') {
    // Extension pages cannot be targeted by scripting.executeScript. The
    // packaged scene sizes its own window and records the resulting viewport.
    const { sceneReady } = await chrome.storage.session.get('sceneReady')
    if (sceneReady?.tabId !== sceneTab) throw new Error('The shared scene is still loading')
    if (sceneReady.error) throw new Error(sceneReady.error)
    if (sceneReady.width !== 1920 || sceneReady.height !== 1080) throw new Error('The shared scene did not reach 1920×1080')
    return true
  }
  throw new Error(`Unknown browser command: ${op}`)
}

async function closeBrowser() {
  if (closing) return
  closing = true
  const windows = await chrome.windows.getAll()
  await Promise.allSettled(windows.map((win) => chrome.windows.remove(win.id)))
}

function connect() {
  if (port || connecting || closing) return
  connecting = true
  const next = chrome.runtime.connectNative('org.call_bots.meet')
  port = next
  next.onMessage.addListener(async (message) => {
    if (Number.isSafeInteger(message?.replyTo)) {
      const entry = pendingReads.get(message.replyTo)
      if (!entry) return
      clearTimeout(entry.timer)
      pendingReads.delete(message.replyTo)
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.value)
      return
    }
    if (!message || !Number.isSafeInteger(message.id)) return
    try {
      await restoreTabs()
      const value = await command(message.op, message.args || {})
      next.postMessage({ id: message.id, value })
    } catch (error) {
      try { next.postMessage({ id: message.id, error: error.message }) } catch {}
    }
  })
  next.onDisconnect.addListener(() => {
    // A disappearing controller must never leave a bot publishing unattended.
    console.error(chrome.runtime.lastError?.message || 'Call Bots controller disconnected')
    port = null
    for (const entry of pendingReads.values()) { clearTimeout(entry.timer); entry.reject(new Error('The audio controller disconnected')) }
    pendingReads.clear()
    closeBrowser().catch(() => {})
  })
  connecting = false
}
chrome.tabs.onRemoved.addListener((id) => {
  if (id === meetTab && !closing) {
    try { port?.postMessage({ event: 'meet-closed' }) } catch {}
  }
})
chrome.windows.onCreated.addListener(() => {
  if (macOS) { try { port?.postMessage({ event: 'window-opened' }) } catch {} }
})
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.tabId === meetTab && details.frameId === 0) {
    audioDocument = null
    try { port?.postMessage({ event: 'audio-loading' }) } catch {}
  }
})
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab || !sender.url?.startsWith('https://meet.google.com/')) return
  if (message?.type === 'read-volume' || message?.type === 'audio-ready') {
    if (meetTab === null && sender.frameId === 0) { meetTab = sender.tab.id; saveTabs().catch(() => {}) }
    if (sender.tab.id !== meetTab) return
    if (message.type === 'read-volume') {
      readVolume().then((value) => reply({ value }), (error) => reply({ error: error.message }))
      return true
    }
    if (sender.frameId === 0) {
      audioDocument = sender.documentId
      try { port?.postMessage({ event: 'audio-ready' }) } catch {}
    }
  }
  if (!macOS && message?.type === 'meet-viewport' && sender.tab.id === meetTab) {
    sizeWindow(meetTab).catch(() => {})
  }
})
chrome.runtime.onInstalled.addListener(connect)
chrome.runtime.onStartup.addListener(connect)
connect()
