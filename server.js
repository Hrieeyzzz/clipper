#!/usr/bin/env node
/**
 * ClipForge Pro — render backend
 * ---------------------------------
 * Real server-side clipping: yt-dlp downloads the YouTube/live source,
 * ffmpeg trims it, mixes music + original audio, burns captions and
 * exports a professional MP4 in 9:16 / 1:1 / 16:9.
 *
 *   YouTube + music export .... needs `yt-dlp` + `ffmpeg` on PATH
 *   Uploaded file + music ...... needs `ffmpeg` only
 *   No binaries installed ...... /api/health reports it, the UI falls back
 *                               to a browser-side (WebM) export automatically.
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const WORK = path.join(os.tmpdir(), 'clipforge');
const OUT = path.join(WORK, 'out');
const CACHE = path.join(WORK, 'cache');
const MUSIC_DIR = path.join(ROOT, 'music');
for (const d of [WORK, OUT, CACHE, MUSIC_DIR]) fs.mkdirSync(d, { recursive: true });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(ROOT, { extensions: ['html'] }));

/* ---------------------------------------------------------------- tools */

function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

const BIN = {
  ffmpeg: process.env.FFMPEG_PATH || which('ffmpeg') || (fs.existsSync('/tmp/ffmpeg') ? '/tmp/ffmpeg' : null),
  ytdlp: process.env.YTDLP_PATH || which('yt-dlp') || which('ytdlp') || which('youtube-dl') ||
         (fs.existsSync('/tmp/venv/bin/yt-dlp') ? '/tmp/venv/bin/yt-dlp' : null)
};

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const limit = (s, c) => (s + c).slice(-20000);
    child.stdout.on('data', d => { out = limit(out, d.toString()); opts.onOut && opts.onOut(d.toString()); });
    child.stderr.on('data', d => { err = limit(err, d.toString()); opts.onErr && opts.onErr(d.toString()); });
    if (opts.signal) opts.signal.addEventListener('abort', () => child.kill('SIGKILL'));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ out, err }) : reject(Object.assign(new Error(`${path.basename(bin)} exited ${code}`), { stderr: err, code })));
  });
}

/* ---------------------------------------------------------------- jobs */

const jobs = new Map();     // id -> { id, status, progress, stage, file, title, error, meta }
const inflight = new Map(); // key -> promise

const newJob = (meta = {}) => {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, { id, status: 'queued', progress: 0, stage: 'Queued', ...meta });
  return jobs.get(id);
};
const setJob = (id, patch) => { const j = jobs.get(id); if (j) Object.assign(j, patch); return j; };

/* ---------------------------------------------------------------- helpers */

