import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECK_LIMITS,
  CHECK_THRESHOLDS,
  check,
  parseCheckInput,
  readBoundedInput,
  type CheckInput,
} from '../src/check.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TYPESAFE = 'https://api.typesafe.ai/v1/systemone';

function payload(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    task: 'How does fetchOnce fail closed?',
    claims: [{ id: 'c1', text: 'fetchOnce refuses HTTP redirects.' }],
    evidence: [{ id: 'e1', source: 'src/fetch.ts', text: 'return fetch(url, { redirect: "error" });' }],
    ...overrides,
  };
}

function jsonInput(overrides: Partial<CheckInput> = {}): string {
  return JSON.stringify(payload(overrides));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function noul(value: number): { type: 'noul'; noul: number } {
  return { type: 'noul', noul: value };
}

function answersFor(input: CheckInput, score: (claimIndex: number, evidenceIndex: number, side: 's' | 'c') => number) {
  const answers: Record<string, { type: 'noul'; noul: number }> = {};
  for (const [claimIndex] of input.claims.entries()) {
    for (const [evidenceIndex] of input.evidence.entries()) {
      answers[`c${claimIndex}e${evidenceIndex}s`] = noul(score(claimIndex, evidenceIndex, 's'));
      answers[`c${claimIndex}e${evidenceIndex}c`] = noul(score(claimIndex, evidenceIndex, 'c'));
    }
  }
  return answers;
}

function providerOk(input: CheckInput, score: (claimIndex: number, evidenceIndex: number, side: 's' | 'c') => number, usage = { input_tokens: 11, output_tokens: 3 }) {
  return jsonResponse({
    model: 'jev-test',
    answers: answersFor(input, score),
    usage,
  });
}

function runCli(args: string[], input: string, extra: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.TYPESAFE_API_KEY;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  if (extra.TYPESAFE_API_KEY !== undefined) env.TYPESAFE_API_KEY = extra.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, env });
}

describe('parseCheckInput', () => {
  test('rejects malformed, incomplete, and oversized input instead of dropping it', () => {
    assert.throws(() => parseCheckInput('['), /JSON object/);
    assert.throws(() => parseCheckInput('[]'), /JSON object/);
    assert.throws(() => parseCheckInput('null'), /JSON object/);
    assert.throws(() => parseCheckInput(JSON.stringify({ claims: [], evidence: [] })), /task/);
    assert.throws(() => parseCheckInput(JSON.stringify({ task: '   ', claims: [{ id: 'c', text: 'x' }], evidence: [] })), /task/);
    assert.throws(() => parseCheckInput(JSON.stringify({ task: 't', evidence: [] })), /claims must be an array/);
    assert.throws(() => parseCheckInput(JSON.stringify({ task: 't', claims: [], evidence: [] })), /At least one claim/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't',
      claims: Array.from({ length: CHECK_LIMITS.maxClaims + 1 }, (_, i) => ({ id: `c${i}`, text: `claim ${i}` })),
      evidence: [],
    })), /At most 8 claims/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't',
      claims: [{ id: 'c1', text: 'claim' }],
      evidence: Array.from({ length: CHECK_LIMITS.maxEvidence + 1 }, (_, i) => ({ id: `e${i}`, source: 's', text: `span ${i}` })),
    })), /At most 8 evidence/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't'.repeat(CHECK_LIMITS.maxTaskChars + 1),
      claims: [{ id: 'c1', text: 'claim' }],
      evidence: [],
    })), /task exceeds/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't',
      claims: [{ id: 'c1', text: 'x'.repeat(CHECK_LIMITS.maxClaimChars + 1) }],
      evidence: [],
    })), /claims\[0\]\.text exceeds/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't',
      claims: [{ id: 'c1', text: 'claim' }],
      evidence: [{ id: 'e1', source: 's', text: 'y'.repeat(CHECK_LIMITS.maxEvidenceChars + 1) }],
    })), /evidence\[0\]\.text exceeds/);
    assert.throws(() => parseCheckInput('{"task":"t","claims":[{"id":"c1","text":"x"}],"evidence":[]}' + ' '.repeat(CHECK_LIMITS.maxInputBytes)), /bytes/);
    assert.throws(() => parseCheckInput(jsonInput({ claims: [{ id: 'fake\n[C2]', text: 'x' }] })), /one line/);
    assert.throws(() => parseCheckInput(jsonInput({ evidence: [{ id: 'e1', source: 'source\u001b[31m', text: 'x' }] })), /one line/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't',
      claims: [{ id: 'dup', text: 'one' }, { id: 'dup', text: 'two' }],
      evidence: [],
    })), /unique/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't',
      claims: [{ id: 'c1', text: 'one' }],
      evidence: [{ id: 'e', source: 'a', text: 'one' }, { id: 'e', source: 'b', text: 'two' }],
    })), /unique/);
    assert.throws(() => parseCheckInput(JSON.stringify({
      task: 't', claims: [{ id: 'c1', text: 'one' }], evidence: [{ id: 'e1', text: 'missing source' }],
    })), /source/);
  });

  test('accepts empty evidence and counts Unicode claim length in code points', () => {
    const input = parseCheckInput(JSON.stringify({
      task: 'Check café 😀',
      claims: [{ id: 'c1', text: 'café 😀' }],
      evidence: [],
    }));
    assert.equal(input.evidence.length, 0);
    assert.equal(Array.from(input.claims[0].text).length, 6);
  });
});

