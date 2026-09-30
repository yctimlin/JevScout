import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hookSettings } from '../src/hook.ts';

// The repository root is also the Claude Code plugin root.
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const pkg = json('package.json');

test('the plugin, its marketplace entry and the npm package release together', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const marketplace = json('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'jevscout');
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.name, 'jevscout');
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, 'jevscout');
  // Installs come from the release tag, so unreleased work on main never reaches plugin users.
  assert.deepEqual(entry.source, { source: 'github', repo: 'yctimlin/JevScout', ref: `v${pkg.version}` });
  assert.equal(entry.description, plugin.description);
  assert.deepEqual(Object.keys(plugin.userConfig), ['typesafe_api_key']);
  assert.equal(plugin.userConfig.typesafe_api_key.sensitive, true, 'the key goes to the credential store, not settings');
});

test('the plugin hook is the settings hook, started from the plugin root with a compile cache', () => {
  const { hooks } = json('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks), ['PostToolUse'], 'the opt-in shell rewrite is not part of the plugin');
  const [group] = hooks.PostToolUse;
  const [settingsGroup] = hookSettings('/opt/jevscout/dist/cli.js').hooks.PostToolUse;
  assert.equal(group.matcher, settingsGroup.matcher);
  assert.equal(group.hooks.length, 1);
  const { command, ...rest } = group.hooks[0];
  const { command: _settingsCommand, ...settingsRest } = settingsGroup.hooks[0];
  assert.deepEqual(rest, settingsRest);
  // Type-stripping src/*.ts costs ~45 ms per call without the cache, about the same as dist/ with it.
  assert.equal(command, 'NODE_COMPILE_CACHE="${CLAUDE_PLUGIN_DATA}/compile-cache" node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" hook post-tool');
});

test('no skill ships with the plugin', () => {
  // Claude Code loads every skill under a plugin root's skills/ into each session. The experimental
  // CLI skill lives in experimental/skills/ until an evaluation supports loading it by default.
  assert.equal(existsSync(join(root, 'skills')), false);
});

test("bin/jevscout runs this checkout's CLI", () => {
  const bin = join(root, 'bin', 'jevscout');
  assert.ok(statSync(bin).mode & 0o100, 'bin/jevscout is executable');
  const run = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), pkg.version);
});

test('the hook runs from the plugin root as Claude Code starts it, and names the bare recovery command', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // An oversized MCP result as Claude Code delivers it: a notice pointing at the session's saved copy.
  const transcript = join(dir, 'session.jsonl');
  const results = join(dir, 'session', 'tool-results');
  mkdirSync(results, { recursive: true });
  writeFileSync(transcript, '');
  const records = Array.from({ length: 600 }, (_, i) => ({ id: i, title: `Maintenance note ${i}`, body: `Cache warmup and log rotation for build ${i}. `.repeat(6) }));
  records[417] = { id: 417, title: 'Rollback a failed deploy', body: 'To roll back a failed deploy, run deployctl rollback --to previous and confirm the health check.' };
  const text = JSON.stringify({ items: records });
  const saved = join(results, 'mcp-plugin-test.txt');
  writeFileSync(saved, text);
  const input = {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__docs__search', tool_use_id: 'toolu_plugin_test',
    tool_input: { query: 'rollback failed deploy' }, transcript_path: transcript,
    tool_response: [{ type: 'text', text: `Error: result (${text.length.toLocaleString('en-US')} characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text\n` }],
  };
  const pluginData = join(dir, 'plugin-data');
  const command = json('hooks/hooks.json').hooks.PostToolUse[0].hooks[0].command
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('${CLAUDE_PLUGIN_DATA}', pluginData);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('JEVSCOUT_') && key !== 'TYPESAFE_API_KEY'));
  const run = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8',
    env: { ...env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pluginData, JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_CACHE_DIR: join(dir, 'cache') } });
  assert.equal(run.status, 0, run.stderr);
  const packet: string = JSON.parse(run.stdout).hookSpecificOutput.updatedToolOutput;
  assert.ok(packet.includes('deployctl rollback --to previous'));
  assert.ok(Buffer.byteLength(packet) < Buffer.byteLength(text) / 10);
  assert.match(packet, /jevscout output \S+/, 'recovery names the command bin/ puts on PATH');
  assert.ok(!packet.includes(root), 'the packet does not embed the versioned plugin path');
  assert.ok(existsSync(join(pluginData, 'compile-cache')), 'the compile cache lives in the plugin data directory');
});
