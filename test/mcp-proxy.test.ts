import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addIntent, addSelector, exactPublishTimestamp, matchesRegistryPackage, recoverResult, requireIntent, transformResult } from '../src/mcp-proxy.ts';
import { hookConfig } from '../src/hook.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('intent is offered only for tools likely to return bulk context', () => {
  const issue = { name: 'get_issue', description: 'Get one GitHub issue as JSON.', inputSchema: { type: 'object', properties: { number: { type: 'integer' } } } };
  const comments = { name: 'get_issue_comments', description: 'List comments on an issue.', inputSchema: { type: 'object' } };
  assert.deepEqual(addIntent(issue), issue);
  assert.ok(addIntent(comments).inputSchema.properties.jevscout_intent);
  assert.ok(addIntent({ name: 'fetchDocument', inputSchema: { type: 'object' } }).inputSchema.properties.jevscout_intent);
  assert.deepEqual(addIntent({ name: 'get_bread', inputSchema: { type: 'object' } }), { name: 'get_bread', inputSchema: { type: 'object' } });
  assert.deepEqual(requireIntent(issue), issue);
  assert.deepEqual(requireIntent({ name: 'fetch_doc', inputSchema: { type: 'object', required: ['url'] } }).inputSchema.required, ['url', 'jevscout_intent']);
});

test('a pass-through diagnostic omits source text and credentials', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-diagnostic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.JEVSCOUT_CODEX_DIAGNOSTICS;
  process.env.JEVSCOUT_CODEX_DIAGNOSTICS = join(dir, 'fallbacks.ndjson');
  t.after(() => { if (previous === undefined) delete process.env.JEVSCOUT_CODEX_DIAGNOSTICS;
    else process.env.JEVSCOUT_CODEX_DIAGNOSTICS = previous; });
  const original = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'private source text\n\nanother segment' }] } };
  assert.deepEqual(await transformResult(original, { name: 'fetch_doc', arguments: {}, intent: 'find private source text' },
    { ...hookConfig({}), minBytes: 1 }, 'stub'), original);
  const diagnostic = readFileSync(process.env.JEVSCOUT_CODEX_DIAGNOSTICS, 'utf8');
  assert.ok(diagnostic.includes('TYPESAFE_API_KEY is not set'));
  assert.ok(!diagnostic.includes('private source text'));
});

test('bounded recovery rejects full original while retaining exact segment reads', () => {
  const denied = recoverResult(1, { id: 'unused', all: true }, false);
  assert.equal(denied.result.isError, true);
  assert.ok(denied.result.content[0].text.includes('Whole-output recovery is unavailable'));
});

