/** اختبار سريع لخط النص فقط — بدون شبكة ولا تكلفة. */
import { clean, expandAbbreviations, expandNumbers } from '../lib/prepare.js';
import { numberToArabicWords, toGenitive } from '../lib/arabic-numbers.js';

const CASES = [
  'عزيزي العميل، تم استلام طلبك رقم 8472 بنجاح. سيصلك خلال 3 أيام عمل.',
  'نذكّرك بموعدك يوم 30/8/2026 الساعة 14:30. المبلغ المستحق 1450 ر.س.',
  'رقم البوليصة 90714523. الخصم 15%.',
  'كم يوماً تحتاج؟ المسافة 12 كم والوزن 3 كجم والسعر 250 ر.س فقط.',
  'الموعد 2026-01-05 الساعة 09:15 ص. الرصيد 2500.75 ريال.',
  'العرض ينتهي بعد 5 أيام. اتصل على 966500000000+ أو زر الفرع.',
];

let bad = 0;
for (const raw of CASES) {
  const out = expandNumbers(expandAbbreviations(clean(raw)), 'smart');
  const leftover = out.match(/\d/g);
  console.log(`\nالأصل   : ${raw}`);
  console.log(`المُجهَّز : ${out}`);
  if (leftover) {
    console.log(`  ⚠ بقيت أرقام: ${leftover.join('')}`);
    bad++;
  }
}

console.log('\n— فحوص مفردة —');
const checks = [
  ['كم الساعة الآن؟', 'كم'],            // ما يتحول لكيلومتر
  ['من فضلك أرسل الملف', 'من'],          // ما يتحول لمساءً
  ['المصر ومصر', 'مصر'],
];
for (const [src, must] of checks) {
  const out = expandAbbreviations(clean(src));
  const okc = out.includes(must);
  console.log(`  ${okc ? '✓' : '✗'} "${src}" → "${out}"`);
  if (!okc) bad++;
}

console.log(`  ✓ الجر: 2026 → ${toGenitive(numberToArabicWords(2026))}`);
console.log(`\n${bad ? `فشل ${bad}` : 'كل الفحوص نجحت'}\n`);
process.exit(bad ? 1 : 0);
