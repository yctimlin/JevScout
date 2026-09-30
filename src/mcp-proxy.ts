import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { condense, JevUnavailableError, recoverOutput, saveOutput, segment } from './condense.ts';
import { hookConfig, isLocator, withoutUrls, type HookConfig } from './hook.ts';
import { recordActivity } from './activity.ts';

// A stdio MCP proxy for hosts whose hooks cannot replace MCP results (Codex). Every message is
// forwarded unchanged, except that large text results of tools/call come back as condensed packets,
// and one recovery tool is added. It fails open: any condensing problem returns the original result.
export const RECOVER_TOOL = 'jevscout_recover';
export const SELECT_PREFIX = 'jevscout_select_';
// An optional argument added to bulk-context tools so the agent can say what it needs from the result.
// It is removed before the call is forwarded; the upstream server never sees it.
export const INTENT_ARG = 'jevscout_intent';
const BULK_TOOL = /\b(?:fetch|search|list|query|read|download|page|document|content|comments|messages|thread|logs?|history|batch)\b/i;
const intentProperty = {
  type: 'string',
  description: 'Optional: what you need from the result, used to select parts of large results.',
};

export function addIntent(tool: any): any {
  if (!tool || typeof tool !== 'object' || tool.name === RECOVER_TOOL) return tool;
  const searchable = `${tool.name ?? ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ') + ` ${tool.description ?? ''}`;
  if (!BULK_TOOL.test(searchable)) return tool;
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
  if (schema.type !== undefined && schema.type !== 'object') return tool;
  if (schema.properties?.[INTENT_ARG]) return tool;
  return { ...tool, inputSchema: { ...schema, type: 'object', properties: { ...(schema.properties ?? {}), [INTENT_ARG]: intentProperty } } };
}

export function requireIntent(tool: any): any {
  const offered = addIntent(tool);
  if (offered === tool) return tool;
  const required = Array.isArray(offered.inputSchema.required) ? offered.inputSchema.required : [];
  return { ...offered, inputSchema: { ...offered.inputSchema,
    required: [...new Set([...required, INTENT_ARG])] } };
}

export function addSelector(tool: any): any | null {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') return null;
  if (tool.name === RECOVER_TOOL || tool.name.startsWith(SELECT_PREFIX)) return null;
  const searchable = tool.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ') + ` ${tool.description ?? ''}`;
  if (!BULK_TOOL.test(searchable)) return null;
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
  if (schema.type !== undefined && schema.type !== 'object') return null;
  if (schema.properties?.[INTENT_ARG]) return null;
  return { ...tool, name: `${SELECT_PREFIX}${tool.name}`,
    description: `Select relevant verbatim evidence from a potentially large ${tool.name} result. Give the exact facts needed in jevscout_intent; the original tool remains available. ${tool.description ?? ''}`.trim(),
    inputSchema: { ...schema, type: 'object', properties: { ...(schema.properties ?? {}), [INTENT_ARG]: intentProperty },
      required: [...new Set([...(schema.required ?? []), INTENT_ARG])] } };
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
const boundedRecoverTool = {
  ...recoverTool,
  description: 'Recover one exact source segment by number or search bounded matching spans with grep. Whole-output reads are unavailable for this result.',
  inputSchema: { ...recoverTool.inputSchema, properties: { id: recoverTool.inputSchema.properties.id,
    segment: recoverTool.inputSchema.properties.segment, grep: recoverTool.inputSchema.properties.grep } },
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

export function exactPublishTimestamp(text: string, query: string) {
  if (!/\b(?:publish(?:ed|ing)?|timestamp|release date)\b/i.test(query)) return null;
  const versions = [
    ...[...query.matchAll(/\bversion\s+((?:\d+\.){2}\d+(?:-[a-z0-9.-]+)?)\b/gi)].map(match => match[1]),
    ...[...query.matchAll(/\btime\[\s*['"]?((?:\d+\.){2}\d+(?:-[a-z0-9.-]+)?)['"]?\s*\]/gi)].map(match => match[1]),
  ];
  if (new Set(versions).size !== 1) return null;
  const version = versions[0];
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const time = (data as Record<string, unknown>).time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) return null;
  const value = (time as Record<string, unknown>)[version];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const found = segment(text).find(item => item.label === `.time.${version} ${value}`);
  if (!found) return null;
  try { if (JSON.parse(`{${found.text}}`)[version] !== value) return null; } catch { return null; }
  const packageName = (data as Record<string, unknown>).name;
  return { version, value, packageName: typeof packageName === 'string' ? packageName : null,
    index: found.index, start: found.start, end: found.end, raw: found.text };
}

export function matchesRegistryPackage(url: unknown, packageName: string | null): boolean {
  if (typeof url !== 'string') return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'registry.npmjs.org') return true;
    return packageName !== null && decodeURIComponent(parsed.pathname.slice(1)) === packageName;
  } catch { return false; }
}

export async function transformResult(message: any, call: { name: string; arguments: unknown; intent?: string }, config: HookConfig, source: string) {
  if (message?.result?.isError) return message;
  const content = message?.result?.content;
  if (!Array.isArray(content) || !content.length || !content.every((block: any) => block?.type === 'text' && typeof block.text === 'string')) return message;
  const text = content.map((block: any) => block.text).join('\n');
  const bytes = Buffer.byteLength(text);
  const tool = `${source}/${call.name}`;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const passed = (reason: string, typeSafe?: JevUnavailableError['typeSafe'] | null) => {
    recordActivity({ host: 'codex-proxy', tool, action: 'passed', reason, inputBytes: bytes, ms: ms(), typeSafe: typeSafe ?? null });
    return message;
  };
  if (bytes <= config.minBytes) return passed('small');
  const args = call.arguments && typeof call.arguments === 'object' ? call.arguments as Record<string, unknown> : {};
  const hasTaskQuery = Boolean(call.intent?.trim()) || ['query', 'search', 'question'].some(key => typeof args[key] === 'string' && String(args[key]).trim());
  if (config.mode === 'auto' && !hasTaskQuery) return passed('no-query');
  const query = `${call.intent ?? ''}\n${toolQuery(call.name, call.arguments)}`.trim();
  const skipFineAt = Number(process.env.JEVSCOUT_CODEX_SKIP_FINE_AT);
  const previewStyle = process.env.JEVSCOUT_CODEX_PREVIEW_STYLE;
  const focused = process.env.JEVSCOUT_CODEX_PACKET_STYLE === 'focused';
  try {
    if (config.mode === 'auto' && config.typeSafeKey) {
      const exact = exactPublishTimestamp(text, query);
      if (exact && matchesRegistryPackage(args.url, exact.packageName)) {
        const id = saveOutput(text, { source: `${source}/${call.name}`, query, inputBytes: Buffer.byteLength(text), usedMode: 'exact-json', typeSafe: null });
        const packet = `[JevScout exact JSON field from ${source}/${call.name}; source text is verbatim.]\n${exact.packageName ? `Package: ${JSON.stringify(exact.packageName)}\n` : ''}Path: time[${JSON.stringify(exact.version)}], chars ${exact.start}-${exact.end}, segment ${exact.index}\n${exact.raw}\nRecover: the ${RECOVER_TOOL} tool with id ${id} [--segment N | --grep TEXT | --all]\n`;
        recordActivity({ host: 'codex-proxy', tool, action: 'condensed', inputBytes: bytes, outputBytes: Buffer.byteLength(packet), shown: 1, ms: ms(), typeSafe: null, id });
        const { structuredContent: _dropped, ...rest } = message.result;
        return { ...message, result: { ...rest, content: [{ type: 'text', text: packet }] } };
      }
    }
    const result = await condense(text, {
      query, source: tool, budgetBytes: config.budgetBytes,
      mode: config.mode, typeSafeKey: config.typeSafeKey, model: config.model, timeoutMs: config.timeoutMs,
      jevTuning: {
        ...(Number.isFinite(skipFineAt) && skipFineAt >= 0 && skipFineAt <= 1 ? { skipFineAt } : {}),
        ...(previewStyle === 'head-tail' ? { previewStyle } : {}),
      },
      packetStyle: focused ? 'focused' : undefined,
      recoverCommand: `the ${RECOVER_TOOL} tool with id`,
    });
    if (result.outputBytes >= bytes) return passed('not-smaller', result.typeSafe);
    recordActivity({ host: 'codex-proxy', tool, action: 'condensed', inputBytes: bytes, outputBytes: result.outputBytes,
      segments: result.segments, shown: result.shown, ms: ms(), typeSafe: result.typeSafe, id: result.id });
    // structuredContent would carry the full payload past the packet, so it is dropped with the text.
    const { structuredContent: _dropped, ...rest } = message.result;
    return { ...message, result: { ...rest, content: [{ type: 'text', text: result.text }] } };
  } catch (error) {
    if (process.env.JEVSCOUT_CODEX_DIAGNOSTICS) {
      const diagnostic = { event: 'pass-through', reason: error instanceof JevUnavailableError ? error.message : 'transform error',
        typeSafe: error instanceof JevUnavailableError ? error.typeSafe ?? null : null };
      try { appendFileSync(process.env.JEVSCOUT_CODEX_DIAGNOSTICS, JSON.stringify(diagnostic) + '\n'); } catch { /* diagnostics never affect tool results */ }
    }
    return passed(error instanceof JevUnavailableError ? error.code : 'error', error instanceof JevUnavailableError ? error.typeSafe : null);
  }
}

export function recoverResult(id: unknown, args: any, allowAll = true) {
  try {
    if (!allowAll && args?.all === true) throw new Error('Whole-output recovery is unavailable; request a segment or grep.');
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

export function runProxy(command: string[], options: { source?: string; config?: HookConfig; route?: 'transparent' | 'explicit' | 'selector-only' | 'intent-required' } = {}): Promise<number> {
  const config = options.config ?? hookConfig();
  const route = options.route ?? process.env.JEVSCOUT_CODEX_ROUTE;
  const explicit = route === 'explicit' || route === 'selector-only';
  const selectorOnly = route === 'selector-only';
  const intentRequired = route === 'intent-required';
  const boundedRecovery = process.env.JEVSCOUT_CODEX_RECOVERY_SCOPE === 'bounded';
  const source = options.source ?? command.map(part => part.split('/').at(-1)).join(' ').slice(0, 60);
  const upstream = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  const calls = new Map<string, { name: string; arguments: unknown; intent?: string; select?: boolean }>();
  const listRequests = new Set<string>();
  const advertisedSelectors = new Map<string, string>();
  let recoverListed = false;
  // Upstream responses may need async work; a promise chain keeps them in their original order.
  let queue = Promise.resolve();
  const write = (message: unknown) => { process.stdout.write(JSON.stringify(message) + '\n'); };

  createInterface({ input: process.stdin }).on('line', line => {
    let message: any;
    try { message = JSON.parse(line); } catch { upstream.stdin.write(line + '\n'); return; }
    const key = JSON.stringify(message?.id);
    if (message?.method === 'tools/call' && message.params?.name === RECOVER_TOOL) {
      queue = queue.then(() => write(recoverResult(message.id, message.params.arguments, !boundedRecovery)));
      return;
    }
    if (explicit && message?.method === 'tools/call' && advertisedSelectors.has(message.params?.name)) {
      const intent = message.params.arguments?.[INTENT_ARG];
      if (typeof intent !== 'string' || !intent.trim()) {
        queue = queue.then(() => write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'jevscout_intent is required for selected context.' }], isError: true } }));
        return;
      }
      const { [INTENT_ARG]: _intent, ...rest } = message.params.arguments;
      const name = advertisedSelectors.get(message.params.name)!;
      message = { ...message, params: { ...message.params, name, arguments: rest } };
      if (message.id !== undefined) calls.set(key, { name, arguments: rest, intent: intent.slice(0, 1000), select: true });
      upstream.stdin.write(JSON.stringify(message) + '\n');
      return;
    }
    if (explicit && message?.method === 'tools/call') {
      if (message.id !== undefined) calls.set(key, { name: String(message.params?.name ?? ''), arguments: message.params?.arguments, select: false });
      upstream.stdin.write(line + '\n');
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
      if (explicit) {
        const native = message.result.tools;
        const names = new Set<string>(native.map((tool: any) => tool?.name).filter((name: unknown): name is string => typeof name === 'string'));
        for (const name of names) advertisedSelectors.delete(name);
        const exposed = [];
        for (const tool of native) {
          const selector = addSelector(tool);
          if (!selector || names.has(selector.name)) { exposed.push(tool); continue; }
          advertisedSelectors.set(selector.name, tool.name);
          if (!selectorOnly) exposed.push(tool);
          exposed.push(selector);
        }
        message.result.tools = exposed;
      } else message.result.tools = message.result.tools.map(intentRequired ? requireIntent : addIntent);
      // Added once per session, so paginated or repeated lists do not duplicate it.
      if (!recoverListed && !message.result.tools.some((tool: any) => tool?.name === RECOVER_TOOL)) { message.result.tools.push(boundedRecovery ? boundedRecoverTool : recoverTool); recoverListed = true; }
    }
    const call = isResponse ? calls.get(key) : undefined;
    if (call) calls.delete(key);
    queue = queue.then(async () => write(call && (!explicit || call.select) ? await transformResult(message, call, config, source) : message));
  });

  return new Promise(resolve => upstream.on('close', code => { queue.then(() => resolve(code ?? 0)); }));
}
