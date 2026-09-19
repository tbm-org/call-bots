// Rebuild the bundled real recordings from the licensed sources and excerpts
// in media/voices.json. Requires ffmpeg on PATH; downloads are cached in .data.
//
//   npm run voices
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const mediaDir = fileURLToPath(new URL('../media/', import.meta.url))
const cacheDir = fileURLToPath(new URL('../.data/voice-sources/', import.meta.url))
const { voices } = JSON.parse(await readFile(join(mediaDir, 'voices.json'), 'utf8'))
const loudness = 'I=-20:TP=-7:LRA=11'
let staging

try {
  await run('ffmpeg', ['-version'])
  await mkdir(cacheDir, { recursive: true })
  staging = await mkdtemp(join(mediaDir, '.voices-'))

  for (const voice of voices) {
    const { file, speaker, start, end, source } = voice
    if (!/^voice-[1-5]\.wav$/u.test(file) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`invalid excerpt for ${speaker}`)
    }
    console.log(`${file}: ${speaker} …`)
    const key = createHash('sha256').update(source.downloadUrl).digest('hex')
    const original = join(cacheDir, `${key}.source`)
    if (!existsSync(original)) {
      const response = await fetch(source.downloadUrl, {
        headers: { 'User-Agent': 'CallBots/1.0 (bundled voice importer)' },
      })
      if (!response.ok) throw new Error(`${speaker}: download failed (HTTP ${response.status})`)
      const partial = `${original}.${process.pid}.part`
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
        await rename(partial, original)
      } finally {
        await rm(partial, { force: true })
      }
    }

    const duration = end - start
    const input = [
      '-hide_banner', '-nostdin', '-y', '-ss', String(start), '-t', String(duration),
      '-i', original, '-map', '0:a:0', '-vn', '-sn', '-dn',
    ]
    const cleanup = 'aformat=channel_layouts=mono,highpass=f=70'
    const { stderr } = await run('ffmpeg', [
      ...input, '-af', `${cleanup},loudnorm=${loudness}:print_format=json`, '-f', 'null', '-',
    ])
    const measured = JSON.parse(stderr.match(/\{\s*"input_i"[\s\S]*?\}/u)?.[0] ?? 'null')
    if (!measured || !['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']
      .every((key) => Number.isFinite(Number(measured[key])))) {
      throw new Error(`${speaker}: could not measure audio loudness`)
    }
    const normalize = `loudnorm=${loudness}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
      `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
      `:offset=${measured.target_offset}:linear=true`
    await run('ffmpeg', [
      ...input, '-af', `${cleanup},${normalize},afade=t=in:d=0.015,afade=t=out:st=${duration - 0.06}:d=0.06`,
      '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', join(staging, file),
    ])
    console.log(`  ${duration.toFixed(1)}s · ${voice.language} · 48 kHz mono`)
  }

  // Keep the previous set usable if any download or conversion fails.
  for (const { file } of voices) await rename(join(staging, file), join(mediaDir, file))
  console.log(`\nRebuilt ${voices.length} recordings. New bots will use them.`)
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'ffmpeg is required: brew install ffmpeg' : error.message)
  process.exitCode = 1
} finally {
  if (staging) await rm(staging, { recursive: true, force: true })
}
