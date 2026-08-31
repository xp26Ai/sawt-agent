/** تحويل صوت Gemini الخام (PCM) إلى صيغ جاهزة للاستخدام. */

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) =>
      reject(new Error(`ffmpeg غير مثبّت أو غير موجود في PATH: ${e.message}`))
    );
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg فشل (${code}): ${Buffer.concat(err).toString().slice(-400)}`));
    });
    if (input) {
      p.stdin.write(input);
      p.stdin.end();
    }
  });
}

/** PCM ‏s16le → WAV (للتشغيل في المتصفح والمعاينة). */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * PCM → OGG/Opus — هذه هي الصيغة الوحيدة التي يعرضها تيليجرام
 * كـ"رسالة صوتية" حقيقية (بموجة صوت) بدل ملف مرفق.
 */
export async function pcmToOpus(pcm, sampleRate = 24000) {
  return run(
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1',
      '-application', 'voip',
      '-f', 'ogg', 'pipe:1',
    ],
    pcm
  );
}

/** PCM → MP3 (لواتساب ولحفظ الأرشيف). */
export async function pcmToMp3(pcm, sampleRate = 24000) {
  return run(
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '64k',
      '-f', 'mp3', 'pipe:1',
    ],
    pcm
  );
}

/** مدة الصوت بالثواني من حجم الـ PCM. */
export function durationSec(pcm, sampleRate = 24000, channels = 1) {
  return pcm.length / 2 / channels / sampleRate;
}

/** فحص وجود ffmpeg عند الإقلاع. */
export async function checkFfmpeg() {
  try {
    await run(['-version']);
    return true;
  } catch {
    return false;
  }
}

export async function tempFile(buf, ext) {
  const p = path.join(os.tmpdir(), `sawt-${randomUUID()}.${ext}`);
  await writeFile(p, buf);
  return { path: p, cleanup: () => unlink(p).catch(() => {}) };
}
