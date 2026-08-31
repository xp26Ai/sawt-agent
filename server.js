import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { synthesize, estimateCost } from './lib/gemini.js';
import { prepare, buildDirective, TONES, PACES } from './lib/prepare.js';
import { pcmToWav, pcmToOpus, pcmToMp3, durationSec, checkFfmpeg } from './lib/audio.js';
import { send, telegramMe, telegramUpdates, quietHoursCheck, sendTelegramText } from './lib/channels.js';
import { buildSecretaryPrompt, SECRETARY_TOOLS, summarize, formatForTelegram } from './lib/secretary.js';
import { phoneToGemini, geminiToPhone, FrameSplitter, streamTwiml } from './lib/telephony.js';
import { VOICES } from './lib/voices.js';
import { q, db } from './lib/db.js';
import { WebSocketServer } from 'ws';
import { LiveSession, LIVE_MODELS, buildSystemPrompt, TOOLS } from './lib/live.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
mkdirSync(AUDIO_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false })); // Twilio يرسل form-urlencoded
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(AUDIO_DIR));

/** ذاكرة مؤقتة للصوت المولَّد، عشان الإرسال ما يعيد التوليد (ولا يعيد الدفع). */
const cache = new Map(); // id -> { pcm, spoken, voice, tone, pace, duration, costSar }

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, e, code = 500) => {
  console.error('[خطأ]', e?.message || e);
  res.status(code).json({ ok: false, error: e?.message || String(e) });
};

/* ────────────────────────── فحص الجاهزية ────────────────────────── */

app.get('/api/health', async (_req, res) => {
  const checks = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    whatsapp: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    owner: Boolean(process.env.OWNER_CHAT_ID),
    ffmpeg: await checkFfmpeg(),
  };
  let bot = null;
  if (checks.telegram) {
    try {
      const me = await telegramMe();
      bot = `@${me.username}`;
    } catch (e) {
      checks.telegram = false;
      bot = e.message;
    }
  }
  ok(res, { checks, bot, quiet: quietHoursCheck(), stats: q.stats() });
});

app.get('/api/voices', (_req, res) => ok(res, { voices: VOICES, tones: TONES, paces: PACES }));

/* ───────────────────── معاينة النص قبل الصوت ───────────────────── */

app.post('/api/prepare', async (req, res) => {
  try {
    const { text = '', ...opts } = req.body || {};
    if (!text.trim()) return fail(res, new Error('النص فارغ'), 400);
    const r = await prepare(text, opts);
    ok(res, r);
  } catch (e) {
    fail(res, e);
  }
});

/* ───────────────────── توليد الصوت (معاينة) ───────────────────── */

app.post('/api/preview', async (req, res) => {
  try {
    const { text = '', voice = 'Kore', tone, pace, dialect, numbers, tashkeel } = req.body || {};
    if (!text.trim()) return fail(res, new Error('النص فارغ'), 400);

    const prep = await prepare(text, { tone, pace, dialect, numbers, tashkeel });
    const t0 = Date.now();
    const audio = await synthesize(prep.directive, { voice });
    const ms = Date.now() - t0;

    const dur = durationSec(audio.pcm, audio.sampleRate, audio.channels);
    const cost = estimateCost(audio.usage);

    const id = randomUUID();
    const wav = pcmToWav(audio.pcm, audio.sampleRate, audio.channels);
    await writeFile(path.join(AUDIO_DIR, `${id}.wav`), wav);

    cache.set(id, {
      pcm: audio.pcm,
      sampleRate: audio.sampleRate,
      raw: text,
      spoken: prep.spoken,
      voice,
      tone,
      pace,
      duration: dur,
      costSar: cost.sar,
    });
    // نحتفظ بآخر ٥٠ فقط
    if (cache.size > 50) cache.delete(cache.keys().next().value);

    ok(res, {
      id,
      url: `/audio/${id}.wav`,
      stages: prep.stages,
      spoken: prep.spoken,
      duration: dur,
      latencyMs: ms,
      usage: audio.usage,
      cost,
      model: audio.model,
      voice,
    });
  } catch (e) {
    fail(res, e);
  }
});

