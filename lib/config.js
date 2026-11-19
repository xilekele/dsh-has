/**
 * Configuration: defaults ← <stateDir>/config.json ← plugin row config ← environment.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { expandHome, pathExists } from './io.js';

export const STATE_DIR_NAME = '.dsh-has';
export const MODEL_FILE = 'has_text_model.gguf';
export const LLAMA_SERVER_EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  contextPerSlot: 8192,
  maxSlots: 4,
  startupTimeoutMs: 120000,
  requestTimeoutMs: 180000,
  idleTimeoutMs: 30 * 60 * 1000,
  maxParallelRequests: 4,
  maxChunkTokens: 3000,
  scanMaxChunkTokens: 5000,
  toolPair: true,
  logLevel: 'info',
  guidance: false,
});

export function packageDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function stateDir() {
  return expandHome(process.env.DSH_HAS_HOME || path.join(os.homedir(), STATE_DIR_NAME));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function pick(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value;
  return undefined;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Candidate model locations, most specific first. */
export function modelCandidates(config = {}) {
  const state = stateDir();
  const candidates = [
    process.env.HAS_TEXT_MODEL_PATH,
    config.modelPath,
    path.join(state, 'models', MODEL_FILE),
    path.join(os.homedir(), '.openclaw', 'tools', 'has-anonymizer', 'models', MODEL_FILE),
    path.join(packageDir(), 'models', MODEL_FILE),
    path.join(process.cwd(), 'models', MODEL_FILE),
  ].filter(Boolean);
  return [...new Set(candidates.map((item) => path.resolve(expandHome(String(item)))))];
}

/** Candidate llama-server locations, most specific first. */
export function llamaServerCandidates(config = {}) {
  const candidates = [process.env.HAS_LLAMA_SERVER, config.llamaServerPath].filter(Boolean);

  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, LLAMA_SERVER_EXE));
    if (process.platform === 'win32') candidates.push(path.join(dir, 'llama-server'));
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
      try {
        for (const name of fs.readdirSync(packages)) {
          if (!/llama|ggml/i.test(name)) continue;
          const dir = path.join(packages, name);
          candidates.push(path.join(dir, LLAMA_SERVER_EXE));
          for (const nested of fs.readdirSync(dir)) {
            candidates.push(path.join(dir, nested, LLAMA_SERVER_EXE));
            candidates.push(path.join(dir, nested, 'bin', LLAMA_SERVER_EXE));
          }
        }
      } catch {
        // WinGet package cache is optional.
      }
    }
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(path.join(base, 'llama.cpp', LLAMA_SERVER_EXE));
      candidates.push(path.join(base, 'llama.cpp', 'build', 'bin', LLAMA_SERVER_EXE));
      candidates.push(path.join(base, 'Programs', 'llama.cpp', LLAMA_SERVER_EXE));
    }
  }

  candidates.push(path.join(os.homedir(), 'llama.cpp', 'build', 'bin', LLAMA_SERVER_EXE));
  return [...new Set(candidates.filter(Boolean).map((item) => path.resolve(expandHome(String(item)))))];
}

/**
 * Resolve the effective configuration.
 * @param {Record<string, unknown>} rowConfig plugin row config from cordis.patch.yml
 */
export function resolveConfig(rowConfig = {}) {
  const file = path.join(stateDir(), 'config.json');
  const fileConfig = readJson(file);
  const merged = { ...DEFAULTS, ...fileConfig, ...rowConfig };
  const effectiveStateDir = merged.stateDir
    ? path.resolve(expandHome(String(merged.stateDir)))
    : stateDir();

  const modelPath = modelCandidates(merged).find((candidate) => fs.existsSync(candidate)) ?? null;
  const llamaServerPath = llamaServerCandidates(merged).find((candidate) => fs.existsSync(candidate)) ?? null;

  const slotLimit = Math.min(
    Math.max(1, toInt(pick(process.env.DSH_HAS_MAX_SLOTS, merged.maxSlots), DEFAULTS.maxSlots)),
    8,
  );
  const parallelDefault = Math.min(
    Math.max(1, toInt(pick(process.env.HAS_TEXT_MAX_PARALLEL_REQUESTS, merged.maxParallelRequests), DEFAULTS.maxParallelRequests)),
    slotLimit,
  );

  return {
    host: String(pick(process.env.DSH_HAS_HOST, merged.host) ?? DEFAULTS.host),
    port: toInt(pick(process.env.DSH_HAS_PORT, merged.port), DEFAULTS.port),
    contextPerSlot: Math.max(2048, toInt(pick(process.env.DSH_HAS_CONTEXT_PER_SLOT, merged.contextPerSlot), DEFAULTS.contextPerSlot)),
    fallbackContextPerSlot: Math.max(
      2048,
      toInt(pick(process.env.DSH_HAS_FALLBACK_CONTEXT_PER_SLOT, merged.fallbackContextPerSlot), 16384),
    ),
    maxSlots: slotLimit,
    startupTimeoutMs: Math.max(
      1000,
      toInt(pick(process.env.DSH_HAS_STARTUP_TIMEOUT_MS, merged.startupTimeoutMs), DEFAULTS.startupTimeoutMs),
    ),
    requestTimeoutMs: Math.max(
      1000,
      toInt(pick(process.env.DSH_HAS_REQUEST_TIMEOUT_MS, merged.requestTimeoutMs), DEFAULTS.requestTimeoutMs),
    ),
    idleTimeoutMs: Math.max(0, toInt(pick(process.env.DSH_HAS_IDLE_TIMEOUT_MS, merged.idleTimeoutMs), DEFAULTS.idleTimeoutMs)),
    maxParallelRequests: parallelDefault,
    maxChunkTokens: Math.max(200, toInt(merged.maxChunkTokens, DEFAULTS.maxChunkTokens)),
    scanMaxChunkTokens: Math.max(200, toInt(merged.scanMaxChunkTokens, DEFAULTS.scanMaxChunkTokens)),
    toolPair: toBool(pick(process.env.DSH_HAS_TOOL_PAIR, merged.toolPair), DEFAULTS.toolPair),
    logLevel: String(pick(process.env.DSH_HAS_LOG_LEVEL, merged.logLevel) ?? DEFAULTS.logLevel),
    guidance: toBool(pick(process.env.DSH_HAS_GUIDANCE, merged.guidance), DEFAULTS.guidance),
    modelPath,
    llamaServerPath,
    stateDir: effectiveStateDir,
    configFile: path.join(effectiveStateDir, 'config.json'),
    gpuLayers: toInt(pick(process.env.DSH_HAS_GPU_LAYERS, merged.gpuLayers), 999),
    modelUrl: 'https://huggingface.co/xuanwulab/HaS_Text_0209_0.6B_Q8',
  };
}

export async function describeConfig(config = resolveConfig({})) {
  return {
    modelPath: config.modelPath,
    modelPresent: config.modelPath ? await pathExists(config.modelPath) : false,
    llamaServerPath: config.llamaServerPath,
    stateDir: config.stateDir,
    configFile: config.configFile,
    host: config.host,
    port: config.port,
    contextPerSlot: config.contextPerSlot,
    maxSlots: config.maxSlots,
    maxParallelRequests: config.maxParallelRequests,
    maxChunkTokens: config.maxChunkTokens,
    scanMaxChunkTokens: config.scanMaxChunkTokens,
    toolPair: config.toolPair,
    guidance: config.guidance,
    modelUrl: config.modelUrl,
  };
}
