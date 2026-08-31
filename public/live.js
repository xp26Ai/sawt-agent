/* المكالمة الحيّة — التقاط الميكروفون، بث للخادم، تشغيل رد الوكيل. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* الصوت داخل وخارج بترددين مختلفين — هذا شرط الـAPI. */
const MIC_RATE = 16000; // إدخال Gemini
const OUT_RATE = 24000; // إخراج Gemini

let MODE = 'secretary';
let CFG = null;

const S = {
  ws: null,
  micCtx: null,
  outCtx: null,
  stream: null,
  node: null,
  playHead: 0,
  sources: [],
  live: false,
  timer: null,
  startedAt: 0,
  lastAgent: null,
  lastUser: null,
};

function toast(m) {
  const t = $('toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ─────────────────── عرض المحادثة ─────────────────── */

function bubble(who, text) {
  const chat = $('chat');
  chat.querySelector('.empty')?.remove();

  // النص يجي على دفعات — نضيف للفقاعة الأخيرة بدل ما نصنع وحدة جديدة
  const key = who === 'agent' ? 'lastAgent' : 'lastUser';
  const other = who === 'agent' ? 'lastUser' : 'lastAgent';
  if (S[key] && S[key].isConnected) {
    S[key].querySelector('.body').textContent += text;
  } else {
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.innerHTML = `<span class="who">${who === 'agent' ? 'الوكيل' : 'أنت'}</span><span class="body"></span>`;
    el.querySelector('.body').textContent = text;
    chat.appendChild(el);
    S[key] = el;
    S[other] = null;
  }
  chat.scrollTop = chat.scrollHeight;
}

function event(text, kind = '') {
  const chat = $('chat');
  chat.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `event ${kind}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  S.lastAgent = S.lastUser = null;
}

function setState(label, cls, sub) {
  $('statePill').textContent = label;
  $('statePill').className = `pill ${cls}`;
  if (sub) $('orbSub').textContent = sub;
}

function orb(mode) {
  $('orb').className = `orb ${mode}`;
  $('orbLabel').textContent =
    mode === 'speaking' ? 'الوكيل يتكلم' : mode === 'listening' ? 'يسمعك' : 'جاهز';
}

/* ─────────────────── تشغيل صوت الوكيل ─────────────────── */

function playChunk(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);

  const buf = S.outCtx.createBuffer(1, pcm.length, OUT_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

  const src = S.outCtx.createBufferSource();
  src.buffer = buf;
  src.connect(S.outCtx.destination);

  // نرصّ المقاطع في الطابور عشان الصوت يطلع متصل بدون فجوات
  const now = S.outCtx.currentTime;
  if (S.playHead < now) S.playHead = now + 0.04;
  src.start(S.playHead);
  S.playHead += buf.duration;

  S.sources.push(src);
  src.onended = () => {
    S.sources = S.sources.filter((x) => x !== src);
    if (!S.sources.length && S.live) orb('listening');
  };
  orb('speaking');
}

/** المقاطعة: العميل بدأ يتكلم فوق الوكيل — نوقف الصوت فوراً. */
function stopPlayback() {
  for (const s of S.sources) {
    try { s.stop(); } catch {}
  }
  S.sources = [];
  S.playHead = 0;
  if (S.live) orb('listening');
}

/* ─────────────────── التقاط الميكروفون ─────────────────── */

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const out = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

async function startMic() {
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // إلغاء الصدى ضروري — السماعة تشغّل صوت الوكيل والميك يسمعه
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  // المتصفح يعيد التردد إلى 16k بنفسه — أدق من إعادة العيّنة يدوياً
  S.micCtx = new AudioContext({ sampleRate: MIC_RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await S.micCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const src = S.micCtx.createMediaStreamSource(S.stream);
  S.node = new AudioWorkletNode(S.micCtx, 'cap');
  S.node.port.onmessage = (e) => {
    if (S.ws?.readyState !== 1) return;
    const bytes = new Uint8Array(e.data);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    S.ws.send(JSON.stringify({ type: 'audio', data: btoa(bin) }));
  };
  src.connect(S.node);
  // مخرج صامت — بعض المتصفحات توقف الـworklet بدون وجهة
  const mute = S.micCtx.createGain();
  mute.gain.value = 0;
  S.node.connect(mute).connect(S.micCtx.destination);
}

function stopMic() {
  try { S.node?.disconnect(); } catch {}
  try { S.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { S.micCtx?.close(); } catch {}
  S.node = S.stream = S.micCtx = null;
}

/* ─────────────────── دورة المكالمة ─────────────────── */

async function startCall() {
  $('err').classList.add('hidden');
  $('callBtn').disabled = true;
  $('callBtn').innerHTML = '<span class="spin">◐</span> جاري الاتصال…';

  try {
    S.outCtx = new AudioContext({ sampleRate: OUT_RATE });
    await S.outCtx.resume();
    await startMic();
  } catch (e) {
    $('err').textContent = `تعذّر فتح الميكروفون: ${e.message}`;
    $('err').classList.remove('hidden');
    $('callBtn').disabled = false;
    $('callBtn').textContent = 'ابدأ المكالمة';
    stopMic();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws/live`);

  S.ws.onopen = () => {
    S.ws.send(JSON.stringify({
      type: 'start',
      config: buildConfig(),
    }));
  };

  S.ws.onmessage = (ev) => handle(JSON.parse(ev.data));

  S.ws.onclose = () => {
    if (S.live) event('انقطع الاتصال', 'warn');
    endCall(false);
  };
  S.ws.onerror = () => {
    $('err').textContent = 'فشل الاتصال بالخادم';
    $('err').classList.remove('hidden');
  };
}

function buildConfig() {
  const base = { mode: MODE, voice: $('voice').value, model: $('model').value };
  if (MODE === 'secretary') {
    return {
      ...base,
      ownerName: $('ownerName').value,
      secretaryName: $('secretaryName').value,
      status: $('status').value,
      dialect: $('dialect2').value,
      freeAfter: $('freeAfter').value,
      notes: $('notes').value,
    };
  }
  return {
    ...base,
    agentName: $('agentName').value,
    company: $('company').value,
    dialect: $('dialect').value,
    knowledge: $('knowledge').value,
  };
}

function handle(m) {
  switch (m.type) {
    case 'ready':
      S.live = true;
      S.startedAt = Date.now();
      $('chat').innerHTML = '';
      $('summary').innerHTML = '<div class="empty">يظهر لما الوكيل يفهم طلبك</div>';
      event('بدأت المكالمة', 'call');
      setState('مكالمة جارية', 'live', 'تكلّم عادي — تقدر تقاطعه في أي وقت');
      orb('listening');
      $('callBtn').classList.add('hidden');
      $('hangBtn').classList.remove('hidden');
      $('typed').disabled = $('sendTyped').disabled = false;
      S.timer = setInterval(tick, 500);
      break;

    case 'audio': playChunk(m.data); break;
    case 'said': bubble('agent', m.text); break;
    case 'heard': bubble('user', m.text); break;

    case 'interrupted':
      stopPlayback();
      event('قاطعته', 'warn');
      break;

    case 'turnComplete':
      S.lastAgent = S.lastUser = null;
      break;

    case 'tool':
      event(`استدعى أداة: ${m.name}(${Object.values(m.args || {}).join('، ')})`, 'call');
      break;

    case 'toolResult':
      if (m.response?.found === false) event('الأداة: ما فيه طلب بهذا الرقم', 'warn');
      else if (m.response?.status) event(`الأداة أرجعت: ${m.response.status}`, 'call');
      break;

    case 'need':
      addSummary('الطلب', m.intent);
      addSummary('التفاصيل', m.details);
      toast('الوكيل فهم طلبك');
      break;

    case 'caller':
      $('summary').innerHTML = '';
      addSummary('المتصل', m.name);
      addSummary('الصفة', m.relation);
      addSummary('الموضوع', m.reason);
      addSummary('التصنيف', m.category);
      addSummary('رقم الرد', m.callbackNumber);
      addSummary('أفضل وقت', m.bestTime);
      event(`سجّل: ${m.name} — ${m.category}`, 'call');
      break;

    case 'urgent':
      addSummary('مستعجل', m.why, true);
      event('علّمها مستعجلة وأرسل تنبيه فوري', 'warn');
      toast('تنبيه فوري أُرسل لك');
      break;

    case 'wrapUp':
      addSummary('الخلاصة', m.summary);
      addSummary('يبي رد؟', m.wantsCallback === false ? 'لا' : 'نعم');
      event('ينهي المكالمة…', 'call');
      break;

    case 'escalate':
      addSummary('تحويل لبشري', m.reason, true);
      if (m.summary) addSummary('ملخّص للموظف', m.summary, true);
      event('طلب تحويل لموظف بشري', 'warn');
      break;

    case 'ended':
      event(m.notified ? 'انتهت — أُرسل الملخّص لتيليجرام' : 'انتهت المكالمة', 'call');
      if (m.summary && !m.notified) {
        event('ما أُرسل تيليجرام — عبّي TELEGRAM_BOT_TOKEN و OWNER_CHAT_ID في .env', 'warn');
      }
      endCall(false);
      break;

    case 'error':
      $('err').textContent = m.message;
      $('err').classList.remove('hidden');
      break;
  }
}

function addSummary(label, value, alert = false) {
  if (!value) return;
  const box = $('summary');
  box.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `sumrow ${alert ? 'alert' : ''}`;
  el.innerHTML = `<b>${esc(label)}</b><span>${esc(value)}</span>`;
  box.appendChild(el);
}

function tick() {
  const s = Math.floor((Date.now() - S.startedAt) / 1000);
  $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function endCall(tellServer = true) {
  if (tellServer && S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type: 'stop' }));
  S.live = false;
  clearInterval(S.timer);
  stopPlayback();
  stopMic();
  try { S.outCtx?.close(); } catch {}
  S.outCtx = null;
  try { S.ws?.close(); } catch {}
  S.ws = null;

  orb('');
  setState('غير متصل', '', 'اضغط "ابدأ المكالمة" وتكلّم بصوتك');
  $('callBtn').classList.remove('hidden');
  $('callBtn').disabled = false;
  $('callBtn').textContent = 'ابدأ المكالمة';
  $('hangBtn').classList.add('hidden');
  $('typed').disabled = $('sendTyped').disabled = true;
  loadCalls();
}

