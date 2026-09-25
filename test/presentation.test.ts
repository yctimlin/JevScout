import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderEvidence, selectText } from '../src/present.ts';
import { digest, type Candidate } from '../src/retrieve.ts';

const pack = '00000000-0000-4000-8000-000000000000';
const evidence: Candidate[] = Array.from({ length: 8 }, (_, i) => ({
  id: digest(String(i)).slice(0, 16), file: `src/example-${i}.ts`, start: 1, end: 2,
  text: `// 退款 ${i}\nexport const deadline = ${i};`, hash: digest('source'), lexical: 1,
}));

test('compact output respects complete UTF-8 byte budget and keeps whole source excerpts', () => {
  const output = selectText(evidence, pack, 'jev', 600);
  assert.ok(output.selected.length > 0 && output.omitted.length > 0);
  assert.ok(Buffer.byteLength(output.text) <= 600);
  assert.equal(output.outputBytes, Buffer.byteLength(output.text));
  for (const item of output.selected) assert.ok(output.text.includes(renderEvidence(item)));
  for (const item of output.omitted) assert.ok(!output.text.includes(renderEvidence(item)));
  assert.ok(output.text.includes(`jevscout list ${pack}`));
  assert.ok(output.text.includes(`jevscout list ${pack}`));
  assert.ok(output.text.includes(`jevscout open ${pack}`));
  assert.ok(!output.text.includes(evidence[0].hash));
});

test('source output identifies complete files and numbers lines for citations', () => {
  const rendered = renderEvidence({ ...evidence[0], complete: true, fileLines: 2 });
  assert.match(rendered, /complete file/);
  assert.match(rendered, /1\|\/\/ 退款 0/);
  assert.match(rendered, /2\|export const deadline = 0;/);
});

test('selection prefers coverage across files before a second window from one file', () => {
  const sameFile = { ...evidence[1], file: evidence[0].file };
  const differentFile = evidence[2];
  const output = selectText([evidence[0], sameFile, differentFile], pack, 'jev', 2000);
  assert.deepEqual(output.selected.map(item => item.id), [evidence[0].id, differentFile.id, sameFile.id]);
});

test('ordinary code questions reserve output for implementation over repeated task text', () => {
  const repeatedTask = { ...evidence[0], file: 'bench/agent.ts', text: 'How does sourceAt stop a symlink outside the repository?', relevance: 0.99 };
  const source = { ...evidence[1], file: 'src/retrieve.ts', text: 'const path = realpathSync(resolve(base, file));', relevance: 0.85 };
  const output = selectText([repeatedTask, source], pack, 'jev', 2000, [], 'How does sourceAt stop a symlink?');
  assert.deepEqual(output.selected.map(item => item.file), ['src/retrieve.ts', 'bench/agent.ts']);
});

test('questions about tests can prefer test evidence', () => {
  const source = { ...evidence[0], file: 'src/retrieve.ts', text: 'function sourceAt() {}', relevance: 0.99 };
  const testFile = { ...evidence[1], file: 'test/core.test.ts', text: 'test("rejects symlink", () => {});', relevance: 0.85 };
  const output = selectText([source, testFile], pack, 'jev', 2000, [], 'Which test covers outside symlinks?');
  assert.deepEqual(output.selected.map(item => item.file), ['test/core.test.ts', 'src/retrieve.ts']);
});

test('implementation question keeps source first when it later asks for tests', () => {
  const source = { ...evidence[0], file: 'src/on-error.ts', text: 'function onError(error) { return error; }' };
  const verifyingTest = { ...evidence[1], file: 'test/on-error.test.ts', text: 'test("onError", () => {});' };
  const output = selectText([verifyingTest, source], pack, 'jev', 2000, [],
    'When a route handler throws, how does onError run? Cite relevant tests.');
  assert.deepEqual(output.selected.map(item => item.file), [source.file, verifyingTest.file]);
});

test('runtime behavior questions put implementation before declaration files', () => {
  const declarations = { ...evidence[0], file: 'index.d.ts', relevance: 0.95 };
  const implementation = { ...evidence[1], file: 'index.js', relevance: 0.7 };
  const output = selectText([declarations, implementation], pack, 'jev', 2000, [],
    'When an AbortError is thrown, does onFailedAttempt run?');
  assert.deepEqual(output.selected.map(item => item.file), [implementation.file, declarations.file]);
});