const YT_ID = /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([\w-]{11})/;
const parseYouTubeId = (url) => {
  if (!url) return null;
  const m = String(url).match(YT_ID);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(String(url).trim()) ? String(url).trim() : null;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

async function durationOf(file) {
  try {
    const { stderr } = await run(BIN.ffmpeg, ['-hide_banner', '-i', file], {}).catch(e => ({ stderr: e.stderr || '' }));
    const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  } catch { return 0; }
}

/**
 * Fetch a YouTube / livestream source with yt-dlp.
 * Downloads at most `maxHeight` so clips render fast; keeps audio for mixing.
 */
async function downloadSource(videoId, job, { maxHeight = 720 } = {}) {
  const key = 'src_' + videoId + '_' + maxHeight;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const cached = path.join(CACHE, `${videoId}_${maxHeight}.mp4`);
    if (fs.existsSync(cached) && (await fsp.stat(cached)).size > 20000) return cached;

    setJob(job, { stage: 'Fetching source from YouTube', progress: 6, sourceUrl: `https://www.youtube.com/watch?v=${videoId}` });

    // Metadata first (title + duration for the UI)
    try {
      const { out } = await run(BIN.ytdlp, ['-J', '--no-warnings', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`]);
      const info = JSON.parse(out.slice(out.indexOf('{')));
      setJob(job, { title: info.title || 'YouTube clip', sourceDuration: info.duration || 0, isLive: !!info.is_live, channel: info.uploader });
    } catch (e) { /* metadata is optional */ }

    const fmt = `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/b[height<=${maxHeight}][ext=mp4]/b`;
    const args = [
      '-f', fmt, '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
      '--no-part', '--retries', '3', '--socket-timeout', '20',
      '--newline', '-o', cached,
      `https://www.youtube.com/watch?v=${videoId}`
    ];
    await run(BIN.ytdlp, args, {
      onOut: (chunk) => {
        const m = chunk.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (m) setJob(job, { stage: 'Downloading source', progress: Math.round(clamp(6 + (+m[1]) * 0.22, 6, 28)) });
      }
    });
    if (!fs.existsSync(cached)) throw new Error('Source download failed');
    return cached;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

function musicPath(trackId) {
  if (!trackId) return null;
  const safe = String(trackId).replace(/[^\w.-]/g, '');
  const p = path.join(MUSIC_DIR, safe);
  return fs.existsSync(p) ? p : null;
}

const ASPECTS = {
  '9x16': { w: 1080, h: 1920 },
  '1x1': { w: 1080, h: 1080 },
  '16x9': { w: 1920, h: 1080 },
  '4x5': { w: 1080, h: 1350 }
};

/** Build the ffmpeg filtergraph: smart-crop → music mix → captions */
function buildFilter({ aspect, inPoint, duration, music, musicVol, origVol, fade, captions, captionText, captionsOn }) {
  const { w, h } = typeof aspect === 'string' ? (ASPECTS[aspect] || ASPECTS['9x16']) : aspect;
  const parts = [];

  // video: scale-to-fill + centre crop, constant fps, even dimensions
  parts.push(`[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,setsar=1[v0]`);

  let vout = 'v0';
  if (captionsOn) {
    const txt = (captionText || 'CLIPFORGE').replace(/[\\':%\[\]{}]/g, ' ').slice(0, 60);
    const size = Math.round(w / 22);
    parts.push(
      `[${vout}]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
      `text='${txt}':fontcolor=white:fontsize=${size}:line_spacing=8:` +
      `box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.55)}:` +
      `x=(w-text_w)/2:y=h-text_h-${Math.round(h * 0.12)}[v1]`
    );
    vout = 'v1';
  }

  // audio: original trimmed + music looped/trimmed, faded, ducked
  const af = [];
  af.push(`[0:a]atrim=start=${inPoint}:duration=${duration},asetpts=PTS-STARTPTS,volume=${origVol}[a_orig]`);

  if (music) {
    af.push(`[1:a]atrim=start=0:duration=${duration},asetpts=PTS-STARTPTS,volume=${musicVol},` +
            `afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}[a_mus]`);
    // sidechain duck the music under the original audio
    af.push(`[0:a]atrim=start=${inPoint}:duration=${duration},asetpts=PTS-STARTPTS,volume=1[sc]`);
    af.push(`[a_mus][sc]sidechaincompress=threshold=0.05:ratio=6:attack=40:release=350:makeup=1[a_duck]`);
    af.push(`[a_orig][a_duck]amix=inputs=2:duration=first:dropout_transition=0,` +
            `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a_out]`);
  } else {
    af.push(`[a_orig]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a_out]`);
  }

  return {
    graph: parts.join(';') + ';' + af.join(';'),
    mapVideo: `[${vout}]`,
    mapAudio: '[a_out]'
  };
}

/* ---------------------------------------------------------------- routes */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ffmpeg: !!BIN.ffmpeg,
    ytdlp: !!BIN.ytdlp,
    ffmpegPath: BIN.ffmpeg,
    ytdlpPath: BIN.ytdlp,
    canRenderYouTube: !!(BIN.ffmpeg && BIN.ytdlp),
    canRenderUpload: !!BIN.ffmpeg,
    music: listMusic()
  });
});

function listMusic(){
  try{
    const onDisk=fs.readdirSync(MUSIC_DIR).filter(f=>/\.(mp3|m4a|wav|ogg)$/i.test(f));
    if(onDisk.length) return onDisk;
  }catch(e){}
  // serverless bundles sometimes don't include music/ — fall back to a manifest
  try{
    const manifest=path.join(ROOT,'music','manifest.json');
    if(fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest,'utf8'));
  }catch(e){}
  return [];
}

app.get('/api/tracks', (req, res) => {
  res.json(listMusic()
    .map(file => ({
      id: file,
      url: '/music/' + encodeURIComponent(file),
      title: file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    })));
});

/** Video metadata for the loader card (title, duration, live?) */
app.get('/api/meta', async (req, res) => {
  const url = req.query.url || '';
  const videoId = parseYouTubeId(url);
  if (!videoId) return res.status(400).json({ error: 'Not a valid YouTube URL' });
  if (!BIN.ytdlp) return res.status(503).json({ error: 'yt-dlp not installed on the server', videoId });
  try {
    const { out } = await run(BIN.ytdlp, ['-J', '--no-warnings', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`]);
    const info = JSON.parse(out.slice(out.indexOf('{')));
    res.json({
      videoId,
      title: info.title,
      duration: info.duration,
      isLive: !!info.is_live,
      channel: info.uploader,
      views: info.view_count,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not read that video', detail: (e.stderr || e.message || '').slice(-400) });
  }
});

/**
 * POST /api/render
 * { sourceUrl | sourceId, inPoint, duration, aspect, music, musicVol, origVol,
 *   fade, captions, captionText, quality }
 * -> { jobId }
 */
app.post('/api/render', async (req, res) => {
  const b = req.body || {};
  const sourceId = b.sourceId || parseYouTubeId(b.sourceUrl);
  const title = (b.title || 'Clip').slice(0, 120);

  if (!sourceId && !b.localFile) return res.status(400).json({ error: 'Missing source' });
  if (!BIN.ffmpeg) return res.status(503).json({ error: 'ffmpeg not installed on the server' });
  if (sourceId && !BIN.ytdlp) return res.status(503).json({ error: 'yt-dlp not installed on the server' });

  const job = newJob({ title, kind: 'render' });
  res.json({ jobId: job.id });

  (async () => {
    setJob(job.id, { status: 'running' });
    try {
      const inPoint = clamp(num(b.inPoint, 0), 0, 60 * 60 * 12);
      const duration = clamp(num(b.duration, 30), 2, 600);
      const aspect = ASPECTS[b.aspect] ? b.aspect : '9x16';
      const music = musicPath(b.music);
      const musicVol = clamp(num(b.musicVol, 0.6), 0, 2);
      const origVol = clamp(num(b.origVol, 0.9), 0, 2);
      const fade = clamp(num(b.fade, 1.5), 0, 10);
      const captionsOn = !!b.captions && !!b.captionText;

      let source;
      if (sourceId) {
        source = await downloadSource(sourceId, job.id, { maxHeight: b.quality === '4k' ? 2160 : 720 });
      } else if (b.localFile === '__demo__') {
        source = path.join(ROOT, 'assets', 'demo-stream.mp4');
        if (!fs.existsSync(source)) throw new Error('Demo asset missing');
      } else {
        source = path.join(WORK, path.basename(b.localFile));
        if (!fs.existsSync(source)) throw new Error('Uploaded file missing');
      }
      setJob(job.id, { stage: 'Rendering clip', progress: 30 });

      const f = buildFilter({ aspect, inPoint, duration, music, musicVol, origVol, fade, captions: captionsOn, captionText: b.captionText, captionsOn });
      const outFile = path.join(OUT, `clip_${job.id}.mp4`);
      const args = [
        '-hide_banner', '-y',
        '-ss', String(inPoint), '-i', source,
        ...(music ? ['-stream_loop', '-1', '-i', music] : []),
        '-filter_complex', f.graph,
        '-map', f.mapVideo, '-map', f.mapAudio,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart', '-t', String(duration), outFile
      ];

      await run(BIN.ffmpeg, args, {
        onErr: (chunk) => {
          const m = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
          if (m) {
            const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
            setJob(job.id, { progress: Math.round(clamp(30 + (secs / duration) * 65, 30, 96)), stage: 'Encoding MP4' });
          }
        }
      });

      if (!fs.existsSync(outFile)) throw new Error('Render produced no file');
      setJob(job.id, {
        status: 'done', progress: 100, stage: 'Done', file: outFile,
        size: (await fsp.stat(outFile)).size,
        download: `/api/jobs/${job.id}/download`,
        meta: { inPoint, duration, aspect, music: music ? path.basename(music) : null }
      });
    } catch (e) {
      setJob(job.id, {
        status: 'error',
        stage: 'Failed',
        error: String(e.message || e).slice(0, 400),
        detail: String(e.stderr || '').slice(-1500)
      });
    }
  })();
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown job' });
  const { file, ...safe } = j;
  res.json(safe);
});

app.get('/api/jobs/:id/download', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done' || !j.file || !fs.existsSync(j.file)) return res.status(404).send('Not ready');
  const name = (j.title || 'clipforge-clip').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'clip';
  res.download(j.file, `${name}.mp4`);
});

/** Simple upload endpoint for the "Upload" tab (kept out of git, temp only) */
app.put('/api/upload/:name', express.raw({ type: '*/*', limit: '512mb' }), async (req, res) => {
  try {
    const name = crypto.randomBytes(6).toString('hex') + '_' + String(req.params.name || 'video.mp4').replace(/[^\w.-]/g, '').slice(-60);
    const dest = path.join(WORK, name);
    await fsp.writeFile(dest, req.body);
    res.json({ ok: true, localFile: name, size: req.body.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

// On Vercel (and other serverless hosts) the platform imports the app instead of
// letting it listen. Long renders can't run there anyway — the UI falls back to
// the in-browser WebCodecs MP4 encoder, so /api/health reports what's missing.
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipForge Pro running on http://0.0.0.0:${PORT}`);
    console.log(`  ffmpeg: ${BIN.ffmpeg || 'NOT FOUND'}`);
    console.log(`  yt-dlp: ${BIN.ytdlp || 'NOT FOUND'}`);
  });
}

module.exports = app;
