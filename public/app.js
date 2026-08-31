/* واجهة "صوت" — كلها بدون مكتبات خارجية. */

const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: 'رد غير صالح' }));
  if (!json.ok) throw Object.assign(new Error(json.error || 'خطأ'), { payload: json, status: res.status });
  return json;
};

const state = { previewId: null, contacts: [], selected: new Set() };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ───────────────────────── الجاهزية ───────────────────────── */

async function loadHealth() {
  try {
    const { checks, bot, quiet, stats } = await api('/health');
    $('health').innerHTML = [
      chip('Gemini', checks.gemini),
      chip('ffmpeg', checks.ffmpeg),
      chip(bot && checks.telegram ? bot : 'تيليجرام', checks.telegram),
      `<span class="chip"><b>${stats.sends}</b> رسالة مُرسلة</span>`,
      `<span class="chip"><b>${stats.costSar.toFixed(2)}</b> ريال إجمالاً</span>`,
    ].join('');

    const b = $('quietBanner');
    if (quiet.blocked) {
      b.textContent = `تنبيه نظامي — ${quiet.message} الإرسال ممكن، لكن راح يطلب لك تأكيد.`;
      b.classList.remove('hidden');
    } else b.classList.add('hidden');
  } catch (e) {
    $('health').innerHTML = `<span class="chip"><span class="dot off"></span>الخادم لا يستجيب</span>`;
  }
}

const chip = (label, on) =>
  `<span class="chip"><span class="dot ${on ? 'on' : 'off'}"></span>${esc(label)}</span>`;

/* ───────────────────── الأصوات والقوائم ───────────────────── */

async function loadVoices() {
  const { voices, tones, paces } = await api('/voices');
  const picks = voices.filter((v) => v.pick);
  const rest = voices.filter((v) => !v.pick);
  const opt = (v) => `<option value="${v.name}">${v.name} — ${v.desc} (${v.gender})</option>`;
  $('voice').innerHTML =
    `<optgroup label="مرشّحة لخدمة العملاء">${picks.map(opt).join('')}</optgroup>` +
    `<optgroup label="أصوات أخرى">${rest.map(opt).join('')}</optgroup>`;

  const LBL = { professional: 'مهنية', warm: 'دافئة', calm: 'هادئة', urgent: 'جادة', cheerful: 'مبتهجة' };
  $('tone').innerHTML = Object.keys(tones)
    .map((k) => `<option value="${k}">${LBL[k] || k}</option>`)
    .join('');

  const PL = { slow: 'بطيئة (للأرقام وكبار السن)', normal: 'معتدلة', fast: 'سريعة' };
  $('pace').innerHTML = Object.keys(paces)
    .map((k) => `<option value="${k}"${k === 'normal' ? ' selected' : ''}>${PL[k] || k}</option>`)
    .join('');
}

async function loadTemplates() {
  const { templates } = await api('/templates');
  $('templateSel').innerHTML =
    '<option value="">— قالب جاهز —</option>' +
    templates.map((t) => `<option value="${esc(t.body)}">${esc(t.title)}</option>`).join('');
}

/* ───────────────────── جهات الاتصال ───────────────────── */

async function loadContacts() {
  const { contacts } = await api('/contacts');
  state.contacts = contacts;
  renderContacts();
}

function renderContacts() {
  const box = $('contacts');
  if (!state.contacts.length) {
    box.innerHTML = `<div class="empty">ما فيه مستقبِلين.<br>خلّ العميل يرسل /start للبوت ثم اضغط "اكتشاف".</div>`;
    return;
  }
  box.innerHTML = state.contacts
    .map(
      (c) => `
    <div class="contact ${state.selected.has(c.id) ? 'on' : ''}" data-id="${c.id}">
      <input type="checkbox" ${state.selected.has(c.id) ? 'checked' : ''}>
      <span class="nm">${esc(c.name)}</span>
      <span class="ad">${c.channel === 'whatsapp' ? 'WA' : 'TG'} ${esc(c.address)}</span>
      <button class="rm" data-del="${c.id}" title="حذف">×</button>
    </div>`
    )
    .join('');

  box.querySelectorAll('.contact').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.dataset.del) return;
      const id = Number(el.dataset.id);
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderContacts();
      updateSendState();
    };
  });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      await api(`/contacts/${b.dataset.del}`, { method: 'DELETE' });
      state.selected.delete(Number(b.dataset.del));
      loadContacts();
      updateSendState();
    };
  });
}

/* ───────────────────── التوليد والمعاينة ───────────────────── */

function opts() {
  return {
    text: $('text').value,
    voice: $('voice').value,
    tone: $('tone').value,
    pace: $('pace').value,
    dialect: $('dialect').value,
    numbers: $('numbers').value,
    tashkeel: $('tashkeel').checked,
  };
}

$('previewBtn').onclick = async () => {
  const btn = $('previewBtn');
  const err = $('previewErr');
  if (!$('text').value.trim()) return toast('اكتب الرسالة أولاً');

  btn.disabled = true;
  btn.innerHTML = '<span class="spin">◐</span> جاري التوليد…';
  err.classList.add('hidden');

  try {
    const r = await api('/preview', { method: 'POST', body: opts() });
    state.previewId = r.id;

    $('player').src = r.url;
    $('resultCard').classList.remove('hidden');

    $('metrics').innerHTML = [
      ['المدة', `${r.duration.toFixed(1)} ث`],
      ['زمن التوليد', `${(r.latencyMs / 1000).toFixed(1)} ث`],
      ['التكلفة', `${r.cost.sar.toFixed(3)} ريال`],
      ['الصوت', r.voice],
    ]
      .map(([k, v]) => `<div class="metric"><b>${esc(v)}</b><span>${k}</span></div>`)
      .join('');

    $('stages').innerHTML = r.stages
      .map((s, i) => {
        const cls = s.id === 'directive' ? 'stage directive' : s.id === 'tashkeel' ? 'stage final' : 'stage';
        return `<div class="${cls}"><h4>${i + 1}. ${esc(s.label)}</h4><p>${esc(s.text)}</p></div>`;
      })
      .join('');

    updateSendState();
    $('player').play().catch(() => {});
    toast('جاهز — استمع قبل الإرسال');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'توليد الصوت ومعاينته';
  }
};

