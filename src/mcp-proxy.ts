import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { condense, recoverOutput } from './condense.ts';
import { hookConfig, isLocator, withoutUrls, type HookConfig } from './hook.ts';

// A stdio MCP proxy for hosts whose hooks cannot replace MCP results (Codex). Every message is
// forwarded unchanged, except that large text results of tools/call come back as condensed packets,
// and one recovery tool is added. It fails open: any condensing problem returns the original result.
export const RECOVER_TOOL = 'jevscout_recover';
// An optional argument added to every upstream tool so the agent can say what it needs from the result.
// It is removed before the call is forwarded; the upstream server never sees it.
export const INTENT_ARG = 'jevscout_intent';
const intentProperty = {
  type: 'string',
  description: 'Optional: what you need from the result, used to select parts of large results.',
};

export function addIntent(tool: any): any {
  if (!tool || typeof tool !== 'object' || tool.name === RECOVER_TOOL) return tool;
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
  if (schema.type !== undefined && schema.type !== 'object') return tool;
  if (schema.properties?.[INTENT_ARG]) return tool;
  return { ...tool, inputSchema: { ...schema, type: 'object', properties: { ...(schema.properties ?? {}), [INTENT_ARG]: intentProperty } } };
}

const recoverTool = {
  name: RECOVER_TOOL,
  description: 'Recover exact text that JevScout omitted from a condensed tool result. Use the output id from the packet, with one of: segment (number), grep (text), or all (true).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Output id shown in the condensed packet.' },
      segment: { type: 'integer', minimum: 0 },
      grep: { type: 'string' },
      all: { type: 'boolean' },
    },
    required: ['id'],
  },
};

function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === 'string' && value.length <= 500 && !isLocator(value)) out.push(withoutUrls(value));
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out, depth + 1);
  return out;
}

export function toolQuery(name: string, args: unknown): string {
  return `${name.replace(/[_-]/g, ' ')} ${strings(args).join(' ')}`.slice(0, 2000);
}

export async function transformResult(message: any, call: { name: string; arguments: unknown; intent?: string }, config: HookConfig, source: string) {
  const content = message?.result?.content;
  if (!Array.isArray(content) || !content.length || !content.every((block: any) => block?.type === 'text' && typeof block.text === 'string')) return message;
  const text = content.map((block: any) => block.text).join('\n');
  if (Buffer.byteLength(text) <= config.minBytes) return message;
  try {
    const result = await condense(text, {
      query: `${call.intent ?? ''}\n${toolQuery(call.name, call.arguments)}`.trim(), source: `${source}/${call.name}`, budgetBytes: config.budgetBytes,
      mode: config.mode, typeSafeKey: config.typeSafeKey, model: config.model, timeoutMs: config.timeoutMs,
      recoverCommand: `the ${RECOVER_TOOL} tool with id`,
    });
    if (result.outputBytes >= Buffer.byteLength(text)) return message;
    // structuredContent would carry the full payload past the packet, so it is dropped with the text.
    const { structuredContent: _dropped, ...rest } = message.result;
    return { ...message, result: { ...rest, content: [{ type: 'text', text: result.text }] } };
  } catch {
    return message;
  }
}

export function recoverResult(id: unknown, args: any) {
  try {
    const text = recoverOutput(String(args?.id ?? ''), {
      segment: Number.isSafeInteger(args?.segment) ? args.segment : undefined,
      grep: typeof args?.grep === 'string' ? args.grep : undefined,
      all: args?.all === true,
    });
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `JevScout recovery failed: ${error instanceof Error ? error.message : 'unknown error'}` }], isError: true } };
  }
}

export function runProxy(command: string[], options: { source?: string; config?: HookConfig } = {}): Promise<number> {
  const config = options.config ?? hookConfig();
  const source = options.source ?? command.map(part => part.split('/').at(-1)).join(' ').slice(0, 60);
  const upstream = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  const calls = new Map<string, { name: string; arguments: unknown; intent?: string }>();
  const listRequests = new Set<string>();
  let recoverListed = false;
  // Upstream responses may need async work; a promise chain keeps them in their original order.
  let queue = Promise.resolve();
  const write = (message: unknown) => { process.stdout.write(JSON.stringify(message) + '\n'); };

  createInterface({ input: process.stdin }).on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { upstream.stdin.write(line + '\n'); return; }
    const key = JSON.stringify(message?.id);
    if (message?.method === 'tools/call' && message.params?.name === RECOVER_TOOL) {
      queue = queue.then(() => write(recoverResult(message.id, message.params.arguments)));
      return;
    }
    if (message?.method === 'tools/call' && message.params?.arguments && typeof message.params.arguments === 'object' && INTENT_ARG in message.params.arguments) {
      const { [INTENT_ARG]: intent, ...rest } = message.params.arguments;
      message = { ...message, params: { ...message.params, arguments: rest } };
      if (message.id !== undefined) calls.set(key, { name: String(message.params.name ?? ''), arguments: rest, intent: typeof intent === 'string' ? intent.slice(0, 1000) : undefined });
      upstream.stdin.write(JSON.stringify(message) + '\n');
      return;
    }
    if (message?.method === 'tools/call' && message.id !== undefined) calls.set(key, { name: String(message.params?.name ?? ''), arguments: message.params?.arguments });
    if (message?.method === 'tools/list' && message.id !== undefined) listRequests.add(key);
    upstream.stdin.write(line + '\n');
  }).on('close', () => upstream.stdin.end());

  createInterface({ input: upstream.stdout }).on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { queue = queue.then(() => { process.stdout.write(line + '\n'); }); return; }
    const key = JSON.stringify(message?.id);
    const isResponse = message && message.method === undefined && message.id !== undefined;
    if (isResponse && listRequests.delete(key) && Array.isArray(message.result?.tools)) {
      message.result.tools = message.result.tools.map(addIntent);
      // Added once per session, so paginated or repeated lists do not duplicate it.
      if (!recoverListed && !message.result.tools.some((tool: any) => tool?.name === RECOVER_TOOL)) { message.result.tools.push(recoverTool); recoverListed = true; }
    }
    const call = isResponse ? calls.get(key) : undefined;
    if (call) calls.delete(key);
    queue = queue.then(async () => write(call ? await transformResult(message, call, config, source) : message));
  });

  return new Promise(resolve => upstream.on('close', code => { queue.then(() => resolve(code ?? 0)); }));
}
