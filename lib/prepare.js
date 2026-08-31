/**
 * خط تجهيز النص قبل التحويل إلى صوت.
 *
 * الهدف الأول: وضوح مخارج الحروف والنطق الصحيح.
 * كل مرحلة تُرجع ناتجها، عشان الواجهة تعرض للمستخدم بالضبط
 * وش الذي راح يُنطق قبل ما يرسل.
 */

import {
  numberToArabicWords,
  digitsToArabicWords,
  normalizeDigits,
  toGenitive,
  yearToArabicWords,
} from './arabic-numbers.js';
import { generateText } from './gemini.js';

/* ───────────────────────── 1) تنظيف ───────────────────────── */

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu;
const TATWEEL = /ـ/g;

export function clean(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(EMOJI, ' ')
    .replace(TATWEEL, '')
    .replace(/[«»""'']/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ──────────────────── 2) توسعة الاختصارات ──────────────────── */

/*
 * تنبيه: `\b` في JavaScript يعتمد على ASCII فقط، فما يشتغل مع الحروف العربية.
 * لذلك نستخدم lookaround على مدى الحروف العربية بدلاً منه.
 */
const AR = '\\u0621-\\u064A';
const NB = `(?<![${AR}])`; // ما قبله حرف عربي
const NA = `(?![${AR}])`; // ما بعده حرف عربي

const rx = (body, flags = 'g') => new RegExp(body, flags);

/** رموز عامة — تنطبق في أي مكان. */
// النقطة الأخيرة لا تُبتلع أبداً — قد تكون نهاية الجملة.
const SYMBOLS = [
  [rx(`${NB}ر\\s?\\.?\\s?س${NA}`), 'ريال'],
  [rx('﷼|\\bSAR\\b', 'gi'), 'ريال'],
  [rx(`${NB}د\\s?\\.?\\s?إ${NA}`), 'درهم'],
  [rx('\\bAED\\b', 'gi'), 'درهم'],
  [rx('\\bUSD\\b', 'gi'), 'دولار'],
  [rx('\\$'), ' دولار'],
  [rx('%'), ' بالمئة'],
  [rx('&'), ' و'],
  [rx('(?<!\\d)\\+(?=\\s|[^\\d])'), ' زائد '],
  [rx('#\\s*'), 'رقم '],
];

/**
 * وحدات وتوابع — لازم يسبقها رقم.
 * هذا يمنع تحويل كلمة "كم" الاستفهامية إلى "كيلومتر"،
 * و"مِن" إلى "مساءً"، وهكذا.
 */
const UNITS = [
  [rx(`(\\d)\\s*(?:كجم|كغم|kg)${NA}`, 'gi'), '$1 كيلوغرام'],
  [rx(`(\\d)\\s*(?:كم|km)${NA}`, 'gi'), '$1 كيلومتر'],
  [rx(`(\\d)\\s*(?:سم|cm)${NA}`, 'gi'), '$1 سنتيمتر'],
  [rx(`(\\d)\\s*(?:مل|ml)${NA}`, 'gi'), '$1 مليلتر'],
  [rx(`(\\d)\\s*(?:جم|g)${NA}`, 'gi'), '$1 غرام'],
  [rx(`(\\d)\\s*هـ${NA}`), '$1 هجري'],
  // ص/م بعد وقت (09:15 ص) تُترك لمرحلة الأرقام عشان ما تتكرر "صباحاً"
  [rx(`(?<!:\\d)(\\d)\\s*ص${NA}`), '$1 صباحاً'],
  [rx(`(?<!:\\d)(\\d)\\s*م${NA}`), '$1 مساءً'],
];

export function expandAbbreviations(text) {
  let out = text;
  for (const [re, rep] of UNITS) out = out.replace(re, rep);
  for (const [re, rep] of SYMBOLS) out = out.replace(re, rep);
  return out.replace(/[ \t]+/g, ' ').trim();
}

/* ─────────────────────── 3) الأرقام ─────────────────────── */

// كلمات تدل على أن الرقم "مرجعي" ويُنطق رقماً رقماً
const REF_HINTS =
  /(رقم|الرقم|طلب|الطلب|فاتورة|الفاتورة|مرجع|المرجع|بطاقة|البطاقة|جوال|الجوال|هاتف|الهاتف|جوّال|تذكرة|التذكرة|حجز|الحجز|شحنة|الشحنة|بوليصة|حساب|الحساب|آيبان|ايبان|كود|الكود|رمز|الرمز)\s*(?:هو\s*)?:?\s*$/;

const HOURS = [
  '', 'الواحدة', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة',
  'السابعة', 'الثامنة', 'التاسعة', 'العاشرة', 'الحادية عشرة', 'الثانية عشرة',
];

const MONTHS = [
  '', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

// ترتيب اليوم بصيغة الجر — "الخامس من يناير"، "الثلاثين من أغسطس"
const ORDINAL_ONES = [
  '', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس',
  'السابع', 'الثامن', 'التاسع', 'العاشر',
];
const ORDINAL_TENS = ['', 'العاشر', 'العشرين', 'الثلاثين'];

function dayOrdinal(d) {
  const n = Number(d);
  const unit = (u) => (u === 1 ? 'الحادي' : ORDINAL_ONES[u]);
  if (n >= 1 && n <= 10) return ORDINAL_ONES[n];
  if (n >= 11 && n <= 19) return `${unit(n - 10)} عشر`;
  if (n === 20 || n === 30) return ORDINAL_TENS[n / 10];
  if (n > 20 && n < 30) return `${unit(n - 20)} والعشرين`;
  if (n === 31) return 'الحادي والثلاثين';
  return toGenitive(numberToArabicWords(d));
}

/** "الثلاثين من أغسطس ألفين وستة وعشرين" */
function dateWords(d, mo, y) {
  const mi = Number(mo);
  const month = MONTHS[mi] || numberToArabicWords(mo);
  return `${dayOrdinal(d)} من ${month} ${yearToArabicWords(y)}`;
}

function timeToWords(h, m, marker) {
  const hh = Number(h) % 24;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const explicit = marker && /^(ص|صباح)/.test(marker) ? ' صباحاً'
    : marker && /^(م|مساء)/.test(marker) ? ' مساءً'
    : null;
  const suffix = explicit ?? (hh < 12 ? ' صباحاً' : ' مساءً');
  const base = HOURS[h12];
  const mm = Number(m);
  if (mm === 0) return `${base}${suffix}`;
  if (mm === 30) return `${base} والنصف${suffix}`;
  if (mm === 15) return `${base} والربع${suffix}`;
  if (mm === 45) return `${base} إلا ربعاً${suffix}`;
  return `${base} و${numberToArabicWords(mm)} دقيقة${suffix}`;
}

/**
 * يحوّل كل الأرقام في النص إلى كلمات، مع مراعاة السياق.
 * @param {string} text
 * @param {'smart'|'words'|'digits'|'off'} mode
 */
export function expandNumbers(text, mode = 'smart') {
  if (mode === 'off') return text;
  let out = normalizeDigits(text);

  if (mode === 'smart') {
    // الوقت: 14:30 أو 09:15 ص — نبتلع علامة الفترة عشان ما تتكرر
    out = out.replace(
      /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*(صباحاً|مساءً|صباحا|مساء|ص|م)(?![ء-ي]))?/g,
      (_, h, m, marker) => timeToWords(h, m, marker)
    );

    // التاريخ: 2026-08-30 (نمط ISO أولاً لأنه أطول)
    out = out.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, y, mo, d) => dateWords(d, mo, y));
    // التاريخ: 30/8/2026
    out = out.replace(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/g, (_, d, mo, y) => dateWords(d, mo, y));

    // أرقام الجوال السعودية: 05xxxxxxxx أو +9665xxxxxxxx
    out = out.replace(/(\+?966|\b0)(5\d{8})\b/g, (_, cc, rest) => {
      const head = cc.startsWith('+') || cc === '966' ? 'زائد، تسعة، ستة، ستة، ' : 'صفر، ';
      return head + digitsToArabicWords(rest);
    });
  }

  // بقية الأرقام
  out = out.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (m, offset, whole) => {
    const before = whole.slice(Math.max(0, offset - 30), offset);
    const digitsOnly = m.replace(/[,.]/g, '');

    if (mode === 'digits') return digitsToArabicWords(m);

    if (mode === 'smart') {
      // رقم مرجعي بعد كلمة دالة → رقماً رقماً
      if (REF_HINTS.test(before)) return digitsToArabicWords(m);
      // أي رقم طويل (٥ خانات فأكثر) بلا فاصلة آلاف → غالباً مرجع
      if (digitsOnly.length >= 5 && !m.includes(',') && !m.includes('.')) {
        return digitsToArabicWords(m);
      }
    }
    return numberToArabicWords(m);
  });

  // تنظيف: علامة + عالقة بعد رقم جوال حُوّل لكلمات
  out = out.replace(/(?<=[ء-ي])\+/g, '');

  return out.replace(/[ \t]+/g, ' ').trim();
}

