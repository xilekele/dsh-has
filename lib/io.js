/**
 * Filesystem helpers: safe text reads, directory scanning and protected writes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const BINARY_SNIFF_BYTES = 8192;

export function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function absolutePath(input, base = process.cwd()) {
  const expanded = expandHome(String(input ?? ''));
  return path.resolve(base, expanded);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Read a UTF-8 text file, refusing binary content.
 * @returns {Promise<{text: string} | {skipped: string}>}
 */
export async function readTextDocument(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    return { skipped: 'read_error', message: error.message };
  }

  try {
    const head = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, BINARY_SNIFF_BYTES, 0);
    if (head.subarray(0, bytesRead).includes(0)) return { skipped: 'binary' };
  } finally {
    await handle.close();
  }

  let buffer;
  try {
    buffer = await fs.readFile(file);
  } catch (error) {
    return { skipped: 'read_error', message: error.message };
  }

  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    return { skipped: 'non_utf8' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text };
}

/** List immediate children of a directory whose names match `pattern`. */
async function collectFiles(dir, pattern) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && pattern.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** List immediate `.docx` children of a directory (non-recursive). */
export async function collectDocxFiles(dir) {
  return collectFiles(dir, /\.docx$/i);
}

/** List immediate `.pdf` children of a directory (non-recursive). */
export async function collectPdfFiles(dir) {
  return collectFiles(dir, /\.pdf$/i);
}

/** Collect immediate text children of a directory (non-recursive). */
export async function collectTextDocuments(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const documents = [];
  const skipped = [];
  for (const name of names) {
    if (/\.(docx|pdf)$/i.test(name)) continue; // handled by the binary collectors
    const file = path.join(dir, name);
    const result = await readTextDocument(file);
    if (result.skipped) skipped.push({ file, reason: result.skipped });
    else documents.push({ source: file, text: result.text });
  }

  // Symlinked files are reported instead of silently ignored.
  for (const entry of entries) {
    if (entry.isSymbolicLink() && entry.isFile()) {
      skipped.push({ file: path.join(dir, entry.name), reason: 'symlink' });
    }
  }

  return { documents, skipped };
}

async function writeAtomic(target, data, mode) {
  await ensureDir(path.dirname(target));
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(temp, data, { encoding: 'utf8', mode });
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  try {
    await fs.chmod(target, mode);
  } catch {
    // chmod is advisory on Windows.
  }
  return target;
}

/** Write text, refusing to clobber unless allowed. */
export async function writeTextOutput(target, text, { overwrite = false, mode = 0o600 } = {}) {
  if (!overwrite && (await pathExists(target))) {
    throw new Error(`Refusing to overwrite existing file: ${target}`);
  }
  return writeAtomic(target, text, mode);
}

export async function writeJsonOutput(target, value, { overwrite = true, mode = 0o600 } = {}) {
  if (!overwrite && (await pathExists(target))) {
    throw new Error(`Refusing to overwrite existing file: ${target}`);
  }
  return writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function stemName(file) {
  return path.basename(file, path.extname(file));
}

/** Default output directory for hide/scan results of a directory input. */
export function defaultAnonymizedDir(dir) {
  return path.join(dir, '.has', 'anonymized');
}

/** Default mapping directory for directory input. */
export function defaultMappingsDir(dir) {
  return path.join(dir, 'mappings');
}

/** Restored output directory, mirroring the reference layout. */
export function defaultRestoredDir(dir) {
  const parent = path.dirname(path.resolve(dir));
  const base = path.basename(parent);
  const grand = path.basename(path.dirname(parent));
  if (base === '.has' && grand) return path.join(parent, 'restored');
  return path.join(dir, '.has', 'restored');
}

export function seekMappingPath(mappingDir, source) {
  return path.join(mappingDir, `${stemName(source)}.mapping.json`);
}
