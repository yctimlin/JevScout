import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { condense, outputDir, projectRecord, pruneOutputs, queryTerms, recoverOutput, segment } from '../src/condense.ts';
import { EXTERNAL_COMMAND, hookConfig, hookQuery, isLocator, savedOutputPath, updateSettings, withJevScout, withoutJevScout, latestUserPrompt, mcpText, postToolHook, preBashHook, shellQuote } from '../src/hook.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function withCache(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-hook-'));
  const previous = process.env.JEVSCOUT_CACHE_DIR;
  process.env.JEVSCOUT_CACHE_DIR = dir;
  t.after(() => { process.env.JEVSCOUT_CACHE_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const noise = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`field_${i}_url`, `https://api.example.com/x/${i}{/y}`]));
const records = Array.from({ length: 40 }, (_, i) => ({
  number: 1000 + i, title: i === 27 ? 'Webhook retries ignore Retry-After on 429' : `Unrelated change ${i}`,
  state: 'open', html_url: `https://example.com/items/${1000 + i}`, node_id: `NODE${i}`,
  body: i === 27 ? 'The retry loop sleeps a fixed 1s. It should honor the Retry-After header returned with 429 responses.' : `Routine maintenance text for item ${i}. `.repeat(8),
  ...noise(12),
}));
const searchJson = JSON.stringify({ total_count: 40, incomplete_results: false, items: records });

test('JSON responses split per record with exact source spans', () => {
  const segments = segment(searchJson);
  assert.equal(segments.length, 40);
  for (const item of segments) assert.equal(searchJson.slice(item.start, item.end), item.text);
  assert.deepEqual(JSON.parse(segments[27].text).number, 1027);
  assert.ok(segments[27].label.includes('Webhook retries'));
});

test('record views keep prose, identifiers and one human link, and hide templated API URLs', () => {
  const view = projectRecord(records[27]);
  assert.ok(view.display.includes('number: 1027'));
  assert.ok(view.display.includes('Retry-After header'));
  assert.ok(view.display.includes('html_url: https://example.com/items/1027'));
  assert.ok(!view.display.includes('api.example.com'));
  assert.ok(!view.display.includes('NODE27'));
  assert.ok(view.shown < view.total);
});

test('condense selects the relevant record within budget and saves the original for recovery', async t => {
  withCache(t);
  const result = await condense(searchJson, { query: 'why do webhook retries ignore Retry-After on 429', source: 'test', budgetBytes: 2500 });
  assert.ok(result.outputBytes <= 2500);
  assert.ok(result.text.includes('Webhook retries ignore Retry-After on 429'));
  assert.ok(result.text.includes(`jevscout output ${result.id}`));
  assert.equal(recoverOutput(result.id, { all: true }), searchJson);
  const raw = recoverOutput(result.id, { segment: 27 });
  assert.ok(raw.includes('"node_id":"NODE27"'), 'segment recovery returns the exact raw record');
  const grep = recoverOutput(result.id, { grep: 'Retry-After' });
  assert.ok(grep.includes('segment 27') && Buffer.byteLength(grep) < 5000, 'grep is bounded even for one-line JSON');
});

test('markdown and plain text split at headings and blank lines', async t => {
  withCache(t);
  const doc = ['# Intro', 'Welcome text. '.repeat(40), '', '## Install', 'npm install thing. '.repeat(40), '', '## Retry policy',
    'Retries honor the Retry-After header and cap at five attempts.', '', '## License', 'MIT. '.repeat(80)].join('\n');
  const result = await condense(doc, { query: 'retry policy Retry-After', source: 'doc', budgetBytes: 1200 });
  assert.ok(result.text.includes('cap at five attempts'));
  assert.ok(result.text.includes('Omitted:'));
});

test('Jev failure falls back to lexical selection with a notice', async t => {
  withCache(t);
  const fetcher = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  const result = await condense(searchJson, { query: 'Retry-After', source: 'test', budgetBytes: 3000, mode: 'auto', typeSafeKey: 'k', fetcher });
  assert.equal(result.usedMode, 'lexical');
  assert.ok(result.text.includes('Jev ranking unavailable'));
  assert.ok(result.text.includes('Retry-After'));
});

test('Jev scores reorder selection when available', async t => {
  withCache(t);
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const answers = Object.fromEntries(body.state.documents.map((doc: { id: string }) => [doc.id, { type: 'noul', noul: doc.id === '3' ? 0.99 : 0.01 }]));
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 2 } }));
  }) as unknown as typeof fetch;
  const result = await condense(searchJson, { query: 'maintenance item', source: 'test', budgetBytes: 2000, mode: 'auto', typeSafeKey: 'k', fetcher });
  assert.equal(result.usedMode, 'jev');
  assert.ok(result.text.includes('number: 1003'));
});

