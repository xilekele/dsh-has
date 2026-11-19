/**
 * Mapping management: tag parsing, merge, tolerant JSON parsing, and
 * on-disk persistence. A mapping file can reverse every anonymization,
 * so it is written with restrictive permissions.
 */

import fs from 'node:fs';
import path from 'node:path';

export const TAG_PATTERN = /<([^<>\[\]]+)\[(\d+)\]\.([^<>\[\].]+)\.([^<>\[\].]+)>/g;

/** Find all anonymized tags in a text. */
export function findTags(text) {
  return Array.from(String(text ?? '').matchAll(new RegExp(TAG_PATTERN.source, 'g')), (m) => m[0]);
}

export function hasTags(text) {
  return new RegExp(TAG_PATTERN.source).test(String(text ?? ''));
}

export function isCompositeTag(key) {
  return findTags(key).length > 1;
}

/** Split a mapping into atomic and composite entries. */
export function findCompositeEntries(mapping) {
  const atomic = {};
  const composite = {};
  for (const [key, values] of Object.entries(mapping ?? {})) {
    if (isCompositeTag(key)) composite[key] = values;
    else atomic[key] = values;
  }
  return { atomic, composite };
}

/** Merge `next` into `base`, deduplicating values and preserving order. */
export function mergeMappings(base, next) {
  const result = {};
  for (const [key, values] of Object.entries(base ?? {})) result[key] = [...values];
  for (const [key, values] of Object.entries(next ?? {})) {
    if (key in result) {
      for (const value of values) if (!result[key].includes(value)) result[key].push(value);
    } else {
      result[key] = [...values];
    }
  }
  return result;
}

/** Validate and normalize a mapping object (string or array values). */
export function normalizeMappingDict(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Mapping data must be a JSON object');
  }
  const normalized = {};
  for (const [rawKey, rawValues] of Object.entries(data)) {
    const key = String(rawKey).trim();
    if (!key) throw new Error('Mapping keys must be non-empty strings');
    if (!hasTags(key)) throw new Error(`Mapping key ${JSON.stringify(key)} is not a valid anonymized tag`);

    const source = typeof rawValues === 'string' ? [rawValues] : Array.isArray(rawValues) ? rawValues : null;
    if (!source) {
      throw new Error(`Mapping entry for ${JSON.stringify(key)} must be a string or an array of strings`);
    }

    const values = [];
    for (const rawValue of source) {
      const value = String(rawValue).trim();
      if (!value) throw new Error(`Mapping entry for ${JSON.stringify(key)} contains an empty value`);
      if (!values.includes(value)) values.push(value);
    }
    if (!values.length) throw new Error(`Mapping entry for ${JSON.stringify(key)} must contain at least one value`);
    normalized[key] = values;
  }
  return normalized;
}

/** Load a mapping from a JSON file path or an inline JSON string. */
export function loadMapping(pathOrJson) {
  const candidate = String(pathOrJson ?? '');
  let data;
  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } else {
    try {
      data = JSON.parse(candidate);
    } catch {
      throw new Error(`${JSON.stringify(candidate)} is neither a valid file path nor a valid JSON string`);
    }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Mapping data must be a JSON object');
  }
  if (data.mapping !== undefined) {
    if (data.mapping === null || typeof data.mapping !== 'object' || Array.isArray(data.mapping)) {
      throw new Error("The 'mapping' field must be a JSON object");
    }
    data = data.mapping;
  }
  return normalizeMappingDict(data);
}

/** Save a mapping as pretty JSON with owner-only permissions. */
export function saveMapping(mapping, filePath) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = `${JSON.stringify(mapping, null, 2)}\n`;
  fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* Windows: best effort only */
  }
}

/**
 * Tolerantly parse JSON from model output: strips markdown fences, then
 * tries the whole string, then the outermost object/array substring.
 */
export function parseJsonTolerant(raw) {
  let text = String(raw ?? '').trim();

  if (text.startsWith('```')) {
    const lines = text.split('\n').slice(1);
    if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
    text = lines.join('\n').trim();
  }

  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* try the next shape */
      }
    }
  }
  return null;
}
