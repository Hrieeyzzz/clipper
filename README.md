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

## Export tiers (it always tells you which one you're getting)

The export modal states the truth up front — before you click Start export, and on
the result screen:

| Tier | Where | What you get |
| ---- | ----- | ------------ |
| **Server render** | anywhere with `ffmpeg` (+ `yt-dlp` for YouTube) | full 1080p MP4 of the real video, original audio + music mixed, captions burned in |
| **Browser MP4** | Chrome / Edge, no server needed | real 1080p MP4 (H.264 + AAC, or Opus when the browser has no AAC) via WebCodecs + mp4-muxer. The muxer is **inlined into index.html**, so no static-file route or MIME setting can break it. Uploaded files get real video frames; YouTube sources export a Ken-Burns *still + music* MP4 because a cross-origin YouTube iframe can never be painted to a canvas |
| **Browser WebM** | Safari / Firefox | canvas capture of uploaded video with mixed audio (`.webm`) |
| **Project file** | no encoder at all | a `.json` that re-opens the clip in the editor — the button says so, it is never labelled MP4 |

The navbar pill shows the active engine: `engine online`, `upload render`,
`browser MP4`, or `no encoder`.

> **Vercel:** this is a pure static deploy — `index.html` (with the muxer inlined),
> `music/`, `assets/`. No `vercel.json` is needed or wanted: declaring `builds`
> there disables Vercel's static file serving and breaks things. Exports use the
> in-browser MP4 tier because serverless has no `ffmpeg`/`yt-dlp`. That's fine for uploaded video; for YouTube footage
> pointing the app at a VPS/Render/Railway instance with both binaries installed
> gives you real video MP4s.

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
vendor/         mp4-muxer (MIT) — also inlined into index.html for portability
music/          your licensed tracks (demo tracks included) + manifest.json
assets/         demo livestream used by the preview
```

## Deploying

Any Node 18+ host works. For MP4 rendering, the host must allow installing
`ffmpeg` and `yt-dlp` (Railway, Render, Fly.io, a VPS, or Docker). On platforms
that only run static sites the UI still works, with WebM/project-file export
fallbacks.