/** استماع سريع لصوت معيّن — جملة اختبار ثابتة فيها الحروف الصعبة. */
const AUDITION =
  'أهلاً بك، معك خدمة العملاء. الضَّيفُ الظَّريفُ حَضَرَ في الصَّباحِ الطَّلْقِ، وسَأَلَ عن الثَّمَنِ والذَّهَبِ والقِيمَةِ.';

app.post('/api/audition', async (req, res) => {
  try {
    const { voice = 'Kore', tone = 'professional', pace = 'normal' } = req.body || {};
    const directive = buildDirective(AUDITION, { tone, pace });
    const audio = await synthesize(directive, { voice });
    const id = randomUUID();
    await writeFile(
      path.join(AUDIO_DIR, `${id}.wav`),
      pcmToWav(audio.pcm, audio.sampleRate, audio.channels)
    );
    ok(res, { url: `/audio/${id}.wav`, voice, text: AUDITION });
  } catch (e) {
    fail(res, e);
  }
});

/* ─────────────────────────── الإرسال ─────────────────────────── */

app.post('/api/send', async (req, res) => {
  try {
    const { id, targets = [], caption = '', overrideQuiet = false } = req.body || {};
    const item = cache.get(id);
    if (!item) return fail(res, new Error('الصوت غير موجود — ولّد معاينة أولاً'), 400);
    if (!targets.length) return fail(res, new Error('ما فيه مستقبِلين'), 400);

    const quiet = quietHoursCheck();
    if (quiet.blocked && !overrideQuiet) {
      return res.status(409).json({ ok: false, quiet, error: quiet.message });
    }

    const ogg = await pcmToOpus(item.pcm, item.sampleRate);
    const mp3 = await pcmToMp3(item.pcm, item.sampleRate);
    const file = `${id}.mp3`;
    await writeFile(path.join(AUDIO_DIR, file), mp3);

    const msgId = Number(
      q.addMessage({
        raw: item.raw,
        spoken: item.spoken,
        voice: item.voice,
        tone: item.tone,
        pace: item.pace,
        duration: item.duration,
        file,
        costSar: item.costSar,
      }).lastInsertRowid
    );

    const results = [];
    for (const t of targets) {
      try {
        await send(t.channel || 'telegram', t.address, ogg, {
          caption,
          durationSec: item.duration,
        });
        q.addSend({ messageId: msgId, contactId: t.id, channel: t.channel || 'telegram', address: t.address, status: 'sent' });
        results.push({ ...t, status: 'sent' });
      } catch (e) {
        q.addSend({ messageId: msgId, contactId: t.id, channel: t.channel || 'telegram', address: t.address, status: 'failed', error: e.message });
        results.push({ ...t, status: 'failed', error: e.message });
      }
    }

    ok(res, { messageId: msgId, results, sent: results.filter((r) => r.status === 'sent').length });
  } catch (e) {
    fail(res, e);
  }
});

/* ────────────────────── جهات الاتصال والقوالب ────────────────────── */

app.get('/api/contacts', (_req, res) => ok(res, { contacts: q.contacts() }));

app.post('/api/contacts', (req, res) => {
  try {
    const { name, channel = 'telegram', address, tag } = req.body || {};
    if (!name || !address) return fail(res, new Error('الاسم والعنوان مطلوبان'), 400);
    q.addContact(name, channel, String(address), tag);
    ok(res, { contacts: q.contacts() });
  } catch (e) {
    fail(res, e);
  }
});

app.delete('/api/contacts/:id', (req, res) => {
  q.delContact(Number(req.params.id));
  ok(res, { contacts: q.contacts() });
});