$('callBtn').onclick = startCall;
$('hangBtn').onclick = () => endCall(true);

$('sendTyped').onclick = () => {
  const t = $('typed').value.trim();
  if (!t || S.ws?.readyState !== 1) return;
  bubble('user', t);
  S.lastUser = null;
  S.ws.send(JSON.stringify({ type: 'text', text: t }));
  $('typed').value = '';
};
$('typed').onkeydown = (e) => { if (e.key === 'Enter') $('sendTyped').click(); };

/* ─────────────────── تحميل الإعدادات ─────────────────── */

async function loadConfig() {
  const r = await fetch('/api/live/config').then((x) => x.json());

  const picks = r.voices.filter((v) => v.pick);
  const rest = r.voices.filter((v) => !v.pick);
  const opt = (v) => `<option value="${v.name}"${v.name === 'Charon' ? ' selected' : ''}>${v.name} — ${v.desc} (${v.gender})</option>`;
  $('voice').innerHTML =
    `<optgroup label="مرشّحة">${picks.map(opt).join('')}</optgroup>` +
    `<optgroup label="أخرى">${rest.map(opt).join('')}</optgroup>`;

  $('model').innerHTML = Object.entries(r.models)
    .map(([k, d]) => `<option value="${k}">${k.replace('gemini-', '').replace('-preview', '')} — ${d}</option>`)
    .join('');

  CFG = r;
  renderTools();

  $('orders').innerHTML = r.orders
    .map((o) => `<div class="order"><b>${esc(o.order_number)}</b><span>${esc(o.status)}</span><span>${esc(o.expected_date)} · ${o.amount} ريال</span></div>`)
    .join('');

  if (!r.ownerNotify) {
    $('orbSub').textContent = 'تنبيه: تيليجرام غير مربوط — الملخّص يظهر هنا فقط';
  }
}

