import aloqa from './aloqa.mjs'
import meet from './meet.mjs'

// One file per platform, each owning its own selectors, join sequence, device
// toggles and participant grid. Adding one means adding a file and listing it
// here; a platform tied to a single host goes before Aloqa, which runs on any
// origin and matches by the shape of the path.
export const PLATFORMS = [meet, aloqa]

export const platformById = (id) => PLATFORMS.find((platform) => platform.id === id) ?? null

// The link says which platform to drive, which origin gets media permission,
// and where to send the bot. Meet identity is allocated separately afterwards.
export const resolveLink = (input) => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('paste the call link')
  if (!/^https?:\/\//u.test(raw)) {
    throw new Error('that is not a full link — copy the link including https://')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a valid link: ${raw.slice(0, 60)}`)
  }

  for (const platform of PLATFORMS) {
    const target = platform.parse(url)
    if (target) return { ...target, platform: platform.id, label: platform.label }
  }
  throw new Error(
    'that link is not recognised — paste a Google Meet link ' +
      '(meet.google.com/abc-defg-hij) or an Aloqa call invite (…/join/abc-def-ghi)',
  )
}
