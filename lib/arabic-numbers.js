/**
 * تفقيط الأرقام إلى كلمات عربية.
 *
 * ليش هذا مهم؟ نماذج TTS تنطق الأرقام بشكل غير متوقع أحياناً
 * (مثلاً 1445 قد تُقرأ "ألف وأربعمئة وخمسة وأربعين" أو "واحد أربعة أربعة خمسة").
 * لما نحوّل الرقم لكلمات بأنفسنا، نضمن النطق الصحيح ١٠٠٪.
 */

const ONES = [
  '', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة',
  'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر',
  'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر',
];

const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];

const HUNDREDS = [
  '', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة',
  'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة',
];

// اسم المرتبة: [مفرد، مثنى، جمع قليل ٣-١٠، جمع كثير ١١+]
const SCALES = [
  null,
  ['ألف', 'ألفان', 'آلاف', 'ألفاً'],
  ['مليون', 'مليونان', 'ملايين', 'مليوناً'],
  ['مليار', 'ملياران', 'مليارات', 'ملياراً'],
];

/** أرقام هندية/فارسية → لاتينية */
export function normalizeDigits(text) {
  return String(text)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function under100(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  if (o === 0) return TENS[t];
  return `${ONES[o]} و${TENS[t]}`;
}

function under1000(n) {
  if (n < 100) return under100(n);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return HUNDREDS[h];
  return `${HUNDREDS[h]} و${under100(rest)}`;
}

/** صيغة المرتبة حسب العدد الذي قبلها (قواعد التمييز العربي) */
function scaleWord(count, scaleIdx) {
  const [one, two, few, many] = SCALES[scaleIdx];
  if (count === 1) return one;
  if (count === 2) return two;
  if (count >= 3 && count <= 10) return `${under1000(count)} ${few}`;
  return `${under1000(count)} ${many}`;
}

/**
 * رقم صحيح → كلمات عربية.
 * مثال: 1445 → "ألف وأربعمئة وخمسة وأربعون"
 */
export function intToArabicWords(num) {
  let n = Math.trunc(Math.abs(Number(num)));
  const negative = Number(num) < 0;
  if (!Number.isFinite(n)) return String(num);
  if (n === 0) return 'صفر';

  const groups = [];
  let idx = 0;
  while (n > 0 && idx < SCALES.length) {
    groups.push([n % 1000, idx]);
    n = Math.floor(n / 1000);
    idx++;
  }
  if (n > 0) return String(num); // أكبر من مليار — نتركه رقماً

  const parts = [];
  for (const [count, scaleIdx] of groups.reverse()) {
    if (count === 0) continue;
    parts.push(scaleIdx === 0 ? under1000(count) : scaleWord(count, scaleIdx));
  }

  const out = parts.join(' و');
  return negative ? `سالب ${out}` : out;
}

/**
 * رقم عشري → كلمات. مثال: 12.5 → "اثنا عشر فاصلة خمسة"
 */
export function numberToArabicWords(raw) {
  const s = normalizeDigits(String(raw)).replace(/,/g, '');
  const [ip, fp] = s.split('.');
  const head = intToArabicWords(ip);
  if (!fp) return head;
  // كسر من خانة أو خانتين (أسعار غالباً) يُقرأ كعدد: "فاصلة خمسة وسبعون"
  const tail =
    fp.length <= 2
      ? intToArabicWords(fp)
      : fp.split('').map((d) => ONES[Number(d)] || 'صفر').join(' ');
  return `${head} فاصلة ${tail}`;
}

/**
 * تحويل الصيغة من الرفع إلى الجر/النصب.
 * لازمة للتواريخ: "عام ألفان وستة وعشرون" غلط — الصحيح "ألفين وستة وعشرين".
 * التحويل آمن لأن هذه هي الصيغ الوحيدة التي يولّدها المُفقِّط.
 */
export function toGenitive(s) {
  return String(s)
    .replace(/مئتان/g, 'مئتين')
    .replace(/ألفان/g, 'ألفين')
    .replace(/مليونان/g, 'مليونين')
    .replace(/ملياران/g, 'مليارين')
    .replace(/(عشر|ثلاث|أربع|خمس|ست|سبع|ثمان|تسع)ون\b/g, '$1ين')
    .replace(/(عشر|ثلاث|أربع|خمس|ست|سبع|ثمان|تسع)ون(?=\s|$)/g, '$1ين')
    .replace(/اثنان/g, 'اثنين');
}

/** سنة ميلادية/هجرية بصيغة التاريخ الطبيعية. */
export function yearToArabicWords(y) {
  return toGenitive(intToArabicWords(y));
}

/**
 * نطق الرقم رقماً رقماً — للأرقام المرجعية (طلب، جوال، بطاقة).
 * مثال: 8472 → "ثمانية، أربعة، سبعة، اثنان"
 */
export function digitsToArabicWords(raw) {
  return normalizeDigits(String(raw))
    .split('')
    .filter((c) => /[0-9]/.test(c))
    .map((d) => (d === '0' ? 'صفر' : ONES[Number(d)]))
    .join('، ');
}
