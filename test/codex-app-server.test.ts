import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexOperationSession, type ReviewedOperation, type OperationExecution } from '../src/hosts/codex-app-server.ts';
import { chooseOperation } from '../src/operations/choice.ts';

const operation: ReviewedOperation = {
  id: 'format', purpose: 'Check formatting.', writes: 'None.', completion: 'Report actual formatting findings.',
  effect: 'read', argv: ['formatter', '--check', 'src'],
};
const request = { id: 'request-1', text: 'Check source formatting without changing it.' };
const response = (choice = 'format', confidence = 0.99) => new Response(JSON.stringify({
  answers: { action: { type: 'choice', choice, confidence } }, usage: { input_tokens: 100, output_tokens: 12 },
}));
function setup(overrides: Partial<Parameters<typeof createCodexOperationSession>[0]> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const session = createCodexOperationSession({
    threadId: 'thread-1', cwd: '/workspace/repo', key: 'test-key', operations: [operation],
    sandboxPolicy: { type: 'readOnly', networkAccess: false, callerRestriction: { preserve: true } },
    fetcher: (async () => response()) as typeof fetch,
    authorize: async () => true,
    verify: async (_op, result) => result.exitCode === 1 && result.stdout.includes('formatting issues') ? 'findings' : 'failed',
    rpc: { async request(method, params) {
      calls.push({ method, params });
      return method === 'command/exec' ? { exitCode: 1, stdout: 'formatting issues: src/file.ts', stderr: '' } : {};
    } },
    ...overrides,
  });
  return { session, calls };
}

test('records real findings and preserves the exact caller sandbox without exposing execution config to Jev', async () => {
  let sent: any;
  const policy = { type: 'readOnly' as const, networkAccess: false, callerRestriction: { preserve: true } };
  const { session, calls } = setup({ sandboxPolicy: policy, fetcher: (async (_url, init) => {
    sent = JSON.parse(init!.body as string); return response();
  }) as typeof fetch });
  policy.networkAccess = true; policy.callerRestriction.preserve = false;
  const r = await session.dispatch(request);
  assert.equal(r.kind, 'completed');
  if (r.kind !== 'completed') return;
  assert.equal(r.receipt.outcome, 'findings'); assert.equal(r.receipt.result?.exitCode, 1);
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: 'readOnly', networkAccess: false, callerRestriction: { preserve: true } });
  assert.deepEqual(calls[0].params.command, operation.argv);
  assert.deepEqual(sent.state, { request: request.text });
  assert.equal(JSON.stringify(sent).includes('/workspace'), false);
  assert.equal(JSON.stringify(sent).includes('test-key'), false);
  assert.equal(calls[1].method, 'thread/inject_items');
  assert.equal(calls[1].params.items[0].content[0].text, request.text);
  assert.match(calls[1].params.items[1].content[0].text, /"outcome":"findings"/);
});

test('missing key, uncertain choice, unknown ID, and provider failure never execute commands', async () => {
  for (const overrides of [
    { key: undefined },
    { fetcher: (async () => response('format', 0.79)) as typeof fetch },
    { fetcher: (async () => response('invented-command')) as typeof fetch },
    { fetcher: (async () => { throw new Error('do not expose secrets'); }) as typeof fetch },
  ]) {
    const { session, calls } = setup(overrides);
    assert.equal((await session.dispatch(request)).kind, 'deferred');
    assert.equal(calls.length, 0);
  }
});

test('HTTP failure retains known usage; malformed decisions do not authorize actions', async () => {
  const { session, calls } = setup({ fetcher: (async () => new Response(JSON.stringify({
    usage: { input_tokens: 41, output_tokens: 2 }, error: 'private server detail',
  }), { status: 503 })) as typeof fetch });
  const result = await session.dispatch(request);
  assert.equal(result.kind, 'deferred');
  if (result.kind === 'deferred') assert.deepEqual(result.usage, { inputTokens: 41, outputTokens: 2 });
  assert.equal(calls.length, 0);
});

test('host refusal and read-only policy prevent a model-selected write', async () => {
  const write = { ...operation, effect: 'write' as const };
  const a = setup({ operations: [write] });
  assert.equal((await a.session.dispatch(request)).kind, 'deferred'); assert.equal(a.calls.length, 0);
  const b = setup({ authorize: async () => false });
  assert.equal((await b.session.dispatch(request)).kind, 'deferred'); assert.equal(b.calls.length, 0);
});

test('missing verification cannot execute an operation for an untyped caller', () => {
  assert.throws(() => setup({ verify: undefined } as unknown as Parameters<typeof setup>[0]), /missing host callbacks/);
});

test('execution acknowledgement loss is uncertain, recorded truthfully, and never re-executed for the same ID', async () => {
  let attempts = 0; let recorded = '';
  const { session } = setup({ rpc: { async request(method, params: any) {
    if (method === 'command/exec') { attempts++; throw new Error('connection lost after submission'); }
    if (method === 'thread/inject_items') recorded = params.items[1].content[0].text;
    return {};
  } } });
  const r = await session.dispatch(request);
  assert.equal(r.kind, 'attention');
  if (r.kind !== 'attention') return;
  assert.equal(r.receipt.execution, 'unknown'); assert.equal(r.receipt.outcome, 'unknown');
  assert.match(recorded, /"execution":"unknown"/);
  assert.equal(await session.dispatch(request), r); assert.equal(attempts, 1);
  await assert.rejects(session.dispatch({ ...request, text: 'a different operation' }), /reused/);
});

