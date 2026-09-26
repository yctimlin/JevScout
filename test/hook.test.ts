import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JevUnavailableError, coarsePool, condense, recordHint, outputDir, projectRecord, pruneOutputs, queryTerms, recoverOutput, segment } from '../src/condense.ts';
import { EXTERNAL_COMMAND, hookConfig, hookQuery, hookSettings, installNotice, isLocator, savedOutputPath, updateSettings, withJevScout, withoutJevScout, latestUserPrompt, mcpText, postToolHook, preBashHook, shellQuote } from '../src/hook.ts';

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

test('in Jev mode, a Jev failure or a missing key means no condensing at all', async t => {
  withCache(t);
  const fetcher = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  await assert.rejects(() => condense(searchJson, { query: 'Retry-After', source: 'test', budgetBytes: 3000, mode: 'auto', typeSafeKey: 'k', fetcher }), JevUnavailableError);
  await assert.rejects(() => condense(searchJson, { query: 'Retry-After', source: 'test', budgetBytes: 3000, mode: 'auto' }), JevUnavailableError);
  const keyword = await condense(searchJson, { query: 'Retry-After', source: 'test', budgetBytes: 3000, mode: 'lexical' });
  assert.ok(keyword.text.includes('Keyword selection (Jev off)'), 'explicit keyword mode is labelled');
});

test('the post-tool hook passes results through unchanged when Jev cannot run', async t => {
  withCache(t);
  const big = [{ type: 'text', text: searchJson }];
  assert.equal(await postToolHook({ tool_name: 'mcp__gh__search', tool_input: { query: 'x' }, tool_response: big }, { ...hookConfig({}), budgetBytes: 3000 }).catch(() => null), null);
  const { runHook } = await import('../src/hook.ts');
  assert.equal(await runHook('post-tool', JSON.stringify({ tool_name: 'mcp__gh__search', tool_input: {}, tool_response: big })), '');
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
  const config = { ...hookConfig({ JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_HOOK_SCOPE: 'all' }), budgetBytes: 3000 };
  const big = [{ type: 'text', text: searchJson }];
  const output = await postToolHook({ tool_name: 'mcp__github__search_issues', tool_input: { query: 'Retry-After 429' }, tool_response: big }, config) as any;
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(output.hookSpecificOutput.updatedToolOutput.includes('Retry-After'));
  assert.equal(await postToolHook({ tool_name: 'mcp__x__y', tool_input: {}, tool_response: [{ type: 'text', text: 'small' }] }, config), null);
  assert.equal(await postToolHook({ tool_name: 'mcp__x__y', tool_input: {}, tool_response: [...big, { type: 'image', data: 'AAA' }] }, config), null);
  assert.equal(await postToolHook({ tool_name: 'Read', tool_input: {}, tool_response: big }, config), null);
  assert.equal(mcpText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('URLs inside the user prompt are left out of the relevance query', t => {
  const dir = withCache(t);
  const transcript = join(dir, 'u.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read https://raw.githubusercontent.com/prettier/prettier/main/CHANGELOG.md and find the marker' } }));
  const query = hookQuery({}, transcript);
  assert.ok(query.includes('find the marker') && !query.includes('prettier') && !query.includes('githubusercontent'));
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
  const env = { ...process.env, JEVSCOUT_CACHE_DIR: dir, JEVSCOUT_HOOK_BUDGET_BYTES: '3000', JEVSCOUT_HOOK_MODE: 'lexical' };
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
    tool_response: [{ type: 'text', text: notice(saved) }] }, { ...hookConfig({ JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000' }), budgetBytes: 3000 }) as any;
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

// A mock Jev that finds one document relevant by meaning, whatever the query words are.
function meaningJev(isRelevant: (text: string) => boolean, record: Array<{ ids: string[]; texts: string[] }> = []) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    record.push({ ids: body.state.documents.map((d: { id: string }) => d.id), texts: body.state.documents.map((d: { text: string }) => d.text) });
    const answers = Object.fromEntries(body.state.documents.map((doc: { id: string; text: string }) => [doc.id, { type: 'noul', noul: isRelevant(doc.text) ? 0.97 : 0.02 }]));
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 2 } }));
  }) as unknown as typeof fetch;
}

test('Jev can select a segment that shares no keywords with the query', async t => {
  withCache(t);
  const sections = Array.from({ length: 120 }, (_, i) => i === 83
    // Same length as its neighbours, so budget packing cannot slip it in by size alone.
    ? '## Housekeeping 83\nSockets that sit unused are torn down after 94 seconds, by the pool, for every one of them.'
    : `## Timeout option ${i}\nThe timeout setting controls how long a request may run before the client gives up, for call ${i}.`);
  const doc = sections.join('\n\n');
  const query = 'How long can an idle connection stay open before it is closed?';
  const lexical = await condense(doc, { query, source: 'docs', budgetBytes: 1500 });
  assert.ok(!lexical.text.includes('94 seconds'), 'lexical selection misses the paraphrased fact');
  const jev = await condense(doc, { query, source: 'docs', budgetBytes: 1500, mode: 'auto', typeSafeKey: 'k', fetcher: meaningJev(text => text.includes('torn down')) });
  assert.equal(jev.usedMode, 'jev');
  assert.ok(jev.text.includes('94 seconds'));
});