test('selectors keep the native schema and require a query for bulk tools', () => {
  const native = { name: 'fetch_doc', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
  const selected = addSelector(native);
  assert.equal(selected.name, 'jevscout_select_fetch_doc');
  assert.deepEqual(selected.inputSchema.required, ['url', 'jevscout_intent']);
  assert.deepEqual(native.inputSchema.required, ['url']);
  assert.equal(addSelector({ name: 'jevscout_select_fetch_doc', description: 'fetch docs' }), null);
});

test('exact publish timestamps use a unique JSON time key and retain the source span', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-exact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.JEVSCOUT_CACHE_DIR;
  process.env.JEVSCOUT_CACHE_DIR = dir;
  t.after(() => { process.env.JEVSCOUT_CACHE_DIR = previous; });
  const versions = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`0.4.${i}`, { name: 'pkg', description: 'package metadata '.repeat(20) }]));
  const time = Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`0.4.${i}`, `2012-08-05T19:52:${String(i % 60).padStart(2, '0')}.718Z`]));
  time['0.4.24'] = '2012-08-05T19:52:33.718Z';
  const data = JSON.stringify({ name: 'pkg', versions, time });
  const query = 'Find the exact publish timestamp for version 0.4.24.';
  assert.equal(exactPublishTimestamp(JSON.stringify({ time: { '0.4.24': time['0.4.24'] } }), query), null, 'small JSON has no independently recoverable time segment');
  const exact = exactPublishTimestamp(data, query);
  assert.equal(exact?.raw, '"0.4.24":"2012-08-05T19:52:33.718Z"');
  assert.equal(exact?.packageName, 'pkg');
  assert.equal(matchesRegistryPackage('https://registry.npmjs.org/pkg', exact!.packageName), true);
  assert.equal(matchesRegistryPackage('https://registry.npmjs.org/other', exact!.packageName), false);
  assert.equal(exactPublishTimestamp(data, "Find the exact time['0.4.24'] publish timestamp")?.raw, exact?.raw);
  assert.equal(exactPublishTimestamp(data, 'Compare version 0.4.24 and version 0.4.25 publish timestamps'), null);
  assert.equal(exactPublishTimestamp(data, 'Find the release notes for version 0.4.24'), null);
  assert.equal(exactPublishTimestamp(data, 'Find the timestamp for version 9.9.9'), null);
  const message = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: data }], structuredContent: JSON.parse(data) } };
  assert.deepEqual(await transformResult(message, { name: 'fetch_url', arguments: {}, intent: query }, { ...hookConfig({}), minBytes: 1 }, 'stub'), message, 'no key keeps the original');
  const result = await transformResult(message, { name: 'fetch_url', arguments: {}, intent: query }, { ...hookConfig({ TYPESAFE_API_KEY: 'test' }), minBytes: 1 }, 'stub');
  assert.ok(result.result.content[0].text.includes(exact!.raw));
  assert.equal(result.result.structuredContent, undefined);
  assert.ok(result.result.content[0].text.includes('jevscout_recover'));
  const id = /with id ([0-9a-f-]{36})/.exec(result.result.content[0].text)?.[1];
  assert.ok(id);
  assert.ok(recoverResult(2, { id, segment: exact!.index }).result.content[0].text.includes(exact!.raw));
  const blockedCache = join(dir, 'not-a-directory');
  writeFileSync(blockedCache, 'x');
  process.env.JEVSCOUT_CACHE_DIR = blockedCache;
  assert.deepEqual(await transformResult(message, { name: 'fetch_url', arguments: {}, intent: query }, { ...hookConfig({ TYPESAFE_API_KEY: 'test' }), minBytes: 1 }, 'stub'), message);
  process.env.JEVSCOUT_CACHE_DIR = dir;
  assert.deepEqual(await transformResult(message, { name: 'get_issue', arguments: { number: 1 } }, { ...hookConfig({ TYPESAFE_API_KEY: 'test' }), minBytes: 1 }, 'stub'), message);
});

