/**
 * Word (.docx) support for the HaS engine.
 *
 * A .docx is an OOXML package: a ZIP holding `word/document.xml` plus optional
 * headers/footers. Rather than rebuilding the document (which would lose
 * styles), we anonymize the paragraph text and then write the tags back into the
 * individual `<w:t>` runs, so bold/italic/fonts/sections survive untouched.
 *
 * Tags are placed in the run where the replaced entity starts. A tag never
 * spans two runs, which also keeps restore a simple per-run replacement.
 */
import { TAG_PATTERN, hasTags } from './mapping.js';
import { runHide } from './hide.js';
import { toolSeek } from './seek.js';
import { readZip, writeZip } from './zip.js';

const TEXT_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const PARAGRAPH = /<w:p(?=[\s>/])[^>]*>[\s\S]*?<\/w:p>/g;
const TEXT_NODE = /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;

export function isDocxFile(file) {
  return /\.docx$/i.test(String(file ?? ''));
}

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function innerRange(xml, nodeStart, nodeSource) {
  const openEnd = nodeStart + nodeSource.indexOf('>') + 1;
  if (nodeSource.endsWith('/>')) return { openEnd, innerStart: openEnd, innerEnd: openEnd, closeEnd: openEnd };
  const closeStart = nodeStart + nodeSource.lastIndexOf('</w:t>');
  return { openEnd, innerStart: openEnd, innerEnd: closeStart, closeEnd: closeStart + 6 };
}

/**
 * Collect paragraphs and their `<w:t>` nodes.
 * @returns {Array<{start: number, end: number, text: string, nodes: Array}>}
 */
export function collectParagraphs(xml) {
  const paragraphs = [];
  PARAGRAPH.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH.exec(xml)) !== null) {
    if (!/[<]w:t(?:\s|\/|>)/.test(match[0])) continue;
    const paragraphStart = match.index;
    const nodes = [];
    let text = '';
    TEXT_NODE.lastIndex = 0;
    let nodeMatch;
    while ((nodeMatch = TEXT_NODE.exec(match[0])) !== null) {
      const source = nodeMatch[0];
      const nodeStart = paragraphStart + nodeMatch.index;
      const { innerStart, innerEnd, closeEnd } = innerRange(xml, nodeStart, source);
      const value = source.endsWith('/>') ? '' : decodeXml(xml.slice(innerStart, innerEnd));
      nodes.push({ nodeStart, nodeEnd: nodeStart + source.length, innerStart, innerEnd, closeEnd, text: value, offset: text.length });
      text += value;
    }
    if (!nodes.length) continue;
    paragraphs.push({ start: paragraphStart, end: paragraphStart + match[0].length, text, nodes });
  }
  return paragraphs;
}

/**
 * Match the tags of `anonymized` back to their original spans.
 * @returns {Array<{start: number, end: number, tag: string}>|null} null when a tag cannot be placed
 */
export function alignEntitySpans(original, anonymized, mapping) {
  const spans = [];
  let cursor = 0;
  const pattern = new RegExp(TAG_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(anonymized)) !== null) {
    const tag = match[0];
    const values = mapping[tag] ?? [];
    let best = null;
    for (const value of values) {
      const candidate = String(value ?? '');
      if (!candidate) continue;
      const index = original.indexOf(candidate, cursor);
      if (index < 0) continue;
      if (!best || index < best.index || (index === best.index && candidate.length > best.length)) {
        best = { index, length: candidate.length };
      }
    }
    if (!best) return null;
    spans.push({ start: best.index, end: best.index + best.length, tag });
    cursor = best.index + best.length;
  }
  return spans;
}

/** Build the replacement text of one `<w:t>` node from the paragraph spans. */
function nodeTextWithTags(original, nodes, node, spans) {
  const from = node.offset;
  const to = node.offset + node.text.length;
  let out = '';
  let position = from;
  for (const span of spans) {
    if (span.end <= position) continue;
    if (span.start >= to) break;
    if (span.start > position) out += original.slice(position, Math.min(span.start, to));
    if (span.start >= position && span.start < to) out += span.tag;
    position = Math.max(position, span.end);
  }
  if (position < to) out += original.slice(position, to);
  return out;
}

function rewriteParagraph(xml, paragraph, replacements) {
  let result = xml;
  for (let index = paragraph.nodes.length - 1; index >= 0; index -= 1) {
    const node = paragraph.nodes[index];
    const replacement = replacements[index];
    if (replacement === node.text) continue;
    const source = result.slice(node.nodeStart, node.nodeEnd);
    if (source.endsWith('/>')) {
      if (!replacement) continue;
      result = `${result.slice(0, node.nodeStart)}<w:t xml:space="preserve">${encodeXml(replacement)}</w:t>${result.slice(node.nodeEnd)}`;
      continue;
    }
    const open = result.slice(node.nodeStart, node.innerStart);
    const needsPreserve = /^\s|\s$/.test(replacement) && !/xml:space=/.test(open);
    const newOpen = needsPreserve ? open.replace(/>$/, ' xml:space="preserve">') : open;
    result = `${result.slice(0, node.nodeStart)}${newOpen}${encodeXml(replacement)}${result.slice(node.innerEnd)}`;
  }
  return result;
}