function renderTools() {
  if (!CFG) return;
  $('tools').innerHTML = (CFG.tools[MODE] || [])
    .map((t) => `<div class="tool"><code>${esc(t.name)}</code><p>${esc(t.description)}</p></div>`)
    .join('');
  $('ordersBox').classList.toggle('hidden', MODE !== 'support');
}

/* تبديل الوضع */
document.querySelectorAll('.mode').forEach((b) => {
  b.onclick = () => {
    if (S.live) return toast('أنهِ المكالمة أولاً');
    MODE = b.dataset.mode;
    document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b));
    $('secretaryFields').classList.toggle('hidden', MODE !== 'secretary');
    $('supportFields').classList.toggle('hidden', MODE !== 'support');
    renderTools();
    loadCalls();
  };
});

async function loadCalls() {
  const r = await fetch(`/api/calls?mode=${MODE}`).then((x) => x.json());

  $('inboxStats').textContent =
    MODE === 'secretary' && r.inbox
      ? `${r.inbox.total} مكالمة · ${r.inbox.unhandled} تحتاج رد${r.inbox.urgent ? ` · ${r.inbox.urgent} مستعجلة` : ''}`
      : '';

  if (!r.calls.length) {
    $('calls').innerHTML = '<div class="empty">ما فيه مكالمات بعد</div>';
    return;
  }

  $('calls').innerHTML = r.calls
    .map((c) =>
      MODE === 'secretary' ? secretaryRow(c) : supportRow(c)
    )
    .join('');

  $('calls').querySelectorAll('[data-done]').forEach((b) => {
    b.onclick = async () => {
      await fetch(`/api/calls/${b.dataset.done}/handled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handled: b.dataset.state !== '1' }),
      });
      loadCalls();
    };
  });
  $('calls').querySelectorAll('[data-notify]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const res = await fetch(`/api/calls/${b.dataset.notify}/notify`, { method: 'POST' })
        .then((x) => x.json());
      toast(res.ok ? 'أُرسل لتيليجرام' : res.error);
      b.disabled = false;
      loadCalls();
    };
  });
}

function secretaryRow(c) {
  const urgent = c.urgency === 'high';
  const done = c.handled === 1;
  return `<div class="hitem ${urgent && !done ? 'urgent' : ''} ${done ? 'done' : ''}">
    <div class="hrow">
      <b>${esc(c.caller_name || 'غير معروف')}</b>
      ${urgent ? '<span class="tag hot">مستعجل</span>' : ''}
      ${c.category ? `<span class="tag">${esc(c.category)}</span>` : ''}
      ${c.wants_callback ? '<span class="tag">يبي رد</span>' : ''}
    </div>
    <p title="${esc(c.summary || '')}">${esc(c.summary || 'بدون ملخّص')}</p>
    <div class="meta">
      ${c.callback_number ? `<span class="num">${esc(c.callback_number)}</span>` : ''}
      ${c.best_time ? `<span>${esc(c.best_time)}</span>` : ''}
      <span>${c.duration ? Math.round(c.duration) + ' ث' : '—'}</span>
      <span>${esc(c.started_at)}</span>
      ${c.notified ? '<span style="color:var(--ok)">أُرسل</span>' : ''}
    </div>
    <div class="hactions">
      <button class="ghost sm" data-done="${c.id}" data-state="${done ? 1 : 0}">${done ? 'رجّعها' : 'تم الرد'}</button>
      <button class="ghost sm" data-notify="${c.id}">أرسل لتيليجرام</button>
    </div>
  </div>`;
}

function supportRow(c) {
  return `<div class="hitem">
    <p>${esc(c.intent || 'بدون تصنيف')}${c.details ? ' — ' + esc(c.details.slice(0, 60)) : ''}</p>
    <div class="meta">
      <span>${esc(c.agent_name || '')}</span>
      <span>${c.duration ? Math.round(c.duration) + ' ث' : '—'}</span>
      ${c.escalated ? '<span style="color:var(--warn)">حُوّلت لبشري</span>' : ''}
      <span>${esc(c.started_at)}</span>
    </div>
  </div>`;
}

loadConfig().then(loadCalls);