// A stub upstream MCP server: echoes small results, returns a large document, and emits a notification.
const upstream = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const doc = Array.from({ length: 300 }, (_, i) => i === 211 ? '## Retry policy\\nRetries honor Retry-After and stop after five attempts.' : '## Section ' + i + '\\n' + 'Filler text about unrelated topics. '.repeat(6)).join('\\n\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'tools/list') send({ jsonrpc: '2.0', id: r.id, result: { tools: process.env.STUB_COLLISION
    ? [{ name: 'fetch_doc', inputSchema: { type: 'object' } }, { name: 'jevscout_select_fetch_doc', inputSchema: { type: 'object' } }, { name: 'fetch_notes', inputSchema: { type: 'object' } }]
    : [{ name: 'fetch_doc', inputSchema: { type: 'object' } }] } });
  else if (r.method === 'tools/call' && r.params.arguments.size === 'small') send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'tiny' }], structuredContent: { a: 1 } } });
  else if (r.method === 'tools/call' && 'jevscout_intent' in r.params.arguments) send({ jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'intent leaked upstream' } });
  else if (r.method === 'tools/call' && r.params.arguments.size === 'echo') send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: r.params.name }], structuredContent: r.params.arguments } });
  else if (r.method === 'tools/call') { send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }); send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: doc }], structuredContent: { doc } } }); }
  else if (r.id !== undefined) send({ jsonrpc: '2.0', id: r.id, result: {} });
});`;

async function session(messages: object[], env: NodeJS.ProcessEnv, dir: string): Promise<any[]> {
  const server = join(dir, 'upstream.mjs');
  writeFileSync(server, upstream);
  const child = spawn(process.execPath, [cli, 'mcp-proxy', '--source', 'stub', '--', process.execPath, server], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const out: any[] = [];
  let buffer = '';
  const expected = messages.filter((m: any) => m.id !== undefined).length;
  let listed: (() => void) | undefined;
  const listReady = new Promise<void>(resolve => { listed = resolve; });
  const firstList = (messages[0] as any)?.method === 'tools/list' ? (messages[0] as any).id : undefined;
  const done = new Promise<void>(resolve => child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) if (line) {
      const response = JSON.parse(line);
      out.push(response);
      if (response.id === firstList) listed?.();
    }
    if (out.filter(m => m.id !== undefined).length >= expected) resolve();
  }));
  if (firstList !== undefined) {
    child.stdin.write(JSON.stringify(messages[0]) + '\n');
    await listReady;
  }
  for (const message of messages.slice(firstList === undefined ? 0 : 1)) child.stdin.write(JSON.stringify(message) + '\n');
  await done;
  child.stdin.end();
  await once(child, 'close');
  return out;
}

test('the MCP proxy passes large results through unchanged when Jev cannot run', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-nojev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, JEVSCOUT_CACHE_DIR: dir };
  delete env.TYPESAFE_API_KEY; delete env.JEVSCOUT_HOOK_MODE;
  const out = await session([{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch_doc', arguments: { url: 'https://x.test/doc' } } }], env, dir);
  const text = out.find(m => m.id === 3).result.content[0].text;
  assert.ok(text.startsWith('## Section 0') && !text.includes('[JevScout condensed'), 'original returned untouched');
});

test('explicit selectors are opt-in, forward original arguments, and leave native collisions alone', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-explicit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, STUB_COLLISION: '1', JEVSCOUT_CODEX_ROUTE: 'explicit',
    JEVSCOUT_CACHE_DIR: dir, JEVSCOUT_HOOK_BUDGET_BYTES: '3000', JEVSCOUT_HOOK_MODE: 'lexical' };
  const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const out = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'fetch_doc', { size: 'echo' }),
    call(3, 'jevscout_select_fetch_doc', { size: 'echo' }),
    call(4, 'jevscout_select_fetch_notes', { jevscout_intent: 'retry policy Retry-After', size: 'echo' }),
    call(5, 'jevscout_select_fetch_notes', { size: 'echo' }),
    call(6, 'jevscout_select_fetch_notes', { jevscout_intent: 'retry policy Retry-After' }),
  ], env, dir);
  const byId = new Map(out.filter(m => m.id !== undefined).map(m => [m.id, m]));
  assert.deepEqual(byId.get(1).result.tools.map((tool: any) => tool.name),
    ['fetch_doc', 'jevscout_select_fetch_doc', 'fetch_notes', 'jevscout_select_fetch_notes', 'jevscout_recover']);
  assert.equal(byId.get(2).result.content[0].text, 'fetch_doc');
  assert.equal(byId.get(3).result.content[0].text, 'jevscout_select_fetch_doc');
  assert.equal(byId.get(4).result.content[0].text, 'fetch_notes');
  assert.deepEqual(byId.get(4).result.structuredContent, { size: 'echo' });
  assert.equal(byId.get(5).result.isError, true);
  const packet = byId.get(6).result.content[0].text;
  assert.ok(packet.includes('stop after five attempts'));
  assert.equal(byId.get(6).result.structuredContent, undefined);
  const id = /with id ([0-9a-f-]{36})/.exec(packet)?.[1];
  assert.ok(id);
  const recovered = await session([call(7, 'jevscout_recover', { id, grep: 'Retry-After' })], env, dir);
  assert.ok(recovered.find(m => m.id === 7).result.content[0].text.includes('Retries honor Retry-After'));
});

test('selector-only route exposes bulk selection first and honors the result size floor', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-selector-only-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base: NodeJS.ProcessEnv = { ...process.env, STUB_COLLISION: '1', JEVSCOUT_CODEX_ROUTE: 'selector-only',
    JEVSCOUT_CACHE_DIR: dir, JEVSCOUT_HOOK_BUDGET_BYTES: '3000', JEVSCOUT_HOOK_MODE: 'lexical' };
  const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'jevscout_select_fetch_notes', { jevscout_intent: 'retry policy Retry-After' }),
    call(3, 'jevscout_select_fetch_notes', { size: 'echo' }),
  ];
  const out = await session(messages, base, dir);
  const byId = new Map(out.filter(m => m.id !== undefined).map(m => [m.id, m]));
  assert.deepEqual(byId.get(1).result.tools.map((tool: any) => tool.name),
    ['fetch_doc', 'jevscout_select_fetch_doc', 'jevscout_select_fetch_notes', 'jevscout_recover']);
  assert.ok(byId.get(2).result.content[0].text.includes('stop after five attempts'));
  assert.equal(byId.get(3).result.isError, true);
  const floor = await session(messages.slice(0, 2), { ...base, JEVSCOUT_HOOK_MIN_BYTES: '100000' }, dir);
  const raw = floor.find(m => m.id === 2).result;
  assert.ok(raw.content[0].text.startsWith('## Section 0'));
  assert.ok(raw.structuredContent.doc.includes('Retry-After'));
});

test('required-intent route retains native names and forwards only upstream arguments', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-required-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, JEVSCOUT_CODEX_ROUTE: 'intent-required', JEVSCOUT_CACHE_DIR: dir,
    JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_HOOK_BUDGET_BYTES: '3000' };
  const out = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fetch_doc', arguments: { size: 'echo', jevscout_intent: 'retry policy' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch_doc', arguments: { jevscout_intent: 'retry policy Retry-After' } } },
  ], env, dir);
  const byId = new Map(out.filter(m => m.id !== undefined).map(m => [m.id, m]));
  assert.deepEqual(byId.get(1).result.tools.map((tool: any) => tool.name), ['fetch_doc', 'jevscout_recover']);
  assert.deepEqual(byId.get(1).result.tools[0].inputSchema.required, ['jevscout_intent']);
  assert.equal(byId.get(2).result.content[0].text, 'fetch_doc');
  assert.deepEqual(byId.get(2).result.structuredContent, { size: 'echo' });
  assert.ok(byId.get(3).result.content[0].text.includes('stop after five attempts'));
});

test('the MCP proxy condenses large text results, passes small ones through, and adds a recovery tool', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, JEVSCOUT_CACHE_DIR: dir, JEVSCOUT_HOOK_BUDGET_BYTES: '3000', JEVSCOUT_HOOK_MODE: 'lexical' };
  const out = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fetch_doc', arguments: { size: 'small' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch_doc', arguments: { url: 'https://x.test/doc', jevscout_intent: 'retry policy Retry-After' } } },
  ], env, dir);
  const byId = new Map(out.filter(m => m.id !== undefined).map(m => [m.id, m]));
  assert.deepEqual(byId.get(1).result.tools.map((tool: any) => tool.name), ['fetch_doc', 'jevscout_recover']);
  assert.ok(byId.get(1).result.tools[0].inputSchema.properties.jevscout_intent, 'upstream tools gain an optional intent argument');
  assert.deepEqual(byId.get(2).result, { content: [{ type: 'text', text: 'tiny' }], structuredContent: { a: 1 } }, 'small results are untouched');
  const packet = byId.get(3).result.content[0].text;
  assert.ok(Buffer.byteLength(packet) <= 3000);
  assert.ok(packet.includes('stop after five attempts'), 'a relevant late section is selected');
  assert.equal(byId.get(3).result.structuredContent, undefined, 'structured duplicate of the full payload is dropped');
  assert.ok(out.some(m => m.method === 'notifications/progress'), 'notifications pass through');
  const id = /with id ([0-9a-f-]{36})/.exec(packet)?.[1];
  assert.ok(id);
  const recovered = await session([{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'jevscout_recover', arguments: { id, grep: 'Retry-After' } } }], env, dir);
  assert.ok(recovered.find(m => m.id === 9).result.content[0].text.includes('Retries honor Retry-After'));
  const bad = await session([{ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'jevscout_recover', arguments: { id: 'nope' } } }], env, dir);
  assert.equal(bad.find(m => m.id === 10).result.isError, true);
});