/* ─────────────────────── 4) التشكيل ─────────────────────── */

const TASHKEEL_PROMPT = `أنت مدقّق لغوي عربي. مهمتك: تشكيل النص التالي تشكيلاً كاملاً ودقيقاً ليُقرأ آلياً بنطق فصيح صحيح.

القواعد الإلزامية:
1. شكّل كل حرف يحتاج تشكيلاً (فتحة، ضمة، كسرة، سكون، شدة، تنوين).
2. لا تغيّر أي كلمة، ولا تحذف، ولا تضف، ولا تعِد الصياغة إطلاقاً.
3. حافظ على علامات الترقيم وفواصل الأسطر كما هي تماماً.
4. اضبط أواخر الكلمات إعرابياً ضبطاً صحيحاً.
5. اترك الكلمات اللاتينية والرموز كما هي بدون تشكيل.
6. أعد النص المشكّل فقط — بدون مقدمة، بدون شرح، بدون علامات اقتباس.

النص:
---
{TEXT}
---`;

const HAS_TASHKEEL = /[ً-ْٰ]/;

/** يتحقق أن الناتج ما زال نفس النص (بعد نزع التشكيل). */
function stripTashkeel(s) {
  return s.replace(/[ً-ْٰٓ-ٟ]/g, '');
}

