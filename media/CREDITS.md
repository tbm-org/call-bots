# Bundled media

## Voices

`voice-1.wav` … `voice-5.wav` are excerpts of real performances and interviews
in English and Russian. They preserve the original speech, pitch, and
pace. The stock camera models below are unrelated to these speakers.

| File | Speaker / language | Excerpt | Source and attribution | Licence |
| --- | --- | --- | --- | --- |
| voice-1.wav | Neil deGrasse Tyson / English | 00:09.500–01:23.600 — the teachers who sparked his curiosity about the universe | [Neil deGrasse Tyson Thanks Teachers](https://www.youtube.com/watch?v=Kg588wefGO0), United States Department of Education, 9 May 2012; [Commons copy](https://commons.wikimedia.org/wiki/File:Neil_deGrasse_Tyson_Thanks_Teachers.webm) | [Public domain, U.S. Department of Education recording](https://commons.wikimedia.org/wiki/File:Neil_deGrasse_Tyson_Thanks_Teachers.webm#Licensing) |
| voice-2.wav | Shakira / English | 06:44.540–07:50.740 — the school choir, her vibrato, and her parents' encouragement | [Shakira: They Said I Sang Like a Goat](https://www.youtube.com/watch?v=l0Uo3rDQHvo), World Economic Forum, interview by Prannoy Roy, 17 January 2017 (reposted 13 June 2018); [Commons copy](https://commons.wikimedia.org/wiki/File:Shakira-_They_Said_I_Sang_Like_a_Goat.webm) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| voice-3.wav | Efim Shifrin / Russian | 00:00.000–00:44.996 — high and low art compared with medical specialties | [Efim Shifrin voice](https://commons.wikimedia.org/wiki/File:Efim_Shifrin_voice.oga), Echo of Moscow, 19 March 2005; [original programme](http://echo.msk.ru/guests/voices/1064.html) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| voice-4.wav | Valdis Pelsh / Russian | 00:00.000–00:25.379 — viewers remembering the presenter's forgotten pranks | [Valdis Pel'sh voice](https://commons.wikimedia.org/wiki/File:Valdis_Pel%27sh_voice.oga), Echo of Moscow, 24 May 2007; [original programme](http://echo.msk.ru/guests/voices/1055.html) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| voice-5.wav | Roman Kartsev / Russian | 00:00.000–00:22.348 — an Odessite's comic distinction between panicking and rushing around | [Roman Kartsev voice](https://commons.wikimedia.org/wiki/File:Roman_Kartsev_voice.oga), Echo of Moscow radio station archive, 12 May 2009; [original programme](http://echo.msk.ru/guests/voices/1050.html) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

Changes made: extracted the listed continuous sections, mixed to mono, removed
low-frequency rumble with a 70 Hz high-pass filter, normalised loudness toward
−20 LUFS with a −7 dBTP target, and added short fades at the loop boundaries.
Encoded as 48 kHz, 16-bit PCM WAV. No synthetic speech or voice cloning.

Rebuild with `npm run voices` (requires FFmpeg). The source URLs and exact
excerpt boundaries are kept in [voices.json](voices.json); source downloads are
cached in `.data/voice-sources`. The script completes all five conversions
before replacing the bundled files.

## Shared screen

`screen.webm` is the footage a bot shares when it shares a screen: a bumblebee
on an Indian Blanket flower in a wildflower meadow.

- Source: Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Flowers_(20210715-FPAC-KLS-0001).webm
- Author: USDAgov
- Licence: Public domain (work of the U.S. federal government)

Changes made: cropped from 1920x1300 to 1920x1080 to drop the letterbox bars
and a burned-in caption, trimmed to 16s, saturation lifted slightly, the tail
dissolved into the head so it loops without a cut, and re-encoded to VP9.
Already 30fps at source, so no retiming was needed. No audio.

## Camera clips

`clip-1` … `clip-5` are stock video of five different people at a desk, used as
each bot's camera. They were downloaded from Pexels by the project owner; the
source files carried Pexels video IDs **5941016, 7261921, 7643836, 7706881,
8048255** (https://www.pexels.com/video/<id>/). Which ID became which clip was
not recorded.

- Licence: Pexels License — https://www.pexels.com/license/
  Free to use, attribution not required. Note its limits: do not sell unaltered
  copies, and do not redistribute the footage on stock or wallpaper platforms.

Changes made: scaled and cropped to 1920x1080, 30fps, 8s, encoded as MJPEG,
which is the format Chrome's fake camera accepts.

To replace them, put your own videos in a folder and run:

    node scripts/import-videos.mjs <folder> --bundle
