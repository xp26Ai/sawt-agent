/**
 * أصوات Gemini TTS الثلاثون.
 * الوصف من توثيق قوقل. كلها تدعم العربية.
 *
 * `pick: true` = مرشّحة لخدمة العملاء بالعربية (صوت متزن وواضح).
 * جرّبها بنفسك من زر "استمع" في الواجهة — الأذن هي الحَكَم.
 */
export const VOICES = [
  { name: 'Kore',           desc: 'حازم ومتزن',        gender: 'أنثى',  pick: true },
  { name: 'Charon',         desc: 'إخباري واضح',       gender: 'ذكر',   pick: true },
  { name: 'Iapetus',        desc: 'نقي وواضح',         gender: 'ذكر',   pick: true },
  { name: 'Erinome',        desc: 'نقية وواضحة',       gender: 'أنثى',  pick: true },
  { name: 'Sulafat',        desc: 'دافئ',              gender: 'أنثى',  pick: true },
  { name: 'Achird',         desc: 'ودود',              gender: 'ذكر',   pick: true },
  { name: 'Schedar',        desc: 'متّزن ورصين',       gender: 'ذكر',   pick: true },
  { name: 'Vindemiatrix',   desc: 'لطيف وهادئ',        gender: 'أنثى',  pick: true },
  { name: 'Rasalgethi',     desc: 'إخباري',            gender: 'ذكر',   pick: true },
  { name: 'Alnilam',        desc: 'حازم',              gender: 'ذكر',   pick: true },
  { name: 'Zephyr',         desc: 'مشرق',              gender: 'أنثى' },
  { name: 'Puck',           desc: 'مرح ونشيط',         gender: 'ذكر' },
  { name: 'Fenrir',         desc: 'متحمّس',            gender: 'ذكر' },
  { name: 'Leda',           desc: 'شبابي',             gender: 'أنثى' },
  { name: 'Orus',           desc: 'حازم',              gender: 'ذكر' },
  { name: 'Aoede',          desc: 'خفيف ومنساب',       gender: 'أنثى' },
  { name: 'Callirrhoe',     desc: 'مرتاح وسلس',        gender: 'أنثى' },
  { name: 'Autonoe',        desc: 'مشرق',              gender: 'أنثى' },
  { name: 'Enceladus',      desc: 'هامس/نَفَسي',       gender: 'ذكر' },
  { name: 'Umbriel',        desc: 'مرتاح',             gender: 'ذكر' },
  { name: 'Algieba',        desc: 'ناعم',              gender: 'ذكر' },
  { name: 'Despina',        desc: 'ناعمة',             gender: 'أنثى' },
  { name: 'Algenib',        desc: 'خشن قليلاً',        gender: 'ذكر' },
  { name: 'Laomedeia',      desc: 'نشيط',              gender: 'أنثى' },
  { name: 'Achernar',       desc: 'رقيق',              gender: 'أنثى' },
  { name: 'Gacrux',         desc: 'ناضج',              gender: 'أنثى' },
  { name: 'Pulcherrima',    desc: 'مندفع',             gender: 'أنثى' },
  { name: 'Zubenelgenubi',  desc: 'عفوي',              gender: 'ذكر' },
  { name: 'Sadachbia',      desc: 'حيوي',              gender: 'ذكر' },
  { name: 'Sadaltager',     desc: 'عارف وواثق',        gender: 'ذكر' },
];

export const VOICE_NAMES = VOICES.map((v) => v.name);