test('post-tool hook condenses large MCP text, and leaves small, non-text, and built-in results alone', async t => {
  withCache(t);
  const config = { ...hookConfig({}), budgetBytes: 3000 };
  const big = [{ type: 'text', text: searchJson }];
  const output = await postToolHook({ tool_name: 'mcp__github__search_issues', tool_input: { query: 'Retry-After 429' }, tool_response: big }, config) as any;
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(output.hookSpecificOutput.updatedToolOutput.includes('Retry-After'));
  assert.equal(await postToolHook({ tool_name: 'mcp__x__y', tool_input: {}, tool_response: [{ type: 'text', text: 'small' }] }, config), null);
  assert.equal(await postToolHook({ tool_name: 'mcp__x__y', tool_input: {}, tool_response: [...big, { type: 'image', data: 'AAA' }] }, config), null);
  assert.equal(await postToolHook({ tool_name: 'Read', tool_input: {}, tool_response: big }, config), null);
  assert.equal(mcpText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('the relevance query includes the latest typed user prompt, not tool results', t => {
  const dir = withCache(t);
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'first question' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'why are webhook retries broken?' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'noise' }] } },
  ].map(item => JSON.stringify(item)).join('\n'));
  assert.equal(latestUserPrompt(transcript), 'why are webhook retries broken?');
  assert.equal(latestUserPrompt(join(dir, 'missing.jsonl')), '');
});

test('pre-bash hook wraps external fetch commands only and never grants permission', () => {
  assert.ok(EXTERNAL_COMMAND.test('gh api repos/x/y/issues'));
  assert.ok(EXTERNAL_COMMAND.test('curl -s https://example.com'));
  for (const command of ['rg foo', 'cat file', 'git log', 'ghost run', 'echo gh api']) assert.equal(EXTERNAL_COMMAND.test(command), false, command);
  const original = "gh api 'repos/o/r/issues?q=it''s'";
  const output = preBashHook({ tool_name: 'Bash', tool_input: { command: original, description: 'd' } }, '/x/cli.js') as any;
  const specific = output.hookSpecificOutput;
  assert.equal(specific.permissionDecision, undefined);
  assert.equal(specific.updatedInput.description, 'd');
  assert.ok(specific.updatedInput.command.startsWith(`${original} | `), 'original command stays verbatim at the front');
  assert.ok(specific.updatedInput.command.includes(' /x/cli.js condense --source bash'));
  assert.equal(preBashHook({ tool_name: 'Bash', tool_input: { command: specific.updatedInput.command } }), null, 'no double wrapping');
  for (const command of ['gh api x | jq .', 'curl x > f', 'gh api x; rm y', 'curl $(cat u)', 'curl "$(cat u)"', "gh api 'x' && rm y"]) {
    assert.equal(preBashHook({ tool_name: 'Bash', tool_input: { command } }), null, command);
  }
  for (const command of ["gh api 'search/issues?q=a+b&per_page=30'", 'curl -s "https://x.test/?a=1&b=2"', 'gh api x\\&y']) {
    assert.ok(preBashHook({ tool_name: 'Bash', tool_input: { command } }), command);
  }
  assert.equal(preBashHook({ tool_name: 'Bash', tool_input: { command: 'rg foo' } }), null);
});

test('exec keeps exit codes and stderr, passes small output, and condenses large output', t => {
  const dir = withCache(t);
  const env = { ...process.env, JEVSCOUT_CACHE_DIR: dir, JEVSCOUT_HOOK_BUDGET_BYTES: '3000' };
  const small = spawnSync(process.execPath, [cli, 'exec', '--source', 'bash', '--query', 'q', '--', 'bash', '-c', 'echo hi; echo oops >&2; exit 3'], { env, encoding: 'utf8' });
  assert.equal(small.status, 3);
  assert.equal(small.stdout, 'hi\n');
  assert.equal(small.stderr, 'oops\n');
  const file = join(dir, 'big.json');
  writeFileSync(file, searchJson);
  const big = spawnSync(process.execPath, [cli, 'exec', '--source', 'bash', '--query', 'Retry-After 429', '--', 'cat', file], { env, encoding: 'utf8' });
  assert.equal(big.status, 0);
  assert.ok(big.stdout.startsWith('[JevScout condensed bash output'));
  assert.ok(Buffer.byteLength(big.stdout) <= 3000);
});

