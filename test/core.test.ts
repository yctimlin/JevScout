import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expand, openEvidence, savePack, select } from '../src/pack.ts';
import { rank } from '../src/rank.ts';
import { digest, search, sourceAt, termsFor, type Candidate } from '../src/retrieve.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function isolateCache(t: TestContext): string {
  const dir = tempDir(t, 'jevscout-cache-');
  const previous = process.env.JEVSCOUT_CACHE_DIR;
  process.env.JEVSCOUT_CACHE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.JEVSCOUT_CACHE_DIR;
    else process.env.JEVSCOUT_CACHE_DIR = previous;
  });
  return dir;
}

function candidate(overrides: Partial<Candidate> & Pick<Candidate, 'id' | 'text'>): Candidate {
  return {
    file: 'src/a.ts',
    start: 1,
    end: 1,
    hash: digest('src'),
    lexical: 1,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cliEnv(cacheDir: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, JEVSCOUT_CACHE_DIR: cacheDir, ...extra };
  delete env.TYPESAFE_API_KEY;
  return env;
}

function runCli(args: string[], cacheDir: string, cwd?: string) {
  return spawnSync(process.execPath, [cliPath, ...args, '--format', 'json'], {
    encoding: 'utf8',
    cwd,
    env: cliEnv(cacheDir),
  });
}

function numberedSource(marker: string, matchLines: number[], total = 40): string {
  const lines = Array.from({ length: total }, (_, i) => `line_${i + 1} = ${i + 1};`);
  for (const line of matchLines) lines[line - 1] = `${marker} at ${line}`;
  return `${lines.join('\n')}\n`;
}

describe('termsFor', () => {
  test('splits camelCase, drops stop words, and caps at 12 terms', () => {
    const terms = termsFor('Please implement RefundPolicy handler for the webhook and the extra unused tokens Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu');
    assert.ok(!terms.includes('please'));
    assert.ok(!terms.includes('implement'));
    assert.ok(!terms.includes('the'));
    assert.ok(terms.includes('refund'));
    assert.ok(terms.includes('policy'));
    assert.ok(terms.includes('handler'));
    assert.ok(terms.includes('webhook'));
    assert.equal(terms.length, 12);
    assert.deepEqual(terms, [...new Set(terms)]);
  });

  test('keeps Unicode letters as retrieval terms', () => {
    const terms = termsFor('如何处理 退款异常 期限 café Überzahlung');
    assert.ok(terms.includes('退款异常'));
    assert.ok(terms.includes('期限'));
    assert.ok(terms.includes('如何处理'));
    assert.ok(terms.includes('café'));
    assert.ok(terms.includes('überzahlung'));
  });

  test('preserves mixed-case API names before splitting their words', () => {
    const terms = termsFor('When onError handles HTTPException, does notFound run?');
    assert.ok(terms.includes('onerror'));
    assert.ok(terms.includes('notfound'));
    assert.ok(terms.includes('error'));
    assert.ok(terms.includes('found'));
  });
});

describe('digest', () => {
  test('returns SHA-256 hex of the exact source bytes', () => {
    assert.equal(digest('abc'), createHash('sha256').update('abc').digest('hex'));
    assert.equal(digest(''), createHash('sha256').update('').digest('hex'));
  });
});

describe('sourceAt', () => {
  test('reads a file inside the repository', (t) => {
    const root = tempDir(t, 'jevscout-src-');
    writeFiles(root, { 'src/keep.ts': 'export const ok = 1;\n' });
    assert.equal(sourceAt(root, 'src/keep.ts'), 'export const ok = 1;\n');
  });

  test('rejects a path that resolves outside the repository', (t) => {
    const parent = tempDir(t, 'jevscout-src-');
    const root = join(parent, 'repo');
    writeFiles(root, { 'src/keep.ts': 'inside\n' });
    writeFiles(parent, { 'secret.ts': 'outside secret\n' });
    assert.throws(() => sourceAt(root, join('..', 'secret.ts')), /Source path must stay inside the repository/);
    assert.throws(() => sourceAt(root, join(parent, 'secret.ts')), /Source path must stay inside the repository/);
  });

  test('rejects a symlink that points outside the repository', (t) => {
    const root = tempDir(t, 'jevscout-src-');
    const outside = tempDir(t, 'jevscout-outside-');
    writeFiles(root, { 'src/keep.ts': 'inside\n' });
    writeFiles(outside, { 'secret.ts': 'outside secret\n' });
    mkdirSync(join(root, 'src'), { recursive: true });
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src/linked.ts'));
    assert.throws(() => sourceAt(root, 'src/linked.ts'), /Source path must stay inside the repository/);
  });
});

describe('search', () => {
  test('discovers excerpts with metadata and source ranges, and skips ignored files', (t) => {
    const root = tempDir(t, 'jevscout-search-');
    const marker = 'RefundDeadlineToken';
    const keep = numberedSource(marker, [10], 40);
    writeFiles(root, {
      'src/keep.ts': keep,
      '.gitignore': 'ignored.ts\nignored-dir/\n',
      'ignored.ts': `${marker} in ignored source\n`,
      'ignored-dir/internal.ts': `${marker} in ignored directory\n`,
      'node_modules/pkg/index.ts': `${marker} in dependencies\n`,
      'dist/out.js': `console.log('${marker}');\n`,
      'vendor/lib.py': `${marker} = True\n`,
      'package-lock.json': `{ "name": "${marker}" }\n`,
      'pnpm-lock.yaml': `${marker}: 1\n`,
      'yarn.lock': `${marker}@1\n`,
      'Cargo.lock': `${marker} = 1\n`,
      '.env': `${marker}=1\n`,
      '.env.local': `${marker}=1\n`,
      'credentials.json': `{ "token": "${marker}" }\n`,
      'secrets.toml': `${marker} = "x"\n`,
    });

    const found = search(root, [marker], 60);
    assert.equal(found.candidates.length, 1);
    assert.equal(found.discovered, 1);
    assert.equal(found.capped, false);
    assert.ok(found.rawBytes > 0);

    const [hit] = found.candidates;
    assert.equal(hit.file, 'src/keep.ts');
    assert.equal(hit.start, 1);
    assert.equal(hit.end, keep.split('\n').length);
    assert.equal(hit.complete, true);
    assert.equal(hit.fileLines, keep.split('\n').length);
    assert.equal(hit.text, keep.split('\n').slice(hit.start - 1, hit.end).join('\n'));
    assert.equal(hit.hash, digest(keep));
    assert.equal(hit.id, digest(`${hit.file}:${hit.start}:${hit.end}:${hit.hash}`).slice(0, 16));
    assert.match(hit.id, /^[a-f0-9]{16}$/);
    assert.equal(hit.lexical, 1);
    assert.ok(hit.text.includes(`${marker} at 10`));
    assert.equal(hit.text.split('\n').length, hit.end - hit.start + 1);
  });

  test('merges nearby match windows and reports the candidate cap', (t) => {
    const root = tempDir(t, 'jevscout-search-');
    const marker = 'WindowMergeToken';
    writeFiles(root, {
      'src/a.ts': numberedSource(marker, [10, 12], 180),
      'src/b.ts': numberedSource(marker, [4], 30),
      'src/c.ts': numberedSource(marker, [20], 30),
    });
    const found = search(root, [marker], 2);
    assert.equal(found.candidates.length, 2);
    assert.ok(found.discovered > 2);
    assert.equal(found.capped, true);
    const merged = found.candidates.find(candidate => candidate.file === 'src/a.ts');
    assert.ok(merged);
    assert.ok(merged.text.includes(`${marker} at 10`));
    assert.ok(merged.text.includes(`${marker} at 12`));
    assert.ok(merged.end - merged.start + 1 < 60);
    assert.equal(merged.complete, false);
  });

  test('does not lose a late match after many earlier hits in one file', (t) => {
    const root = tempDir(t, 'jevscout-late-match-');
    const lines = Array.from({ length: 180 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    for (let i = 0; i < 15; i++) lines[i] = `const early${i} = 'needle';`;
    lines[169] = "export function lateFix() { return 'needle'; }";
    writeFiles(root, { 'src/large.ts': lines.join('\n') });
    const found = search(root, ['needle']);
    assert.ok(found.candidates.some(candidate => candidate.text.includes('lateFix')));
  });

  test('rescans a file when 50 early matches hide a later answer', (t) => {
    const root = tempDir(t, 'jevscout-capped-late-match-');
    const lines = Array.from({ length: 220 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    for (let i = 0; i < 70; i++) lines[i] = `const early${i} = 'issue';`;
    lines[199] = "export function linkedFailure() { return 'issue fetch warning'; }";
    writeFiles(root, { 'src/large.ts': lines.join('\n') });
    const found = search(root, ['issue', 'fetch', 'warning']);
    assert.ok(found.candidates.some(candidate => candidate.text.includes('linkedFailure')));
  });

  test('reserves a later query concept in a top file when many files match', (t) => {
    const root = tempDir(t, 'jevscout-novel-window-');
    const lines = Array.from({ length: 200 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    lines[4] = "const setup = 'needle foo';";
    lines[189] = "export function lateAnswer() { return 'special'; }";
    const files: Record<string, string> = { 'src/primary.ts': lines.join('\n') };
    for (let i = 0; i < 20; i++) files[`src/other${i}.ts`] = "export const value = 'needle';";
    writeFiles(root, files);
    const found = search(root, ['needle', 'foo', 'special'], 10);
    assert.ok(found.candidates.some(candidate => candidate.file === 'src/primary.ts' && candidate.text.includes('lateAnswer')));
    assert.ok(new Set(found.candidates.map(candidate => candidate.file)).size >= 8);
  });

  test('keeps weakly overlapping source topics in separate windows', (t) => {
    const root = tempDir(t, 'jevscout-topic-windows-');
    const lines = Array.from({ length: 150 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
    lines[2] = 'const firstNeedle = true;';
    lines[20] = 'const secondNeedle = true;';
    writeFiles(root, { 'src/large.ts': lines.join('\n') });
    const windows = search(root, ['Needle']).candidates;
    assert.equal(windows.length, 2);
    assert.ok(windows.some(window => window.text.includes('firstNeedle') && !window.text.includes('secondNeedle')));
    assert.ok(windows.some(window => window.text.includes('secondNeedle') && !window.text.includes('firstNeedle')));
  });

  test('finds Unicode terms in source', (t) => {
    const root = tempDir(t, 'jevscout-search-');
    writeFiles(root, {
      'src/i18n.ts': 'export const notice = "退款异常: 期限冲突";\n',
      'src/other.ts': 'export const ok = 1;\n',
    });
    const terms = termsFor('处理 退款异常');
    assert.ok(terms.includes('退款异常'));
    const found = search(root, ['退款异常']);
    assert.equal(found.candidates.length, 1);
    assert.equal(found.candidates[0].file, 'src/i18n.ts');
    assert.ok(found.candidates[0].text.includes('退款异常'));
  });

  test('throws when no terms are provided', () => {
    assert.throws(() => search('/tmp', []), /No searchable terms/);
  });
});

describe('select', () => {
  test('keeps whole snippets and omits the next record when it would exceed the budget', () => {
    const first = candidate({ id: 'aaaaaaaaaaaaaaaa', text: 'first whole snippet' });
    const second = candidate({ id: 'bbbbbbbbbbbbbbbb', file: 'src/b.ts', text: 'second whole snippet' });
    const firstSize = Buffer.byteLength(JSON.stringify(first));
    const packed = select([first, second], firstSize);
    assert.deepEqual(packed.selected, [first]);
    assert.deepEqual(packed.omitted, [second]);
    assert.equal(packed.evidenceBytes, firstSize);
    assert.equal(packed.selected[0].text, 'first whole snippet');
    assert.equal(packed.omitted[0].text, 'second whole snippet');

    const tooSmall = select([first], firstSize - 1);
    assert.deepEqual(tooSmall.selected, []);
    assert.deepEqual(tooSmall.omitted, [first]);
    assert.equal(tooSmall.omitted[0].text, first.text);
  });
});

describe('savePack and expand', () => {
  test('round-trips excerpt text from current source', (t) => {
    isolateCache(t);
    const root = tempDir(t, 'jevscout-pack-');
    writeFiles(root, { 'src/keep.ts': numberedSource('PackToken', [9], 24) });
    const found = search(root, ['PackToken']);
    assert.ok(found.candidates.length >= 1);
    const id = savePack(root, found.candidates);
    assert.match(id, /^[a-f0-9-]{36}$/);
    const expanded = expand(id, found.candidates[0].id);
    assert.equal(expanded.text, found.candidates[0].text);
    assert.equal(expanded.file, found.candidates[0].file);
    assert.equal(expanded.hash, found.candidates[0].hash);
    assert.equal(expanded.start, found.candidates[0].start);
    assert.equal(expanded.end, found.candidates[0].end);
  });

  test('opens neighboring source lines for a partial excerpt and preserves line numbers', (t) => {
    isolateCache(t);
    const root = tempDir(t, 'jevscout-open-');
    const source = numberedSource('OpenToken', [70], 180);
    writeFiles(root, { 'src/large.ts': source });
    const [found] = search(root, ['OpenToken']).candidates;
    assert.equal(found.complete, false);
    const id = savePack(root, [found]);
    const opened = openEvidence(id, found.id, 30, 30);
    assert.equal(opened.start, found.start - 30);
    assert.equal(opened.end, found.end + 30);
    assert.equal(opened.text, source.split('\n').slice(opened.start - 1, opened.end).join('\n'));
    assert.equal(opened.complete, false);
    assert.equal(opened.fileLines, source.split('\n').length);
    assert.throws(() => openEvidence(id, found.id, -1, 0), /Context lines must be nonnegative/);
    writeFiles(root, { 'src/large.ts': `${source}// modified\n` });
    assert.throws(() => openEvidence(id, found.id, 30, 30), /Source changed/);
  });

  test('rejects stale content after the source changes', (t) => {
    isolateCache(t);
    const root = tempDir(t, 'jevscout-pack-');
    writeFiles(root, { 'src/keep.ts': numberedSource('StaleToken', [9], 24) });
    const found = search(root, ['StaleToken']);
    const id = savePack(root, found.candidates);
    writeFiles(root, { 'src/keep.ts': numberedSource('StaleToken', [9], 24) + '// changed\n' });
    assert.throws(() => expand(id, found.candidates[0].id), /Source changed since this pack was created/);
  });

  test('rejects expansion when the stored file is replaced by an outside-root symlink', (t) => {
    isolateCache(t);
    const root = tempDir(t, 'jevscout-pack-');
    const outside = tempDir(t, 'jevscout-outside-');
    writeFiles(root, { 'src/keep.ts': numberedSource('LinkToken', [9], 24) });
    writeFiles(outside, { 'secret.ts': numberedSource('LinkToken', [9], 24) });
    const found = search(root, ['LinkToken']);
    const id = savePack(root, found.candidates);
    rmSync(join(root, 'src/keep.ts'));
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src/keep.ts'));
    assert.throws(() => expand(id, found.candidates[0].id), /Source path must stay inside the repository/);
  });

  test('rejects invalid pack or evidence IDs', (t) => {
    isolateCache(t);
    const root = tempDir(t, 'jevscout-pack-');
    writeFiles(root, { 'src/keep.ts': 'export const PackIdToken = 1;\n' });
    const found = search(root, ['PackIdToken']);
    const id = savePack(root, found.candidates);
    assert.throws(() => expand('not-a-uuid', found.candidates[0].id), /Invalid pack or evidence ID/);
    assert.throws(() => expand(id, 'zzzzzzzzzzzzzzzz'), /Invalid pack or evidence ID/);
    assert.throws(() => expand(id, 'aaaaaaaaaaaaaaaa'), /Evidence ID does not belong to this pack/);
  });
});

describe('rank', () => {
  test('scores a batch and sorts by relevance', async () => {
    const docs = [
      candidate({ id: '1111111111111111', text: 'low', lexical: 2 }),
      candidate({ id: '2222222222222222', file: 'src/b.ts', text: 'high', lexical: 1 }),
    ];
    const ranked = await rank('refund deadline', docs, {
      key: 'test-key',
      fetcher: async (url, init) => {
        assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
        assert.equal(init?.method, 'POST');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('Authorization'), 'Bearer test-key');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'jev-latest');
        assert.equal(body.state.query, 'refund deadline');
        assert.equal(body.state.documents.length, 2);
        return jsonResponse({
          model: 'jev-test',
          answers: {
            '1111111111111111': { type: 'noul', noul: 0.2 },
            '2222222222222222': { type: 'noul', noul: 0.9 },
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        });
      },
    });
    assert.equal(ranked.model, 'jev-test');
    assert.equal(ranked.calls, 1);
    assert.equal(ranked.inputTokens, 10);
    assert.equal(ranked.outputTokens, 4);
    assert.equal(ranked.candidates[0].id, '2222222222222222');
    assert.equal(ranked.candidates[0].relevance, 0.9);
    assert.equal(ranked.candidates[1].relevance, 0.2);
  });

  test('batches after 24 documents and after the 48 KB text budget', async () => {
    const many = Array.from({ length: 25 }, (_, i) => candidate({
      id: digest(`doc-${i}`).slice(0, 16),
      file: `src/n${i}.ts`,
      text: `small ${i}`,
    }));
    const sizes: number[] = [];
    await rank('batch', many, {
      key: 'k',
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        sizes.push(body.state.documents.length);
        return jsonResponse({
          model: 'jev-test',
          answers: Object.fromEntries(body.state.documents.map((doc: { id: string }) => [doc.id, { type: 'noul', noul: 0.5 }])),
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    assert.deepEqual(sizes, [24, 1]);

    const bulky = [
      candidate({ id: digest('b0').slice(0, 16), text: 'x'.repeat(30_000) }),
      candidate({ id: digest('b1').slice(0, 16), file: 'src/b.ts', text: 'y'.repeat(30_000) }),
    ];
    const bulkySizes: number[] = [];
    const bulkyResult = await rank('batch', bulky, {
      key: 'k',
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bulkySizes.push(body.state.documents.length);
        return jsonResponse({
          model: 'jev-test',
          answers: Object.fromEntries(body.state.documents.map((doc: { id: string }) => [doc.id, { type: 'noul', noul: 0.4 }])),
          usage: { input_tokens: 2, output_tokens: 3 },
        });
      },
    });
    assert.deepEqual(bulkySizes, [1, 1]);
    assert.equal(bulkyResult.calls, 2);
    assert.equal(bulkyResult.inputTokens, 4);
    assert.equal(bulkyResult.outputTokens, 6);
  });

  test('rejects HTTP errors and invalid provider payloads', async () => {
    const docs = [candidate({ id: 'cccccccccccccccc', text: 'refund' })];
    await assert.rejects(
      () => rank('q', docs, { key: 'k', fetcher: async () => jsonResponse({ error: 'nope' }, 503) }),
      /Jev HTTP 503/,
    );
    await assert.rejects(
      () => rank('q', docs, { key: 'k', fetcher: async () => jsonResponse({ error: 'nope' }, 401) }),
      /Jev HTTP 401/,
    );

    const invalidBodies = [
      { model: 1, answers: { cccccccccccccccc: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { model: 'jev-test', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
      {
        model: 'jev-test',
        answers: {
          cccccccccccccccc: { type: 'noul', noul: 0.5 },
          dddddddddddddddd: { type: 'noul', noul: 0.1 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { model: 'jev-test', answers: { cccccccccccccccc: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: -1, output_tokens: 1 } },
      { model: 'jev-test', answers: { cccccccccccccccc: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1.5, output_tokens: 1 } },
      { model: 'jev-test', answers: { cccccccccccccccc: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: -2 } },
    ];
    for (const body of invalidBodies) {
      await assert.rejects(
        () => rank('q', docs, { key: 'k', fetcher: async () => jsonResponse(body) }),
        /Invalid Jev response/,
      );
    }

    const invalidAnswers = [
      { type: 'noul', noul: 1.2 },
      { type: 'noul', noul: -0.01 },
      { type: 'noul', noul: Number.NaN },
      { type: 'text', noul: 0.5 },
      { noul: 0.5 },
    ];
    for (const answer of invalidAnswers) {
      await assert.rejects(
        () => rank('q', docs, {
          key: 'k',
          fetcher: async () => jsonResponse({
            model: 'jev-test',
            answers: { cccccccccccccccc: answer },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        }),
        /Invalid Jev relevance probability/,
      );
    }
  });

  test('fails immediately when the Jev deadline has already elapsed', async () => {
    let called = 0;
    await assert.rejects(
      () => rank('q', [candidate({ id: 'dddddddddddddddd', text: 'x' })], {
        key: 'k',
        timeoutMs: 0,
        fetcher: async () => {
          called += 1;
          return jsonResponse({});
        },
      }),
      /Jev deadline exceeded/,
    );
    assert.equal(called, 0);
  });
});

describe('cli', () => {
  test('lexical search returns JevScout JSON with excerpts', (t) => {
    const cache = isolateCache(t);
    const root = tempDir(t, 'jevscout-cli-');
    writeFiles(root, { 'src/keep.ts': numberedSource('CliLexicalToken', [8], 20) });
    const result = runCli(['search', 'where is CliLexicalToken handled', '--path', root, '--mode', 'lexical', '--terms', 'CliLexicalToken'], cache);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.requestedMode, 'lexical');
    assert.equal(payload.usedMode, 'lexical');
    assert.equal(payload.reason, 'Lexical mode requested.');
    assert.equal(payload.root, realpathSync(root));
    assert.match(payload.expand, /^jevscout expand /);
    assert.ok(Array.isArray(payload.evidence));
    assert.ok(payload.evidence.some((item: Candidate) => item.file === 'src/keep.ts'));
    assert.equal(payload.evidence[0].text, readFileSync(join(root, 'src/keep.ts'), 'utf8').split('\n').slice(payload.evidence[0].start - 1, payload.evidence[0].end).join('\n'));
  });

  test('auto skips Jev when the candidate set is small', (t) => {
    const cache = isolateCache(t);
    const root = tempDir(t, 'jevscout-cli-');
    writeFiles(root, { 'src/keep.ts': numberedSource('CliAutoSmallToken', [8], 20) });
    const result = runCli(['search', 'CliAutoSmallToken', '--path', root, '--mode', 'auto', '--terms', 'CliAutoSmallToken', '--budget-bytes', '256'], cache);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.requestedMode, 'auto');
    assert.equal(payload.usedMode, 'lexical');
    assert.equal(payload.reason, 'Single candidate or all evidence fits; Jev skipped.');
    assert.equal(payload.metrics.typeSafe, null);
  });

  test('auto skips Jev when every excerpt already fits a large budget', (t) => {
    const cache = isolateCache(t);
    const root = tempDir(t, 'jevscout-cli-');
    const files: Record<string, string> = {};
    for (let i = 0; i < 13; i++) files[`src/m${String(i).padStart(2, '0')}.ts`] = `export const CliAutoFitToken_${i} = 'CliAutoFitToken';\n`;
    writeFiles(root, files);
    const result = runCli(['search', 'CliAutoFitToken', '--path', root, '--mode', 'auto', '--terms', 'CliAutoFitToken', '--budget-bytes', '1000000', '--candidates', '60'], cache);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.metrics.candidates > 12);
    assert.equal(payload.omitted.length, 0);
    assert.equal(payload.requestedMode, 'auto');
    assert.equal(payload.usedMode, 'lexical');
    assert.equal(payload.reason, 'Single candidate or all evidence fits; Jev skipped.');
  });

  test('auto with a tight budget and many candidates falls back when the API key is missing', (t) => {
    const cache = isolateCache(t);
    const root = tempDir(t, 'jevscout-cli-');
    const files: Record<string, string> = {};
    for (let i = 0; i < 13; i++) files[`src/m${String(i).padStart(2, '0')}.ts`] = `export const CliAutoKeyToken_${i} = 'CliAutoKeyToken';\n`;
    writeFiles(root, files);
    const result = runCli(['search', 'CliAutoKeyToken', '--path', root, '--mode', 'auto', '--terms', 'CliAutoKeyToken', '--budget-bytes', '256', '--candidates', '60'], cache);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.metrics.candidates > 12);
    assert.equal(payload.requestedMode, 'auto');
    assert.equal(payload.usedMode, 'lexical');
    assert.equal(payload.reason, 'No API key; lexical fallback.');
    assert.equal(payload.metrics.typeSafe, null);
  });

  test('jev mode without an API key stays lexical', (t) => {
    const cache = isolateCache(t);
    const root = tempDir(t, 'jevscout-cli-');
    writeFiles(root, { 'src/keep.ts': numberedSource('CliJevToken', [8], 20) });
    const result = runCli(['search', 'CliJevToken', '--path', root, '--mode', 'jev', '--terms', 'CliJevToken'], cache);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.requestedMode, 'jev');
    assert.equal(payload.usedMode, 'lexical');
    assert.equal(payload.reason, 'No API key; lexical fallback.');
  });

  test('help and failures identify JevScout', (t) => {
    const cache = isolateCache(t);
    const help = runCli(['--help'], cache);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /JevScout/);
    assert.doesNotMatch(help.stdout, /Cluepack/);
    const failed = runCli(['search'], cache);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /^JevScout:/);
  });
});
