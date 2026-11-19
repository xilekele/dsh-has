/**
 * Script-based language detection, used to decide whether deterministic
 * Tool-Seek is safe. Self-contained; no external dependencies.
 */

const TAG_RE = /<[^<>[\]]+\[\d+\]\.[^<>[\].]+\.[^<>[\].]+>/g;

const HINT_PATTERNS = [
  /翻译(为|成)\s*([\w\u4e00-\u9fff]+)/,
  /请用\s*([\w\u4e00-\u9fff]+)\s*(回答|作答|输出)/,
  /(answer in|reply in|respond in)\s+([A-Za-z]+)/i,
  /translate .* to\s+([A-Za-z]+)/i,
];

const LANG_HINT_MAP = {
  中文: 'zh',
  汉语: 'zh',
  简体: 'zh',
  繁体: 'zh',
  Chinese: 'zh',
  Mandarin: 'zh',
  英文: 'en',
  英语: 'en',
  English: 'en',
  日文: 'ja',
  日语: 'ja',
  Japanese: 'ja',
  韩文: 'ko',
  韩语: 'ko',
  Korean: 'ko',
  法语: 'fr',
  French: 'fr',
  德语: 'de',
  German: 'de',
  俄语: 'ru',
  Russian: 'ru',
  西班牙语: 'es',
  Spanish: 'es',
  葡萄牙语: 'pt',
  Portuguese: 'pt',
};

export function stripTags(text) {
  return String(text ?? '').replace(TAG_RE, '');
}

function scriptCounts(text) {
  const counts = {
    latin: 0,
    han: 0,
    hiragana: 0,
    katakana: 0,
    hangul: 0,
    cyrillic: 0,
    arabic: 0,
    devanagari: 0,
  };
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) counts.latin += 1;
    else if (code >= 0x4e00 && code <= 0x9fff) counts.han += 1;
    else if (code >= 0x3040 && code <= 0x309f) counts.hiragana += 1;
    else if (code >= 0x30a0 && code <= 0x30ff) counts.katakana += 1;
    else if (code >= 0xac00 && code <= 0xd7af) counts.hangul += 1;
    else if (code >= 0x0400 && code <= 0x04ff) counts.cyrillic += 1;
    else if (code >= 0x0600 && code <= 0x06ff) counts.arabic += 1;
    else if (code >= 0x0900 && code <= 0x097f) counts.devanagari += 1;
  }
  return counts;
}

/** @returns {{lang: string|null, confidence: number}} */
export function detectScriptLang(text) {
  const cleaned = stripTags(text).trim();
  if (!cleaned) return { lang: null, confidence: 0 };

  const counts = scriptCounts(cleaned);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
  const ratio = (name) => counts[name] / total;
  const kana = ratio('hiragana') + ratio('katakana');

  if (kana > 0.15 && ratio('han') < 0.6) return { lang: 'ja', confidence: 0.8 };
  if (ratio('hangul') > 0.2) return { lang: 'ko', confidence: 0.8 };
  if (ratio('han') > 0.2 && kana < 0.1) return { lang: 'zh', confidence: 0.7 };
  if (ratio('cyrillic') > 0.2) return { lang: 'ru', confidence: 0.75 };
  if (ratio('arabic') > 0.2) return { lang: 'ar', confidence: 0.75 };
  if (ratio('devanagari') > 0.2) return { lang: 'hi', confidence: 0.75 };
  if (ratio('latin') > 0.4) return { lang: 'en', confidence: 0.6 };
  return { lang: null, confidence: 0 };
}

function extractTargetLangHint(text) {
  const source = String(text ?? '');
  for (const pattern of HINT_PATTERNS) {
    const match = source.match(pattern);
    if (!match) continue;
    const token = String(match[match.length - 1] ?? '').trim();
    const lang =
      LANG_HINT_MAP[token] ??
      LANG_HINT_MAP[token.charAt(0).toUpperCase() + token.slice(1)] ??
      LANG_HINT_MAP[token.toLowerCase()];
    if (lang) return lang;
  }
  return null;
}

/** Compare the dominant language of two texts. */
export function isSameLanguage(textA, textB) {
  const a = detectScriptLang(textA);
  const b = detectScriptLang(textB);

  if (a.lang === null || b.lang === null) return true;
  if (a.confidence < 0.5 || b.confidence < 0.5) return true;

  const targetHint = extractTargetLangHint(textA);
  if (targetHint && targetHint !== a.lang && b.lang === targetHint) return false;

  return a.lang === b.lang;
}
