// Shared TypeSafe System One transport for every JevScout decision. Callers build their own payloads
// and validate their own answers; this module owns how a request is sent, bounded, retried and read.
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface JevUsage { readonly inputTokens: number; readonly outputTokens: number }

export interface SendOptions {
  key: string;
  fetcher?: typeof fetch;
  /** Absolute Date.now() deadline; a request that cannot start before it fails with "Jev deadline exceeded." */
  deadline?: number;
  /** Per-request timeout when there is no shared deadline. */
  timeoutMs?: number;
  /** Caller cancellation, combined with the timeout. */
  signal?: AbortSignal;
  /** One retry for network failures and 5xx responses, within the same deadline. */
  retry?: boolean;
}

function requestSignal(options: SendOptions): AbortSignal {
  let timeout: number;
  if (options.deadline !== undefined) {
    timeout = options.deadline - Date.now();
    if (timeout <= 0) throw new Error('Jev deadline exceeded.');
  } else {
    timeout = options.timeoutMs ?? 8000;
  }
  const timer = AbortSignal.timeout(timeout);
  return options.signal ? AbortSignal.any([options.signal, timer]) : timer;
}

/** POSTs one System One request body. Network errors propagate unchanged so callers keep their messages. */
export async function sendJev(body: string, options: SendOptions): Promise<Response> {
  const attempts = options.retry ? 2 : 1;
  let response: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const signal = requestSignal(options);
    try {
      response = await (options.fetcher ?? fetch)(TYPESAFE_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' }, body,
      });
    } catch (error) {
      if (attempt === attempts - 1 || options.signal?.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw error;
      continue;
    }
    if (response.status < 500 || attempt === attempts - 1) break;
  }
  return response!;
}

/** Reads a response body up to maxBytes; throws on a missing, unreadable or oversized body. */
export async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Runs batches through a bounded worker pool. The first failure aborts the shared signal, so
 * requests still in flight stop, and is rethrown.
 */
export async function runBatches<T>(batches: T[], concurrency: number, work: (batch: T, signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  let next = 0;
  const worker = async () => {
    while (next < batches.length) await work(batches[next++], controller.signal);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  } catch (error) {
    controller.abort();
    throw error;
  }
}

/** A valid Jev probability answer, or null. */
export function noulOf(answer: unknown): number | null {
  const value = answer as { type?: unknown; noul?: unknown } | null;
  return value && typeof value === 'object' && value.type === 'noul' && typeof value.noul === 'number' &&
    Number.isFinite(value.noul) && value.noul >= 0 && value.noul <= 1 ? value.noul : null;
}

/** Non-negative integer token usage from a System One response, or null. */
export function usageOf(value: unknown): JevUsage | null {
  const u = value as Record<string, unknown> | null;
  return u && typeof u === 'object' && Number.isSafeInteger(u.input_tokens) && Number.isSafeInteger(u.output_tokens) &&
    (u.input_tokens as number) >= 0 && (u.output_tokens as number) >= 0
    ? Object.freeze({ inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number }) : null;
}