test('hook entry points fail open on malformed input', () => {
  for (const kind of ['post-tool', 'pre-bash', 'unknown']) {
    const run = spawnSync(process.execPath, [cli, 'hook', kind], { input: 'not json', encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  }
  const settings = JSON.parse(spawnSync(process.execPath, [cli, 'hook', 'settings'], { encoding: 'utf8' }).stdout);
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'mcp__.*');
  assert.equal(settings.hooks.PreToolUse, undefined, 'the shell rewrite is opt-in');
  const shell = JSON.parse(spawnSync(process.execPath, [cli, 'hook', 'settings', '--with-shell'], { encoding: 'utf8' }).stdout);
  assert.equal(shell.hooks.PreToolUse[0].matcher, 'Bash');
});

test('oversized MCP results are read from the session tool-results copy, and nowhere else', async t => {
  const dir = withCache(t);
  const { mkdirSync } = await import('node:fs');
  const transcript = join(dir, 'project', 'session-1.jsonl');
  const results = join(dir, 'project', 'session-1', 'tool-results');
  mkdirSync(results, { recursive: true });
  writeFileSync(transcript, '');
  const saved = join(results, 'mcp-gh-search-1.txt');
  writeFileSync(saved, searchJson);
  const outside = join(dir, 'secret.txt');
  writeFileSync(outside, 'private');
  const notice = (path: string) => `Error: result (206,529 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\nYou MUST read the content in sequential chunks.`;
  assert.ok(savedOutputPath(notice(saved), transcript)?.endsWith('mcp-gh-search-1.txt'));
  assert.equal(savedOutputPath(notice(outside), transcript), null);
  assert.equal(savedOutputPath(notice(join(results, '..', '..', '..', 'secret.txt')), transcript), null);
  const output = await postToolHook({ tool_name: 'mcp__gh__search', tool_input: { query: 'Retry-After 429' }, transcript_path: transcript,
    tool_response: [{ type: 'text', text: notice(saved) }] }, { ...hookConfig({}), budgetBytes: 3000 }) as any;
  assert.ok(output.hookSpecificOutput.updatedToolOutput.includes('Webhook retries ignore Retry-After'));
  assert.ok(!output.hookSpecificOutput.updatedToolOutput.includes('sequential chunks'));
});

test('packets say when distinctive query terms occur nowhere in the output', async t => {
  withCache(t);
  const result = await condense(searchJson, { query: 'LanguageModelStreamPart rename webhook', source: 'test', budgetBytes: 3000 });
  assert.ok(result.text.includes('Not found anywhere in this output: languagemodelstreampart'));
  assert.ok(!/Not found anywhere[^\n]*webhook/.test(result.text), 'terms present in the output are not listed');
});

test('oversized nested JSON objects split into their members with path labels', async t => {
  withCache(t);
  const time = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`1.${i}.0`, `2024-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}.000Z`]));
  const versions = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`1.${i}.0`, { name: 'pkg', version: `1.${i}.0`, description: 'x'.repeat(300) }]));
  const doc = JSON.stringify({ name: 'pkg', versions, time, readme: 'r' });
  const segments = segment(doc);
  assert.ok(segments.length > 800, 'large members are split');
  const target = segments.find(item => item.label.startsWith('.time.1.437.0'));
  assert.ok(target && doc.slice(target.start, target.end) === target.text);
  const result = await condense(doc, { query: 'publish time of version 1.437.0', source: 'npm', budgetBytes: 3000 });
  const grep = recoverOutput(result.id, { grep: '"1.437.0"' });
  assert.ok(grep.includes('1.437.0') && Buffer.byteLength(grep) < 8000);
});

test('a small lone array does not hide the rest of a JSON object', () => {
  const doc = JSON.stringify({ name: 'pkg', keywords: ['a', 'b', 'c'], time: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`1.${i}.0`, 'x'.repeat(40)])), readme: 'long '.repeat(400) });
  const labels = segment(doc).map(item => item.label);
  assert.ok(labels.some(label => label.startsWith('.time')) && labels.some(label => label.startsWith('.readme')));
});

test('query terms keep versions and dotted names intact', () => {
  const terms = queryTerms('When was hono 4.0.0 published, and does fs.watch or 7.0.0-beta.76 matter?');
  for (const term of ['4.0.0', 'fs.watch', '7.0.0-beta.76', 'hono', 'published']) assert.ok(terms.includes(term), term);
});

test('large records stay whole while large collections split', () => {
  const record = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, 'v'.repeat(300)]));
  const doc = JSON.stringify({ items: [record, record, record] });
  assert.equal(segment(doc).length, 3);
});

