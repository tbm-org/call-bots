import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { meetPageCommand } from '../platforms/meet-page.mjs'
import { pageSnapshot, pageSummary } from '../rtc-page.mjs'
import { screenHtml } from '../screen.mjs'

const source = fileURLToPath(new URL('.', import.meta.url))
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
let key
const extensionKey = () => key ??= generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
  .export({ type: 'spki', format: 'der' }).toString('base64')

export async function prepareExtension(profile, socket, token, label, color, { macOS = false, audio = null } = {}) {
  const dir = join(profile, 'call-bots-extension')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const publicKey = extensionKey()
  const id = [...createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('')
  const manifest = {
    manifest_version: 3,
    name: 'Call Bots Meet driver', version: '1.0.0', minimum_chrome_version: '146',
    key: publicKey,
    permissions: ['nativeMessaging', 'scripting', 'tabs', 'storage', 'webNavigation'],
    host_permissions: ['https://meet.google.com/*'],
    background: { service_worker: 'worker.js' },
    content_scripts: [
      { matches: ['https://meet.google.com/*'], js: ['audio-isolated.js'], run_at: 'document_start', all_frames: true },
      { matches: ['https://meet.google.com/*'], js: ['audio-main.js', ...(audio ? ['audio-recording.js'] : []), 'audio-shim.js', 'audio-ready.js', ...(!macOS ? ['early.js'] : [])], world: 'MAIN', run_at: 'document_start', all_frames: true },
      ...(!macOS ? [
        { matches: ['https://meet.google.com/*'], js: ['viewport.js'], run_at: 'document_idle' },
        { matches: ['https://meet.google.com/*'], js: ['monitor.js', 'commands.js'], world: 'MAIN', run_at: 'document_idle' },
      ] : []),
    ],
  }
  if (audio) {
    // The macOS audio-service sandbox cannot read an arbitrary fake-input WAV.
    // Serve the bot's own recording from its private extension instead; keep
    // the native capture track for device settings and lifecycle, and keep
    // every browser sandbox enabled.
    manifest.web_accessible_resources = [{ resources: ['voice.wav'], matches: ['https://meet.google.com/*'] }]
    await copyFile(audio, join(dir, 'voice.wav'))
    await writeFile(join(dir, 'audio-recording.js'), `(() => {
      let decoded;
      window.__botCreateAudioSource__ = async (context) => {
        decoded ??= fetch(${JSON.stringify(`chrome-extension://${id}/voice.wav`)})
          .then(response => { if (!response.ok) throw new Error('The bot recording could not be loaded'); return response.arrayBuffer(); })
          .then(bytes => context.decodeAudioData(bytes))
          .catch(error => { decoded = null; throw error; });
        const source = context.createBufferSource();
        source.buffer = await decoded;
        source.loop = true;
        return source;
      };
    })();\n`)
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(dir, 'config.js'), `const macOS = ${macOS};\n`)
  await Promise.all([
    ...['audio-main.js', 'audio-isolated.js', 'audio-ready.js'].map((file) => copyFile(join(source, file), join(dir, file))),
    copyFile(join(source, '../audio-shim.js'), join(dir, 'audio-shim.js')),
    copyFile(join(source, 'worker.js'), join(dir, 'worker.js')),
    copyFile(join(source, 'early.js'), join(dir, 'early.js')),
    copyFile(join(source, 'viewport.js'), join(dir, 'viewport.js')),
    copyFile(join(source, '../vendor/rtc-stream-monitor.js'), join(dir, 'monitor.js')),
  ])
  // Static, packaged functions; no eval, Function constructor, remote code,
  // or arbitrary source sent through the native bridge.
  await writeFile(join(dir, 'commands.js'), `(() => {
    const page = ${meetPageCommand.toString()};
    const summary = ${pageSummary.toString()};
    const snapshot = ${pageSnapshot.toString()};
    window.__callBotsMeetLabel__ = ${JSON.stringify(String(label))};
    const monitor = window.__rtcStreamMonitor__;
    monitor?.adopt([...(window.__botPeerConnections__ || [])]);
    const host = document.getElementById('rtc-stream-monitor-host');
    if (host) { host.style.display = 'none'; host.shadowRoot?.getElementById('panel')?.classList.add('min'); }
    window.__callBotsMeetCommand__ = (name, args) => {
      if (name === 'rtc-summary') return summary();
      if (name === 'rtc-snapshot') return snapshot();
      return page(name, args);
    };
  })();\n`)
  const safeLabel = String(label).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const html = screenHtml(safeLabel, color, null)
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1] || ''
  await writeFile(join(dir, 'scene.html'), html.replace(/<script>[\s\S]*?<\/script>/u, '<script src="scene.js"></script>'))
  await writeFile(join(dir, 'scene.js'), `${script}\n;(async () => {
    const tab = await chrome.tabs.getCurrent();
    let resizing = false;
    const size = async () => {
    if (resizing) return;
    resizing = true;
    try {
      await chrome.windows.update(tab.windowId, {
        state: 'normal', left: 0, top: 0,
        width: 1920 + outerWidth - innerWidth,
        height: 1080 + outerHeight - innerHeight,
      });
      for (let i = 0; i < 20 && (innerWidth !== 1920 || innerHeight !== 1080); i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await chrome.storage.session.set({ sceneReady: { tabId: tab.id, width: innerWidth, height: innerHeight } });
    } catch (error) {
      await chrome.storage.session.set({ sceneReady: { tabId: tab.id, error: error.message } });
    } finally { resizing = false; }
    };
    window.addEventListener('resize', () => {
      if (innerWidth !== 1920 || innerHeight !== 1080) size();
    });
    await size();
  })();\n`)

  // Chrome looks in --user-data-dir/NativeMessagingHosts. No host registration
  // is written into the user's Chrome settings or system directories.
  const hosts = join(profile, 'NativeMessagingHosts')
  await mkdir(hosts, { mode: 0o700 })
  const launcher = join(profile, 'native-host')
  await writeFile(launcher, `#!/bin/sh\nexport CALL_BOTS_MEET_SOCKET=${quote(socket)}\nexport CALL_BOTS_MEET_TOKEN=${quote(token)}\nexec ${quote(process.execPath)} ${quote(join(source, 'native-host.mjs'))} "$@"\n`, { mode: 0o700 })
  await chmod(launcher, 0o700)
  await writeFile(join(hosts, 'org.call_bots.meet.json'), JSON.stringify({
    name: 'org.call_bots.meet', description: 'Private Call Bots browser connection',
    path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`],
  }), { mode: 0o600 })
  return dir
}
