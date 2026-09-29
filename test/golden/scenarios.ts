// Golden scenarios for every TypeSafe call site. The recorded requests and normalized results were
// captured from the pre-refactor code; the shared core must reproduce them exactly.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { condense } from '../../src/condense.ts';
import { rank } from '../../src/rank.ts';
import { searchGitHub } from '../../src/github.ts';
import { check } from '../../src/check.ts';
import { chooseOperation } from '../../src/operations/choice.ts';
import { createCodexOperationSession } from '../../src/hosts/codex-app-server.ts';

process.env.JEVSCOUT_CACHE_DIR ??= mkdtempSync(join(tmpdir(), 'jevscout-golden-'));

export interface Recorded { url: string; method?: string; redirect?: string; headers: Record<string, string>; body: string }
type Reply = (request: Recorded, call: number) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textOf(state: any, key: string): string {
  const docId = key.split(':')[0];
  const doc = state.documents?.find((d: any) => String(d.id) === docId);
  if (doc) return String(doc.text ?? '') + String(doc.title ?? '');
  const match = /^c(\d+)e(\d+)[sc]$/.exec(key);
  if (match) return state.evidence?.[Number(match[2])]?.text ?? '';
  return '';
}

// Deterministic scores: NEEDLE text is relevant, everything else gets a small stable score.
export function noulReply(options: { low?: boolean } = {}): Reply {
  return request => {
    const body = JSON.parse(request.body);
    const answers = Object.fromEntries(Object.keys(body.questions).map(key => {
      const text = textOf(body.state, key);
      const high = !options.low && text.includes('NEEDLE') && !key.endsWith(':instruction') && !key.endsWith(':conflict') && !key.endsWith('c');
      let hash = 0;
      for (const char of key + text.length) hash = (hash * 31 + char.charCodeAt(0)) % 997;
      return [key, { type: 'noul', noul: high ? 0.93 : Number((0.02 + (hash % 20) / 100).toFixed(2)) }];
    }));
    return json({ model: 'jev-golden', answers, usage: { input_tokens: 100 + request.body.length % 50, output_tokens: 7 } });
  };
}

function recorder(reply: Reply) {
  const requests: Recorded[] = [];
  let calls = 0;
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const request: Recorded = { url: String(url), method: init.method, redirect: init.redirect, headers, body: typeof init.body === 'string' ? init.body : '' };
    requests.push(request);
    return reply(request, calls++);
  }) as typeof fetch;
  return { fetcher, requests };
}

// Remove values that legitimately differ between runs: output IDs, timings, and saved-output paths.
export function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<id>');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /(Ms|latency)$/i.test(k) && typeof v === 'number' ? 0 : normalize(v)]));
  }
  return value;
}

async function outcome(run: () => Promise<unknown>) {
  try { return { result: normalize(await run()) }; }
  catch (error) { return { error: { name: (error as Error).name, message: normalize((error as Error).message) } }; }
}

const records = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1, title: `Record ${i + 1} about routine maintenance`, body: i === 23 ? 'NEEDLE: the retry budget is 7 attempts per hour.' : `Routine note ${i} with filler text `.repeat(6),
}));
const bigJson = JSON.stringify(records, null, 2) + '\n' + JSON.stringify({ padding: 'x'.repeat(4000) });
const condenseOptions = (fetcher: typeof fetch) => ({ query: 'How many retries are allowed per hour?', source: 'mcp__golden__search', mode: 'auto' as const, typeSafeKey: 'golden-key', budgetBytes: 6000, fetcher, recoverCommand: 'jevscout output' });

const candidates = Array.from({ length: 30 }, (_, i) => ({
  id: `c${i}`, file: `src/file${i % 5}.ts`, start: i * 10 + 1, end: i * 10 + 9, hash: `h${i}`,
  text: i === 11 ? 'NEEDLE export const retryBudget = 7;' : `const value${i} = ${i};`, lexical: 30 - i,
}));

