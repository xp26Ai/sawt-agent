/**
 * اختبار اتصال Gemini Live API الحقيقي.
 * يفتح WebSocket، يرسل دوراً نصياً بالعربي، ويستقبل صوتاً.
 * تشغيل: node scripts/test-live.js
 */

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmToWav } from '../lib/audio.js';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'audio');

const HOST = 'generativelanguage.googleapis.com';
const PATHNAME = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODELS = ['gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-latest'];

const SYSTEM = `أنت "سند"، موظف خدمة عملاء سعودي في شركة توصيل.
تحدث بالعربية بلهجة سعودية بيضاء مفهومة، بجمل قصيرة وواضحة.
انطق الحروف بمخارجها الصحيحة ولا تدغم الكلمات.
اسأل سؤالاً واحداً في المرة، وتأكد أن العميل فهم قبل أن تنتقل.`;

const USER_TURN = 'السلام عليكم، طلبي ما وصل من ثلاثة أيام وأبي أعرف وش صار فيه.';

function tryModel(model) {
  return new Promise((resolve) => {
    const url = `wss://${HOST}${PATHNAME}?key=${process.env.GEMINI_API_KEY}`;
    const ws = new WebSocket(url);
    const chunks = [];
    const said = [];
    let setupDone = false;
    const t0 = Date.now();
    let firstAudioMs = null;

    const done = (result) => {
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => done({ model, ok: false, error: 'انتهت المهلة (30 ث)' }), 30000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generation_config: {
            response_modalities: ['AUDIO'],
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: 'Charon' } } },
          },
          system_instruction: { parts: [{ text: SYSTEM }] },
          output_audio_transcription: {},
          input_audio_transcription: {},
        },
      }));
    };

    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.setupComplete) {
        setupDone = true;
        ws.send(JSON.stringify({
          client_content: {
            turns: [{ role: 'user', parts: [{ text: USER_TURN }] }],
            turn_complete: true,
          },
        }));
        return;
      }

      const sc = msg.serverContent;
      if (!sc) return;

      for (const p of sc.modelTurn?.parts || []) {
        const d = p.inlineData?.data;
        if (d) {
          if (firstAudioMs === null) firstAudioMs = Date.now() - t0;
          chunks.push(Buffer.from(d, 'base64'));
        }
      }
      if (sc.outputTranscription?.text) said.push(sc.outputTranscription.text);
      if (sc.turnComplete) {
        done({ model, ok: true, pcm: Buffer.concat(chunks), said: said.join(''), firstAudioMs });
      }
    };

    ws.onerror = (e) => done({ model, ok: false, error: e.message || 'خطأ WebSocket' });
    ws.onclose = (e) => {
      if (!chunks.length) {
        done({ model, ok: false, error: `أُغلق (${e.code}) ${e.reason || (setupDone ? 'بعد الإعداد' : 'قبل الإعداد')}` });
      }
    };
  });
}

for (const m of MODELS) {
  process.stdout.write(`\n  ${m}\n`);
  const r = await tryModel(m);
  if (!r.ok) {
    console.log(`    فشل: ${r.error}`);
    continue;
  }
  const sec = r.pcm.length / 2 / 24000;
  await writeFile(path.join(OUT, `live-${m}.wav`), pcmToWav(r.pcm, 24000));
  console.log(`    نجح.`);
  console.log(`    أول صوت بعد : ${r.firstAudioMs} ملّي ثانية`);
  console.log(`    مدة الرد     : ${sec.toFixed(2)} ثانية`);
  console.log(`    قال          : ${r.said || '(بدون نص)'}`);
  console.log(`    الملف        : audio/live-${m}.wav`);
}
console.log();
