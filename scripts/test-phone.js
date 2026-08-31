/**
 * محاكاة مكالمة هاتف حقيقية عبر بروتوكول Twilio Media Streams.
 *
 * نولّد صوت "المتصل" بـTTS، نحوّله لـμ-law 8 كيلوهرتز، ونبثّه للخادم
 * بنفس ما يفعله Twilio (إطارات 20 ملّي ثانية)، ثم نجمع رد السكرتير
 * ونحوّله لملف wav نسمعه.
 *
 * هذا يختبر السلسلة كاملة بدون رقم هاتف ولا حساب Twilio.
 *
 * تشغيل: node scripts/test-phone.js   (الخادم لازم يكون شغّال)
 */

import 'dotenv/config';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesize } from '../lib/gemini.js';
import { pcmToWav } from '../lib/audio.js';
import { muLawToPcm, pcmToMuLaw, resample, asInt16 } from '../lib/telephony.js';
import { db } from '../lib/db.js';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'audio');
const PORT = process.env.PORT || 4630;

const FRAME = 160;      // 20 ملّي ثانية من μ-law عند 8 كيلوهرتز
const FRAME_MS = 20;

const LINES = [
  'ألو، السلام عليكم، أبي أكلم صاحب الجوال لو سمحت',
  'معك أبو فيصل من مؤسسة النخبة، عندنا فاتورة متأخرة والموضوع مستعجل',
  'رقمي صفر خمسة صفر صفر صفر صفر صفر صفر صفر صفر، وأفضل بعد العصر',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ينطق جملة ويرجّعها μ-law 8 كيلوهرتز مثل ما يجي من الهاتف. */
const CACHE = path.join(OUT, '.caller-cache');

async function speakAsCaller(text) {
  // نخزّن الناتج على القرص — الحصة المجانية لـTTS محدودة،
  // ولا معنى لإعادة توليد نفس الجملة في كل تشغيل.
  await mkdir(CACHE, { recursive: true });
  const key = createHash('sha1').update(text).digest('hex').slice(0, 16);
  const file = path.join(CACHE, key + '.ulaw');
  try {
    return await readFile(file);
  } catch { /* أول مرة */ }

  const a = await synthesize(
    'تحدث بالعربية السعودية بنبرة رجل يتصل بالهاتف، بوضوح وسرعة طبيعية:\n' + text,
    { voice: 'Puck' }
  );
  const mu = pcmToMuLaw(resample(asInt16(a.pcm), 24000, 8000));
  await writeFile(file, mu);
  return mu;
}

/**
 * بديل بلا تكلفة: يقرأ ملف wav مولّداً سابقاً ويحوّله لـμ-law.
 * يُستخدم لما تنفد حصة TTS المجانية — المهم في هذا الاختبار
 * هو مسار النقل والترميز، لا نصّ الكلام نفسه.
 */
async function callerFromWav(wavPath, maxSec = 8) {
  const buf = await readFile(wavPath);
  const rate = buf.readUInt32LE(24);
  const pcm = asInt16(buf.subarray(44, 44 + Math.min(buf.length - 44, rate * 2 * maxSec)));
  return pcmToMuLaw(resample(pcm, rate, 8000));
}

/** صمت — لازم بعد كل جملة عشان يعرف Gemini أن المتصل خلّص. */
const silence = (ms) => pcmToMuLaw(new Int16Array((8000 * ms) / 1000));

async function main() {
  process.stdout.write('  أجهّز صوت المتصل… ');
  const clips = [];
  let labels = LINES;
  try {
    for (const l of LINES) clips.push(await speakAsCaller(l));
    console.log('تم.');
  } catch (e) {
    // نفدت حصة TTS — نستخدم صوتاً عربياً مولّداً سابقاً
    console.log('TTS غير متاح، أستخدم صوتاً محفوظاً.');
    console.log(`  (${e.message.slice(0, 60)}…)`);
    clips.length = 0;
    clips.push(await callerFromWav(path.join(OUT, 'test-1.wav'), 8));
    labels = ['(صوت عربي محفوظ — اختبار نقل فقط)'];
  }

  const ws = new WebSocket(`ws://localhost:${PORT}/ws/phone`);
  const back = [];
  let frames = 0;
  let firstReplyMs = null;
  const t0 = Date.now();

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('فشل الاتصال — تأكد أن الخادم شغّال'));
  });

  const streamSid = 'MZtest0000000000';
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.event === 'media') {
      if (firstReplyMs === null) firstReplyMs = Date.now() - t0;
      frames++;
      back.push(Buffer.from(m.media.payload, 'base64'));
    } else if (m.event === 'clear') {
      console.log('  ← الخادم طلب مسح المخزون (مقاطعة)');
    }
  };

  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({
    event: 'start',
    streamSid,
    start: {
      streamSid,
      callSid: 'CAtest',
      customParameters: { from: '+966500000000' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  }));

  /** يبثّ مخزوناً بنفس إيقاع الهاتف الحقيقي. */
  async function stream(buf, label) {
    if (label) console.log(`\n  ◀ المتصل: ${label}`);
    for (let i = 0; i + FRAME <= buf.length; i += FRAME) {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: buf.subarray(i, i + FRAME).toString('base64') },
      }));
      await sleep(FRAME_MS);
    }
  }

  // نسكت أولاً عشان يرحّب السكرتير
  await stream(silence(6000));

  for (let i = 0; i < clips.length; i++) {
    await stream(clips[i], labels[i] || labels[0]);
    await stream(silence(7000));       // نتركه يرد
  }
  await stream(silence(4000));

  ws.send(JSON.stringify({ event: 'stop', streamSid }));
  await sleep(2500);
  ws.close();

  /* ── النتائج ── */

  const mu = Buffer.concat(back);
  const pcm8 = muLawToPcm(mu);
  const wav = pcmToWav(Buffer.from(pcm8.buffer, pcm8.byteOffset, pcm8.byteLength), 8000);
  await writeFile(path.join(OUT, 'phone-test.wav'), wav);

  const row = db.prepare("SELECT * FROM calls WHERE channel='phone' ORDER BY id DESC LIMIT 1").get();

  console.log('\n  ═════════ النتيجة ═════════');
  console.log(`  إطارات رجعت   : ${frames}  (${(mu.length / 8000).toFixed(1)} ثانية صوت)`);
  console.log(`  أول رد بعد    : ${firstReplyMs} ملّي ثانية`);
  console.log(`  الملف         : audio/phone-test.wav`);
  if (row) {
    console.log(`\n  رقم المتصل    : ${row.caller || '—'}`);
    console.log(`  الاسم         : ${row.caller_name || '—'}`);
    console.log(`  الموضوع       : ${row.summary || '—'}`);
    console.log(`  التصنيف       : ${row.category || '—'} · ${row.urgency || '—'}`);
    console.log(`  رقم الرد      : ${row.callback_number || '—'}`);
    console.log(`  أفضل وقت      : ${row.best_time || '—'}`);
    console.log(`  تيليجرام      : ${row.notified ? 'أُرسل' : 'غير مربوط'}`);
  }

  const okFrames = frames > 200;                 // على الأقل ٤ ثوانٍ كلام
  const okName = row && row.caller_name && row.caller_name !== 'غير معروف';
  const okBack = row && (row.callback_number || '').replace(/\D/g, '').length >= 9;

  console.log('');
  console.log(`  ${okFrames ? '✓' : '✗'} رجع صوت للهاتف`);
  console.log(`  ${okName ? '✓' : '✗'} عرف اسم المتصل`);
  console.log(`  ${okBack ? '✓' : '✗'} التقط رقم الرد`);
  console.log('');

  process.exit(okFrames && okName ? 0 : 1);
}

main().catch((e) => {
  console.error('\n  فشل:', e.message, '\n');
  process.exit(1);
});