$('auditionBtn').onclick = async (ev) => {
  const b = ev.target;
  b.disabled = true;
  const old = b.textContent;
  b.innerHTML = '<span class="spin">◐</span>';
  try {
    const r = await api('/audition', {
      method: 'POST',
      body: { voice: $('voice').value, tone: $('tone').value, pace: $('pace').value },
    });
    new Audio(r.url).play();
    toast(`عيّنة ${r.voice} — فيها الضاد والظاء والثاء والذال`);
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = false;
    b.textContent = old;
  }
};

/* ───────────────────────── الإرسال ───────────────────────── */

function updateSendState() {
  const ready = Boolean(state.previewId) && state.selected.size > 0;
  $('sendBtn').disabled = !ready;
  $('sendHint').textContent = !state.previewId
    ? 'ولّد معاينة أولاً'
    : state.selected.size === 0
    ? 'اختر مستقبِلاً واحداً على الأقل'
    : `جاهز للإرسال إلى ${state.selected.size} مستقبِل`;
}

$('sendBtn').onclick = async () => {
  const btn = $('sendBtn');
  const targets = state.contacts
    .filter((c) => state.selected.has(c.id))
    .map((c) => ({ id: c.id, channel: c.channel, address: c.address, name: c.name }));

  btn.disabled = true;
  btn.innerHTML = '<span class="spin">◐</span> جاري الإرسال…';

  const doSend = async (overrideQuiet) =>
    api('/send', {
      method: 'POST',
      body: { id: state.previewId, targets, caption: $('caption').value, overrideQuiet },
    });

  try {
    let r;
    try {
      r = await doSend(false);
    } catch (e) {
      if (e.status === 409 && confirm(`${e.message}\n\nهذي رسالة خدمية (مو ترويجية)؟ اضغط موافق للإرسال.`)) {
        r = await doSend(true);
      } else throw e;
    }

    $('sendResult').innerHTML = r.results
      .map(
        (x) =>
          `<div class="res-line ${x.status === 'sent' ? 'ok' : 'bad'}">${
            x.status === 'sent' ? '✓' : '✕'
          } ${esc(x.name || x.address)}${x.error ? ' — ' + esc(x.error) : ''}</div>`
      )
      .join('');
    toast(`تم الإرسال إلى ${r.sent} من ${r.results.length}`);
    loadHistory();
    loadHealth();
  } catch (e) {
    $('sendResult').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  } finally {
    btn.textContent = 'أرسل الرسالة الصوتية';
    updateSendState();
  }
};

$('discoverBtn').onclick = async (ev) => {
  const b = ev.target;
  b.disabled = true;
  try {
    const { found } = await api('/contacts/discover');
    if (!found.length) return toast('ما فيه أحد راسل البوت بعد');
    let added = 0;
    for (const f of found) {
      if (state.contacts.some((c) => c.address === f.id)) continue;
      await api('/contacts', { method: 'POST', body: { name: f.name, channel: 'telegram', address: f.id } });
      added++;
    }
    await loadContacts();
    toast(added ? `أُضيف ${added} مستقبِل` : 'كلهم مضافين مسبقاً');
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = false;
  }
};

$('addContact').onclick = async () => {
  const name = $('cName').value.trim();
  const address = $('cAddr').value.trim();
  if (!name || !address) return toast('عبّي الاسم والعنوان');
  try {
    await api('/contacts', { method: 'POST', body: { name, address, channel: $('cChan').value } });
    $('cName').value = $('cAddr').value = '';
    loadContacts();
  } catch (e) {
    toast(e.message);
  }
};

/* ───────────────────────── السجل ───────────────────────── */

async function loadHistory() {
  const { history } = await api('/history');
  $('history').innerHTML = history.length
    ? history
        .map(
          (h) => `<div class="hitem">
            <p>${esc(h.raw_text.slice(0, 70))}${h.raw_text.length > 70 ? '…' : ''}</p>
            <div class="meta">
              <span>${esc(h.voice)}</span>
              <span>${h.duration?.toFixed(1) || '?'} ث</span>
              <span>✓ ${h.ok}${h.bad ? ` · ✕ ${h.bad}` : ''}</span>
              <span>${esc(h.created_at)}</span>
            </div></div>`
        )
        .join('')
    : '<div class="empty">ما فيه رسائل بعد</div>';
}

/* ───────────────────────── ربط عام ───────────────────────── */

$('templateSel').onchange = (e) => {
  if (e.target.value) {
    $('text').value = e.target.value;
    $('text').dispatchEvent(new Event('input'));
    e.target.value = '';
  }
};

$('text').addEventListener('input', (e) => {
  $('charCount').textContent = `${e.target.value.length} حرف`;
  state.previewId = null;
  updateSendState();
});

$('clearBtn').onclick = () => {
  $('text').value = '';
  $('text').dispatchEvent(new Event('input'));
};

for (const id of ['voice', 'tone', 'pace', 'dialect', 'numbers', 'tashkeel']) {
  $(id).addEventListener('change', () => {
    state.previewId = null;
    updateSendState();
  });
}

(async function init() {
  await Promise.all([loadHealth(), loadVoices(), loadTemplates(), loadContacts(), loadHistory()]);
  updateSendState();
  setInterval(loadHealth, 60000);
})();
