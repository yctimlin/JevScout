import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activityPath, formatActivity, formatBytes, readActivity, recordActivity, summarizeActivity } from '../src/activity.ts';
import { hookConfig, hookSettings, postToolHook } from '../src/hook.ts';

function withCache(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-activity-'));
  const previous = process.env.JEVSCOUT_CACHE_DIR;
  process.env.JEVSCOUT_CACHE_DIR = dir;
  t.after(() => { process.env.JEVSCOUT_CACHE_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const records = Array.from({ length: 40 }, (_, i) => ({
  number: 1000 + i, title: i === 27 ? 'Webhook retries ignore Retry-After on 429' : `Unrelated change ${i}`,
  body: i === 27 ? 'The retry loop sleeps a fixed 1s. It should honor the Retry-After header returned with 429 responses.' : `Routine maintenance text for item ${i}. `.repeat(8),
}));
const searchJson = JSON.stringify({ total_count: 40, items: records });

// An oversized MCP result as Claude Code delivers it: a notice pointing at the session's saved copy.
function oversized(dir: string, text: string) {
  const transcript = join(dir, 'p', 's.jsonl');
  const results = join(dir, 'p', 's', 'tool-results');
  mkdirSync(results, { recursive: true });
  writeFileSync(transcript, '');
  const saved = join(results, 'mcp-gh-1.txt');
  writeFileSync(saved, text);
  const notice = `Error: result (200,000 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text`;
  return { tool_name: 'mcp__gh__search', tool_input: { query: 'Retry-After 429' }, transcript_path: transcript, tool_response: [{ type: 'text', text: notice }] };
}

test('activity records sizes and reasons only, and JEVSCOUT_ACTIVITY=off disables it', t => {
  withCache(t);
  recordActivity({ host: 'claude', tool: 'mcp__gh__search', action: 'passed', reason: 'inline', inputBytes: 1200, ms: 1 });
  recordActivity({ host: 'claude', tool: 'mcp__gh__search', action: 'passed', reason: 'inline', inputBytes: 1200, ms: 1 }, { JEVSCOUT_ACTIVITY: 'off' });
  const events = readActivity();
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['action', 'at', 'host', 'inputBytes', 'ms', 'reason', 'tool']);
  assert.equal(statSync(activityPath()).mode & 0o777, 0o600);
  assert.deepEqual(readActivity(Date.now() + 60_000), [], 'events older than the window are left out');
});

test('a torn line is skipped and the log keeps its newest half past the cap', t => {
  withCache(t);
  recordActivity({ host: 'claude', tool: 't', action: 'passed', reason: 'small', inputBytes: 1, ms: 0 });
  writeFileSync(activityPath(), readFileSync(activityPath(), 'utf8') + '{"at":"2026-\n');
  recordActivity({ host: 'claude', tool: 't', action: 'passed', reason: 'small', inputBytes: 2, ms: 0 });
  assert.deepEqual(readActivity().map(event => event.inputBytes), [1, 2]);
  const line = JSON.stringify({ at: new Date().toISOString(), host: 'claude', tool: 'x'.repeat(900), action: 'passed', reason: 'small', inputBytes: 0, ms: 0 }) + '\n';
  writeFileSync(activityPath(), line.repeat(2100));
  recordActivity({ host: 'claude', tool: 'last', action: 'passed', reason: 'small', inputBytes: 3, ms: 0 });
  const kept = readActivity();
  assert.ok(statSync(activityPath()).size < 2_000_000);
  assert.ok(kept.length > 1000 && kept.length < 1100);
  assert.equal(kept.at(-1)?.tool, 'last');
});

test('the summary counts decisions per host and reports what was kept out of context', () => {
  const at = '2026-09-30T10:00:00.000Z';
  const summary = summarizeActivity([
    { at, host: 'claude', tool: 'mcp__a', action: 'condensed', inputBytes: 400_000, outputBytes: 6000, segments: 90, shown: 3, ms: 2000, typeSafe: { calls: 2, inputTokens: 5000, outputTokens: 40, model: 'jev-1.13.0' } },
    { at, host: 'claude', tool: 'mcp__b', action: 'condensed', inputBytes: 200_000, outputBytes: 4000, segments: 40, shown: 2, ms: 1000, typeSafe: { calls: 1, inputTokens: 2000, outputTokens: 20, model: 'jev-1.13.0' } },
    { at, host: 'claude', tool: 'mcp__c', action: 'passed', reason: 'inline', inputBytes: 900, ms: 0 },
    { at, host: 'claude', tool: 'mcp__c', action: 'passed', reason: 'no-key', inputBytes: 150_000, ms: 1 },
    { at, host: 'codex-proxy', tool: 'search', action: 'passed', reason: 'small', inputBytes: 100, ms: 0 },
  ]);
  assert.deepEqual(summary.byHost.claude, { condensed: 2, passed: 2, reasons: { inline: 1, 'no-key': 1 } });
  assert.equal(summary.medianCondenseMs, 1000);
  assert.deepEqual(summary.typeSafe, { calls: 3, inputTokens: 7000, outputTokens: 60 });
  assert.deepEqual(summary.models, ['jev-1.13.0']);
  const text = formatActivity(summary, 7);
  assert.match(text, /Claude Code hook: 2 condensed, 2 passed through unchanged/);
  assert.match(text, /Codex MCP proxy: 0 condensed, 1 passed/);
  assert.match(text, /Condensed 600 KB of tool output into 10\.0 KB of packets \(98% kept out of context\)/);
  assert.match(text, /no TYPESAFE_API_KEY/);
  assert.match(formatActivity(summarizeActivity([]), 1), /No activity recorded yet/);
  assert.deepEqual([formatBytes(999), formatBytes(12_345), formatBytes(456_000), formatBytes(2_500_000)], ['999 B', '12.3 KB', '456 KB', '2.5 MB']);
});

test('the hook tells the user, not the model, when it condenses a result', async t => {
  const dir = withCache(t);
  const config = { ...hookConfig({ JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000' }), budgetBytes: 3000 };
  const output = await postToolHook(oversized(dir, searchJson), config) as any;
  assert.ok(output.hookSpecificOutput.updatedToolOutput.includes('Retry-After'));
  assert.match(output.systemMessage, /^JevScout kept \d+(\.\d)? KB of this \d+(\.\d)? KB result \(\d+ of \d+ segments, keyword selection, \d+\.\d s\)/);
  assert.ok(!output.hookSpecificOutput.updatedToolOutput.includes(output.systemMessage), 'the notice is not part of the model-visible packet');
  const [event] = readActivity();
  assert.equal(event.action, 'condensed');
  assert.equal(event.inputBytes, Buffer.byteLength(searchJson));
  assert.ok(event.id && !JSON.stringify(event).includes('Retry-After'), 'the log holds no source text or query');
  assert.equal(hookConfig({ JEVSCOUT_HOOK_NOTICES: 'off' }).notices, false);
  const quiet = await postToolHook(oversized(dir, searchJson), { ...config, notices: false }) as any;
  assert.equal(quiet.systemMessage, undefined);
  assert.ok(quiet.hookSpecificOutput.updatedToolOutput);
});

test('an oversized result that passes through for a missing key says why; routine pass-throughs stay silent', async t => {
  const dir = withCache(t);
  const config = { ...hookConfig({ JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000' }), typeSafeKey: undefined, budgetBytes: 3000 };
  const output = await postToolHook(oversized(dir, searchJson), config) as any;
  assert.deepEqual(Object.keys(output), ['systemMessage'], 'the tool result itself is left unchanged');
  assert.match(output.systemMessage, /TYPESAFE_API_KEY isn't set where Claude Code runs/);
  assert.equal(await postToolHook(oversized(dir, searchJson), { ...config, notices: false }), null);
  assert.equal(await postToolHook({ tool_name: 'mcp__x__y', tool_input: {}, tool_response: [{ type: 'text', text: 'small' }] }, config), null);
  assert.deepEqual(readActivity().map(event => event.reason), ['no-key', 'no-key', 'inline']);
});

test('a Jev error or low confidence passes the result through with a notice', async t => {
  const dir = withCache(t);
  const config = { ...hookConfig({ JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000' }), typeSafeKey: 'k', budgetBytes: 3000 };
  const failing = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
  const unsure = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const answers = Object.fromEntries(body.state.documents.map((doc: { id: string }) => [doc.id, { type: 'noul', noul: 0.05 }]));
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 2 } }));
  }) as unknown as typeof fetch;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = failing;
  assert.match((await postToolHook(oversized(dir, searchJson), config) as any).systemMessage, /Jev was unavailable/);
  globalThis.fetch = unsure;
  assert.match((await postToolHook(oversized(dir, searchJson), config) as any).systemMessage, /Jev found no likely relevant part/);
  const [provider, lowConfidence] = readActivity();
  assert.equal(provider.reason, 'provider');
  assert.equal(lowConfidence.reason, 'low-confidence');
  assert.equal(lowConfidence.typeSafe?.model, 'jev-test', 'TypeSafe usage is recorded even when nothing is condensed');
});

test('the installed hook shows a spinner message while it runs', () => {
  const settings = hookSettings('/opt/jevscout/dist/cli.js');
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].statusMessage, 'JevScout is checking this result');
});

test('as a plugin, the hook reads the plugin key, prints a stable recovery command and names the plugin settings', async t => {
  const dir = withCache(t);
  const { CLI_PATH, insidePlugin, outputCommand, passedNotice } = await import('../src/hook.ts');
  const { dirname } = await import('node:path');
  const root = dirname(dirname(CLI_PATH));
  assert.equal(insidePlugin(CLI_PATH, { CLAUDE_PLUGIN_ROOT: root }), true);
  assert.equal(insidePlugin(CLI_PATH, { CLAUDE_PLUGIN_ROOT: dir }), false, 'another plugin root does not count');
  assert.equal(insidePlugin(CLI_PATH, {}), false);
  assert.equal(hookConfig({ CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: 'from-plugin' }).typeSafeKey, 'from-plugin');
  assert.equal(hookConfig({ TYPESAFE_API_KEY: 'from-shell', CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: 'from-plugin' }).typeSafeKey, 'from-shell');
  assert.equal(hookConfig({ CLAUDE_PLUGIN_ROOT: root }).plugin, true);
  const previous = process.env.CLAUDE_PLUGIN_ROOT;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = previous; });
  process.env.CLAUDE_PLUGIN_ROOT = root;
  assert.equal(outputCommand(), 'jevscout output');
  assert.notEqual(outputCommand('/elsewhere/jevscout/dist/cli.js'), 'jevscout output', 'an allow rule for another install keeps its full path');
  delete process.env.CLAUDE_PLUGIN_ROOT;
  assert.match(outputCommand(), / output$/);
  assert.match(passedNotice('no-key', 200_000, { plugin: true })!, /Run \/plugin configure jevscout@jevscout in Claude Code/);
  assert.match(passedNotice('no-key', 200_000)!, /Export it in the shell/);
});

test('when the plugin and a settings hook both run on one result, only the first condenses it', async t => {
  const dir = withCache(t);
  const { claimToolCall } = await import('../src/hook.ts');
  const config = { ...hookConfig({ JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000' }), budgetBytes: 3000 };
  const input = { ...oversized(dir, searchJson), tool_use_id: 'toolu_same' };
  const first = await postToolHook(input, config) as any;
  assert.ok(first.hookSpecificOutput.updatedToolOutput);
  assert.equal(await postToolHook(input, config), null, 'the second hook leaves the result to the first');
  assert.deepEqual(readActivity().map(event => event.reason ?? event.action), ['condensed', 'duplicate']);
  assert.equal(claimToolCall(undefined), true, 'calls without an id are never deduplicated');
  assert.equal(claimToolCall('toolu_old', Date.now()), true);
  assert.equal(claimToolCall('toolu_new', Date.now() + 2 * 86_400_000), true, 'claims older than a day are pruned');
  assert.equal(claimToolCall('toolu_old', Date.now() + 2 * 86_400_000), true, 'a pruned claim can be taken again');
});
