import { readBounded, sendJev, usageOf, type JevUsage } from '../core/jev.ts';

/** A reviewed, fixed operation. Jev never supplies executable arguments. */
export interface OperationDescription {
  readonly id: string;
  readonly purpose: string;
  readonly writes: string;
  readonly completion: string;
}

export type OperationUsage = JevUsage;
export interface OperationDecision {
  readonly choice: string;
  readonly confidence: number;
  readonly selected: string | null;
  readonly usage: OperationUsage;
}

export class OperationProviderError extends Error {
  readonly usage: OperationUsage | null;
  constructor(message: string, usage: OperationUsage | null = null) { super(message); this.usage = usage; }
}

// Selection identifies an operation; authorization and verification belong to code.
export const OPERATION_INSTRUCTIONS = 'Select the single registered repository operation that fulfills the user request. Each option states its purpose, write scope, and completion evidence. Select an operation only when the user requests execution and its effects match the request. A question about how to do something, a request for code implementation or repair, an unsupported combination of operations, publication, or an ambiguous request goes to needs_agent. The program checks prerequisites before execution. Return a choice only; do not infer that executing an operation succeeded.';

export function operationPayload(request: string, operations: readonly OperationDescription[], model = 'jev-1.13.0') {
  if (!request.trim() || !model.trim() || operations.length === 0 || operations.length > 30 ||
      new Set(operations.map(op => op.id)).size !== operations.length) throw new Error('Invalid operation selection input');
  for (const op of operations) {
    if (!/^[A-Za-z][\w:.-]{0,79}$/.test(op.id) || op.id === 'needs_agent' ||
        [op.purpose, op.writes, op.completion].some(v => typeof v !== 'string' || !v.trim())) {
      throw new Error('Invalid reviewed operation description');
    }
  }
  const payload = { model, state: { request }, questions: { action: {
    type: 'choice', instructions: OPERATION_INSTRUCTIONS,
    criteria: { ...Object.fromEntries(operations.map(({ id, purpose, writes, completion }) => [id, { purpose, writes, completion }])),
      needs_agent: 'Continue the normal coding-agent workflow without automatically executing an operation.' },
  } } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 48_000) throw new Error('Operation request exceeds its size limit');
  return payload;
}

export async function chooseOperation(request: string, operations: readonly OperationDescription[], options: {
  key: string; model?: string; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<OperationDecision> {
  const payload = operationPayload(request, operations, options.model);
  const allowedChoices = Object.keys(payload.questions.action.criteria);
  let response: Response;
  try {
    response = await sendJev(JSON.stringify(payload), { key: options.key, fetcher: options.fetcher, signal: options.signal, timeoutMs: 10_000 });
  } catch { throw new OperationProviderError('TypeSafe request failed; usage is unknown'); }
  let raw: string;
  try { raw = await readBounded(response, 65_536); }
  catch { throw new OperationProviderError('Invalid TypeSafe response; usage is unknown'); }
  let data: { answers?: { action?: { type?: unknown; choice?: unknown; confidence?: unknown } }; usage?: unknown };
  try { data = JSON.parse(raw); }
  catch { throw new OperationProviderError('Invalid TypeSafe JSON; usage is unknown'); }
  const usage = usageOf(data?.usage);
  if (!response.ok) throw new OperationProviderError(`TypeSafe HTTP ${response.status}`, usage);
  const answer = data?.answers?.action;
  if (!usage || answer?.type !== 'choice' || typeof answer.choice !== 'string' ||
      !allowedChoices.includes(answer.choice) ||
      typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new OperationProviderError('Invalid TypeSafe operation decision', usage);
  }
  return Object.freeze({ choice: answer.choice, confidence: answer.confidence,
    selected: answer.confidence >= 0.8 && answer.choice !== 'needs_agent' ? answer.choice : null, usage });
}