test('the coarse stage previews every segment, and large outputs mix lexical leaders with an even sample', async t => {
  withCache(t);
  const record: Array<{ ids: string[]; texts: string[] }> = [];
  // Nothing relevant: the call passes through, but every record was still previewed.
  await assert.rejects(() => condense(searchJson, { query: 'Retry-After', source: 'test', budgetBytes: 3000, mode: 'auto', typeSafeKey: 'k', fetcher: meaningJev(() => false, record) }), JevUnavailableError);
  const coarseIds = new Set(record.filter(call => call.texts.every(text => text.length <= 400)).flatMap(call => call.ids));
  assert.equal(coarseIds.size, 40, 'every record gets a preview');
  const many = Array.from({ length: 1000 }, (_, i) => ({ index: i, label: `s${i}`, start: 0, end: 0, text: '', display: '', group: i, score: i % 7 }));
  const pool = coarsePool(many as never, 400);
  assert.equal(pool.length, 400);
  assert.ok(pool.some(item => item.index > 900) && pool.some(item => item.index < 100), 'the sample spans the whole output');
});

test('a failed fine stage keeps the coarse ranking; a missing key is stated in the packet', async t => {
  withCache(t);
  let calls = 0;
  const flaky = (async (url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    if (body.state.documents.some((d: { text: string }) => d.text.length > 400)) return new Response('{}', { status: 503 });
    return meaningJev(text => text.includes('Webhook retries'))(url, init);
  }) as unknown as typeof fetch;
  const result = await condense(searchJson, { query: 'which item is about backoff headers?', source: 'test', budgetBytes: 3000, mode: 'auto', typeSafeKey: 'k', fetcher: flaky });
  assert.equal(result.usedMode, 'jev');
  assert.ok(result.text.includes('Webhook retries ignore Retry-After'));
  await assert.rejects(() => condense(searchJson, { query: 'x', source: 'test', budgetBytes: 3000, mode: 'auto' }), JevUnavailableError);
});

test('a JSON-like code sample inside a markdown document does not make it JSON', () => {
  const doc = ['# HTTP', '', 'Raw headers look like this:', '', '```js', "[ 'ConTent-Length', '123456',", "  'content-LENGTH', '123' ]", '```', '', ...Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nProse about section ${i}. `.repeat(3))].join('\n');
  const segments = segment(doc);
  assert.ok(segments.length > 30, 'split as markdown sections');
  assert.ok(segments.every(item => !item.label.includes('truncated tail')));
  assert.ok(segments.some(item => item.label.includes('Section 42')));
});

test('comment records are labelled by author and first line, and previews lead with their prose', () => {
  const comments = Array.from({ length: 5 }, (_, i) => ({ id: 1000 + i, node_id: `N${i}`, user: { login: `user${i}`, id: i }, created_at: '2024-01-01T00:00:00Z',
    author_association: 'NONE', reactions: { total_count: 0 }, body: i === 3 ? 'Raising the limit only postpones the crash; the cache is never reclaimed.' : `Routine comment ${i} with plenty of words to count as prose here.` }));
  const segments = segment(JSON.stringify(comments));
  assert.ok(segments[3].label.includes('user3: Raising the limit'));
  assert.ok(segments[3].preview.startsWith('body: Raising the limit'));
  assert.equal(recordHint({ id: 5 }), '5');
  assert.equal(recordHint({ title: 'T', body: 'B' }), 'T');
});

test('with Jev, the keyword "not found" notice gives way to Jev confidence', async t => {
  withCache(t);
  const sections = Array.from({ length: 60 }, (_, i) => i === 40 ? '## Housekeeping\nSockets that sit unused are torn down after 94 seconds.' : `## Topic ${i}\nUnrelated prose about topic ${i}.`);
  const doc = sections.join('\n\n');
  const query = 'How long can an idle connection linger before disconnection?';
  const confident = await condense(doc, { query, source: 'docs', budgetBytes: 1500, mode: 'auto', typeSafeKey: 'k', fetcher: meaningJev(text => text.includes('torn down')) });
  assert.ok(!confident.text.includes('Not found anywhere'), 'no keyword notice when Jev selected');
  assert.ok(!confident.text.includes('Jev found no part'));
  await assert.rejects(() => condense(doc, { query, source: 'docs', budgetBytes: 1500, mode: 'auto', typeSafeKey: 'k', fetcher: meaningJev(() => false) }), JevUnavailableError, 'low confidence passes through');
  const lexical = await condense(doc, { query, source: 'docs', budgetBytes: 1500, mode: 'lexical' });
  assert.ok(lexical.text.includes('Not found anywhere'), 'keyword selection keeps the keyword notice');
});

test('the called tool name is removed from the relevance query', t => {
  const dir = withCache(t);
  const transcript = join(dir, 'tool.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Using the fetch_url tool, find the retry policy' } }));
  const query = hookQuery({}, transcript, 'mcp__fixture__fetch_url');
  assert.ok(!query.includes('fetch_url') && query.includes('retry policy'));
});