test('root-level test.js is a verifying test, not primary runtime source', () => {
  const testFile = { ...evidence[0], file: 'test.js', relevance: 0.95 };
  const implementation = { ...evidence[1], file: 'index.js', relevance: 0.7 };
  const output = selectText([testFile, implementation], pack, 'jev', 2000, [],
    'When AbortError is thrown, does the runtime schedule another attempt?');
  assert.deepEqual(output.selected.map(item => item.file), [implementation.file, testFile.file]);
});

test('a normal code investigation includes one verifying test before unrelated source', () => {
  const sources = [
    { ...evidence[0], file: 'src/a.ts' },
    { ...evidence[1], file: 'src/b.ts' },
    { ...evidence[2], file: 'src/c.ts' },
  ];
  const verifyingTest = { ...evidence[3], file: 'test/a.test.ts' };
  const output = selectText([...sources, verifyingTest], pack, 'jev', 2000, [], 'Why does a source check reject stale data?');
  assert.deepEqual(output.selected.map(item => item.file), ['src/a.ts', 'src/b.ts', 'test/a.test.ts', 'src/c.ts']);
});

test('a second window covering a new query term precedes a repeated import', () => {
  const implementation = { ...evidence[0], file: 'src/retrieve.ts', text: 'const path = realpathSync(root);' };
  const repeatedImport = { ...evidence[1], file: 'src/retrieve.ts', text: "import { realpathSync } from 'node:fs';" };
  const ignoreRule = { ...evidence[2], file: 'src/retrieve.ts', text: '// .gitignore controls ignored files' };
  const output = selectText([implementation, repeatedImport, ignoreRule], pack, 'jev', 2000, [], 'How do realpath and gitignore work?');
  assert.deepEqual(output.selected.map(item => item.id), [implementation.id, ignoreRule.id, repeatedImport.id]);
});

test('a distinct source fact precedes a verifying test when evidence is tight', () => {
  const pathCheck = { ...evidence[0], file: 'src/retrieve.ts', text: 'const path = realpathSync(root);' };
  const staleCheck = { ...evidence[1], file: 'src/pack.ts', text: 'if (stale) throw new Error();' };
  const ignoreRule = { ...evidence[2], file: 'src/retrieve.ts', text: 'const gitignoreRule = true;' };
  const testFile = { ...evidence[3], file: 'test/core.test.ts', text: 'test("gitignore", () => {});' };
  const output = selectText([pathCheck, staleCheck, testFile, ignoreRule], pack, 'jev', 2000, [],
    'How do realpath, stale checks and gitignore work?');
  assert.deepEqual(output.selected.map(item => item.id), [pathCheck.id, staleCheck.id, ignoreRule.id, testFile.id]);
});

test('a named implementation module is considered before unrelated higher-scored modules', () => {
  const cli = { ...evidence[0], file: 'src/cli.ts', relevance: 0.9 };
  const retrieve = { ...evidence[1], file: 'src/retrieve.ts', relevance: 0.85 };
  const rank = { ...evidence[2], file: 'src/rank.ts', relevance: 0.7 };
  const output = selectText([cli, retrieve, rank], pack, 'jev', 2000, [], 'Why does ranking fail?');
  assert.deepEqual(output.selected.map(item => item.file), ['src/rank.ts', 'src/cli.ts', 'src/retrieve.ts']);
});

test('a low-relevance generic filename cannot displace a strong implementation result', () => {
  const adapter = { ...evidence[0], file: 'src/adapter/handler.ts', relevance: 0.14 };
  const compose = { ...evidence[1], file: 'src/compose.ts', relevance: 0.9 };
  const output = selectText([adapter, compose], pack, 'jev', 2000, [],
    'When a route handler throws, how does onError run?');
  assert.deepEqual(output.selected.map(item => item.file), [compose.file, adapter.file]);
});

