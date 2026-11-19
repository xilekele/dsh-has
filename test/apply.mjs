/**
 * Verifies the plugin entry point against a minimal fake Cordis context:
 * registration happens inside one effect, every tool is registered, and the
 * cleanup disposes the server manager. No model or llama-server is needed.
 */

import assert from 'node:assert/strict';

import { apply, name, inject } from '../index.js';

assert.equal(name, 'dsh-has');
assert.deepEqual(inject, ['tools']);

const registered = new Map();
const effects = [];
const sectioned = [];
let disposed = false;

const ctx = {
  tools: {
    register(definition) {
      assert.ok(definition?.name, 'tool needs a name');
      assert.equal(registered.has(definition.name), false, `duplicate tool ${definition.name}`);
      assert.equal(typeof definition.execute, 'function', `${definition.name}.execute`);
      assert.equal(typeof definition.output?.render, 'function', `${definition.name}.output.render`);
      assert.equal(definition.parameters?.type, 'object', `${definition.name}.parameters`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
  effect(fn, label) {
    const cleanup = fn();
    effects.push({ label, cleanup });
    return () => cleanup?.();
  },
  inject(names, fn) {
    // Cordis hands the callback a scoped context carrying the injected services.
    const scope = {
      effect: ctx.effect,
      systemPrompt: names.includes('systemPrompt') ? ctx.systemPrompt : undefined,
    };
    fn(scope);
  },
  get() {
    return undefined;
  },
  systemPrompt: {
    section(section) {
      sectioned.push(section);
      return () => {};
    },
  },
  logger() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  },
};

apply(ctx, { guidance: true });

const names = [...registered.keys()].sort();
assert.deepEqual(names, ['has_hide', 'has_restore', 'has_scan', 'has_status'], `registered: ${names}`);

const hide = registered.get('has_hide');
assert.equal(hide.parameters.required.includes('types'), true);
assert.ok(hide.parameters.properties.maxChunkTokens, 'has_hide exposes maxChunkTokens');

const scan = registered.get('has_scan');
assert.equal(scan.parameters.required.includes('types'), true);

const restore = registered.get('has_restore');
assert.deepEqual(restore.parameters.required, [], 'has_restore takes no required argument');

assert.equal(effects.length >= 1, true, 'tools are registered inside ctx.effect');
assert.equal(sectioned.length, 1, 'guidance section registered when enabled');
assert.equal(sectioned[0].name, 'dsh-has-tagged-text');
assert.ok(sectioned[0].text.includes('<EntityType[ID].Category.Attribute>'), 'guidance explains tags');

for (const { cleanup } of effects) cleanup?.();

assert.equal(registered.size, 0, 'cleanup unregisters every tool');
assert.equal(disposed, false); // no server was started, nothing to dispose

console.log('ok   apply registers four tools in one effect and cleans up');
