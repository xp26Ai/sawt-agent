/** قاعدة بيانات SQLite حقيقية — جهات الاتصال، القوالب، سجل الإرسال. */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'sawt.db'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  channel    TEXT    NOT NULL DEFAULT 'telegram',   -- telegram | whatsapp
  address    TEXT    NOT NULL,                      -- chat_id أو رقم جوال
  tag        TEXT,
  opted_out  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, address)
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  tone       TEXT    NOT NULL DEFAULT 'professional',
  pace       TEXT    NOT NULL DEFAULT 'normal',
  voice      TEXT    NOT NULL DEFAULT 'Kore',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text    TEXT    NOT NULL,
  spoken_text TEXT    NOT NULL,
  voice       TEXT    NOT NULL,
  tone        TEXT,
  pace        TEXT,
  duration    REAL,
  audio_file  TEXT,
  cost_sar    REAL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES messages(id),
  contact_id  INTEGER REFERENCES contacts(id),
  channel     TEXT    NOT NULL,
  address     TEXT    NOT NULL,
  status      TEXT    NOT NULL,                     -- sent | failed
  error       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sends_msg ON sends(message_id);

-- ─── المكالمات الحيّة ───

CREATE TABLE IF NOT EXISTS calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mode        TEXT    NOT NULL DEFAULT 'support',  -- support | secretary
  channel     TEXT    NOT NULL DEFAULT 'browser',  -- browser | phone | whatsapp
  caller      TEXT,
  agent_name  TEXT,
  voice       TEXT,
  model       TEXT,
  intent      TEXT,
  details     TEXT,
  escalated   INTEGER NOT NULL DEFAULT 0,
  escalate_reason TEXT,
  -- حقول السكرتير
  caller_name TEXT,
  relation    TEXT,
  category    TEXT,
  urgency     TEXT,
  callback_number TEXT,
  best_time   TEXT,
  wants_callback  INTEGER,
  summary     TEXT,
  notified    INTEGER NOT NULL DEFAULT 0,
  handled     INTEGER NOT NULL DEFAULT 0,
  transcript  TEXT,
  duration    REAL,
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT
);