/** يستخرج العملاء الذين راسلوا البوت — أسهل طريقة لجمع chat_id. */
app.get('/api/contacts/discover', async (_req, res) => {
  try {
    ok(res, { found: await telegramUpdates() });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/templates', (_req, res) => ok(res, { templates: q.templates() }));

app.post('/api/templates', (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return fail(res, new Error('العنوان والنص مطلوبان'), 400);
  q.addTemplate(title, body);
  ok(res, { templates: q.templates() });
});

app.delete('/api/templates/:id', (req, res) => {
  q.delTemplate(Number(req.params.id));
  ok(res, { templates: q.templates() });
});

app.get('/api/history', (_req, res) => ok(res, { history: q.history(), stats: q.stats() }));

/* ─────────────────────── المكالمة الحيّة ─────────────────────── */

app.get('/api/live/config', (_req, res) =>
  ok(res, {
    models: LIVE_MODELS,
    voices: VOICES,
    tools: {
      support: Object.values(TOOLS).map((t) => ({
        name: t.declaration.name,
        description: t.declaration.description,
      })),
      secretary: Object.values(SECRETARY_TOOLS).map((t) => ({
        name: t.declaration.name,
        description: t.declaration.description,
      })),
    },
    orders: q.orders(),
    ownerNotify: Boolean(process.env.OWNER_CHAT_ID && process.env.TELEGRAM_BOT_TOKEN),
  })
);

app.get('/api/calls', (req, res) =>
  ok(res, { calls: q.calls(30, req.query.mode || null), inbox: q.inboxStats() })
);

app.post('/api/calls/:id/handled', (req, res) => {
  q.markHandled(Number(req.params.id), req.body?.handled === false ? 0 : 1);
  ok(res, { calls: q.calls(30, 'secretary'), inbox: q.inboxStats() });
});

/** إعادة إرسال ملخّص مكالمة لتيليجرام. */
app.post('/api/calls/:id/notify', async (req, res) => {
  try {
    const call = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(req.params.id));
    if (!call) return fail(res, new Error('مكالمة غير موجودة'), 404);
    const chatId = process.env.OWNER_CHAT_ID;
    if (!chatId) return fail(res, new Error('OWNER_CHAT_ID غير موجود في .env'), 400);

    await sendTelegramText(
      chatId,
      formatForTelegram(
        {
          name: call.caller_name,
          relation: call.relation,
          category: call.category,
          reason: call.summary,
          callbackNumber: call.callback_number,
          bestTime: call.best_time,
          wantsCallback: !!call.wants_callback,
          urgency: call.urgency,
          urgencyLabel: call.urgency === 'high' ? 'مستعجل' : call.urgency === 'low' ? 'غير مستعجل' : 'عادي',
          urgentWhy: '',
          durationSec: Math.round(call.duration || 0),
        },
        call.transcript
      )
    );
    db.prepare('UPDATE calls SET notified=1 WHERE id=?').run(call.id);
    ok(res, {});
  } catch (e) {
    fail(res, e);
  }
});

/* ═══════════════════ مكالمة هاتف حقيقية (Twilio) ═══════════════════ */

/**
 * Twilio يطلب هذي النقطة أول ما ترن المكالمة، ونرد بـTwiML
 * يوصّل صوت المكالمة بمقبس WebSocket عندنا في الاتجاهين.
 *
 * اضبطها في لوحة Twilio:  A CALL COMES IN → Webhook → POST → https://<نطاقك>/twilio/voice
 */
app.all('/twilio/voice', (req, res) => {
  const body = { ...req.query, ...req.body };
  const from = body.From || '';
  const host = process.env.PUBLIC_HOST || req.get('host');
  const wsUrl = `wss://${host}/ws/phone`;

  // لا نطبع رقم المتصل في السجل — بيانات شخصية تبقى في السجلات.
  console.log('[هاتف] مكالمة واردة');
  res.type('text/xml').send(streamTwiml(wsUrl, { from, callSid: body.CallSid || '' }));
});

/**
 * جسر الصوت. بروتوكول Twilio Media Streams:
 *   وارد : connected → start → media* → stop
 *   صادر : {event:'media'|'clear', streamSid, …}
 */
function createPhoneBridge() {
  const phoneWss = new WebSocketServer({ noServer: true });

  phoneWss.on('connection', (twilio) => {
  let live = null;
  let callId = null;
  let streamSid = null;
  let from = '';
  let startedAt = 0;
  let finishing = false;

  const splitter = new FrameSplitter(160); // 20 ملّي ثانية
  const transcript = [];
  const sec = { caller: null, wrapUp: null, urgent: null };

  const toTwilio = (obj) => {
    if (twilio.readyState === 1) twilio.send(JSON.stringify(obj));
  };

  const sendAudio = (pcm24) => {
    if (!streamSid) return;
    for (const frame of splitter.push(geminiToPhone(pcm24))) {
      toTwilio({ event: 'media', streamSid, media: { payload: frame.toString('base64') } });
    }
  };

  async function finish(why) {
    if (finishing) return;
    finishing = true;
    console.log(`[هاتف] انتهت المكالمة — ${why}`);

    if (live) { live.close(); live = null; }
    try { twilio.close(); } catch {}

    if (!callId) return;
    const id = callId;
    callId = null;

    const text = transcript.join('\n');
    const s = await summarize({ ...sec, transcript: text, durationSec: (Date.now() - startedAt) / 1000 });

    let notified = false;
    const chatId = process.env.OWNER_CHAT_ID;
    if (chatId && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const head = from ? `<b>من الرقم:</b> <code>${from}</code>\n` : '';
        await sendTelegramText(chatId, formatForTelegram(s, text).replace('\n\n', '\n\n' + head));
        notified = true;
      } catch (e) {
        console.error('[تيليجرام]', e.message);
      }
    }
    q.saveSummary(id, s, text, notified);
  }

  twilio.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }

    if (m.event !== 'media') console.log('[هاتف] حدث:', m.event);

    if (m.event === 'start') {
      try {
      streamSid = m.start.streamSid;
      from = m.start.customParameters?.from || '';
      startedAt = Date.now();

      if (!process.env.GEMINI_API_KEY) {
        console.error('[هاتف] GEMINI_API_KEY غير موجود');
        return finish('ما فيه مفتاح');
      }

      callId = Number(
        q.startCall({
          mode: 'secretary',
          channel: 'phone',
          caller: from,
          agentName: process.env.SECRETARY_NAME || 'مساعد',
          voice: process.env.SECRETARY_VOICE || 'Charon',
          model: 'gemini-3.1-flash-live-preview',
        }).lastInsertRowid
      );

      live = new LiveSession({
        apiKey: process.env.GEMINI_API_KEY,
        voice: process.env.SECRETARY_VOICE || 'Charon',
        systemPrompt: buildSecretaryPrompt({
          ownerName: process.env.OWNER_NAME || 'صاحب الجوال',
          secretaryName: process.env.SECRETARY_NAME || 'مساعد',
          status: process.env.OWNER_STATUS || 'مشغول الآن ولا يقدر يرد',
          freeAfter: process.env.OWNER_FREE_AFTER || '',
        }),
        tools: SECRETARY_TOOLS,
        db,
      });

      live.on('ready', () => live.greet());
      live.on('audio', (b64) => {
        try {
          sendAudio(Buffer.from(b64, 'base64'));
        } catch (e) {
          console.error('[هاتف] فشل تحويل الصوت:', e.message);
        }
      });
      live.on('interrupted', () => {
        splitter.reset();
        if (streamSid) toTwilio({ event: 'clear', streamSid });
      });
      live.on('heard', (t) => transcript.push(`المتصل: ${t}`));
      live.on('said', (t) => transcript.push(`السكرتير: ${t}`));
      live.on('caller', (c) => { sec.caller = { ...sec.caller, ...c }; });
      live.on('urgent', (u) => {
        sec.urgent = u;
        const chatId = process.env.OWNER_CHAT_ID;
        if (chatId) {
          sendTelegramText(
            chatId,
            `🔴 <b>تنبيه فوري — مكالمة جارية</b>\n\n${u.why}\n\nالمتصل: ${sec.caller?.name || 'ما عرّف بنفسه بعد'}`
          ).catch(() => {});
        }
      });
      live.on('wrapUp', (w) => {
        sec.wrapUp = w;
        setTimeout(() => finish('خلّص السكرتير'), 6000);
      });
      live.on('error', (e) => { console.error('[هاتف]', e.message); finish('خطأ'); });
      live.on('close', (c) => finish(`أُغلقت جلسة Gemini (${c.code}) ${c.reason || ''}`.trim()));

      live.connect();

        // حد Gemini للجلسة الصوتية 15 دقيقة — نقفل قبله
        setTimeout(() => finish('طالت المكالمة'), 14 * 60 * 1000);
      } catch (e) {
        console.error('[هاتف] فشل بدء المكالمة:', e.message);
        console.error(e.stack);
        finish('فشل البدء');
      }
      return;
    }

    if (m.event === 'media' && live) {
      live.sendAudio(phoneToGemini(m.media.payload));
      return;
    }

    if (m.event === 'stop') finish('أقفل المتصل');
  });

    twilio.on('close', () => finish('انقطع الاتصال'));
    twilio.on('error', () => finish('خطأ في المقبس'));
  });

  return phoneWss;
}