test('lost history acknowledgement cannot turn into fallback or replay a command', async () => {
  let executions = 0; let injections = 0;
  const { session } = setup({ rpc: { async request(method) {
    if (method === 'command/exec') { executions++; return { exitCode: 1, stdout: 'formatting issues', stderr: '' }; }
    if (method === 'thread/inject_items') { injections++; throw new Error('acknowledgement lost'); }
    return {};
  } } });
  const r = await session.dispatch(request);
  assert.equal(r.kind, 'attention');
  if (r.kind !== 'attention') return;
  assert.equal(r.phase, 'history'); assert.equal(r.history, 'unknown');
  assert.equal(r.receipt.outcome, 'findings');
  await session.dispatch(request); assert.equal(executions, 1); assert.equal(injections, 1);
});

test('a missing history acknowledgement is never reported as completion', async () => {
  const { session } = setup({ rpc: { async request(method) {
    return method === 'command/exec' ? { exitCode: 1, stdout: 'formatting issues', stderr: '' } : undefined;
  } } });
  const result = await session.dispatch(request);
  assert.equal(result.kind, 'attention');
  if (result.kind === 'attention') assert.equal(result.history, 'unknown');
});

test('verification failure and nonzero exits cannot be reported as successful completion', async () => {
  for (const verify of [async () => { throw new Error('missing artifact'); }, async () => 'passed' as const]) {
    const { session } = setup({ verify });
    const result = await session.dispatch(request);
    assert.equal(result.kind, 'attention');
    if (result.kind === 'attention') assert.notEqual(result.receipt.outcome, 'passed');
  }
});

test('a receipt timeout returns attention without a second history write', async () => {
  let injections = 0;
  const { session } = setup({ rpcGraceMs: 15, rpc: { async request(method) {
    if (method === 'command/exec') return { exitCode: 1, stdout: 'formatting issues', stderr: '' };
    injections++; return new Promise(() => {});
  } } });
  const result = await session.dispatch(request);
  assert.equal(result.kind, 'attention');
  if (result.kind === 'attention') assert.equal(result.phase, 'history');
  assert.equal(injections, 1);
});

test('cancellation before authorization finishes never starts a command', async () => {
  const controller = new AbortController();
  let entered!: () => void; const authorizing = new Promise<void>(r => { entered = r; });
  const { session, calls } = setup({ authorize: async () => { entered(); return new Promise(() => {}); } });
  const pending = session.dispatch(request, controller.signal);
  await authorizing; controller.abort();
  assert.equal((await pending).kind, 'cancelled'); assert.equal(calls.length, 0);
});

test('cancellation after command submission terminates that process and preserves the partial result', async () => {
  const controller = new AbortController(); let started!: () => void;
  const running = new Promise<void>(r => { started = r; });
  let finish!: (r: unknown) => void; let executionId: string | undefined; let terminated: string | undefined;
  const { session } = setup({ rpc: { async request(method, params: any) {
    if (method === 'command/exec') { executionId = params.processId; started(); return new Promise(r => { finish = r; }); }
    if (method === 'command/exec/terminate') { terminated = params.processId; finish({ exitCode: 1, stdout: 'partial', stderr: '' }); }
    return {};
  } } });
  const pending = session.dispatch(request, controller.signal); await running; controller.abort();
  const result = await pending;
  assert.equal(terminated, executionId); assert.equal(result.kind, 'attention');
  if (result.kind === 'attention') { assert.equal(result.phase, 'cancellation'); assert.equal(result.receipt.cancellationRequested, true); }
});

test('same-ID concurrent calls share one execution; different requests cannot interleave', async () => {
  let authorize!: (value: boolean) => void;
  const { session, calls } = setup({ authorize: () => new Promise(r => { authorize = r; }) });
  const first = session.dispatch(request), duplicate = session.dispatch(request);
  assert.equal(first, duplicate);
  await assert.rejects(session.dispatch({ id: 'second', text: request.text }), /active/);
  while (!authorize) await new Promise(r => setImmediate(r));
  authorize(true); await first;
  assert.equal(calls.filter(c => c.method === 'command/exec').length, 1);
});

test('command arguments are frozen and resource caps preserve truncation evidence', async () => {
  const argv = ['formatter', '--check', 'src']; let seen: OperationExecution | undefined;
  const { session, calls } = setup({ operations: [{ ...operation, argv }], outputBytesCap: 256,
    verify: async (_op, r) => { seen = r; return 'findings'; },
    rpc: { async request(method, params) {
      calls.push({ method, params });
      return method === 'command/exec' ? { exitCode: 1, stdout: 'x'.repeat(500), stderr: '' } : {};
    } },
  });
  argv[0] = 'unreviewed-command';
  await session.dispatch(request);
  assert.equal(calls[0].params.command[0], 'formatter');
  assert.equal(seen?.stdout.length, 256); assert.equal(seen?.outputMayBeTruncated, true);
});

test('oversized input never reaches the provider, and receipt capacity does not evict old IDs', async () => {
  let fetches = 0;
  const { session } = setup({ maxRequests: 1, fetcher: (async () => { fetches++; return response(); }) as typeof fetch });
  assert.equal((await session.dispatch({ id: 'large', text: 'x'.repeat(50_000) })).kind, 'deferred');
  assert.equal(fetches, 0);
  await assert.rejects(session.dispatch(request), /capacity/);
});

test('provider responses cannot inject a command not present in the frozen question', async () => {
  const operations = [{ ...operation }];
  await assert.rejects(chooseOperation(request.text, operations, { key: 'test', fetcher: (async () => {
    operations[0].id = 'malicious'; return response('malicious');
  }) as typeof fetch }), /Invalid TypeSafe operation decision/);
});
