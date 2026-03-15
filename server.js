const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;
const YTDLP = path.join(__dirname, 'yt-dlp');

function run(cmd) {
  return new Promise((resolve, reject) => {
    console.log('$', cmd);
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

async function setup() {
  // Install python3 and ffmpeg if missing
  try {
    await run('python3 --version');
    console.log('python3 OK');
  } catch {
    console.log('Installing python3...');
    await run('apt-get update -qq && apt-get install -y python3 ffmpeg');
  }

  // Download yt-dlp binary if missing
  if (!fs.existsSync(YTDLP)) {
    console.log('Downloading yt-dlp...');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(YTDLP);
      function download(url) {
        https.get(url, res => {
          if (res.statusCode === 301 || res.statusCode === 302) return download(res.headers.location);
          res.pipe(file);
          file.on('finish', () => { file.close(); fs.chmodSync(YTDLP, '755'); resolve(); });
        }).on('error', err => { try { fs.unlinkSync(YTDLP); } catch(_){} reject(err); });
      }
      download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
    });
    console.log('yt-dlp downloaded OK');
  } else {
    fs.chmodSync(YTDLP, '755');
    console.log('yt-dlp ready');
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    exec(`"${YTDLP}" ${args}`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

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

app.post('/download', async (req, res) => {
  const { url, format = 'mp4', quality = '720' } = req.body;
  if (!url) return res.status(400).send('Missing url');

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ytgrab_${Date.now()}`);

  let args;
  if (format === 'mp3') {
    args = `-x --audio-format mp3 --audio-quality 0 -o "${tmpFile}.%(ext)s" --no-playlist "${url}"`;
  } else {
    args = `-f "bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]" --merge-output-format mp4 -o "${tmpFile}.%(ext)s" --no-playlist "${url}"`;
  }

  try {
    await ytdlp(args);

    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    let outFile = `${tmpFile}.${ext}`;

    if (!fs.existsSync(outFile)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(path.basename(tmpFile)));
      if (!files.length) throw new Error('Output file not found');
      outFile = path.join(tmpDir, files[0]);
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
  stream.on('close', () => { try { fs.unlinkSync(filePath); } catch (_) {} });
}

function formatDuration(secs) {
  if (!secs) return '?';
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  const h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

setup().then(() => {
  app.listen(PORT, () => console.log(`YTgrab running on port ${PORT}`));
}).catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
