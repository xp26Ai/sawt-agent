/**
 * اختبار الجسر: متصفح ⇄ خادم ⇄ Gemini Live.
 * يحاكي متصفحاً لكن بالنص بدل الصوت، ويتحقق أن الوكيل
 * يستدعي الأدوات فعلاً ويرجع صوتاً.
 *
 * تشغيل: node scripts/test-bridge.js   (لازم الخادم شغّال)
 */

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmToWav } from '../lib/audio.js';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'audio');
const PORT = process.env.PORT || 4630;

// سيناريو: عميل يسأل عن طلبه، ثم يطلب موظفاً بشرياً
const SCRIPT = [
  'السلام عليكم، طلبي متأخر وأبي أعرف وش صار فيه',
  'رقم الطلب ثمانية أربعة سبعة اثنين',
  'طيب وكم رسوم التوصيل عندكم؟',
  'ما فهمت، أبي أكلم موظف من فضلك',
];

const ws = new WebSocket(`ws://localhost:${PORT}/ws/live`);
const audio = [];
const log = [];
let step = -1;
let turns = 0;

const nextTurn = () => {
  step++;
  if (step >= SCRIPT.length) {
    setTimeout(finish, 1500);
    return;
  }
  console.log(`\n  ◀ العميل: ${SCRIPT[step]}`);
  ws.send(JSON.stringify({ type: 'text', text: SCRIPT[step] }));
};

async function finish() {
  ws.send(JSON.stringify({ type: 'stop' }));
  const pcm = Buffer.concat(audio);
  if (pcm.length) {
    await writeFile(path.join(OUT, 'bridge-test.wav'), pcmToWav(pcm, 24000));
    console.log(`\n  الصوت: ${(pcm.length / 2 / 24000).toFixed(1)} ثانية → audio/bridge-test.wav`);
  }
  console.log(`  الأحداث: ${log.join(' · ') || 'لا شيء'}`);
  console.log(`  الأدوار: ${turns}\n`);
  const toolsFired = log.some((l) => l.startsWith('أداة'));
  console.log(toolsFired ? '  ✓ الأدوات اشتغلت' : '  ✗ الأدوات ما اشتغلت');
  ws.close();
  process.exit(pcm.length && toolsFired ? 0 : 1);
}

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'start',
    config: {
      agentName: 'سند',
      company: 'شركة سند للتوصيل',
      dialect: 'najdi',
      voice: 'Charon',
      model: 'gemini-3.1-flash-live-preview',
      knowledge: 'رسوم التوصيل خمسة عشر ريالاً، ومجاني للطلبات فوق مئتي ريال. أوقات العمل من التاسعة صباحاً إلى التاسعة مساءً.',
    },
  }));
};

ws.onmessage = (ev) => {
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
    case 'tool':
      log.push(`أداة:${m.name}`);
      console.log(`\n  ⚙ ${m.name}(${JSON.stringify(m.args)})`);
      break;
    case 'toolResult':
      console.log(`  ⚙ النتيجة: ${JSON.stringify(m.response)}`);
      break;
    case 'need':
      log.push(`طلب:${m.intent}`);
      break;
    case 'escalate':
      log.push('تحويل');
      console.log(`\n  ⚠ تحويل لبشري: ${m.reason}`);
      break;
    case 'turnComplete':
      turns++;
      if (turns === 1) console.log('  ▶ الوكيل رحّب.');
      setTimeout(nextTurn, 400);
      break;
    case 'error':
      console.error(`\n  خطأ: ${m.message}`);
      break;
  }
};

ws.onerror = (e) => {
  console.error('  فشل الاتصال بالخادم — تأكد أنه شغّال.', e.message || '');
  process.exit(1);
};

setTimeout(() => {
  console.error('\n  انتهت المهلة (90 ث)');
  process.exit(1);
}, 90000);