test('an exact version key outranks long records that merely mention it', async t => {
  withCache(t);
  const versions = Object.fromEntries(['4.0.0-rc.0', '4.0.0-rc.1', '4.0.0'].map(v => [v, { name: 'hono', version: v, description: `hono ${v} release notes `.repeat(40) }]));
  const time = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`3.${i}.0`, '2023-01-01T00:00:00.000Z']).concat([['4.0.0', '2024-02-09T06:09:03.353Z']]));
  const result = await condense(JSON.stringify({ name: 'hono', versions, time }), { query: 'publish timestamp of hono version 4.0.0', source: 'npm', budgetBytes: 1500 });
  assert.ok(result.text.includes('2024-02-09T06:09:03.353Z'));
});

test('URL arguments are left out of the relevance query', () => {
  assert.ok(isLocator('https://raw.githubusercontent.com/nodejs/node/main/doc/api/fs.md'));
  assert.ok(!isLocator('fs.watch recursive AIX'));
  const query = hookQuery({ url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/fs.md', topic: 'fs.watch on AIX' }, undefined);
  assert.ok(query.includes('fs.watch on AIX') && !query.includes('githubusercontent'));
});

test('JSON after a text preamble is still split into records', async t => {
  withCache(t);
  const wrapped = `Content type application/json; charset=utf-8 cannot be simplified to markdown, but here is the raw content:\nContents of https://api.example.com/issues:\n${searchJson}`;
  const segments = segment(wrapped);
  assert.ok(segments[0].label.startsWith('Content type'), 'the preamble is its own segment');
  assert.equal(segments.length, 41);
  assert.equal(JSON.parse(segments[28].text).number, 1027);
  const result = await condense(wrapped, { query: 'webhook retries Retry-After 429', source: 'fetch', budgetBytes: 3000 });
  assert.ok(result.text.includes('number: 1027'));
});

test('grep falls back to a case-insensitive regular expression when literal text finds nothing', async t => {
  withCache(t);
  const result = await condense(searchJson, { query: 'x', source: 'test', budgetBytes: 3000 });
  const out = recoverOutput(result.id, { grep: 'title.*RETRY-after' });
  assert.ok(out.includes('segment 27'));
  assert.ok(recoverOutput(result.id, { grep: '([' }).includes('No segments contain'), 'invalid regex is reported, not thrown');
});

test('a JSON array cut off by a character limit still splits into complete records', async t => {
  withCache(t);
  const items = JSON.stringify(records);
  const cut = `Contents of https://api.example.com/issues:\n${items.slice(0, Math.floor(items.length * 0.8))}`;
  const segments = segment(cut);
  assert.ok(segments.some(item => item.label.includes('truncated tail')));
  const target = segments.find(item => item.label.startsWith('[27]'));
  assert.ok(target && JSON.parse(target.text).number === 1027);
  const result = await condense(cut, { query: 'webhook retries Retry-After 429', source: 'fetch', budgetBytes: 3000 });
  assert.ok(result.text.includes('number: 1027'));
});

test('saved outputs expire after the configured number of days', async t => {
  withCache(t);
  const { utimesSync, existsSync } = await import('node:fs');
  const old = await condense(searchJson, { query: 'x', source: 'test', budgetBytes: 3000 });
  const fresh = await condense(searchJson, { query: 'x', source: 'test', budgetBytes: 3000 });
  const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
  for (const ext of ['txt', 'json']) utimesSync(join(outputDir(), `${old.id}.${ext}`), tenDaysAgo, tenDaysAgo);
  assert.equal(pruneOutputs(Date.now(), 7), 2);
  assert.ok(!existsSync(join(outputDir(), `${old.id}.txt`)) && existsSync(join(outputDir(), `${fresh.id}.txt`)));
  assert.equal(pruneOutputs(Date.now(), 0), 0, '0 keeps everything');
});

test('install merges into existing settings with a backup, and uninstall restores the rest exactly', t => {
  const dir = withCache(t);
  const file = join(dir, 'project', '.claude', 'settings.json');
  const original = { model: 'x', permissions: { allow: ['Bash(ls:*)'] }, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }] } };
  const { mkdirSync, readFileSync, existsSync } = require('node:fs');
  mkdirSync(join(dir, 'project', '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify(original));
  const installed = updateSettings(file, s => withJevScout(s, '/x/cli.js'));
  assert.ok(installed.backup && existsSync(installed.backup));
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.model, 'x');
  assert.equal(after.hooks.PostToolUse.length, 2);
  assert.ok(after.permissions.allow.includes('Bash(ls:*)'));
  assert.deepEqual(withJevScout(after, '/x/cli.js'), after, 'installing twice changes nothing');
  updateSettings(file, s => withoutJevScout(s, '/x/cli.js'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
});
