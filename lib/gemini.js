/** غلاف رقيق حول Gemini API — توليد الصوت + معالجة النص. */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY غير موجود في .env');
  return k;
}

async function post(path, body, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`رد غير صالح من Gemini (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * إعادة المحاولة عند الضغط (503) أو تجاوز الحد (429).
 *
 * عند 429 يذكر Google المهلة المطلوبة في نص الخطأ
 * ("Please retry in 13.9s") — نحترمها بدل التخمين، وإلا فشلنا مبكراً.
 */
function retryAfterMs(message) {
  const m = /retry in ([\d.]+)\s*s/i.exec(message || '');
  if (!m) return null;
  return Math.min(Math.ceil(Number(m[1]) * 1000) + 1000, 70000);
}

async function withRetry(fn, { tries = 3, baseDelay = 1500 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retryable = e.status === 503 || e.status === 429 || e.name === 'AbortError';
      if (!retryable || i === tries - 1) throw e;
      const wait = retryAfterMs(e.message) ?? baseDelay * 2 ** i;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/**
 * توليد صوت من نص.
 * @returns {{pcm: Buffer, sampleRate: number, channels: number, usage: object}}
 */
export async function synthesize(text, { voice = 'Kore', model = process.env.TTS_MODEL } = {}) {
  const m = model || 'gemini-3.1-flash-tts-preview';
  const json = await withRetry(() =>
    post('/interactions', {
      model: m,
      input: text,
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    })
  );

  const audio = (json.steps || [])
    .flatMap((s) => s.content || [])
    .find((c) => c.type === 'audio' && c.data);

  if (!audio) throw new Error('لم يرجع Gemini أي صوت');

  return {
    pcm: Buffer.from(audio.data, 'base64'),
    sampleRate: audio.sample_rate || 24000,
    channels: audio.channels || 1,
    usage: json.usage || {},
    model: m,
  };
}

/** استدعاء نموذج نصّي عادي. */
export async function generateText(prompt, { model = process.env.TEXT_MODEL, temperature = 0 } = {}) {
  const m = model || 'gemini-3.5-flash';
  const json = await withRetry(() =>
    post(`/models/${m}:generateContent`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature },
    })
  );
  const out = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('');
  if (!out) throw new Error('لم يرجع النموذج نصاً');
  return out.trim();
}

/** تكلفة تقريبية بالدولار حسب أسعار Gemini 3.1 Flash TTS. */
export function estimateCost(usage) {
  const inTok = usage?.total_input_tokens || 0;
  const outTok = usage?.total_output_tokens || 0;
  const usd = (inTok / 1e6) * 1.0 + (outTok / 1e6) * 20.0;
  return { usd, sar: usd * 3.75 };
}