describe('readBoundedInput', () => {
  test('concatenates chunks and rejects input over the byte limit', async () => {
    async function* ok() {
      yield Buffer.from('{"a":');
      yield '1}';
    }
    assert.equal(await readBoundedInput(ok(), 20), '{"a":1}');
    async function* big() {
      yield Buffer.from('x'.repeat(40));
      yield Buffer.from('y'.repeat(20));
    }
    await assert.rejects(() => readBoundedInput(big(), 50), /50 bytes/);
  });
});

describe('check', () => {
  test('empty evidence leaves every claim unresolved without calling TypeSafe', async () => {
    let called = 0;
    const result = await check(payload({ evidence: [] }), {
      fetcher: async () => {
        called += 1;
        return jsonResponse({});
      },
    });
    assert.equal(called, 0);
    assert.equal(result.claims[0].status, 'unresolved');
    assert.equal(result.claims[0].support, 0);
    assert.equal(result.claims[0].conflict, 0);
    assert.equal(result.model, null);
    assert.equal(result.metrics.calls, 0);
    assert.equal(result.metrics.typeSafe, null);
    assert.match(result.text, /unresolved/);
  });

  test('compact text puts each claim next to its status and stays within the byte budget', async () => {
    const input = payload({
      claims: [
        { id: 'redirects', text: 'fetchOnce refuses HTTP redirects.' },
        { id: 'db', text: 'Results are stored in PostgreSQL.' },
      ],
      evidence: [],
    });
    const result = await check(input, { budgetBytes: 8000 });
    assert.match(result.text, /\[redirects\] unresolved · fetchOnce refuses HTTP redirects\. · support 0 · conflict 0/);
    assert.match(result.text, /\[db\] unresolved · Results are stored in PostgreSQL\. · support 0 · conflict 0/);
    assert.ok(Buffer.byteLength(result.text) <= 8000);
    assert.equal(result.metrics.outputBytes, Buffer.byteLength(result.text));
    assert.equal(result.text.includes(input.claims[0].text), true);
    assert.equal(result.text.includes(input.claims[1].text), true);
  });

  test('missing API key fails clearly for nonempty evidence', async () => {
    let called = 0;
    await assert.rejects(
      () => check(payload(), { fetcher: async () => { called += 1; return jsonResponse({}); } }),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /TYPESAFE_API_KEY/);
        assert.equal(error.message.includes('secret'), false);
        assert.equal(error.message.includes(payload().evidence[0].text), false);
        return true;
      },
    );
    assert.equal(called, 0);
  });

  test('records exact Unicode code-point offsets for quoted spans', async () => {
    const input = payload({
      evidence: [{ id: 'e1', source: 'notes/café.md', text: 'café 😀 timeout' }],
    });
    const result = await check(input, {
      key: 'test-key',
      fetcher: async () => providerOk(input, () => 0.91),
    });
    const quote = result.claims[0].supporting[0];
    assert.equal(quote.text, 'café 😀 timeout');
    assert.equal(quote.start, 0);
    assert.equal(quote.end, Array.from(quote.text).length);
    assert.notEqual(quote.end, quote.text.length);
    assert.equal(Array.from(quote.text).slice(quote.start, quote.end).join(''), quote.text);
    assert.ok(result.text.includes('café 😀 timeout'));
    assert.ok(result.text.includes(`0-${quote.end}`));
  });

  test('maps mocked TypeSafe scores onto supported, contradicted, mixed, and unresolved', async () => {
    const input: CheckInput = {
      task: 'Retry helper behavior',
      claims: [
        { id: 'supported', text: 'fetchOnce refuses HTTP redirects.' },
        { id: 'contradicted', text: 'fetchOnce follows redirects.' },
        { id: 'mixed', text: 'The timeout is 30 seconds.' },
        { id: 'unresolved', text: 'Results are stored in PostgreSQL.' },
      ],
      evidence: [
        { id: 'e1', source: 'src/fetch.ts', text: 'fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) })' },
        { id: 'e2', source: 'src/defaults.ts', text: 'const DEFAULT_TIMEOUT_MS = 30_000;' },
        { id: 'e3', source: 'src/retry.ts', text: 'for (let attempt = 0; attempt < 3; attempt++) call();' },
      ],
    };
    const scores: Record<string, number> = {
      c0e0s: 0.94, c0e0c: 0.04, c0e1s: 0.1, c0e1c: 0.05, c0e2s: 0.08, c0e2c: 0.07,
      c1e0s: 0.06, c1e0c: 0.93, c1e1s: 0.1, c1e1c: 0.04, c1e2s: 0.05, c1e2c: 0.11,
      c2e0s: 0.12, c2e0c: 0.88, c2e1s: 0.9, c2e1c: 0.08, c2e2s: 0.1, c2e2c: 0.09,
      c3e0s: 0.2, c3e0c: 0.15, c3e1s: 0.18, c3e1c: 0.12, c3e2s: 0.22, c3e2c: 0.19,
    };
    let calls = 0;
    const result = await check(input, {
      key: 'test-key',
      fetcher: async (url, init) => {
        calls += 1;
        assert.equal(String(url), TYPESAFE);
        assert.equal(init?.method, 'POST');
        assert.equal(init?.redirect, 'error');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('Authorization'), 'Bearer test-key');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'jev-latest');
        assert.deepEqual(body.state.claims.map((claim: { text: string }) => claim.text), input.claims.map(claim => claim.text));
        assert.deepEqual(body.state.evidence.map((span: { text: string }) => span.text), input.evidence.map(span => span.text));
        assert.equal(Object.keys(body.questions).length, 24);
        assert.match(body.questions.c0e0s.instructions, /state\.evidence\[0\]\.text/);
        assert.match(body.questions.c0e0s.instructions, /state\.claims\[0\]\.text/);
        assert.match(body.questions.c2e1c.instructions, /state\.evidence\[1\]\.text/);
        assert.equal(body.questions.c0e0s.instructions.includes('c0e0s'), false);
        assert.equal(body.questions.c0e0s.instructions.includes(input.claims[0].text), false);
        assert.equal(JSON.stringify(body.state.evidence[0]).includes('src/fetch.ts'), false);
        return jsonResponse({
          model: 'jev-test',
          answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, noul(scores[id] ?? 0)])),
          usage: { input_tokens: 40, output_tokens: 8 },
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.model, 'jev-test');
    assert.deepEqual(result.claims.map(claim => [claim.id, claim.status]), [
      ['supported', 'supported'],
      ['contradicted', 'contradicted'],
      ['mixed', 'mixed'],
      ['unresolved', 'unresolved'],
    ]);
    assert.equal(result.claims[0].supporting[0].evidenceId, 'e1');
    assert.equal(result.claims[1].contradicting[0].evidenceId, 'e1');
    assert.equal(result.claims[2].supporting[0].evidenceId, 'e2');
    assert.equal(result.claims[2].contradicting[0].evidenceId, 'e1');
    assert.equal(result.claims[3].supporting.length, 0);
    assert.equal(result.claims[3].contradicting.length, 0);
    assert.equal(result.metrics.typeSafe?.inputTokens, 40);
    assert.equal(result.metrics.typeSafe?.outputTokens, 8);
    assert.equal(result.metrics.typeSafe?.calls, 1);
    assert.equal(result.thresholds.support, CHECK_THRESHOLDS.support);
    assert.match(result.text, /\[supported\] supported/);
    assert.match(result.text, /\[contradicted\] contradicted/);
    assert.match(result.text, /\[mixed\] mixed/);
    assert.match(result.text, /\[unresolved\] unresolved/);
    assert.ok(result.text.includes(input.evidence[0].text));
    assert.equal(result.text.split(input.evidence[0].text).length - 1, 1);
  });

  test('keeps at most two quotes per side and preserves contradictory spans', async () => {
    const input = payload({
      claims: [{ id: 'mixed', text: 'Timeout is 30 seconds.' }],
      evidence: [
        { id: 'low', source: 'a.ts', text: 'timeout 1' },
        { id: 'mid', source: 'b.ts', text: 'timeout 2' },
        { id: 'high', source: 'c.ts', text: 'timeout 3' },
        { id: 'conflict', source: 'd.ts', text: 'timeout 8000' },
      ],
    });
    const result = await check(input, {
      key: 'k',
      fetcher: async () => providerOk(input, (claimIndex, evidenceIndex, side) => {
        if (side === 'c') return evidenceIndex === 3 ? 0.91 : 0.1;
        return [0.81, 0.84, 0.97][evidenceIndex] ?? 0.1;
      }),
    });
    assert.equal(result.claims[0].status, 'mixed');
    assert.deepEqual(result.claims[0].supporting.map(quote => quote.evidenceId), ['high', 'mid']);
    assert.deepEqual(result.claims[0].contradicting.map(quote => quote.evidenceId), ['conflict']);
    assert.equal(result.claims[0].support, 0.97);
    assert.equal(result.claims[0].conflict, 0.91);
  });

  test('shows a below-threshold lead while keeping the claim unresolved', async () => {
    const input = payload();
    const result = await check(input, {
      key: 'k',
      fetcher: async () => providerOk(input, (_claim, _evidence, side) => side === 'c' ? 0.72 : 0.1),
    });
    assert.equal(result.claims[0].status, 'unresolved');
    assert.equal(result.claims[0].leads[0]?.relation, 'conflict');
    assert.equal(result.claims[0].leads[0]?.quote.evidenceId, 'e1');
    assert.match(result.text, /possible conflict \[e1\] 0\.72 \(below threshold\)/);
    assert.equal(result.text.split(input.evidence[0].text).length - 1, 1);
  });

  test('keeps three distinct leads for focused escalation', async () => {
    const input = payload({
      evidence: [0, 1, 2, 3].map(index => ({ id: `e${index}`, source: `source-${index}`, text: `evidence ${index}` })),
    });
    const result = await check(input, {
      key: 'k',
      fetcher: async () => providerOk(input, (_claim, evidence, side) => side === 'c'
        ? [0.69, 0.77, 0.73, 0.6][evidence] : 0.1),
    });
    assert.equal(result.claims[0].status, 'unresolved');
    assert.deepEqual(result.claims[0].leads.map(lead => lead.quote.evidenceId), ['e1', 'e2', 'e0']);
    assert.doesNotMatch(result.text, /\[e3\]/);
  });

  test('text budget favors unresolved leads over extra confirming quotes', async () => {
    const input = payload({
      claims: [
        { id: 'confirmed', text: 'The request refuses redirects.' },
        { id: 'uncertain', text: 'The request supports WebSockets.' },
      ],
      evidence: [
        { id: 'primary', source: 'a', text: `Primary evidence ${'a'.repeat(320)}` },
        { id: 'extra', source: 'b', text: `Extra evidence ${'b'.repeat(320)}` },
        { id: 'lead', source: 'c', text: `Possible conflict ${'c'.repeat(320)}` },
      ],
    });
    const result = await check(input, {
      key: 'k', budgetBytes: 1300,
      fetcher: async () => providerOk(input, (claim, evidence, side) => {
        if (claim === 0 && side === 's') return evidence < 2 ? 0.95 - evidence * 0.05 : 0.1;
        if (claim === 1 && side === 'c') return evidence === 2 ? 0.72 : 0.1;
        return 0.1;
      }),
    });
    assert.equal(result.claims[0].supporting.length, 2);
    assert.equal(result.claims[1].leads[0].quote.evidenceId, 'lead');
    assert.ok(result.text.includes(input.evidence[2].text));
    assert.equal(result.text.includes(input.evidence[1].text), false);
    assert.ok(Buffer.byteLength(result.text) <= 1300);
  });

  test('rejects HTTP errors and malformed provider replies without leaking evidence or keys', async () => {
    const secret = 'super-secret-key';
    const input = payload();
    const failed = [
      () => jsonResponse({ error: 'nope' }, 503),
      () => jsonResponse({ model: 'jev-test', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
      () => jsonResponse({
        model: 'jev-test',
        answers: { c0e0s: noul(0.9), c0e0c: noul(0.1), extra: noul(0.2) },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      () => jsonResponse({
        model: 'jev-test',
        answers: { c0e0s: noul(0.9), c0e0c: noul(0.1) },
        usage: { input_tokens: -1, output_tokens: 1 },
      }),
      () => jsonResponse({
        model: 'jev-test',
        answers: { c0e0s: noul(0.9), c0e0c: noul(1.2) },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      () => jsonResponse({
        model: 1,
        answers: { c0e0s: noul(0.9), c0e0c: noul(0.1) },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ];
    for (const reply of failed) {
      await assert.rejects(
        () => check(input, { key: secret, fetcher: async () => reply() }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Jev HTTP 503|Invalid Jev/);
          assert.equal(error.message.includes(secret), false);
          assert.equal(error.message.includes(input.evidence[0].text), false);
          return true;
        },
      );
    }
  });

  test('fails when the deadline has already elapsed and when the provider aborts', async () => {
    let called = 0;
    await assert.rejects(
      () => check(payload(), {
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

    await assert.rejects(
      () => check(payload(), {
        key: 'k',
        timeoutMs: 15,
        fetcher: async (_url, init) => {
          const error = new Error('aborted');
          error.name = 'TimeoutError';
          init?.signal?.throwIfAborted();
          throw error;
        },
      }),
      /Jev deadline exceeded/,
    );
  });

  test('omits whole quotes to honor the text budget and keeps displayed quotes verbatim', async () => {
    const long = 'redirect: "error";'.repeat(40);
    const input = payload({
      evidence: [{ id: 'e1', source: 'src/fetch.ts', text: long }],
    });
    const result = await check(input, {
      key: 'k',
      budgetBytes: 400,
      fetcher: async () => providerOk(input, (_c, _e, side) => side === 's' ? 0.9 : 0.05),
    });
    assert.ok(Buffer.byteLength(result.text) <= 400);
    assert.equal(result.metrics.outputBytes, Buffer.byteLength(result.text));
    assert.equal(result.text.includes(long), false);
    assert.equal(result.claims[0].supporting[0].text, long);
    assert.match(result.text, /quote omitted|quotes omitted/);
    assert.match(result.warnings.join(' '), /omitted/);

    const fitted = await check(input, {
      key: 'k',
      budgetBytes: 8000,
      fetcher: async () => providerOk(input, (_c, _e, side) => side === 's' ? 0.9 : 0.05),
    });
    assert.ok(fitted.text.includes(long));
    const start = fitted.text.indexOf(long);
    assert.equal(fitted.text.slice(start, start + long.length), long);

    const crowded = payload({
      task: `Fail-closed fetch behavior ${'detail '.repeat(40)}`,
      evidence: [{ id: 'e1', source: 'src/fetch.ts', text: long }],
    });
    await assert.rejects(
      () => check(crowded, {
        key: 'k',
        budgetBytes: 256,
        fetcher: async () => providerOk(crowded, () => 0.9),
      }),
      /Budget too small/,
    );
  });
});

describe('cli check', () => {
  test('help lists check', () => {
    const help = runCli(['--help'], '');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /jevscout check/);
  });

  test('reads one JSON object from stdin and prints unresolved claims when evidence is empty', () => {
    const result = runCli(['check'], jsonInput({ evidence: [] }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /unresolved/);
    assert.match(result.stdout, /provisional evidence status/);
  });

  test('json format keeps diagnostics without TypeSafe usage when evidence is empty', () => {
    const result = runCli(['check', '--format', 'json'], jsonInput({ evidence: [] }));
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.claims[0].status, 'unresolved');
    assert.equal(body.metrics.typeSafe, null);
    assert.equal(body.thresholds.support, CHECK_THRESHOLDS.support);
    assert.ok(body.warnings.length >= 2);
  });

  test('rejects invalid stdin and missing keys without writing source text', () => {
    const invalid = runCli(['check'], '{');
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /^JevScout:/);
    assert.equal(invalid.stdout, '');

    const missing = runCli(['check'], jsonInput());
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /TYPESAFE_API_KEY/);
    assert.equal(missing.stdout, '');
    assert.equal(missing.stderr.includes(payload().evidence[0].text), false);

    const extra = runCli(['check', 'nope'], jsonInput({ evidence: [] }));
    assert.notEqual(extra.status, 0);
  });

  test('rejects a too-small output budget before calling TypeSafe', () => {
    const result = runCli(['check', '--budget-bytes', '256'], jsonInput({
      task: `Fail-closed fetch behavior ${'detail '.repeat(40)}`,
      evidence: [],
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Budget too small/);
    assert.equal(result.stdout, '');
  });
});