function githubFetcher(reply: Reply) {
  const recorded = recorder(reply);
  const items = [
    { number: 42, title: 'Retry budget per hour', body: 'NEEDLE: the retry budget is 7 attempts per hour.' },
    { number: 7, title: 'Unrelated badge change', body: 'Update README badges.' },
    { number: 3, title: 'Docs typo', body: 'Fix a typo in the guide.' },
  ].map(item => ({ ...item, state: 'open', updated_at: '2024-01-02T00:00:00Z', repository_url: 'https://api.github.com/repos/owner/name', html_url: `https://github.com/owner/name/issues/${item.number}` }));
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith('https://api.github.com/')) return json({ total_count: items.length, incomplete_results: false, items });
    return recorded.fetcher(url, init);
  }) as typeof fetch;
  return { fetcher, requests: recorded.requests };
}

const checkInput = {
  task: 'Is the retry budget 7 attempts per hour?',
  claims: [{ id: 'k1', text: 'The retry budget is 7 attempts per hour.' }],
  evidence: [
    { id: 'e1', source: 'docs/retry.md', text: 'NEEDLE: the retry budget is 7 attempts per hour.' },
    { id: 'e2', source: 'docs/other.md', text: 'The README has badges.' },
  ],
};

const operations = [
  { id: 'format:check', purpose: 'Report formatting problems without changing files.', writes: 'None.', completion: 'Formatter check output.', effect: 'read' as const, argv: ['npm', 'run', 'format:check'] },
  { id: 'test:unit', purpose: 'Run the unit test suite.', writes: 'Test caches only.', completion: 'Test runner summary.', effect: 'write' as const, argv: ['npm', 'test'] },
];
const choice = (answer: unknown, status = 200) => () => json({ answers: { action: answer }, usage: { input_tokens: 321, output_tokens: 9 } }, status);
const chooseRun = (reply: Reply) => {
  const { fetcher, requests } = recorder(reply);
  return { requests, run: () => chooseOperation('Check formatting without changing anything.', operations, { key: 'golden-key', fetcher }) };
};

