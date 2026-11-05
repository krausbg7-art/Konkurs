// Converts uploaded videos (iPhone HEVC .mov, HDR, 60 fps, rotated, …) into one format
// every browser plays: MP4, H.264 + AAC, 8-bit SDR, long side ≤ VIDEO_MAX_SIDE, ≤ 30 fps,
// moov atom at the start for instant playback. All metadata is dropped — iPhone files
// carry the GPS location of the shooting place.
//
// Jobs run in the background one by one (VIDEO_TRANSCODE_CONCURRENCY), so an upload
// request returns at once and the server CPU is not overloaded. Videos left in
// 'processing' after a restart are picked up again by resume().

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { stat, unlink, rename } from 'node:fs/promises';
import { randomToken } from './security.js';
import { probe } from './video.js';

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']); // HLG (iPhone), PQ

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, stderr: String(stderr || err?.message || '') }));
  });
}

async function videoStream(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,pix_fmt,color_transfer,width,height,avg_frame_rate', '-of', 'json', file], 30000);
  try { return JSON.parse(r.stdout).streams?.[0] || null; } catch { return null; }
}

const frameRate = (r) => {
  const [n, d] = String(r || '').split('/').map(Number);
  return n && d ? n / d : 0;
};

let zscaleAvailable;
async function hasZscale(ffmpeg) {
  if (zscaleAvailable === undefined) {
    const r = await run(ffmpeg, ['-hide_banner', '-filters'], 10000);
    zscaleAvailable = r.ok && /\szscale\s/.test(r.stdout) && /\stonemap\s/.test(r.stdout);
  }
  return zscaleAvailable;
}

export function buildArgs({ input, output, hdr, toneMap, maxSide, maxSeconds, fps }) {
  // Rotation from the phone is applied by ffmpeg before filters, so iw/ih are already upright.
  // Downscale first: tone mapping works per pixel and is the slowest step.
  const k = `min(1,${maxSide}/max(iw,ih))`;
  const filters = [];
  // 60 fps from the phone → 30 fps; done first so later filters handle half the frames.
  if (fps > 30.5) filters.push('fps=30');
  filters.push(`scale=w='trunc(${k}*iw/2)*2':h='trunc(${k}*ih/2)*2'`);
  if (hdr && toneMap) {
    // HDR → SDR (BT.709) so colours do not look washed out on ordinary screens.
    filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
      'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  filters.push('format=yuv420p');

  return [
    '-hide_banner', '-v', 'error', '-y',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-t', String(maxSeconds),
    '-vf', filters.join(','),
    '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4', output,
  ];
}

export async function transcodeFile(cfg, input, output) {
  const v = cfg.video;
  const s = await videoStream(v.ffprobe, input);
  if (!s) return { ok: false, error: 'no video stream' };
  const hdr = HDR_TRANSFERS.has(s.color_transfer);
  const toneMap = hdr && (await hasZscale(v.ffmpeg));

  const args = buildArgs({
    input, output, hdr, toneMap, maxSide: v.maxSide, maxSeconds: v.maxSeconds + v.toleranceSeconds, fps: frameRate(s.avg_frame_rate),
  });
  const r = await new Promise((resolve) => {
    const p = spawn(v.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), v.transcodeTimeoutSeconds * 1000);
    p.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, stderr: err.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr }); });
  });
  if (!r.ok) return { ok: false, error: r.stderr.trim().split('\n').slice(-3).join(' ') || 'ffmpeg failed' };

  const out = await probe(v.ffprobe, output);
  if (!out.ok) return { ok: false, error: 'output is not a valid video' };
  return { ok: true, duration: out.duration, hdr, toneMapped: toneMap };
}

export class Transcoder {
  constructor({ cfg, pool, log }) {
    this.cfg = cfg;
    this.pool = pool;
    this.log = log;
    this.queue = [];
    this.running = 0;
    this.waiters = [];
    this.stopped = false;
  }

  enqueue(videoId) {
    if (this.stopped || this.queue.includes(videoId)) return;
    this.queue.push(videoId);
    this.pump();
  }

  // After a restart: everything still marked 'processing' goes back to the queue.
  async resume() {
    const { rows } = await this.pool.query("select id from videos where status = 'processing' order by uploaded_at");
    rows.forEach((r) => this.enqueue(r.id));
    if (!(await hasZscale(this.cfg.video.ffmpeg))) {
      this.log.warn('ffmpeg has no zscale/tonemap: HDR videos will be converted without tone mapping');
    }
  }

  // Resolves when the queue is empty (used by tests and on shutdown).
  idle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop() { this.stopped = true; this.queue = []; return this.idle(); }

  pump() {
    while (this.running < this.cfg.video.transcodeConcurrency && this.queue.length) {
      const id = this.queue.shift();
      this.running += 1;
      this.process(id)
        .catch((err) => this.log.error({ err, videoId: id }, 'transcode crashed'))
        .finally(() => {
          this.running -= 1;
          if (!this.running && !this.queue.length) this.waiters.splice(0).forEach((w) => w());
          else this.pump();
        });
    }
  }

  async process(id) {
    const { pool, cfg } = this;
    const v = (await pool.query("select * from videos where id = $1 and status = 'processing'", [id])).rows[0];
    if (!v) return;
    const dir = path.resolve(cfg.videoDir);
    const input = path.join(dir, v.file_name);
    const finalName = `${v.company_id}-${randomToken(12)}.mp4`;
    const tmpOut = path.join(dir, 'tmp', `${finalName}.part`);
    const started = Date.now();

    const res = await transcodeFile(cfg, input, tmpOut);
    if (!res.ok) {
      await unlink(tmpOut).catch(() => {});
      await unlink(input).catch(() => {});
      await pool.query(
        "update videos set status = 'failed', processing_error = $2 where id = $1 and status = 'processing'",
        [id, res.error.slice(0, 1000)]);
      this.log.warn({ videoId: id, error: res.error }, 'transcode failed');
      return;
    }

    await rename(tmpOut, path.join(dir, finalName));
    const { size } = await stat(path.join(dir, finalName));
    const r = await pool.query(
      `update videos set status = 'pending', file_name = $2, mime = 'video/mp4', size_bytes = $3,
              duration_sec = $4, processed_at = now(), processing_error = null
        where id = $1 and status = 'processing'`,
      [id, finalName, size, res.duration.toFixed(2)]);
    if (r.rowCount) await unlink(input).catch(() => {});
    else await unlink(path.join(dir, finalName)).catch(() => {});
    this.log.info({ videoId: id, ms: Date.now() - started, hdr: res.hdr, toneMapped: res.toneMapped }, 'video transcoded');
  }
}