function readParts(buffer) {
  const entries = readZip(buffer);
  const parts = [];
  for (const [name, data] of entries) {
    if (!TEXT_PART.test(name)) continue;
    parts.push({ name, xml: data.toString('utf8') });
  }
  if (!parts.length) throw new Error('Not a Word document: word/document.xml is missing');
  return { entries, parts };
}

/**
 * Anonymize a .docx, keeping the paragraph runs (formatting) intact.
 * @returns {Promise<{bytes: Buffer, mapping: object, original: string, anonymized: string, paragraphs: number}>}
 */
export async function anonymizeDocx(client, buffer, types, options = {}) {
  const { warn = () => {}, ...hideOptions } = options;
  const { entries, parts } = readParts(buffer);

  let mapping = hideOptions.existingMapping ? { ...hideOptions.existingMapping } : {};
  const originalLines = [];
  const anonymizedLines = [];
  let paragraphCount = 0;

  for (const part of parts) {
    const paragraphs = collectParagraphs(part.xml);
    const replacements = [];
    for (const paragraph of paragraphs) {
      if (!paragraph.text.trim()) continue;
      const hidden = await runHide(client, paragraph.text, types, { ...hideOptions, existingMapping: Object.keys(mapping).length ? mapping : null, warn });
      mapping = hidden.mapping;
      paragraphCount += 1;
      originalLines.push(paragraph.text);
      anonymizedLines.push(hidden.text);

      const spans = alignEntitySpans(paragraph.text, hidden.text, mapping);
      let nodeTexts;
      if (spans === null) {
        warn(`Paragraph ${paragraphCount}: a tag could not be mapped back to a run; rewriting it as one run.`);
        nodeTexts = paragraph.nodes.map((node, index) => (index === 0 ? hidden.text : ''));
      } else {
        nodeTexts = paragraph.nodes.map((node) => (spans.length ? nodeTextWithTags(paragraph.text, paragraph.nodes, node, spans) : node.text));
      }
      replacements.push({ paragraph, nodeTexts });
    }

    let xml = part.xml;
    for (let index = replacements.length - 1; index >= 0; index -= 1) {
      xml = rewriteParagraph(xml, replacements[index].paragraph, replacements[index].nodeTexts);
    }
    part.xml = xml;
  }

  for (const part of parts) entries.set(part.name, Buffer.from(part.xml, 'utf8'));
  return {
    bytes: writeZip(entries),
    mapping,
    original: originalLines.join('\n'),
    anonymized: anonymizedLines.join('\n'),
    paragraphs: paragraphCount,
  };
}

/**
 * Restore a .docx produced by {@link anonymizeDocx}.
 * @returns {Promise<{bytes: Buffer, method: string, original: string, restored: string}>}
 */
export async function restoreDocx(client, buffer, mapping, options = {}) {
  const { warn = () => {}, seekText = null } = options;
  const { entries, parts } = readParts(buffer);
  const anonymizedLines = [];
  const restoredLines = [];
  let usedModel = false;

  for (const part of parts) {
    const paragraphs = collectParagraphs(part.xml);
    const replacements = [];
    for (const paragraph of paragraphs) {
      if (!paragraph.text.trim()) continue;
      anonymizedLines.push(paragraph.text);
      const perNode = paragraph.nodes.map((node) => (hasTags(node.text) ? toolSeek(node.text, mapping) : node.text));
      const joined = perNode.join('');
      if (hasTags(joined) && seekText) {
        usedModel = true;
        const restored = await seekText(joined, mapping);
        const first = paragraph.nodes.findIndex((node) => hasTags(node.text));
        const target = first >= 0 ? first : 0;
        replacements.push({ paragraph, nodeTexts: paragraph.nodes.map((node, index) => (index === target ? restored : '')) });
        restoredLines.push(restored);
        continue;
      }
      if (hasTags(joined)) warn('A paragraph still contains tags after restore; the mapping may be incomplete.');
      replacements.push({ paragraph, nodeTexts: perNode });
      restoredLines.push(joined);
    }

    let xml = part.xml;
    for (let index = replacements.length - 1; index >= 0; index -= 1) {
      xml = rewriteParagraph(xml, replacements[index].paragraph, replacements[index].nodeTexts);
    }
    part.xml = xml;
  }

  for (const part of parts) entries.set(part.name, Buffer.from(part.xml, 'utf8'));
  return {
    bytes: writeZip(entries),
    method: usedModel ? 'model' : 'tool',
    anonymized: anonymizedLines.join('\n'),
    restored: restoredLines.join('\n'),
  };
}

/** Plain text of the document, for scanning. */
export function docxPlainText(buffer) {
  const { parts } = readParts(buffer);
  const lines = [];
  for (const part of parts) {
    for (const paragraph of collectParagraphs(part.xml)) {
      if (paragraph.text.trim()) lines.push(paragraph.text);
    }
  }
  return lines.join('\n');
}