test('install enables Jev by default, never writes the key, and explains the data flow', () => {
  const on = hookSettings('/x/cli.js');
  assert.ok(!JSON.stringify(on).includes('JEVSCOUT_HOOK_MODE'), 'Jev is the default mode');
  assert.ok(!JSON.stringify(on).includes('TYPESAFE_API_KEY='), 'the key is never written');
  const off = hookSettings('/x/cli.js', { lexicalOnly: true });
  assert.ok(off.hooks.PostToolUse[0].hooks[0].command.startsWith('JEVSCOUT_HOOK_MODE=lexical '));
  const missingKeyNotice = installNotice({}, {});
  assert.ok(missingKeyNotice.includes('TYPESAFE_API_KEY is not set'));
  assert.ok(missingKeyNotice.includes('pass through unchanged'));
  assert.ok(!missingKeyNotice.includes('local keyword selection'));
  assert.ok(installNotice({}, { TYPESAFE_API_KEY: 'k' }).includes('api.typesafe.ai') && !installNotice({}, { TYPESAFE_API_KEY: 'k' }).includes('not set'));
  assert.ok(installNotice({ lexicalOnly: true }).includes('nothing is sent'));
});

test('a transient Jev server error is retried once', async t => {
  withCache(t);
  let failures = 0;
  const flaky = (async (url: string, init: RequestInit) => {
    if (failures < 1) { failures++; return new Response('{}', { status: 500 }); }
    return meaningJev(text => text.includes('Webhook retries'))(url, init);
  }) as unknown as typeof fetch;
  const result = await condense(searchJson, { query: 'backoff headers', source: 'test', budgetBytes: 3000, mode: 'auto', typeSafeKey: 'k', fetcher: flaky });
  assert.equal(result.usedMode, 'jev');
  assert.equal(failures, 1);
});

test('by default only oversized results are condensed; inline results pass through', async t => {
  const dir = withCache(t);
  const { mkdirSync } = await import('node:fs');
  const transcript = join(dir, 'p', 's.jsonl');
  const results = join(dir, 'p', 's', 'tool-results');
  mkdirSync(results, { recursive: true });
  writeFileSync(transcript, '');
  const config = { ...hookConfig({ JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000' }), budgetBytes: 3000 };
  assert.equal(config.scope, 'oversized');
  const inline = await postToolHook({ tool_name: 'mcp__gh__search', tool_input: { query: 'Retry-After' }, transcript_path: transcript, tool_response: [{ type: 'text', text: searchJson }] }, config);
  assert.equal(inline, null, 'an inline 20 KB result is left alone');
  const saved = join(results, 'mcp-gh-1.txt');
  writeFileSync(saved, searchJson);
  const notice = `Error: result (200,000 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text`;
  const oversized = await postToolHook({ tool_name: 'mcp__gh__search', tool_input: { query: 'Retry-After' }, transcript_path: transcript, tool_response: [{ type: 'text', text: notice }] }, config) as any;
  assert.ok(oversized.hookSpecificOutput.updatedToolOutput.includes('Retry-After'));
  assert.equal(hookConfig({ JEVSCOUT_HOOK_SCOPE: 'all' }).scope, 'all');
});

test('oversized results below the size floor pass through', async t => {
  const dir = withCache(t);
  const { mkdirSync } = await import('node:fs');
  const transcript = join(dir, 'p', 'f.jsonl');
  const results = join(dir, 'p', 'f', 'tool-results');
  mkdirSync(results, { recursive: true });
  writeFileSync(transcript, '');
  const saved = join(results, 'mcp-x-1.txt');
  writeFileSync(saved, searchJson);
  const notice = `Error: result (60,000 characters) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text`;
  const input = { tool_name: 'mcp__x__y', tool_input: {}, transcript_path: transcript, tool_response: [{ type: 'text', text: notice }] };
  assert.equal(hookConfig({}).minOversizedBytes, 100_000);
  assert.equal(await postToolHook(input, { ...hookConfig({ JEVSCOUT_HOOK_MODE: 'lexical' }), budgetBytes: 3000 }), null, 'a ~20 KB saved result is below the default floor');
});
