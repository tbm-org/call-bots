import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import zoom, { pageCommand } from '../src/platforms/zoom.mjs'
import { resolveLink } from '../src/platforms/index.mjs'
import { prepareExtension } from '../src/meet-extension/extension.mjs'
import { launchChannel } from '../src/browser.mjs'

let browser
before(async () => { browser = await chromium.launch({ channel: launchChannel() }) })
after(async () => { await browser?.close() })

test('Zoom invitation routes to the web client, preserving the encrypted passcode', () => {
  for (const host of ['zoom.us', 'us02web.zoom.us', 'company.zoom.us', 'app.zoom.us', 'zoom.com']) {
    const target = resolveLink(`https://${host}/j/12345678901?pwd=a%2Bb%2F%3D&tracking=discard`)
    assert.equal(target.platform, 'zoom')
    assert.equal(target.origin, 'https://app.zoom.us')
    assert.equal(new URL(target.url).searchParams.get('pwd'), 'a+b/=')
    assert.equal(new URL(target.url).searchParams.get('tracking'), null)
  }
  assert.equal(resolveLink('https://app.zoom.us/wc/1234567890/start').callId, '1234567890')
  assert.equal(resolveLink('https://meet.google.com/abc-defg-hij').platform, 'meet')
  assert.equal(resolveLink('https://aloqa.test/join/abc-def-ghi').platform, 'aloqa')
  for (const link of ['https://zoom.us.evil.test/j/1234567890', 'https://evilzoom.us/j/1234567890', 'https://zoom.us/j/bad', 'http://zoom.us/j/1234567890', 'https://zoom.us:444/j/1234567890']) assert.throws(() => resolveLink(link))
})