/* ─────────────────────────── الإقلاع ─────────────────────────── */

const PORT = Number(process.env.PORT) || 4630;
const server = app.listen(PORT, () => {
  console.log(`\n  صوت — وكيل خدمة العملاء الصوتي`);
  console.log(`  http://localhost:${PORT}\n`);
  checkFfmpeg().then((has) => {
    if (!has) console.warn('  تحذير: ffmpeg غير موجود — الإرسال لتيليجرام لن يعمل.\n');
  });
});

/* ───────── جسر المكالمة: المتصفح ⇄ الخادم ⇄ Gemini Live ───────── */

/*
 * تنبيه: لا تربط أكثر من WebSocketServer بنفس خادم HTTP عبر خيار `path`.
 * كل واحد يضيف مستمعاً لحدث upgrade، وما لا يطابق مساره يُسقط المقبس —
 * فيقطع كلٌّ منهما اتصالات الآخر. الحل: `noServer` وموجّه واحد.
 */
const phoneWss = createPhoneBridge();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const target = pathname === '/ws/live' ? wss : pathname === '/ws/phone' ? phoneWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

wss.on('connection', (client) => {
  let live = null;
  let callId = null;
  let mode = 'support';
  let startedAt = 0;
  let finishing = false;
  const transcript = [];
  const summary = { intent: null, details: null, escalated: false, reason: null };
  const sec = { caller: null, wrapUp: null, urgent: null };

  const say = (obj) => {
    if (client.readyState === 1) client.send(JSON.stringify(obj));
  };

  /** يرسل ملخّص المكالمة لصاحب الجوال في تيليجرام. */
  async function notifyOwner(s, text) {
    const chatId = process.env.OWNER_CHAT_ID;
    if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return false;
    try {
      await sendTelegramText(chatId, formatForTelegram(s, text));
      return true;
    } catch (e) {
      console.error('[تيليجرام]', e.message);
      return false;
    }
  }

  const finish = async () => {
    if (finishing) return;
    finishing = true;

    if (live) {
      live.close();
      live = null;
    }
    if (!callId) return;

    const id = callId;
    callId = null;
    const text = transcript.join('\n');
    const durationSec = (Date.now() - startedAt) / 1000;

    if (mode === 'secretary') {
      const s = await summarize({ ...sec, transcript: text, durationSec });
      const notified = await notifyOwner(s, text);
      q.saveSummary(id, s, text, notified);
      say({ type: 'ended', callId: id, summary: s, notified });
    } else {
      q.endCall(id, { ...summary, transcript: text, duration: durationSec });
      say({ type: 'ended', callId: id });
    }
  };

  client.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      if (live) return;
      if (!process.env.GEMINI_API_KEY) return say({ type: 'error', message: 'GEMINI_API_KEY غير موجود' });

      const cfg = msg.config || {};
      mode = cfg.mode === 'secretary' ? 'secretary' : 'support';
      finishing = false;

      const systemPrompt =
        mode === 'secretary' ? buildSecretaryPrompt(cfg) : buildSystemPrompt(cfg);
      startedAt = Date.now();

      live = new LiveSession({
        apiKey: process.env.GEMINI_API_KEY,
        model: cfg.model,
        voice: cfg.voice,
        systemPrompt,
        tools: mode === 'secretary' ? SECRETARY_TOOLS : undefined,
        db,
      });

      callId = Number(
        q.startCall({
          mode,
          channel: 'browser',
          agentName: mode === 'secretary' ? cfg.secretaryName : cfg.agentName,
          voice: cfg.voice,
          model: cfg.model,
        }).lastInsertRowid
      );

      live.on('ready', () => {
        say({ type: 'ready', callId, systemPrompt });
        live.greet();
      });
      live.on('audio', (data) => say({ type: 'audio', data }));
      live.on('heard', (text) => {
        transcript.push(`العميل: ${text}`);
        say({ type: 'heard', text });
      });
      live.on('said', (text) => {
        transcript.push(`الوكيل: ${text}`);
        say({ type: 'said', text });
      });
      live.on('interrupted', () => say({ type: 'interrupted' }));
      live.on('turnComplete', () => say({ type: 'turnComplete' }));
      live.on('tool', (t) => say({ type: 'tool', ...t }));
      live.on('toolResult', (t) => say({ type: 'toolResult', ...t }));
      live.on('need', (n) => {
        summary.intent = n.intent;
        summary.details = n.details;
        say({ type: 'need', ...n });
      });
      live.on('escalate', (e) => {
        summary.escalated = true;
        summary.reason = e.reason;
        say({ type: 'escalate', ...e });
      });

      // أحداث وضع السكرتير
      live.on('caller', (c) => {
        sec.caller = { ...sec.caller, ...c };
        say({ type: 'caller', ...c });
      });
      live.on('urgent', (u) => {
        sec.urgent = u;
        say({ type: 'urgent', ...u });
        const chatId = process.env.OWNER_CHAT_ID;
        if (chatId) {
          sendTelegramText(
            chatId,
            `🔴 <b>تنبيه فوري — مكالمة جارية</b>\n\n${u.why}\n\nالمتصل: ${sec.caller?.name || 'لم يعرّف بنفسه بعد'}`
          ).catch(() => {});
        }
      });
      live.on('wrapUp', (w) => {
        sec.wrapUp = w;
        say({ type: 'wrapUp', ...w });
        // الوكيل خلّص — نغلق بعد ما يقول جملة الوداع
        setTimeout(() => finish(), 6000);
      });
      live.on('error', (e) => say({ type: 'error', message: e.message }));
      live.on('close', (c) => {
        say({ type: 'error', message: `انتهت جلسة Gemini (${c.code}) ${c.reason || ''}`.trim() });
        finish();
      });

      live.connect();
      return;
    }

    if (!live) return;
    if (msg.type === 'audio') live.sendAudio(msg.data);
    else if (msg.type === 'text') live.sendText(msg.text);
    else if (msg.type === 'stop') finish();
  });

  client.on('close', finish);
  client.on('error', finish);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  المنفذ ${PORT} محجوز لبرنامج آخر.`);
    console.error(`  غيّر PORT في ملف .env ثم أعد التشغيل.\n`);
  } else {
    console.error('\n  فشل الإقلاع:', e.message, '\n');
  }
  process.exit(1);
});