function similar(a, b) {
  const na = stripTashkeel(a).replace(/\s+/g, '');
  const nb = stripTashkeel(b).replace(/\s+/g, '');
  if (na === nb) return 1;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  if (!longer.length) return 1;
  let hits = 0;
  for (let i = 0; i < shorter.length; i++) if (shorter[i] === longer[i]) hits++;
  return hits / longer.length;
}

/**
 * يضيف التشكيل الكامل عبر Gemini، مع حارس أمان:
 * لو رجع النموذج نصاً مختلفاً عن الأصل، نرفضه ونرجّع الأصل.
 */
export async function addTashkeel(text) {
  if (!text.trim()) return { text, applied: false, reason: 'نص فارغ' };
  const out = await generateText(TASHKEEL_PROMPT.replace('{TEXT}', text));
  const cleaned = out.replace(/^---\s*|\s*---$/g, '').trim();

  const score = similar(text, cleaned);
  if (score < 0.9) {
    return { text, applied: false, reason: `النموذج غيّر النص (تطابق ${(score * 100).toFixed(0)}٪) — رُفض` };
  }
  if (!HAS_TASHKEEL.test(cleaned)) {
    return { text, applied: false, reason: 'لم يُضف تشكيل' };
  }
  return { text: cleaned, applied: true, reason: null };
}