test('second implementation module fills missing query concepts after named module', () => {
  const rank = { ...evidence[0], file: 'src/rank.ts', text: 'A batch fails and partial output is discarded.', relevance: 0.72 };
  const retrieve = { ...evidence[1], file: 'src/retrieve.ts', text: 'const output = lexicalSearch();', relevance: 0.9 };
  const cli = { ...evidence[2], file: 'src/cli.ts', text: 'On failure, use lexical fallback; usage is unknown.', relevance: 0.85 };
  const output = selectText([retrieve, cli, rank], pack, 'jev', 2000, [],
    'Why does ranking batch failure use lexical fallback and unknown usage?');
  assert.deepEqual(output.selected.map(item => item.file), ['src/rank.ts', 'src/cli.ts', 'src/retrieve.ts']);
});

test('failure investigations favor a later cleanup path over another setup window', () => {
  const rankSetup = { ...evidence[0], file: 'src/rank.ts', text: 'Prepare the ranking batch with AbortController; throw on deadline.', relevance: 0.8 };
  const cli = { ...evidence[1], file: 'src/cli.ts', text: 'On failure use lexical fallback.', relevance: 0.85 };
  const rankSetupMore = { ...evidence[2], file: 'src/rank.ts', text: 'The response payload is parsed.', relevance: 0.75 };
  const rankCleanup = { ...evidence[3], file: 'src/rank.ts', text: 'catch (error) { controller.abort(); throw error; }', relevance: 0.61 };
  const output = selectText([cli, rankSetup, rankSetupMore, rankCleanup], pack, 'jev', 2000, [],
    'What happens when a ranking batch fails?');
  assert.deepEqual(output.selected.map(item => item.id), [rankSetup.id, cli.id, rankCleanup.id, rankSetupMore.id]);
});

test('a complete file that does not fit becomes a verbatim focused range with same recovery ID', () => {
  const lines = Array.from({ length: 45 }, (_, i) => `const value${i + 1} = ${i + 1};`);
  lines[24] = 'if (staleHash) throw new Error("Source changed");';
  const item: Candidate = { ...evidence[0], file: 'src/pack.ts', start: 1, end: 45, fileLines: 45,
    complete: true, matchLines: [25], text: lines.join('\n') };
  const output = selectText([item], pack, 'jev', 650, [], 'What happens when a source hash is stale?');
  assert.equal(output.selected.length, 1);
  assert.equal(output.selected[0].id, item.id);
  assert.equal(output.selected[0].complete, false);
  assert.ok(output.selected[0].text.includes(lines[24]));
  assert.equal(output.selected[0].text, lines.slice(output.selected[0].start - 1, output.selected[0].end).join('\n'));
  assert.ok(Buffer.byteLength(output.text) <= 650);
});

test('a later implementation match wins a density tie against an import', () => {
  const lines = Array.from({ length: 55 }, (_, i) => `const value${i + 1} = ${i + 1};`);
  lines[4] = "import { sourceAt } from './retrieve.ts';";
  lines[41] = 'const content = sourceAt(root, file);';
  lines[42] = 'if (digest(content) !== hash) throw new Error("Source changed");';
  const item: Candidate = { ...evidence[0], file: 'src/pack.ts', start: 1, end: 55, fileLines: 55,
    complete: true, matchLines: [5, 42], text: lines.join('\n') };
  const output = selectText([item], pack, 'jev', 700, [], 'How does sourceAt protect expansion?');
  assert.equal(output.selected.length, 1);
  assert.ok(output.selected[0].start > 5);
  assert.ok(output.selected[0].text.includes('Source changed'));
});

test('per-item cap frees room for other evidence without changing the original recovery ID', () => {
  const lines = Array.from({ length: 70 }, (_, i) => `const value${i + 1} = ${i + 1};`);
  lines[40] = 'if (digest(content) !== ref.hash) throw new Error("Source changed");';
  const large: Candidate = { ...evidence[0], file: 'src/pack.ts', start: 1, end: 70,
    fileLines: 70, complete: true, matchLines: [41], text: lines.join('\n') };
  const other = { ...evidence[1], file: 'src/retrieve.ts', text: 'const path = realpathSync(root);' };
  const output = selectText([large, other], pack, 'jev', 1500, [], 'Why does stale content fail?', 900);
  assert.deepEqual(output.selected.map(item => item.file), ['src/pack.ts', 'src/retrieve.ts']);
  assert.equal(output.selected[0].id, large.id);
  assert.equal(output.selected[0].complete, false);
  assert.ok(output.selected[0].text.includes('Source changed'));
  assert.ok(Buffer.byteLength(renderEvidence(output.selected[0])) <= 900);
});

