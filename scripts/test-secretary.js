/**
 * اختبار وضع السكرتير — مكالمة كاملة من متصل مجهول.
 * يتحقق أن الوكيل: يعرّف بنفسه، يجمع الاسم والسبب والرقم،
 * يعلّم الاستعجال، وينهي بملخّص.
 *
 * تشغيل: node scripts/test-secretary.js   (الخادم لازم يكون شغّال)
 */

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmToWav } from '../lib/audio.js';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'audio');
const PORT = process.env.PORT || 4630;

const SCRIPT = [
  'ألو، السلام عليكم، أبي أكلم صاحب الجوال',
  'معك أبو فيصل من مؤسسة النخبة للمقاولات',
  'عندنا فاتورة متأخرة وأبي أعرف متى بتنزل، الموضوع مستعجل لأن العمال ينتظرون',
  'رقمي خمسة، صفر، صفر، صفر، صفر، صفر، صفر، صفر، صفر. وأفضّل بعد العصر',
];

const ws = new WebSocket(`ws://localhost:${PORT}/ws/live`);
const audio = [];
const seen = new Set();
let step = -1;
let turns = 0;
let ended = false;

const nextTurn = () => {
  step++;
  if (step >= SCRIPT.length) return; // ننتظر الوكيل يقفل بنفسه
  console.log(`\n  ◀ المتصل: ${SCRIPT[step]}`);
  ws.send(JSON.stringify({ type: 'text', text: SCRIPT[step] }));
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'start',
    config: {
      mode: 'secretary',
      ownerName: 'صاحب الجوال',
      secretaryName: 'مساعد',
      status: 'مشغول في اجتماع الآن',
      dialect: 'najdi',
      voice: 'Charon',
      model: 'gemini-3.1-flash-live-preview',
      freeAfter: 'راح يرجع بعد الساعة خمسة إن شاء الله',
      notes: 'لو المتصل من شركة تسويق، اعتذر بأدب واختم بسرعة.',
    },
  }));
};

ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case 'ready':
      console.log(`  الجلسة جاهزة (مكالمة رقم ${m.callId})`);
      break;
    case 'audio':
      audio.push(Buffer.from(m.data, 'base64'));
      break;
    case 'said':
      process.stdout.write(m.text);
      break;
    case 'caller':
      seen.add('caller');
      console.log(`\n  ⚙ recordCaller: ${JSON.stringify(m, null, 0)}`);
      break;
    case 'urgent':
      seen.add('urgent');
      console.log(`\n  ⚙ markUrgent: ${m.why}`);
      break;
    case 'wrapUp':
      seen.add('wrapUp');
      console.log(`\n  ⚙ endCall: ${m.summary}`);
      break;
    case 'turnComplete':
      turns++;
      if (turns === 1) console.log('  ▶ المساعد رحّب.');
      if (!seen.has('wrapUp')) setTimeout(nextTurn, 400);
      break;
    case 'ended': {
      ended = true;
      const pcm = Buffer.concat(audio);
      if (pcm.length) await writeFile(path.join(OUT, 'secretary-test.wav'), pcmToWav(pcm, 24000));
      console.log('\n\n  ══════ الملخّص المُرسل ══════');
      for (const [k, v] of Object.entries(m.summary || {})) {
        if (v !== '' && v !== null && v !== undefined) console.log(`  ${k.padEnd(16)} : ${v}`);
      }
      console.log(`\n  تيليجرام: ${m.notified ? 'أُرسل' : 'غير مربوط (OWNER_CHAT_ID فارغ)'}`);
      console.log(`  الصوت   : ${(pcm.length / 2 / 24000).toFixed(1)} ث → audio/secretary-test.wav`);

      const need = ['caller', 'urgent', 'wrapUp'];
      const missing = need.filter((k) => !seen.has(k));
      console.log(missing.length ? `\n  ✗ أدوات ما اشتغلت: ${missing.join('، ')}\n` : '\n  ✓ كل الأدوات اشتغلت\n');
      ws.close();
      process.exit(missing.length ? 1 : 0);
    }
    case 'error':
      console.error(`\n  خطأ: ${m.message}`);
      break;
  }
};

ws.onerror = () => {
  console.error('  فشل الاتصال بالخادم — تأكد أنه شغّال.');
  process.exit(1);
};

setTimeout(() => {
  if (!ended) {
    console.error('\n  انتهت المهلة (120 ث)');
    process.exit(1);
  }
}, 120000);