/* ─────────────────── 5) توجيه النطق للـ TTS ─────────────────── */

export const TONES = {
  professional: 'مهنية ودودة ومطمئنة، مثل موظف خدمة عملاء محترف',
  warm: 'دافئة ومرحّبة ومبتسمة',
  calm: 'هادئة ومتأنّية ومتعاطفة',
  urgent: 'جادة وواضحة تدل على أهمية الرسالة، بدون توتر',
  cheerful: 'مبتهجة ومتحمّسة',
};

export const PACES = {
  slow: 'بطيئة ومتأنّية — مناسبة لكبار السن والأرقام المهمة',
  normal: 'معتدلة وطبيعية',
  fast: 'سريعة قليلاً وحيوية',
};

/**
 * يبني التوجيه النهائي الذي يُرسل للـ TTS.
 * هذا هو المفتاح الحقيقي لوضوح مخارج الحروف.
 */
export function buildDirective(text, { tone = 'professional', pace = 'normal', dialect = 'msa' } = {}) {
  const dialectLine =
    dialect === 'najdi'
      ? 'تحدّث باللهجة السعودية النجدية البيضاء المفهومة.'
      : 'تحدّث بالعربية الفصحى الحديثة.';

  return [
    'الملف الصوتي: موظف خدمة عملاء عربي، صوته واضح واحترافي.',
    '',
    'تعليمات الأداء:',
    `- ${dialectLine}`,
    `- النبرة: ${TONES[tone] || TONES.professional}.`,
    `- السرعة: ${PACES[pace] || PACES.normal}.`,
    '- انطق كل حرف بمخرجه الصحيح ولا تدغم الكلمات ببعضها.',
    '- ميّز بوضوح بين الحروف المتقاربة: الضاد والظاء، والصاد والسين، والقاف والكاف، والذال والزاي، والثاء والسين، والحاء والهاء، والطاء والتاء.',
    '- التزم بالتشكيل المكتوب حرفياً ولا تخالفه.',
    '- انطق الأرقام المكتوبة بالحروف كما هي مكتوبة تماماً.',
    '- قف وقفة قصيرة عند الفواصل، ووقفة أطول عند النقاط.',
    '- لا تقرأ هذه التعليمات. اقرأ النص الذي بعد السطر التالي فقط.',
    '',
    'النص المطلوب نطقه:',
    text,
  ].join('\n');
}

/* ─────────────────── الخط الكامل ─────────────────── */

/**
 * يشغّل كل المراحل ويرجّع تفاصيلها للعرض في الواجهة.
 */
export async function prepare(raw, opts = {}) {
  const {
    numbers = 'smart',
    tashkeel = true,
    tone = 'professional',
    pace = 'normal',
    dialect = 'msa',
  } = opts;

  const stages = [];

  const s1 = clean(raw);
  stages.push({ id: 'clean', label: 'تنظيف', text: s1 });

  const s2 = expandAbbreviations(s1);
  stages.push({ id: 'abbrev', label: 'توسعة الاختصارات', text: s2 });

  const s3 = expandNumbers(s2, numbers);
  stages.push({ id: 'numbers', label: `الأرقام (${numbers})`, text: s3 });

  let s4 = s3;
  let tashkeelNote = 'مُعطَّل';
  if (tashkeel) {
    try {
      const r = await addTashkeel(s3);
      s4 = r.text;
      tashkeelNote = r.applied ? 'تم' : `تخطّي — ${r.reason}`;
    } catch (e) {
      tashkeelNote = `فشل — ${e.message}`;
    }
  }
  stages.push({ id: 'tashkeel', label: `التشكيل (${tashkeelNote})`, text: s4 });

  const directive = buildDirective(s4, { tone, pace, dialect });
  stages.push({ id: 'directive', label: 'التوجيه النهائي للـ TTS', text: directive });

  return { spoken: s4, directive, stages };
}
