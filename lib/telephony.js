/**
 * جسر الهاتف: تحويل الترميز بين شبكة الهاتف وGemini Live.
 *
 * شبكة الهاتف (Twilio Media Streams): ‏μ-law، ‏8 كيلوهرتز، إطارات 20 ملّي ثانية.
 * Gemini: ‏PCM16 خام — ‏16 كيلوهرتز دخلاً، ‏24 كيلوهرتز خرجاً.
 *
 * كل شيء هنا خالص الحساب بدون حالة عامة، عشان يسهل اختباره.
 */

/* ─────────────────────── ترميز μ-law (G.711) ─────────────────────── */

const BIAS = 0x84;
const CLIP = 32635;

/** جدول فك الترميز — 256 قيمة، نبنيه مرة واحدة. */
const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = (((u & 0x0f) << 3) + BIAS) << ((u & 0x70) >> 4);
  t -= BIAS;
  DECODE[i] = (u & 0x80) ? -t : t;
}

/** جدول التشفير — نبنيه من المدى الكامل للعيّنات. */
const ENCODE = new Uint8Array(65536);
(function buildEncodeTable() {
  for (let s = -32768; s < 32768; s++) {
    let sample = s;
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);

    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    ENCODE[s & 0xffff] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
})();

/** μ-law → PCM16 */
export function muLawToPcm(mu) {
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) out[i] = DECODE[mu[i]];
  return out;
}

/** PCM16 → μ-law */
export function pcmToMuLaw(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ENCODE[pcm[i] & 0xffff];
  return out;
}

/* ─────────────────────── إعادة العيّنة ─────────────────────── */

/**
 * إعادة عيّنة خطّية. كافية تماماً للكلام الهاتفي،
 * ولا تضيف تأخيراً يُذكر (مهم في المكالمة الحيّة).
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = (input[i0] * (1 - frac) + input[i1] * frac) | 0;
  }
  return out;
}

/* ─────────────────────── المحوّلات الجاهزة ─────────────────────── */

/** من Twilio إلى Gemini: base64 μ-law 8k → base64 PCM16 16k */
export function phoneToGemini(base64MuLaw) {
  const mu = Buffer.from(base64MuLaw, 'base64');
  const pcm8 = muLawToPcm(mu);
  const pcm16 = resample(pcm8, 8000, 16000);
  return Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64');
}

/**
 * يقرأ Buffer كـInt16Array بأمان.
 *
 * ‏`Buffer.from(base64)` يقتطع من مجمّع مشترك، فقد يكون `byteOffset` فردياً،
 * و`new Int16Array(buf.buffer, byteOffset, …)` يرمي استثناءً حينها.
 * لذلك ننسخ إلى مخزن جديد عند عدم المحاذاة.
 */
export function asInt16(buf) {
  if (buf.byteOffset % 2 === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  }
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Int16Array(copy.buffer, 0, buf.byteLength >> 1);
}

/** من Gemini إلى Twilio: PCM16 24k (Buffer) → μ-law 8k (Buffer) */
export function geminiToPhone(pcm24kBuffer) {
  const pcm8 = resample(asInt16(pcm24kBuffer), 24000, 8000);
  return pcmToMuLaw(pcm8);
}

/* ─────────────────────── مقسّم الإطارات ─────────────────────── */

/**
 * Twilio يتوقع إطارات 20 ملّي ثانية = 160 بايت μ-law.
 * Gemini يرسل مقاطع بأحجام عشوائية، فنكدّسها ونقصّها.
 */
export class FrameSplitter {
  constructor(frameBytes = 160) {
    this.frameBytes = frameBytes;
    this.buf = Buffer.alloc(0);
  }

  /** يضيف بايتات ويرجع كل الإطارات المكتملة. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= this.frameBytes) {
      frames.push(this.buf.subarray(0, this.frameBytes));
      this.buf = this.buf.subarray(this.frameBytes);
    }
    return frames;
  }

  /** يرمي ما تبقّى — عند المقاطعة. */
  reset() {
    this.buf = Buffer.alloc(0);
  }
}

/* ─────────────────────── TwiML ─────────────────────── */

/**
 * يبني رد TwiML الذي يوصّل المكالمة بمقبس WebSocket عندنا.
 * `<Connect><Stream>` ثنائي الاتجاه — نستقبل ونرسل صوتاً.
 */
export function streamTwiml(wsUrl, params = {}) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const extra = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `      <Parameter name="${esc(k)}" value="${esc(v)}" />`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${esc(wsUrl)}">
${extra}
    </Stream>
  </Connect>
</Response>`;
}
