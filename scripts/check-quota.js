/**
 * يفحص حالة الحصة الآن لكل نموذج نستخدمه.
 *
 * قوقل لا تعرض "المتبقي" في الـAPI — الطريقة الوحيدة الصادقة
 * هي طلب صغير جداً ورؤية هل يمر أم يُرفض بـ429.
 *
 * تشغيل: node scripts/check-quota.js
 */

import 'dotenv/config';

const KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const TEXT_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

async function probeText(model) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 1 },
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function probeTts() {
  const res = await fetch(`${BASE}/interactions`, {
    method: 'POST',
    headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3.1-flash-tts-preview',
      input: 'hi',
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    }),
  });
  return { status: res.status, body: await res.text() };
}

function probeLive() {
  return new Promise((resolve) => {
    const url =
      'wss://generativelanguage.googleapis.com/ws/'
      + 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + KEY;
    const ws = new WebSocket(url);
    const done = (r) => { try { ws.close(); } catch {} resolve(r); };
    const t = setTimeout(() => done({ status: 0, body: 'مهلة' }), 15000);

    ws.onopen = () => ws.send(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generation_config: { response_modalities: ['AUDIO'] },
      },
    }));
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      if (raw.includes('setupComplete')) { clearTimeout(t); done({ status: 200, body: 'ok' }); }
    };
    ws.onclose = (e) => { clearTimeout(t); done({ status: e.code === 1000 ? 200 : 429, body: e.reason || `code ${e.code}` }); };
    ws.onerror = () => { clearTimeout(t); done({ status: 0, body: 'خطأ اتصال' }); };
  });
}

function verdict({ status, body }) {
  if (status === 200) return ['✓ متاح الآن', ''];
  if (status === 429) {
    const m = /retry in ([\d.]+)\s*s/i.exec(body);
    const lim = /limit:\s*(\d+)/i.exec(body);
    return ['✗ تجاوزت الحد', `${lim ? `الحد ${lim[1]} · ` : ''}${m ? `أعد بعد ${Math.ceil(Number(m[1]))} ثانية` : ''}`];
  }
  if (status === 503) return ['⚠ الخدمة مزدحمة', 'أعد المحاولة'];
  if (status === 404) return ['— غير موجود', ''];
  return [`✗ HTTP ${status}`, body.slice(0, 70)];
}

/** منتصف الليل بتوقيت المحيط الهادئ = وقت تصفير الحصة اليومية. */
function nextReset() {
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const riyadhNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const offsetH = Math.round((riyadhNow - pacificNow) / 3600000);

  const msLeft = (24 - pacificNow.getHours()) * 3600000
               - pacificNow.getMinutes() * 60000;
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return { h, m, riyadhHour: (0 + offsetH + 24) % 24 };
}

async function main() {
  if (!KEY) { console.error('\n  GEMINI_API_KEY غير موجود\n'); process.exit(1); }

  console.log('\n  حالة الحصة المجانية الآن\n  ' + '─'.repeat(52));

  for (const m of TEXT_MODELS) {
    const [v, note] = verdict(await probeText(m));
    console.log(`  ${m.padEnd(24)} ${v}${note ? '  — ' + note : ''}`);
  }

  const [tv, tn] = verdict(await probeTts());
  console.log(`  ${'TTS (توليد صوت)'.padEnd(24)} ${tv}${tn ? '  — ' + tn : ''}`);

  const [lv, ln] = verdict(await probeLive());
  console.log(`  ${'Live (مكالمة حيّة)'.padEnd(24)} ${lv}${ln ? '  — ' + ln : ''}`);

  const r = nextReset();
  console.log('  ' + '─'.repeat(52));
  console.log(`  الحصة اليومية تُصفَّر بعد ${r.h} ساعة و${r.m} دقيقة`);
  console.log(`  (منتصف الليل بتوقيت المحيط الهادئ = الساعة ${r.riyadhHour} صباحاً بالرياض)\n`);
}

main().catch((e) => { console.error('\n  فشل:', e.message, '\n'); process.exit(1); });
