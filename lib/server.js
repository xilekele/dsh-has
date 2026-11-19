/**
 * llama-server manager: one warm local server per model, shared by every tool
 * call and reused across plugin restarts through `<stateDir>/server.json`.
 */

import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HasClient } from './client.js';
import { LLAMA_SERVER_EXE, stateDir } from './config.js';
import { ensureDir, pathExists } from './io.js';

const STATE_FILE = 'server.json';
const LOG_FILE = 'server.log';
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '::']);

export class ServerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
  }
}

function isLoopback(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').toLowerCase());
}

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sameModel(left, right) {
  if (!left || !right) return false;
  return path.basename(left).toLowerCase() === path.basename(right).toLowerCase();
}

export class ServerManager {
  /**
   * @param {ReturnType<import('./config.js').resolveConfig>} config
   * @param {{log?: (level: string, message: string) => void}} [options]
   */
  constructor(config, options = {}) {
    this.config = config;
    this.log = options.log ?? (() => {});
    this.child = null;
    this.ownedPid = null;
    this.info = null;
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.inFlight = 0;
    this.disposed = false;
    this.logFd = null;
  }

  #statePath() {
    return path.join(this.config.stateDir ?? stateDir(), STATE_FILE);
  }

  #logPath() {
    return path.join(this.config.stateDir ?? stateDir(), LOG_FILE);
  }

  #baseUrl(port) {
    return `http://${this.config.host}:${port}`;
  }

  #client(port, { signal, timeoutMs } = {}) {
    return new HasClient(this.#baseUrl(port), {
      signal,
      timeoutMs: timeoutMs ?? this.config.requestTimeoutMs,
    });
  }

  async #readState() {
    try {
      const raw = await fsp.readFile(this.#statePath(), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async #writeState(state) {
    await ensureDir(this.config.stateDir);
    await fsp.writeFile(this.#statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async #clearState() {
    await fsp.rm(this.#statePath(), { force: true });
  }

  /** Read llama-server capabilities; null when unreachable. */
  async #probe(port) {
    const client = this.#client(port, { timeoutMs: 5000 });
    if (!(await client.health())) return null;
    try {
      const response = await fetch(`${this.#baseUrl(port)}/props`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { reachable: true };
      const props = await response.json();
      const settings = props?.default_generation_settings ?? {};
      return {
        reachable: true,
        modelPath: props?.model_path ?? settings?.model ?? null,
        ctx: Number(props?.n_ctx ?? settings?.n_ctx ?? 0),
        slots: Number(props?.total_slots ?? settings?.n_parallel ?? 0),
      };
    } catch {
      return { reachable: true };
    }
  }

  /** Run `task` with exclusive access to the server lifecycle. */
  async #serialized(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #kill(pid) {
    if (!pid) return;
    await new Promise((resolve) => {
      const args =
        process.platform === 'win32' ? ['/pid', String(pid), '/T', '/F'] : ['-TERM', String(pid)];
      const killer = spawn(process.platform === 'win32' ? 'taskkill' : 'kill', args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => resolve());
      killer.on('exit', () => resolve());
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (process.platform !== 'win32' && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /** Stop a server that we own (child process) or adopted from our state file. */
  async #stopOwned(record) {
    if (!record) return;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.removeAllListeners();
        child.kill();
      } catch {
        // ignore
      }
    }
    if (record.pid && (this.ownedPid === record.pid || !this.child)) await this.#kill(record.pid);
    this.ownedPid = null;
    this.info = null;
    await this.#clearState();
  }

  async #openLog() {
    if (this.logFd !== null) return this.logFd;
    await ensureDir(this.config.stateDir);
    const file = this.#logPath();
    try {
      const stat = await fsp.stat(file);
      if (stat.size > LOG_LIMIT_BYTES) {
        await fsp.rename(file, `${file}.1`);
      }
    } catch {
      // no previous log
    }
    this.logFd = await fsp.open(file, 'a');
    return this.logFd;
  }

  async #spawnOn(port, { slots, contextPerSlot }) {
    const { modelPath, llamaServerPath, host, gpuLayers } = this.config;
    if (!modelPath || !(await pathExists(modelPath))) {
      throw new ServerError(
        `HaS text model not found. Put has_text_model.gguf in ${path.join(this.config.stateDir, 'models')} ` +
          `or set modelPath / HAS_TEXT_MODEL_PATH. Download: ${this.config.modelUrl}`,
        'model_not_found',
      );
    }
    if (!llamaServerPath) {
      throw new ServerError(
        `llama-server (${LLAMA_SERVER_EXE}) was not found. Install llama.cpp (winget install ggml.llamacpp), ` +
          'or set llamaServerPath / HAS_LLAMA_SERVER to the executable path.',
        'llama_server_not_found',
      );
    }

    const args = [
      '--host', host,
      '-m', modelPath,
      '-ngl', String(gpuLayers),
      '-c', String(contextPerSlot * slots),
      '-np', String(slots),
      '-fa', 'on',
      '-ctk', 'q8_0',
      '-ctv', 'q8_0',
      '--port', String(port),
    ];

    const logHandle = await this.#openLog();
    this.log('info', `starting llama-server on port ${port} (slots=${slots}, ctx=${contextPerSlot * slots})`);

    const child = spawn(llamaServerPath, args, {
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
      cwd: path.dirname(llamaServerPath),
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        child.removeListener('spawn', onSpawn);
        reject(
          new ServerError(
            `Failed to start llama-server (${llamaServerPath}): ${error.message}`,
            'spawn_failed',
          ),
        );
      };
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });

    this.child = child;
    this.ownedPid = child.pid;
    child.once('exit', (code, signal) => {
      this.log('warn', `llama-server exited (code=${code}, signal=${signal})`);
      if (this.child === child) {
        this.child = null;
        this.ownedPid = null;
        this.info = null;
      }
    });

    const deadline = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) throw new ServerError('llama-server exited during startup', 'startup_failed');
      const probe = await this.#probe(port);
      if (probe?.reachable) {
        const record = {
          pid: child.pid,
          port,
          host,
          slots,
          contextPerSlot,
          modelPath,
          startedAt: new Date().toISOString(),
        };
        await this.#writeState(record);
        this.info = record;
        return record;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await this.#stopOwned({ pid: child.pid });
    throw new ServerError(
      `llama-server did not become healthy within ${this.config.startupTimeoutMs} ms. See ${this.#logPath()}`,
      'startup_timeout',
    );
  }

  #scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const idle = this.config.idleTimeoutMs;
    // Never stop the server while a call is still running: a long generation
    // can outlive the idle window and would be killed mid-answer.
    if (!idle || this.inFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0) return;
      const record = this.info;
      this.info = null;
      this.#serialized(async () => {
        if (this.child || record) await this.#stopOwned(record ?? (await this.#readState()));
      }).catch(() => {});
    }, idle);
    this.idleTimer.unref?.();
  }

  /**
   * Ensure a compatible server is running and return a client for it.
   * @returns {Promise<{client: HasClient, port: number, baseUrl: string, info: object}>}
   */
  async ensure({ slots = 1, contextPerSlot = this.config.contextPerSlot, signal } = {}) {
    if (this.disposed) throw new ServerError('Server manager has been disposed', 'disposed');
    if (!isLoopback(this.config.host)) {
      throw new ServerError(
        `Refusing to call llama-server at non-loopback host "${this.config.host}": HaS must run fully on-device.`,
        'non_loopback_host',
      );
    }

    const needed = Math.min(Math.max(1, slots), this.config.maxSlots);
    // Start with every slot the profile allows so later concurrent calls never
    // pay a second model load just to raise `-np`.
    const spawnSlots = Math.max(needed, this.config.maxSlots);
    const serves = (info) =>
      Boolean(info && info.port && (info.slots ?? 0) >= needed && (info.contextPerSlot ?? 0) >= contextPerSlot);

    const record = await this.#serialized(async () => {
      if (this.child && this.info && serves(this.info)) {
        const probe = await this.#probe(this.info.port);
        if (probe?.reachable) return this.info;
      }
      if (this.child && this.info) {
        this.log('warn', 'restarting llama-server to satisfy requested slots/context');
        await this.#stopOwned(this.info);
      }

      const state = await this.#readState();
      if (state?.port) {
        const probe = await this.#probe(state.port);
        const ours = probe?.reachable && sameModel(probe.modelPath, this.config.modelPath) && pidAlive(state.pid);
        if (ours && serves(state)) {
          this.info = state;
          this.ownedPid = null;
          this.log('info', `reusing llama-server on port ${state.port}`);
          return state;
        }
        if (ours) {
          this.log('warn', 'stopping stale dsh-has llama-server with incompatible limits');
          await this.#kill(state.pid);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        await this.#clearState();
      }

      let port = this.config.port;
      if (!(await portFree(port, this.config.host))) {
        const probe = await this.#probe(port);
        if (probe?.reachable && sameModel(probe.modelPath, this.config.modelPath)) {
          this.log('warn', `adopting an externally started llama-server on port ${port} (limits unknown)`);
          const adopted = {
            port,
            slots: spawnSlots,
            contextPerSlot,
            modelPath: this.config.modelPath,
            external: true,
          };
          this.info = adopted;
          return adopted;
        }
        port = await freePort(this.config.host);
        this.log('warn', `port ${this.config.port} is busy, using ${port} instead`);
      }

      return this.#spawnOn(port, { slots: spawnSlots, contextPerSlot });
    });

    this.#scheduleIdle();
    return {
      client: this.#client(record.port, { signal }),
      port: record.port,
      baseUrl: this.#baseUrl(record.port),
      info: record,
    };
  }

  /**
   * Call `fn(client)` once; if it fails with a context-budget error, restart
   * the server with the fallback context window and retry once.
   */
  async withClient(fn, { slots = 1, signal, retryOverflow = true } = {}) {
    const first = await this.ensure({ slots, signal });
    this.inFlight += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      return await fn(first.client, first);
    } catch (error) {
      const message = String(error?.message ?? '');
      const retryable =
        retryOverflow &&
        /no longer leaves room|context (window|size)|Prompt \(\d+ tokens\)|exceeds context/i.test(message);
      if (!retryable) throw error;
      if (this.config.fallbackContextPerSlot <= this.config.contextPerSlot) throw error;

      this.log('warn', 'retrying with a larger context window (fallbackContextPerSlot)');
      await this.#serialized(async () => {
        await this.#stopOwned(this.info ?? (await this.#readState()));
      });
      const second = await this.ensure({ slots, contextPerSlot: this.config.fallbackContextPerSlot, signal });
      return fn(second.client, second);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.#scheduleIdle();
    }
  }

  status() {
    const record = this.info;
    if (!record) {
      return { running: false, modelPath: this.config.modelPath, stateDir: this.config.stateDir };
    }
    return {
      running: true,
      owned: Boolean(this.child),
      pid: record.pid ?? null,
      port: record.port,
      baseUrl: this.#baseUrl(record.port),
      modelPath: record.modelPath ?? this.config.modelPath,
      model: path.basename(record.modelPath ?? this.config.modelPath ?? ''),
      slots: record.slots ?? null,
      context: record.slots ? record.slots * (record.contextPerSlot ?? this.config.contextPerSlot) : null,
      startedAt: record.startedAt ?? null,
      logFile: this.#logPath(),
    };
  }

  /** Restart (used after a manual model change). */
  async restart(options = {}) {
    return this.#serialized(async () => {
      await this.#stopOwned(this.info ?? (await this.#readState()));
      return null;
    }).then(() => this.ensure(options));
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.#serialized(async () => {
      await this.#stopOwned(this.info ?? (await this.#readState()));
    });
    if (this.logFd !== null) {
      try {
        await this.logFd.close();
      } catch {
        // ignore
      }
      this.logFd = null;
    }
  }
}

export { isLoopback };