-- طلبات تجريبية عشان أداة getOrderStatus تشتغل فعلاً
CREATE TABLE IF NOT EXISTS demo_orders (
  order_number  TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  expected_date TEXT,
  amount        REAL,
  courier       TEXT
);
`);

/**
 * ترحيل بسيط: CREATE TABLE IF NOT EXISTS لا يضيف أعمدة لجدول موجود،
 * فنضيف الناقص يدوياً. آمن للتكرار.
 */
const haveCols = new Set(db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name));
const NEEDED = [
  ['mode', "TEXT NOT NULL DEFAULT 'support'"],
  ['caller_name', 'TEXT'],
  ['relation', 'TEXT'],
  ['category', 'TEXT'],
  ['urgency', 'TEXT'],
  ['callback_number', 'TEXT'],
  ['best_time', 'TEXT'],
  ['wants_callback', 'INTEGER'],
  ['summary', 'TEXT'],
  ['notified', 'INTEGER NOT NULL DEFAULT 0'],
  ['handled', 'INTEGER NOT NULL DEFAULT 0'],
];
for (const [name, type] of NEEDED) {
  if (!haveCols.has(name)) db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
}

const orderCount = db.prepare('SELECT COUNT(*) AS n FROM demo_orders').get().n;
if (orderCount === 0) {
  const ins = db.prepare(
    'INSERT INTO demo_orders (order_number, status, expected_date, amount, courier) VALUES (?, ?, ?, ?, ?)'
  );
  ins.run('8472', 'في الطريق إليك', 'بعد يومين', 450.0, 'سمسا');
  ins.run('1193', 'تم التسليم', 'أمس', 220.5, 'أرامكس');
  ins.run('5560', 'متأخر بسبب الطقس', 'بعد أربعة أيام', 1300.0, 'سمسا');
  ins.run('7021', 'قيد التجهيز في المستودع', 'بعد ثلاثة أيام', 89.0, 'ناقل');
}

/** قوالب خدمة عملاء جاهزة — تُزرع مرة واحدة. */
const SEED = [
  ['تأكيد استلام طلب', 'عزيزي العميل، تم استلام طلبك رقم {رقم_الطلب} بنجاح. سيصلك خلال {عدد} أيام عمل. شكراً لثقتك بنا.'],
  ['تأكيد موعد', 'مرحباً {الاسم}، نذكّرك بموعدك يوم {التاريخ} الساعة {الوقت}. نرجو الحضور قبل الموعد بعشر دقائق.'],
  ['الطلب في الطريق', 'بشرى سارة! طلبك رقم {رقم_الطلب} خرج من المستودع وهو في الطريق إليك الآن. المندوب سيتواصل معك قريباً.'],
  ['اعتذار وتأخير', 'نعتذر منك بصدق. طلبك رقم {رقم_الطلب} تأخر بسبب ظرف خارج عن إرادتنا. سنعوّضك بخصم قدره {عدد} ريال على طلبك القادم.'],
  ['تحصيل مستحقات', 'تحية طيبة، نودّ تذكيرك بأن لديك مبلغاً مستحقاً قدره {عدد} ريال. يمكنك السداد عبر التطبيق أو التواصل معنا.'],
  ['ترحيب بعميل جديد', 'أهلاً وسهلاً بك معنا! سعداء بانضمامك. فريق خدمة العملاء جاهز لمساعدتك في أي وقت.'],
  ['إغلاق تذكرة دعم', 'مرحباً، تم حل مشكلتك في التذكرة رقم {رقم_الطلب} وإغلاقها. إذا احتجت أي مساعدة أخرى فنحن في الخدمة.'],
];

const count = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
if (count === 0) {
  const ins = db.prepare('INSERT INTO templates (title, body) VALUES (?, ?)');
  for (const [t, b] of SEED) ins.run(t, b);
}

export const q = {
  contacts: () => db.prepare('SELECT * FROM contacts ORDER BY id DESC').all(),
  addContact: (name, channel, address, tag) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO contacts (name, channel, address, tag) VALUES (?, ?, ?, ?)'
      )
      .run(name, channel, address, tag || null),
  delContact: (id) => db.prepare('DELETE FROM contacts WHERE id = ?').run(id),

  templates: () => db.prepare('SELECT * FROM templates ORDER BY id').all(),
  addTemplate: (title, body) =>
    db.prepare('INSERT INTO templates (title, body) VALUES (?, ?)').run(title, body),
  delTemplate: (id) => db.prepare('DELETE FROM templates WHERE id = ?').run(id),

  addMessage: (m) =>
    db
      .prepare(
        `INSERT INTO messages (raw_text, spoken_text, voice, tone, pace, duration, audio_file, cost_sar)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.raw, m.spoken, m.voice, m.tone, m.pace, m.duration, m.file, m.costSar),

  addSend: (s) =>
    db
      .prepare(
        `INSERT INTO sends (message_id, contact_id, channel, address, status, error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(s.messageId, s.contactId || null, s.channel, s.address, s.status, s.error || null),

  history: (limit = 50) =>
    db
      .prepare(
        `SELECT m.*,
                (SELECT COUNT(*) FROM sends s WHERE s.message_id = m.id AND s.status = 'sent')   AS ok,
                (SELECT COUNT(*) FROM sends s WHERE s.message_id = m.id AND s.status = 'failed') AS bad
           FROM messages m ORDER BY m.id DESC LIMIT ?`
      )
      .all(limit),

  startCall: (c) =>
    db
      .prepare(
        'INSERT INTO calls (mode, channel, caller, agent_name, voice, model) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(c.mode || 'support', c.channel, c.caller || null, c.agentName, c.voice, c.model),

  endCall: (id, c) =>
    db
      .prepare(
        `UPDATE calls SET intent=?, details=?, escalated=?, escalate_reason=?,
                          transcript=?, duration=?, ended_at=datetime('now')
           WHERE id=?`
      )
      .run(c.intent || null, c.details || null, c.escalated ? 1 : 0, c.reason || null,
           c.transcript || '', c.duration || 0, id),

  /** يحفظ ملخّص مكالمة السكرتير. */
  saveSummary: (id, s, transcript, notified) =>
    db
      .prepare(
        `UPDATE calls SET caller_name=?, relation=?, category=?, urgency=?,
                          callback_number=?, best_time=?, wants_callback=?,
                          summary=?, notified=?, transcript=?, duration=?,
                          ended_at=datetime('now')
           WHERE id=?`
      )
      .run(s.name, s.relation, s.category, s.urgency, s.callbackNumber, s.bestTime,
           s.wantsCallback ? 1 : 0, s.reason, notified ? 1 : 0, transcript || '',
           s.durationSec || 0, id),

  markHandled: (id, v = 1) => db.prepare('UPDATE calls SET handled=? WHERE id=?').run(v, id),

  calls: (limit = 30, mode = null) =>
    mode
      ? db.prepare('SELECT * FROM calls WHERE mode=? ORDER BY id DESC LIMIT ?').all(mode, limit)
      : db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT ?').all(limit),

  inboxStats: () => ({
    total: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE mode='secretary'").get().n,
    unhandled: db
      .prepare("SELECT COUNT(*) AS n FROM calls WHERE mode='secretary' AND handled=0 AND wants_callback=1")
      .get().n,
    urgent: db
      .prepare("SELECT COUNT(*) AS n FROM calls WHERE mode='secretary' AND urgency='high' AND handled=0")
      .get().n,
  }),

  orders: () => db.prepare('SELECT * FROM demo_orders ORDER BY order_number').all(),

  stats: () => ({
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    sends: db.prepare("SELECT COUNT(*) AS n FROM sends WHERE status='sent'").get().n,
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE opted_out=0').get().n,
    seconds: db.prepare('SELECT COALESCE(SUM(duration),0) AS s FROM messages').get().s,
    costSar: db.prepare('SELECT COALESCE(SUM(cost_sar),0) AS c FROM messages').get().c,
  }),
};
