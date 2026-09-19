import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIO_SHIM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'audio-shim.js')

export const volumePercent = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 200) {
    throw new Error('volume must be a number from 0 to 200')
  }
  return value
}

export const installAudioControl = async (context, currentVolume) => {
  // A binding reads the Guest's current setting on EVERY capture, including
  // after a navigation. Init-script ordering cannot safely restore live values.
  await context.exposeFunction('__botReadVolume__', currentVolume)
  await context.addInitScript({ path: AUDIO_SHIM_PATH })
}

export const setGuestVolumes = async (guests, value) => {
  const volume = volumePercent(value)
  const entries = await Promise.all(guests.map(async (guest) => {
    try {
      return [guest.label, await guest.setVolume(volume)]
    } catch (error) {
      return [guest.label, {
        ok: false, volume: guest.volume, revision: guest.volumeRevision, error: error.message,
      }]
    }
  }))
  return Object.fromEntries(entries)
}
