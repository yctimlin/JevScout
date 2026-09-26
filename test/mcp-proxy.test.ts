import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// A stub upstream MCP server: echoes small results, returns a large document, and emits a notification.
const upstream = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const doc = Array.from({ length: 300 }, (_, i) => i === 211 ? '## Retry policy\\nRetries honor Retry-After and stop after five attempts.' : '## Section ' + i + '\\n' + 'Filler text about unrelated topics. '.repeat(6)).join('\\n\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'tools/list') send({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'fetch_doc', inputSchema: { type: 'object' } }] } });
  else if (r.method === 'tools/call' && r.params.arguments.size === 'small') send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'tiny' }], structuredContent: { a: 1 } } });
  else if (r.method === 'tools/call' && 'jevscout_intent' in r.params.arguments) send({ jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'intent leaked upstream' } });
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
  const done = new Promise<void>(resolve => child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) if (line) out.push(JSON.parse(line));
    if (out.filter(m => m.id !== undefined).length >= expected) resolve();
  }));
  for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n');
  await done;
  child.stdin.end();
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
