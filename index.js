/**
 * dsh-has — on-device reversible anonymization (HaS) for DeepSeek Harness.
 *
 * Registers four tools backed by a lazily started, reused local llama-server
 * running the HaS text GGUF. No text ever leaves the machine.
 */

import { resolveConfig } from './lib/config.js';
import { ServerManager } from './lib/server.js';
import { createTools } from './lib/tools.js';

export const name = 'dsh-has';
export const inject = ['tools'];

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const GUIDANCE = [
  'Text passed through the has_hide tool contains reversible tags shaped like `<EntityType[ID].Category.Attribute>`',
  '(for example `<人名[1].姓名.全名>`).',
  'Treat every tag as opaque data: keep it byte-for-byte, never translate it, never change or invent an ID,',
  'never guess the value behind it, and reuse the same ID for the same entity.',
  'Call has_restore with the returned mapping file to turn the tags back into the real values.',
].join(' ');

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config ?? {});
  const threshold = LEVELS[resolved.logLevel] ?? LEVELS.info;

  function log(level, message) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const line = `[dsh-has] ${message}`;
    const logger = ctx?.logger;
    const sink =
      (typeof logger?.[level] === 'function' ? logger[level] : null) ??
      (typeof logger?.info === 'function' ? logger.info : null) ??
      (typeof console[level] === 'function' ? console[level] : console.log);
    try {
      sink.call(logger && typeof logger[level] === 'function' ? logger : console, line);
    } catch {
      // logging must never break the plugin
    }
  }

  const server = new ServerManager(resolved, { log });
  const getContext = () => ({ config: resolved, server, log });

  const definitions = createTools({ getContext }).map((definition) => ({
    ...definition,
    async execute(args, exec) {
      try {
        return await definition.execute(args, exec);
      } catch (error) {
        log('warn', `${definition.name} failed: ${error?.message ?? error}`);
        throw error;
      }
    },
  }));

  if (resolved.guidance) {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.effect(
        () =>
          scope.systemPrompt.section({
            name: 'dsh-has-tagged-text',
            order: 900,
            text: GUIDANCE,
          }),
        'dsh-has: tagged-text guidance',
      );
    });
  }

  ctx.effect(() => {
    const disposers = definitions.map((definition) => ctx.tools.register(definition));
    log('info', `ready (model: ${resolved.modelPath ?? 'missing'}, server: ${resolved.llamaServerPath ?? 'missing'})`);
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          log('warn', `failed to unregister a tool: ${error?.message ?? error}`);
        }
      }
      server.dispose().catch((error) => log('warn', `failed to stop llama-server: ${error?.message ?? error}`));
    };
  }, 'dsh-has: local anonymization tools');
}

export { resolveConfig, ServerManager };
