/**
 * اختبار خط النطق كاملاً — بدون واجهة.
 * تشغيل:  node scripts/test-pronunciation.js
 *
 * ملاحظة مهمة: ما نمرّر نصاً عربياً عبر سطر الأوامر أبداً في ويندوز،
 * لأن الصدفة تخرّب ترميز UTF-8. كل النصوص هنا داخل الملف.
 */

import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandAbbreviations, expandNumbers, clean, addTashkeel, buildDirective } from '../lib/prepare.js';
import { numberToArabicWords, digitsToArabicWords } from '../lib/arabic-numbers.js';
import { synthesize, estimateCost } from '../lib/gemini.js';
import { pcmToWav, pcmToOpus, durationSec } from '../lib/audio.js';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'audio');

const CASES = [
  'عزيزي العميل، تم استلام طلبك رقم 8472 بنجاح. سيصلك خلال 3 أيام عمل. شكراً لثقتك بنا.',
  'مرحباً عميلنا العزيز، نذكّرك بموعدك يوم 30/8/2026 الساعة 14:30. المبلغ المستحق 1450 ر.س.',
  'تم شحن طلبك. رقم البوليصة 90714523. للاستفسار اتصل على الرقم الموحّد. الخصم 15%.',
];

const HARD_LETTERS =
  'الضَّيفُ الظَّريفُ حَضَرَ في الصَّباحِ الطَّلْقِ، وسَأَلَ عن الثَّمَنِ والذَّهَبِ والقِيمَةِ الحَقيقيَّةِ.';

function box(title) {
  console.log(`\n${'═'.repeat(64)}\n  ${title}\n${'═'.repeat(64)}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  /* ١ — تفقيط الأرقام (منطق محلي، بدون شبكة) */
  box('١ · تفقيط الأرقام');
  for (const n of [0, 3, 11, 21, 100, 205, 1000, 1450, 2026, 8472, 1234567]) {
    console.log(`  ${String(n).padStart(9)} → ${numberToArabicWords(n)}`);
  }
  console.log(`  رقماً رقماً 8472 → ${digitsToArabicWords(8472)}`);

  /* ٢ — خط التجهيز النصّي */
  box('٢ · خط التجهيز');
  let prepared = [];
  for (const raw of CASES) {
    const c = clean(raw);
    const a = expandAbbreviations(c);
    const n = expandNumbers(a, 'smart');
    console.log(`\n  الأصل  : ${raw}`);
    console.log(`  المُجهَّز: ${n}`);
    prepared.push(n);
  }

  /* ٣ — التشكيل */
  box('٣ · التشكيل عبر Gemini');
  const t = await addTashkeel(prepared[0]);
  console.log(`  الحالة : ${t.applied ? 'تم' : 'رُفض — ' + t.reason}`);
  console.log(`  الناتج : ${t.text}`);

  /* ٤ — توليد صوت حقيقي */
  box('٤ · توليد الصوت');
  const directive = buildDirective(t.text, { tone: 'professional', pace: 'normal' });
  const t0 = Date.now();
  const audio = await synthesize(directive, { voice: 'Kore' });
  const ms = Date.now() - t0;
  const dur = durationSec(audio.pcm, audio.sampleRate);
  const cost = estimateCost(audio.usage);

  await writeFile(path.join(OUT, 'test-1.wav'), pcmToWav(audio.pcm, audio.sampleRate));
  await writeFile(path.join(OUT, 'test-1.ogg'), await pcmToOpus(audio.pcm, audio.sampleRate));

  console.log(`  المدة       : ${dur.toFixed(2)} ثانية`);
  console.log(`  زمن التوليد : ${(ms / 1000).toFixed(2)} ثانية`);
  console.log(`  التكلفة     : ${cost.sar.toFixed(4)} ريال (${cost.usd.toFixed(5)} دولار)`);
  console.log(`  الملفات     : audio/test-1.wav  ·  audio/test-1.ogg`);

  /* ٥ — اختبار الحروف الصعبة */
  box('٥ · اختبار مخارج الحروف الصعبة');
  const a2 = await synthesize(buildDirective(HARD_LETTERS, { pace: 'slow' }), { voice: 'Kore' });
  await writeFile(path.join(OUT, 'test-letters.wav'), pcmToWav(a2.pcm, a2.sampleRate));
  console.log(`  ${HARD_LETTERS}`);
  console.log(`  → audio/test-letters.wav (${durationSec(a2.pcm, a2.sampleRate).toFixed(2)} ث)`);

  console.log('\n  كل الاختبارات نجحت.\n');
}

main().catch((e) => {
  console.error('\n  فشل:', e.message, '\n');
  process.exit(1);
});
