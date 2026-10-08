import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'

import { launchChannel } from '../src/browser.mjs'
import aloqa from '../src/platforms/aloqa.mjs'

let browser
before(async () => { browser = await chromium.launch({ channel: launchChannel() }) })
after(async () => { await browser?.close() })

// Exercise the real adapter against browser-rendered entry transitions, with
// no staging call or host admission required for the regression suite.
async function joinFixture({ prejoin = true, admission = false, blocked = false, label = 'Join call' } = {}) {
  const page = await browser.newPage()
  const logs = []
  try {
    await page.route('https://aloqa.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<form><input name="display_name"><button type="submit">Continue</button></form>
        <button onclick="window.wrongJoin = true">Join call</button>
        <main></main>
        <script>
          window.joinClicks = 0;
          window.wrongJoin = false;
          const main = document.querySelector('main');
          const enter = () => {
            if (${blocked}) {
              main.innerHTML = '<div data-testid="guest-join-blocked">Guest access denied</div>';
              return;
            }
            const open = () => {
              history.pushState({}, '', '/guest/meeting/test-meeting');
              main.innerHTML = '<div data-testid="guest-call-surface">In call</div>';
            };
            if (${admission}) {
              main.innerHTML = '<p>Waiting for approval</p>';
              setTimeout(open, 900);
            } else open();
          };
          document.querySelector('form').onsubmit = (event) => {
            event.preventDefault();
            window.guestName = document.querySelector('input').value;
            event.target.remove();
            if (!${prejoin}) { enter(); return; }
            setTimeout(() => {
              main.innerHTML = '<div data-testid="guest-prejoin"><button data-testid="lobby-join" aria-disabled="true">${label}</button><button onclick="window.cancelled = true">Cancel</button></div>';
              const join = main.querySelector('[data-testid="lobby-join"]');
              join.onclick = () => {
                window.joinClicks++;
                // Keep the screen visible briefly to catch duplicate clicks.
                setTimeout(enter, 900);
              };
              setTimeout(() => join.removeAttribute('aria-disabled'), 200);
            }, 100);
          };
        </script>`,
    }))
    const result = aloqa.join({
      page,
      target: { url: 'https://aloqa.test/join/abc-def-ghi' },
      displayName: 'Test Bot',
      log: { info: (message) => logs.push(message) },
      fail: async (stage, message) => { throw new Error(`${stage}: ${message}`) },
    })
    if (blocked) await assert.rejects(result, /blocked: join refused: Guest access denied/u)
    else assert.equal((await result).callId, 'test-meeting')
    const state = await page.evaluate(() => ({
      name: window.guestName, clicks: window.joinClicks,
      wrongJoin: window.wrongJoin, cancelled: Boolean(window.cancelled),
    }))
    assert.deepEqual(state, { name: 'Test Bot', clicks: prejoin ? 1 : 0, wrongJoin: false, cancelled: false })
    if (admission) assert.ok(logs.some((message) => message.includes('waiting to be admitted')))
  } finally {
    await page.close()
  }
}

test('passes a delayed device check and waits for its Join button', () => joinFixture())
test('uses stable selectors for Russian button labels', () => joinFixture({ label: 'Войти в звонок' }))
test('passes device check before waiting for admission', () => joinFixture({ admission: true }))
test('still supports direct entry on older deployments', () => joinFixture({ prejoin: false }))
test('still supports admission without a device check', () => joinFixture({ prejoin: false, admission: true }))
test('reports a refusal after the device check', () => joinFixture({ blocked: true }))
test('five guests pass their own device checks concurrently', async () => {
  await Promise.all(Array.from({ length: 5 }, () => joinFixture()))
})
