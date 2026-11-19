/**
 * PDF anonymization: extract the text, run the HaS engine over it, and rebuild
 * a clean text PDF that embeds a CJK font.
 *
 * PDF has no editable paragraphs, so "formatting preserved" cannot mean the
 * same thing as in Word. What is kept is the page geometry (size, one text
 * column, original font size); images, tables and vector graphics from the
 * source are not carried over. The anonymized PDF therefore reads as a
 * re-typeset copy of the document text — use it for sharing, and restore from
 * the mapping to get the original text back.
 */

import { extractDocument } from './pdf-text.js';
import { buildPdf, layoutText } from './pdf-write.js';
import { CJK_FONT_CANDIDATES, findCjkFont } from './fonts.js';
import { runHide } from './hide.js';
import { runSeek } from './seek.js';

export const DEFAULT_PDF_FONT_SIZE = 15;
export const DEFAULT_PDF_MARGIN = 72;
export const DEFAULT_PAGE_WIDTH = 595.32;
export const DEFAULT_PAGE_HEIGHT = 841.92;

export function isPdfFile(file) {
  return /\.pdf$/i.test(file);
}

/** Plain text of a PDF, with lines joined by newlines. */
export function pdfPlainText(buffer) {
  return extractDocument(buffer).text;
}

let fontPromise = null;

/** Load (once) and cache the CJK font used for generated PDFs. */
async function pdfFont() {
  if (!fontPromise) {
    fontPromise = findCjkFont(CJK_FONT_CANDIDATES).then((found) => {
      if (!found) {
        throw new Error(
          'No embeddable CJK font was found. Install a TrueType CJK font (for example C:\\Windows\\Fonts\\simhei.ttf) or write the result as .txt instead.',
        );
      }
      return found.font;
    });
    fontPromise.catch(() => {
      fontPromise = null;
    });
  }
  return fontPromise;
}

/** Most common text size in the document, used as the rebuild font size. */
function dominantFontSize(document) {
  const counts = new Map();
  for (const page of document.pages) {
    for (const run of page.runs) {
      if (!run.text || !run.text.trim()) continue;
      const size = Math.round(run.size * 2) / 2;
      counts.set(size, (counts.get(size) ?? 0) + run.text.length);
    }
  }
  let best = DEFAULT_PDF_FONT_SIZE;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

function pageGeometry(document) {
  const first = document.pages[0] ?? {};
  const width = first.width && first.width > 50 ? first.width : DEFAULT_PAGE_WIDTH;
  const height = first.height && first.height > 50 ? first.height : DEFAULT_PAGE_HEIGHT;
  return { width, height };
}

/** Lay text out with the geometry of the source document. */
async function renderText(text, document) {
  const font = await pdfFont();
  const { width, height } = pageGeometry(document);
  const fontSize = dominantFontSize(document);
  const pages = layoutText(font, text, { width, height, fontSize, margin: DEFAULT_PDF_MARGIN });
  return { bytes: buildPdf({ pages, font }), pages: pages.length, fontSize };
}

/**
 * Anonymize a PDF: returns rebuilt PDF bytes plus the mapping that restores it.
 */
export async function anonymizePdf(client, buffer, types, options = {}) {
  const document = extractDocument(buffer);
  const original = document.text;
  if (!original.trim()) {
    return { bytes: buffer, mapping: {}, original, anonymized: original, skipped: 'no_text', pages: document.pages.length };
  }
  const hidden = await runHide(client, original, types, options);
  const rendered = await renderText(hidden.text, document);
  return {
    bytes: rendered.bytes,
    mapping: hidden.mapping,
    original,
    anonymized: hidden.text,
    pages: rendered.pages,
    fontSize: rendered.fontSize,
  };
}

/**
 * Restore a PDF from its mapping. Direct mapping replacement is tried first;
 * the model is only asked when tags remain and a client is available.
 */
export async function restorePdf(client, buffer, mapping, options = {}) {
  const document = extractDocument(buffer);
  const anonymized = document.text;
  const warn = options.warn ?? (() => {});
  const seeked = await runSeek(client, anonymized, mapping, { ...options, warn });
  const rendered = await renderText(seeked.text, document);
  return {
    bytes: rendered.bytes,
    method: seeked.method ?? 'model',
    anonymized,
    restored: seeked.text,
    pages: rendered.pages,
  };
}
/**
 * Anonymize a PDF into plain text instead of a rebuilt document. Figures and
 * tables are not carried over, but nothing about the page layout has to be
 * reinvented, so this is the cheap path for long reports.
 */
export async function anonymizePdfText(client, buffer, types, options = {}) {
  const document = extractDocument(buffer);
  const original = document.text;
  if (!original.trim()) {
    return { text: original, mapping: {}, original, pages: document.pages.length, skipped: 'no_text' };
  }
  const hidden = await runHide(client, original, types, options);
  return { text: hidden.text, mapping: hidden.mapping, original, pages: document.pages.length, chunks: hidden.chunks };
}

/** Restore plain text produced by {@link anonymizePdfText}. */
export async function restorePdfText(client, buffer, mapping, options = {}) {
  const document = extractDocument(buffer);
  const anonymized = document.text;
  const warn = options.warn ?? (() => {});
  const seeked = await runSeek(client, anonymized, mapping, { ...options, warn });
  return { text: seeked.text, method: seeked.method ?? 'model', anonymized };
}