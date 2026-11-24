# ClipForge Pro — YouTube & livestream clipping studio

A professional clipping studio for **YouTube videos and livestreams**:

- 🎬 **Clip anything** — paste a YouTube video/Shorts/live URL, go live on a stream, or upload your own file
- ⚡ **Live clipping** — one click captures the last 30 s of a stream the moment it happens
- ✂️ **Timeline editor** — draggable in/out handles, clip presets (15/30/60/90 s), 9:16 · 1:1 · 16:9
- 🎵 **Music on the clip** — pick a song, see it on the music lane, mix it with fades and auto-ducking
- 🎚️ **Audio mixer** — original vs. music volume, EQ presets, loudness normalization (-14 LUFS)
- 💬 **Captions burned in** — type the caption line, it's rendered into the exported video
- 📤 **Real MP4 export** — 1080×1920 / 1080×1080 / 1920×1080, H.264 + AAC, rendered server-side with ffmpeg

## Run it

```bash
npm install
npm start          # http://localhost:8000
```

That's it — the studio UI loads immediately with a demo livestream so you can try
clipping right away.

### Enable YouTube + full MP4 rendering

The browser only plays YouTube; the render itself happens on the server with two
binaries:

| Binary   | Used for                                    | Install                                                             |
| -------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `ffmpeg` | trimming, music mix, captions, MP4 encode    | `apt install ffmpeg` · `brew install ffmpeg`                        |
| `yt-dlp` | downloading the YouTube / live stream source | `pipx install yt-dlp` · `pip install -U yt-dlp` · `brew install yt-dlp` |

Then restart `npm start`. The status pill in the navbar shows what is available:

- **engine online** → YouTube + uploads render straight to MP4
- **upload render** → uploads render; YouTube needs `yt-dlp`
- **browser mode** → no `ffmpeg`; clips export as WebM (uploads) or a project file

Custom paths are supported: `FFMPEG_PATH=/usr/local/bin/ffmpeg YTDLP_PATH=/usr/local/bin/yt-dlp npm start`.

> Rendering YouTube content requires you to have the rights to the source
> material (your own streams, VODs, or content you're licensed to clip).

## Music

Drop licensed MP3s into **`music/`** — they're served at `/music/<file>` and appear
in the song list automatically. Three demo tracks ship with the repo so the mixer
and the export pipeline work out of the box. See `music/README.md` for sources.

## How the export works

```
POST /api/render
{ sourceUrl | localFile, inPoint, duration, aspect, music, musicVol,
  origVol, fade, captions, captionText }
   → jobId
GET  /api/jobs/:id            → { status, progress, stage, download }
GET  /api/jobs/:id/download   → the finished MP4
```

Server-side ffmpeg graph:

```
video:  scale→crop (smart vertical) → fps 30 → drawtext caption band
audio:  original (trim, volume)  +  music (loop, fade)
        → sidechaincompress ducking → amix → loudnorm I=-14 → AAC 48 kHz
```

## API

| Endpoint                  | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `GET /api/health`         | which render engines are available           |
| `GET /api/tracks`         | songs found in `music/`                      |
| `GET /api/meta?url=…`     | YouTube title / duration / live flag         |
| `POST /api/render`        | start a render job                           |
| `GET /api/jobs/:id`       | job status + progress                        |
| `GET /api/jobs/:id/download` | download the rendered MP4                 |
| `PUT /api/upload/:name`   | push an uploaded source for server rendering |

## Keyboard shortcuts

`Space` play/pause · `I` set in · `O` set out · `L` clip live · click/drag the
waveform to move the selection.

## Project layout

```
index.html      the studio (UI, player, timeline, mixer, export modal)
server.js       express server + ffmpeg/yt-dlp render pipeline
music/          your licensed tracks (demo tracks included)
assets/         demo livestream used by the preview
```

## Deploying

Any Node 18+ host works. For MP4 rendering, the host must allow installing
`ffmpeg` and `yt-dlp` (Railway, Render, Fly.io, a VPS, or Docker). On platforms
that only run static sites the UI still works, with WebM/project-file export
fallbacks.
