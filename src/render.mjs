import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

import { launchChannel } from './browser.mjs'
import { decodePng } from './png.mjs'

const SCENE = join(dirname(fileURLToPath(import.meta.url)), 'scene.html')

// BT.601 studio swing, planar YUV420 — the layout y4m C420 expects.
const toYuv420 = (rgb, width, height, channels, out) => {
  const ySize = width * height
  const cW = width >> 1
  const cSize = cW * (height >> 1)
  const buf = out ?? Buffer.alloc(ySize + 2 * cSize)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels
      const r = rgb[i]
      const g = rgb[i + 1]
      const b = rgb[i + 2]
      buf[y * width + x] = 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256
      if ((x & 1) === 0 && (y & 1) === 0) {
        const c = ySize + (y >> 1) * cW + (x >> 1)
        buf[c] = 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256
        buf[c + cSize] = 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256
      }
    }
  }
  return buf
}

// Renders one themed clip by driving a real canvas in Chromium, so the text is
// properly anti-aliased and the gradients are as smooth as the browser can make
// them. Returns a complete y4m buffer.
export const renderClip = async ({ theme, width, height, fps, seconds, onProgress }) => {
  const browser = await chromium.launch({ channel: launchChannel(), headless: true, chromiumSandbox: process.env.CALL_BOTS_CONTAINER === '1' })
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    })
    await page.goto(pathToFileURL(SCENE).href, { waitUntil: 'load' })
    await page.evaluate(([w, h]) => window.setup(w, h), [width, height])

    const totalFrames = Math.round(fps * seconds)
    const frameHeader = Buffer.from('FRAME\n')
    const chunks = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420\n`)]
    const scratch = Buffer.alloc(width * height + 2 * (width >> 1) * (height >> 1))

    for (let n = 0; n < totalFrames; n += 1) {
      await page.evaluate(([t, index]) => window.drawFrame(index, t), [n / totalFrames, theme])
      const png = await page.locator('canvas').screenshot({ type: 'png' })
      const image = decodePng(png)
      chunks.push(frameHeader, Buffer.from(toYuv420(image.data, width, height, image.channels, scratch)))
      if (onProgress) onProgress(n + 1, totalFrames)
    }
    return Buffer.concat(chunks)
  } finally {
    await browser.close().catch(() => {})
  }
}