export const scenarios: Record<string, () => Promise<{ requests: Recorded[]; rpc?: unknown[]; outcome: unknown }>> = {
  async 'condense success'() {
    const { fetcher, requests } = recorder(noulReply());
    return { requests, outcome: await outcome(() => condense(bigJson, condenseOptions(fetcher))) };
  },
  async 'condense retries one server error'() {
    const ok = noulReply();
    const { fetcher, requests } = recorder((request, call) => call === 0 ? json({ error: 'busy' }, 503) : ok(request, call));
    return { requests, outcome: await outcome(() => condense(bigJson, condenseOptions(fetcher))) };
  },
  async 'condense repeated server error'() {
    const { fetcher, requests } = recorder(() => json({ error: 'down' }, 500));
    return { requests, outcome: await outcome(() => condense(bigJson, condenseOptions(fetcher))) };
  },
  async 'condense repeated network error'() {
    const { fetcher, requests } = recorder(() => { throw new TypeError('fetch failed'); });
    return { requests, outcome: await outcome(() => condense(bigJson, condenseOptions(fetcher))) };
  },
  async 'condense invalid usage'() {
    const { fetcher, requests } = recorder(() => json({ answers: {}, usage: {} }));
    return { requests, outcome: await outcome(() => condense(bigJson, condenseOptions(fetcher))) };
  },
  async 'condense low confidence'() {
    const { fetcher, requests } = recorder(noulReply({ low: true }));
    return { requests, outcome: await outcome(() => condense(bigJson, condenseOptions(fetcher))) };
  },
  async 'rank success'() {
    const { fetcher, requests } = recorder(noulReply());
    return { requests, outcome: await outcome(() => rank('Where is the retry budget defined?', candidates, { key: 'golden-key', fetcher })) };
  },
  async 'rank server error'() {
    const { fetcher, requests } = recorder(() => json({ error: 'down' }, 500));
    return { requests, outcome: await outcome(() => rank('Where is the retry budget defined?', candidates, { key: 'golden-key', fetcher })) };
  },
  async 'rank invalid response'() {
    const { fetcher, requests } = recorder(() => json({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }));
    return { requests, outcome: await outcome(() => rank('Where is the retry budget defined?', candidates, { key: 'golden-key', fetcher })) };
  },
  async 'github search success'() {
    const { fetcher, requests } = githubFetcher(noulReply());
    return { requests, outcome: await outcome(() => searchGitHub({ repo: 'owner/name', query: 'retry budget per hour', mode: 'jev', typeSafeKey: 'golden-key', fetcher, followLinks: false })) };
  },
  async 'github search server error'() {
    const { fetcher, requests } = githubFetcher(() => json({ error: 'down' }, 500));
    return { requests, outcome: await outcome(() => searchGitHub({ repo: 'owner/name', query: 'retry budget per hour', mode: 'jev', typeSafeKey: 'golden-key', fetcher, followLinks: false })) };
  },
  async 'check success'() {
    const { fetcher, requests } = recorder(noulReply());
    return { requests, outcome: await outcome(() => check(checkInput, { key: 'golden-key', fetcher })) };
  },
  async 'check network error'() {
    const { fetcher, requests } = recorder(() => { throw new TypeError('fetch failed'); });
    return { requests, outcome: await outcome(() => check(checkInput, { key: 'golden-key', fetcher })) };
  },
  async 'check timeout'() {
    const { fetcher, requests } = recorder(() => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
    return { requests, outcome: await outcome(() => check(checkInput, { key: 'golden-key', fetcher })) };
  },
  async 'check invalid json'() {
    const { fetcher, requests } = recorder(() => new Response('not json', { status: 200 }));
    return { requests, outcome: await outcome(() => check(checkInput, { key: 'golden-key', fetcher })) };
  },
  async 'choose confident'() {
    const { requests, run } = chooseRun(choice({ type: 'choice', choice: 'format:check', confidence: 0.97 }));
    return { requests, outcome: await outcome(run) };
  },
  async 'choose below gate'() {
    const { requests, run } = chooseRun(choice({ type: 'choice', choice: 'format:check', confidence: 0.6 }));
    return { requests, outcome: await outcome(run) };
  },
  async 'choose http error with usage'() {
    const { requests, run } = chooseRun(choice({ type: 'choice', choice: 'format:check', confidence: 0.97 }, 500));
    return { requests, outcome: await outcome(run) };
  },
  async 'choose non-json'() {
    const { requests, run } = chooseRun(() => new Response('<html>bad gateway</html>', { status: 502 }));
    return { requests, outcome: await outcome(run) };
  },
  async 'choose oversized response'() {
    const { requests, run } = chooseRun(() => new Response('x'.repeat(70_000)));
    return { requests, outcome: await outcome(run) };
  },
  async 'choose network error'() {
    const { requests, run } = chooseRun(() => { throw new TypeError('fetch failed'); });
    return { requests, outcome: await outcome(run) };
  },
  async 'choose invalid choice'() {
    const { requests, run } = chooseRun(choice({ type: 'choice', choice: 'deploy', confidence: 0.99 }));
    return { requests, outcome: await outcome(run) };
  },
  async 'codex dispatch completed'() {
    const { fetcher, requests } = recorder(choice({ type: 'choice', choice: 'format:check', confidence: 0.97 }));
    const rpc: unknown[] = [];
    const session = createCodexOperationSession({
      threadId: 'thread-golden', cwd: '/workspace/repo', key: 'golden-key', operations, fetcher,
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      authorize: async () => true,
      verify: async (_op, result) => result.exitCode === 1 ? 'findings' : 'failed',
      rpc: { async request(method, params) { rpc.push({ method, params }); return method === 'command/exec' ? { exitCode: 1, stdout: 'src/a.ts needs formatting', stderr: '' } : {}; } },
    });
    return { requests, rpc, outcome: await outcome(() => session.dispatch({ id: 'req-1', text: 'Check formatting without changing anything.' })) };
  },
};

export async function runAll() {
  const out: Record<string, unknown> = {};
  for (const [name, scenario] of Object.entries(scenarios)) {
    const { requests, rpc, outcome } = await scenario();
    // Concurrent batches may be sent in any order; compare the set of exact requests.
    const sorted = requests.map(r => JSON.stringify(r)).sort().map(r => JSON.parse(r));
    out[name] = { requests: sorted, ...(rpc ? { rpc: normalize(rpc) } : {}), outcome };
  }
  return out;
}
