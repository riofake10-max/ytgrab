// server.js — YTgrab backend
// Requirements: Node.js, yt-dlp installed on the system
//
// Setup:
//   npm install express cors
//   node server.js

const express = require('express');
const cors = require('cors');
const { exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Helpers ──────────────────────────────────────────────────────────────────

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    exec(`yt-dlp ${args}`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /info?url=...
// Returns title, thumbnail, duration, uploader
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const json = await ytdlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(json);

    res.json({
      title: info.title,
      duration: formatDuration(info.duration),
      uploader: info.uploader,
      thumbnail: info.thumbnail,
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// POST /download
// Body: { url, format: 'mp4'|'mp3', quality: '720'|'1080'|'480'|'360' }
// Returns: binary file stream
app.post('/download', async (req, res) => {
  const { url, format = 'mp4', quality = '720' } = req.body;
  if (!url) return res.status(400).send('Missing url');

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ytgrab_${Date.now()}`);

  let args;

  if (format === 'mp3') {
    args = `-x --audio-format mp3 --audio-quality 0 -o "${tmpFile}.%(ext)s" --no-playlist "${url}"`;
  } else {
    // MP4: merge best video+audio at target quality
    args = `-f "bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]" --merge-output-format mp4 -o "${tmpFile}.%(ext)s" --no-playlist "${url}"`;
  }

  try {
    await ytdlp(args);

    // Find the output file
    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    const outFile = `${tmpFile}.${ext}`;

    if (!fs.existsSync(outFile)) {
      // Try finding any file with tmpFile prefix
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(path.basename(tmpFile)));
      if (!files.length) throw new Error('Output file not found');
      const found = path.join(tmpDir, files[0]);
      streamFile(found, format, res);
      return;
    }

    streamFile(outFile, format, res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

function streamFile(filePath, format, res) {
  const mime = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  const ext = format === 'mp3' ? '.mp3' : '.mp4';
  const filename = path.basename(filePath).replace(/[^\w.-]/g, '_');

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}${ext}"`);
  res.setHeader('Content-Length', fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('close', () => {
    try { fs.unlinkSync(filePath); } catch (_) {}
  });
}

function formatDuration(secs) {
  if (!secs) return '?';
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  const h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`YTgrab server running on http://localhost:${PORT}`);
  console.log('Make sure yt-dlp is installed: https://github.com/yt-dlp/yt-dlp');
});
