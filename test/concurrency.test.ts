import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { rank } from '../src/rank.ts';
import { digest } from '../src/retrieve.ts';

test('ranking uses at most two concurrent requests and preserves all candidate identities', async () => {
  let active = 0;
  let maximum = 0;
  const candidates = Array.from({ length: 49 }, (_, i) => ({ id: String(i), file: `${i}.ts`, start: 1, end: 1, hash: digest('x'), lexical: 1, text: 'x' }));
  const result = await rank('x', candidates, { key: 'test', fetcher: async (_url, init) => {
    active++;
    maximum = Math.max(maximum, active);
    const body = JSON.parse(String(init?.body));
    await setTimeout(10);
    active--;
    return new Response(JSON.stringify({ model: 'test', answers: Object.fromEntries(body.state.documents.map((d: {id: string}) => [d.id, {type: 'noul', noul: 0.8}])), usage: {input_tokens: 10, output_tokens: 1} }));
  } });
  assert.equal(maximum, 2);
  assert.equal(result.calls, 3);
  assert.equal(result.inputTokens, 30);
  assert.deepEqual(new Set(result.candidates.map(c => c.id)), new Set(candidates.map(c => c.id)));
});

test('a failed batch aborts another in-flight request instead of leaking a partial ranking', async () => {
  const candidates = Array.from({ length: 25 }, (_, i) => ({ id: String(i), file: `${i}.ts`, start: 1, end: 1, hash: digest('x'), lexical: 1, text: 'x' }));
  let calls = 0;
  let aborted = false;
  await assert.rejects(rank('x', candidates, { key: 'test', fetcher: async (_url, init) => {
    calls++;
    if (calls === 1) { await setTimeout(5); return new Response('', {status: 503}); }
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, {once: true});
    });
  } }), /Jev HTTP 503/);
  assert.equal(aborted, true);
});