test('fallback notices survive selection and impossibly small budgets fail explicitly', () => {
  const notice = 'Jev unavailable; lexical fallback.';
  assert.ok(selectText(evidence, pack, 'lexical', 400, [notice]).text.includes(notice));
  assert.throws(() => selectText(evidence, pack, 'jev', 20), /Budget too small/);
});

test('default CLI returns compact evidence; optional report and list preserve diagnostics and recovery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-presentation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sample.ts'), 'export const refundDeadline = 30;\n');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const report = join(dir, 'report.json');
  const env = { ...process.env, JEVSCOUT_CACHE_DIR: join(dir, 'cache') };
  const run = spawnSync(process.execPath, [cli, 'search', 'refundDeadline', '--path', dir, '--budget-bytes', '500', '--report', report], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Buffer.byteLength(run.stdout) <= 500);
  assert.ok(run.stdout.includes('export const refundDeadline = 30;'));
  assert.ok(!run.stdout.includes('metrics'));
  const data = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(data.outputBytes, Buffer.byteLength(run.stdout));
  assert.equal(data.usedMode, 'lexical');
  const list = spawnSync(process.execPath, [cli, 'list', data.packId, '--format', 'json'], { env, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].id, data.evidence[0].id);
  const expand = spawnSync(process.execPath, [cli, 'expand', data.packId, data.evidence[0].id], { env, encoding: 'utf8' });
  assert.equal(expand.status, 0, expand.stderr);
  assert.ok(expand.stdout.includes('export const refundDeadline = 30;'));
  const open = spawnSync(process.execPath, [cli, 'open', data.packId, data.evidence[0].id, '--before', '2', '--after', '2'], { env, encoding: 'utf8' });
  assert.equal(open.status, 0, open.stderr);
  assert.ok(open.stdout.includes('1|export const refundDeadline = 30;'));
});

test('auto considers ranking a small candidate set when its source does not fit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-auto-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, `${name}.ts`), `export const needle = '${'x'.repeat(350)}';\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, JEVSCOUT_CACHE_DIR: join(dir, 'cache') };
  delete env.TYPESAFE_API_KEY;
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'search', 'needle', '--path', dir, '--mode', 'auto', '--budget-bytes', '300', '--format', 'json'], {env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.metrics.candidates, 3);
  assert.equal(data.reason, 'No API key; lexical fallback.');
});

test('auto considers Jev when a candidate would only fit as a narrowed excerpt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-narrowed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = Array.from({ length: 120 }, () => `// header line with some padding ${'y'.repeat(60)}`);
  for (let i = 50; i < 72; i += 3) lines[i] = `if (webhook.eventId) seen.add(eventId); // idempotency guard ${i} ${'z'.repeat(40)}`;
  writeFileSync(join(dir, 'big.ts'), lines.join('\n'));
  writeFileSync(join(dir, 'small.ts'), "export const webhook = 'eventId idempotency';\n");
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const report = join(dir, 'report.json');
  const env: NodeJS.ProcessEnv = { ...process.env, JEVSCOUT_CACHE_DIR: join(dir, 'cache') };
  delete env.TYPESAFE_API_KEY;
  const run = spawnSync(process.execPath, [cli, 'search', 'webhook idempotency eventId', '--path', dir, '--mode', 'auto',
    '--budget-bytes', '2500', '--report', report], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(data.omitted.length, 0);
  assert.ok(data.evidence.some((item: Candidate) => item.file === 'big.ts' && item.complete === false));
  assert.equal(data.reason, 'No API key; lexical fallback.');
});

test('selectText counts narrowed excerpts separately from omitted candidates', () => {
  const text = Array.from({ length: 40 }, (_, i) => `const line${i} = '${'x'.repeat(80)}'; // deadline ${i}`).join('\n');
  const large: Candidate = { id: digest('large').slice(0, 16), file: 'src/large.ts', start: 1, end: 40, text,
    hash: digest('large-source'), lexical: 1, fileLines: 400, complete: false, matchLines: [20] };
  const output = selectText([large], pack, 'lexical', 1200, [], 'deadline');
  assert.equal(output.omitted.length, 0);
  assert.equal(output.narrowed, 1);
  assert.equal(selectText(evidence, pack, 'lexical', 20_000).narrowed, 0);
});
