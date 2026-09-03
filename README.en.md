# sawt-agent

[العربية](README.md)

**Arabic text goes in. A voice message with correct pronunciation comes out. Or a phone call that an agent answers.**

An Arabic voice platform built on Gemini. It has a five-stage pronunciation pipeline and a live call agent over WebSocket. It delivers through three channels: Telegram, WhatsApp Cloud API, and phone via Twilio.

**Measured cost: SAR 0.06 for a 24-second voice message.** No phone number, no call charges.
4,236 lines of JavaScript, and only three dependencies: `express`, `ws`, and `dotenv`.

---

## The problem

People write Arabic without diacritics. One spelling can carry more than one pronunciation.
So the speech engine reads the word wrong, and the listener does not understand it.

Numbers are worse. `8472` is an order number. But the engine says "eight thousand four hundred
seventy-two". The customer cannot write it down after hearing it.

So I need to see the exact spoken text **before** I pay to generate it.

---

## How it works

Text passes through five stages, and every stage returns its output to the UI:

| Stage | What it does |
|---|---|
| 1. Cleanup | Strips emoji, tatweel, and extra whitespace |
| 2. Symbol expansion | `ر.س` becomes `ريال` · `15%` becomes `خمسة عشر بالمئة` |
| 3. Numbers | Separates reference numbers from quantity numbers |
| 4. Diacritization | Adds the marks with a text model, behind a validation guard |
| 5. Delivery hints | Asks the model to keep ض apart from ظ, and ص apart from س |

**Reference vs quantity:** the pipeline reads some numbers digit by digit. These are numbers after
"order", "invoice", or "policy". It does the same for any number of five digits or more. The number
must have no thousands separator. The pipeline spells out everything else in full.

### The brain is independent of the channel

`lib/live.js` does not know where the audio came from. Three channels call the same session.
Only `lib/telephony.js` converts the encoding:

| Channel | Audio encoding | State |
|---|---|---|
| Browser | PCM 16 kHz | Working |
| Phone via Twilio | μ-law 8 kHz, 160-byte frames | Working, and testable without a Twilio account |
| WhatsApp Business Calling | Opus | Written in the code, not wired up |

The agent sends its first audio after 1.3 seconds. I measured this with `scripts/test-live.js`. The agent calls its own tools. It reads order status and logs what the customer needs. It can also hand off to a human.

---

## The key design decision

Diacritization is the strongest factor in correct pronunciation. No accurate Arabic diacritizer
exists outside a language model. But the model sometimes cheats. It rewrites the sentence instead of only marking it.

A customer message with changed wording is worse than one with no diacritics at all.

**The decision: a validation guard that rejects the model's output.** After diacritization we strip
the marks back off. Then we compare the result to the original text, character by character. If the match
falls below 90%, we throw the output away. We fall back to the original text and show the reason in
the UI.

The cost: one extra text call, and sometimes weaker pronunciation.
The return: the spoken text is always the written text. No exceptions.

---

## Running it

```bash
npm install                  # three dependencies
cp .env.example .env         # add the Gemini key and the Telegram bot token
node server.js               # UI on http://localhost:4630
```

It needs Node.js 22.5 or newer (for the built-in `node:sqlite`). It also needs `ffmpeg` on `PATH`.

`scripts/` holds eight check scripts: seven tests and a quota probe.
The fastest one checks the whole text pipeline with no network and no cost:

```
$ node scripts/test-text.js

الأصل   : عزيزي العميل، تم استلام طلبك رقم 8472 بنجاح. سيصلك خلال 3 أيام عمل.
المُجهَّز : عزيزي العميل، تم استلام طلبك رقم ثمانية، أربعة، سبعة، اثنان بنجاح. سيصلك خلال ثلاثة أيام عمل.

الأصل   : نذكّرك بموعدك يوم 30/8/2026 الساعة 14:30. المبلغ المستحق 1450 ر.س.
المُجهَّز : نذكّرك بموعدك يوم الثلاثين من أغسطس ألفين وستة وعشرين الساعة الثانية والنصف مساءً. المبلغ المستحق ألف وأربعمئة وخمسون ريال.

الأصل   : رقم البوليصة 90714523. الخصم 15%.
المُجهَّز : رقم البوليصة تسعة، صفر، سبعة، واحد، أربعة، خمسة، اثنان، ثلاثة. الخصم خمسة عشر بالمئة.

الأصل   : كم يوماً تحتاج؟ المسافة 12 كم والوزن 3 كجم والسعر 250 ر.س فقط.
المُجهَّز : كم يوماً تحتاج؟ المسافة اثنا عشر كيلومتر والوزن ثلاثة كيلوغرام والسعر مئتان وخمسون ريال فقط.

الأصل   : الموعد 2026-01-05 الساعة 09:15 ص. الرصيد 2500.75 ريال.
المُجهَّز : الموعد الخامس من يناير ألفين وستة وعشرين الساعة التاسعة والربع صباحاً. الرصيد ألفان وخمسمئة فاصلة خمسة وسبعون ريال.

الأصل   : العرض ينتهي بعد 5 أيام. اتصل على 966500000000+ أو زر الفرع.
المُجهَّز : العرض ينتهي بعد خمسة أيام. اتصل على زائد، تسعة، ستة، ستة، خمسة، صفر، صفر، صفر، صفر، صفر، صفر، صفر، صفر أو زر الفرع.

— فحوص مفردة —
  ✓ "كم الساعة الآن؟" → "كم الساعة الآن؟"
  ✓ "من فضلك أرسل الملف" → "من فضلك أرسل الملف"
  ✓ "المصر ومصر" → "المصر ومصر"
  ✓ الجر: 2026 → ألفين وستة وعشرين

كل الفحوص نجحت
```

The `كم` and `من` checks are deliberate. The question word `كم` must not become "kilometre".
And `من` must not become "p.m.". Expansion only fires after a number.

---

## Why I built it

I work as an IT supervisor. We send written messages, and people do not read them.

So I built a pipeline. It makes an Arabic voice message dependable, at SAR 0.06 per message.
