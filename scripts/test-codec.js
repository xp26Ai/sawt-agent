/**
 * اختبار محوّلات الهاتف — حسابي بحت، بدون شبكة ولا تكلفة.
 * تشغيل: node scripts/test-codec.js
 */

import {
  muLawToPcm, pcmToMuLaw, resample,
  phoneToGemini, geminiToPhone, FrameSplitter, streamTwiml,
} from '../lib/telephony.js';

let bad = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) bad++;
};

console.log('\n— ترميز μ-law —');

// موجة جيبية مثل الكلام
const N = 8000;
const sine = new Int16Array(N);
for (let i = 0; i < N; i++) sine[i] = Math.round(12000 * Math.sin((2 * Math.PI * 300 * i) / 8000));

const round = muLawToPcm(pcmToMuLaw(sine));
let maxErr = 0, sumErr = 0;
for (let i = 0; i < N; i++) {
  const e = Math.abs(round[i] - sine[i]);
  maxErr = Math.max(maxErr, e);
  sumErr += e;
}
const avgErr = sumErr / N;
// μ-law ترميز مفقود بطبيعته — نتوقع خطأ صغيراً نسبةً للسعة
check('ذهاب وعودة يحافظ على الشكل', avgErr < 12000 * 0.02,
      `متوسط الخطأ ${avgErr.toFixed(1)} من سعة 12000`);
check('لا انقلاب في الإشارة', round[100] * sine[100] >= 0);

// الصمت يجب أن يبقى صمتاً
const silence = new Int16Array(160);
const silRound = muLawToPcm(pcmToMuLaw(silence));
check('الصمت يبقى صمتاً', Math.max(...silRound.map(Math.abs)) < 40,
      `أقصى انحراف ${Math.max(...silRound.map(Math.abs))}`);

// الحدود القصوى
const extremes = Int16Array.from([32767, -32768, 0, 1, -1]);
const exRound = muLawToPcm(pcmToMuLaw(extremes));
check('القيم القصوى لا تنقلب', exRound[0] > 20000 && exRound[1] < -20000,
      `${exRound[0]} / ${exRound[1]}`);

console.log('\n— إعادة العيّنة —');

const up = resample(sine, 8000, 16000);
check('8k → 16k يضاعف الطول', up.length === N * 2, `${N} → ${up.length}`);

const down = resample(up, 16000, 8000);
check('16k → 8k يرجّع الطول', down.length === N, `${up.length} → ${down.length}`);

const dn24 = resample(new Int16Array(24000), 24000, 8000);
check('24k → 8k ينقص للثلث', dn24.length === 8000, `24000 → ${dn24.length}`);

console.log('\n— المحوّلات الكاملة —');

const muIn = pcmToMuLaw(sine);            // ما يرسله Twilio
const toGem = phoneToGemini(muIn.toString('base64'));
const gemBytes = Buffer.from(toGem, 'base64');
check('هاتف → Gemini يضاعف البايتات ×4',
      gemBytes.length === muIn.length * 4,
      `${muIn.length} بايت μ-law → ${gemBytes.length} بايت PCM16 16k`);

const pcm24 = Buffer.alloc(24000 * 2);    // ثانية واحدة من Gemini
const toPhone = geminiToPhone(pcm24);
check('Gemini → هاتف يعطي 8000 بايت للثانية',
      toPhone.length === 8000, `${toPhone.length} بايت`);

console.log('\n— مقسّم الإطارات —');

const sp = new FrameSplitter(160);
check('403 بايت → إطاران وبقية', sp.push(Buffer.alloc(403)).length === 2);
check('يكمل الإطار الثالث من الدفعة التالية', sp.push(Buffer.alloc(80)).length === 1);
sp.reset();
check('reset يرمي الباقي', sp.push(Buffer.alloc(159)).length === 0);

console.log('\n— TwiML —');

const xml = streamTwiml('wss://x.example/ws/phone', { from: '+966500000000', callSid: 'CA1' });
check('فيه Connect و Stream', xml.includes('<Connect>') && xml.includes('<Stream'));
check('يمرّر رقم المتصل', xml.includes('+966500000000'));
check('يهرب المحارف الخاصة',
      streamTwiml('wss://x/y', { from: 'a&b<c' }).includes('a&amp;b&lt;c'));

console.log(bad ? `\n  فشل ${bad}\n` : '\n  كل الفحوص نجحت\n');
process.exit(bad ? 1 : 0);