async function fixture({ lobby = false, refusal = '', password = false, cam = true, mic = true } = {}) {
  const page = await browser.newPage()
  await page.route('https://app.zoom.us/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <main><input id="input-for-name"><button id="mic" aria-label="Mute">Mute</button><button id="cam" aria-label="Stop Video">Stop Video</button><button id="join">Join</button><p>Zoom is protected by reCAPTCHA</p></main>
    <script>
      let muted = false, stopped = false;
      const main = document.querySelector('main');
      const wire = () => {
        document.querySelector('#mic').onclick = e => { muted = !muted; e.target.textContent = muted ? 'Unmute' : 'Mute'; e.target.setAttribute('aria-label', e.target.textContent); };
        document.querySelector('#cam').onclick = e => { stopped = !stopped; e.target.textContent = stopped ? 'Start Video' : 'Stop Video'; e.target.setAttribute('aria-label', e.target.textContent); };
      };
      wire();
      document.querySelector('#join').onclick = () => {
        window.joinName = document.querySelector('input').value;
        window.entryMuted = muted; window.entryStopped = stopped;
        if (${JSON.stringify(refusal)}) { main.textContent = ${JSON.stringify(refusal)}; return; }
        if (${password}) { main.innerHTML = '<input type="password">'; return; }
        const enter = () => {
          main.innerHTML = '<button>Leave</button><button id="mic" aria-label="Unmute">Unmute</button><button id="cam" aria-label="Start Video">Start Video</button><button id="audio">Join Audio by Computer</button><button id="share">Share Screen</button>';
          muted = stopped = true; wire();
          document.querySelector('#audio').onclick = e => e.target.remove();
          document.querySelector('#share').onclick = e => e.target.textContent = e.target.textContent === 'Share Screen' ? 'Stop Share' : 'Share Screen';
        };
        if (${lobby}) { main.innerHTML = '<p>Please wait, the meeting host will let you in soon</p><button>Leave</button><button aria-label="Unmute">Unmute</button>'; setTimeout(enter, 1000); } else enter();
      };
    </script>` }))
  const waiting = []
  const ctx = { page, target: resolveLink('https://zoom.us/j/1234567890?pwd=secret'), displayName: 'Bot Example', options: { startMic: mic, startCam: cam }, log: { info() {}, warn() {} }, setWaitingAdmission: v => waiting.push(v), fail: async (_, message) => { throw new Error(message) }, prepareScreen: async () => {} }
  return { page, ctx, waiting }
}

test('guest joins with its name, connects computer audio, toggles devices and screen', async () => {
  const { page, ctx } = await fixture()
  try {
    assert.deepEqual(await zoom.join(ctx), { callId: '1234567890' })
    assert.equal(await page.evaluate('window.joinName'), 'Bot Example')
    assert.equal(await zoom.setMic(ctx, true), 'on')
    assert.equal(await zoom.setMic(ctx, false), 'off')
    assert.equal(await zoom.setCam(ctx, true), 'on')
    assert.equal(await zoom.setCam(ctx, false), 'off')
    assert.equal(await zoom.setScreen(ctx, true), 'on')
    assert.equal(await zoom.setScreen(ctx, false), 'off')
  } finally { await page.close() }
})

test('waiting room with Leave and Unmute controls is not considered admission', async () => {
  const { page, ctx, waiting } = await fixture({ lobby: true, cam: false, mic: false })
  try {
    await zoom.join(ctx)
    assert.ok(waiting.includes(true))
    assert.equal(waiting.at(-1), false)
    assert.equal(await page.evaluate('window.entryMuted && window.entryStopped'), true)
  } finally { await page.close() }
})

for (const refusal of ['Invalid meeting ID', 'This meeting has ended', 'Sign in to join', 'Please verify you are human']) {
  test(`reports ${refusal}`, async () => {
    const { page, ctx } = await fixture({ refusal })
    try { await assert.rejects(zoom.join(ctx), /Zoom/); } finally { await page.close() }
  })
}
test('passcode entry asks for full invitation instead of typing encrypted token', async () => {
  const { page, ctx } = await fixture({ password: true })
  try { await assert.rejects(zoom.join(ctx), /full invitation/); } finally { await page.close() }
})

for (const refusal of ["Automated bots aren't allowed to join this meeting. Sign in to join", 'Automated bots are not allowed to join this meeting. Sign in to join', 'Automated bots aren’t allowed to join this meeting. Sign in to join']) {
  test(`bot protection is reported separately from authentication: ${refusal}`, async () => {
    const { page, ctx } = await fixture({ refusal })
    try { await assert.rejects(zoom.join(ctx), /Zoom blocked this automated guest/); } finally { await page.close() }
  })
}

test('extension packages the right platform commands and limits host permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'call-bots-extension-test-'))
  try {
    for (const platform of ['meet', 'zoom']) {
      const output = await prepareExtension(join(dir, platform), '/tmp/test.sock', 'test-token', 'Test', '#00e5ff', { platform })
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
      assert.deepEqual(manifest.host_permissions, platform === 'meet' ? ['https://meet.google.com/*'] : ['https://*.zoom.us/*', 'https://*.zoom.com/*'])
      const commands = await readFile(join(output, 'commands.js'), 'utf8')
      assert.match(commands, new RegExp(`function ${platform}PageCommand`))
      new vm.Script(commands)
      new vm.Script(await readFile(join(output, 'config.js'), 'utf8'))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('camera waits through Zoom startup disabling the button', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(`<button disabled aria-label="start my video" onclick="this.setAttribute('aria-label','stop my video')">Video</button><script>setTimeout(() => document.querySelector('button').disabled = false, 600)</script>`)
    assert.equal(await zoom.setCam({ page, log: { warn() {} } }, true), 'on')
  } finally { await page.close() }
})

test('Leave waits for Zoom confirmation before closing the browser', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(`<main><button aria-label="mute my microphone">Mute</button><button onclick="setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Leave Meeting'; b.onclick = () => { window.left = true; document.querySelector('main').remove() }; document.body.append(b) }, 300)">Leave</button></main>`)
    await zoom.leave({ page })
    assert.equal(await page.evaluate('window.left'), true)
  } finally { await page.close() }
})

test('joined native browser receives Leave before its launch signal is aborted', async () => {
  const { Guest } = await import('../src/guest.mjs')
  const bot = new Guest({ n: 1, slug: 'test', label: 'Test' }, {}, {})
  bot.state = 'in-call'
  bot.page = {}
  bot.startAbort = new AbortController()
  const events = []
  bot.platform = { leave: async () => { assert.equal(bot.startAbort.signal.aborted, false); events.push('leave') } }
  bot.closeBrowser = async () => { assert.equal(bot.startAbort.signal.aborted, true); events.push('close') }
  await bot.teardown()
  assert.deepEqual(events, ['leave', 'close'])
  assert.equal(bot.state, 'closed')
})

test('Zoom preview crops only the named bot from its shadow-root video canvas', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  try {
    await page.setContent(`<style>body { margin:0 } .video-avatar__avatar { position:absolute; left:0; top:0; width:200px; height:100px } .video-avatar__avatar-footer { position:absolute; bottom:0 }</style><button aria-label="stop my video">Video</button><div id="player" style="position:absolute;left:0;top:0"></div><div class="video-avatar__avatar"><div class="video-avatar__avatar-footer">Test Bot</div></div>`)
    await page.evaluate(() => {
      const root = document.querySelector('#player').attachShadow({ mode: 'open' })
      const canvas = document.createElement('canvas')
      canvas.id = 'video-player-canvas-test'; canvas.width = 400; canvas.height = 100
      root.append(canvas)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 200, 100)
      ctx.fillStyle = 'blue'; ctx.fillRect(200, 0, 200, 100)
    })
    const image = await pageCommand(page, 'thumbnail', { label: 'Test Bot' })
    assert.match(image, /^data:image\/jpeg;base64,/u)
    const pixel = await page.evaluate(async (src) => {
      const image = new Image(); image.src = src; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      return [...ctx.getImageData(160, 80, 1, 1).data]
    }, image)
    assert.ok(pixel[0] > 240 && pixel[2] < 10, 'preview must contain the local red tile, not the remote blue tile')
    assert.equal(await pageCommand(page, 'thumbnail', { label: 'Missing Bot' }), null)
  } finally { await page.close() }
})
