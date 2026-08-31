/** قنوات التوصيل: تيليجرام (جاهزة) وواتساب (Meta Cloud API). */

/* ─────────── حارس الأنظمة: أوقات الحظر حسب هيئة الاتصالات (CST) ─────────── */

/**
 * تمنع الأنظمة السعودية الرسائل والمكالمات الترويجية
 * من ١٠ مساءً حتى ٩ صباحاً بتوقيت الرياض.
 * الرسائل الخدمية (تأكيد طلب، موعد) مستثناة عادةً — لذلك الحارس قابل للتجاوز.
 */
export function quietHoursCheck(now = new Date()) {
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const h = riyadh.getHours();
  const blocked = h >= 22 || h < 9;
  return {
    blocked,
    hour: h,
    message: blocked
      ? `الساعة الآن ${h}:00 بالرياض. الأنظمة تمنع الرسائل الترويجية من 10 مساءً حتى 9 صباحاً.`
      : null,
  };
}

/* ───────────────────────────── تيليجرام ───────────────────────────── */

const TG = 'https://api.telegram.org';

function tgToken() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN غير موجود في .env');
  return t;
}

/**
 * يرسل الصوت كـ"رسالة صوتية" حقيقية في تيليجرام.
 * لازم OGG/Opus — أي صيغة ثانية تظهر كملف مرفق.
 */
export async function sendTelegramVoice(chatId, oggBuffer, { caption, durationSec } = {}) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'message.ogg');
  if (caption) fd.append('caption', caption);
  if (durationSec) fd.append('duration', String(Math.round(durationSec)));

  const res = await fetch(`${TG}/bot${tgToken()}/sendVoice`, { method: 'POST', body: fd });
  const json = await res.json();
  if (!json.ok) throw new Error(`تيليجرام: ${json.description || 'خطأ غير معروف'}`);
  return json.result;
}

/** رسالة نصية — تُستخدم لإرسال ملخّص المكالمة لصاحب الجوال. */
export async function sendTelegramText(chatId, text, { html = true } = {}) {
  const res = await fetch(`${TG}/bot${tgToken()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId),
      text,
      parse_mode: html ? 'HTML' : undefined,
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`تيليجرام: ${json.description || 'خطأ'}`);
  return json.result;
}

export async function telegramMe() {
  const res = await fetch(`${TG}/bot${tgToken()}/getMe`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || 'فشل getMe');
  return json.result;
}

/** يقرأ آخر المحادثات — لاستخراج chat_id للعملاء الذين راسلوا البوت. */
export async function telegramUpdates() {
  const res = await fetch(`${TG}/bot${tgToken()}/getUpdates?limit=100`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || 'فشل getUpdates');
  const seen = new Map();
  for (const u of json.result) {
    const c = u.message?.chat || u.edited_message?.chat;
    if (!c) continue;
    seen.set(String(c.id), {
      id: String(c.id),
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || c.username || String(c.id),
      username: c.username || null,
      type: c.type,
    });
  }
  return [...seen.values()];
}

/* ───────────────────────────── واتساب ───────────────────────────── */

const WA = 'https://graph.facebook.com/v21.0';

/**
 * واتساب على خطوتين: ارفع الملف ثم أرسل معرّفه.
 * يحتاج حساب WhatsApp Business + رقم موثّق.
 * ملاحظة: خارج نافذة الـ٢٤ ساعة لازم قالب معتمد مسبقاً.
 */
export async function sendWhatsappVoice(toNumber, oggBuffer) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_TOKEN أو WHATSAPP_PHONE_ID غير موجود في .env');

  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'audio/ogg');
  fd.append('file', new Blob([oggBuffer], { type: 'audio/ogg; codecs=opus' }), 'voice.ogg');

  const up = await fetch(`${WA}/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  }).then((r) => r.json());

  if (!up.id) throw new Error(`رفع واتساب فشل: ${up.error?.message || JSON.stringify(up).slice(0, 200)}`);

  const send = await fetch(`${WA}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(toNumber).replace(/[^\d]/g, ''),
      type: 'audio',
      audio: { id: up.id },
    }),
  }).then((r) => r.json());

  if (send.error) throw new Error(`واتساب: ${send.error.message}`);
  return send;
}

export async function send(channel, address, oggBuffer, meta = {}) {
  if (channel === 'whatsapp') return sendWhatsappVoice(address, oggBuffer);
  return sendTelegramVoice(address, oggBuffer, meta);
}
