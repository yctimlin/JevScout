import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { condense } from './condense.ts';

// Hooks must never break tool use: every entry point fails open (no output leaves the tool result as is).
export interface HookConfig {
  // 'oversized' (default): condense only results that exceed Claude Code's own limit, which Claude
  // Code would otherwise replace with a "read the saved copy in chunks" notice. 'all': also condense
  // inline results above minBytes.
  scope: 'oversized' | 'all';
  minBytes: number;
  // Oversized results below this size pass through: just over Claude Code's limit its own
  // saved-copy flow is cheap, and evaluations were mixed there.
  minOversizedBytes: number;
  budgetBytes: number;
  mode: 'lexical' | 'auto';
  typeSafeKey?: string;
  model?: string;
  timeoutMs: number;
}

export function hookConfig(env: NodeJS.ProcessEnv = process.env): HookConfig {
  const number = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return value !== undefined && Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  return {
    scope: env.JEVSCOUT_HOOK_SCOPE === 'all' ? 'all' : 'oversized',
    minBytes: number(env.JEVSCOUT_HOOK_MIN_BYTES, 8000, 512, 10_000_000),
    minOversizedBytes: number(env.JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES, 100_000, 0, 100_000_000),
    budgetBytes: number(env.JEVSCOUT_HOOK_BUDGET_BYTES, 6000, 1000, 1_000_000),
    // Jev mode is the default. Without a key, or if Jev fails, results pass through unchanged.
    // JEVSCOUT_HOOK_MODE=lexical selects keyword-only condensing, which can drop paraphrased facts.
    mode: env.JEVSCOUT_HOOK_MODE === 'lexical' ? 'lexical' : 'auto',
    typeSafeKey: env.TYPESAFE_API_KEY,
    model: env.JEVSCOUT_HOOK_MODEL,
    timeoutMs: number(env.JEVSCOUT_HOOK_TIMEOUT_MS, 8000, 500, 25_000),
  };
}

// Reads only the tail of a possibly large transcript and returns the latest user-typed prompt.
export function latestUserPrompt(transcriptPath: unknown, maxBytes = 2_000_000): string {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
  let text: string;
  try {
    const size = statSync(transcriptPath).size;
    const length = Math.min(size, maxBytes);
    const fd = openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    closeSync(fd);
    text = buffer.toString('utf8');
  } catch { return ''; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.type !== 'user' || entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const texts = content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text);
      if (texts.length) return texts.join('\n');
    }
  }
  return '';
}

function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length > 20) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out, depth + 1);
  return out;
}

// The relevance query: what the tool was asked for, plus what the user most recently asked.
// URLs say where to look, not what to look for; their fragments would dilute relevance scoring.
export function isLocator(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value.trim());
}

export function withoutUrls(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
}

// The called tool's own name (e.g. "fetch_url" in "Using the fetch_url tool") says nothing about the content.
export function hookQuery(toolInput: unknown, transcriptPath: unknown, toolName = ''): string {
  const args = stringsIn(toolInput).filter(item => item.length <= 500 && !isLocator(item)).join(' ');
  const short = toolName.split('__').at(-1) ?? '';
  const withoutTool = (text: string) => short ? text.split(short).join(' ') : text;
  const prompt = withoutTool(withoutUrls(latestUserPrompt(transcriptPath))).slice(-1500);
  return `${args}\n${prompt}`.trim().slice(0, 2000);
}

// MCP results arrive as content blocks. Anything that is not plain text (images, resources) is left alone.
export function mcpText(response: unknown): string | null {
  const blocks = Array.isArray(response) ? response
    : response && typeof response === 'object' && Array.isArray((response as { content?: unknown }).content) ? (response as { content: unknown[] }).content
      : typeof response === 'string' ? [{ type: 'text', text: response }] : null;
  if (!blocks?.length) return null;
  if (!blocks.every(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')) return null;
  return blocks.map(block => (block as { text: string }).text).join('\n');
}

// Claude Code replaces an MCP result above its own token limit with a notice pointing at a saved copy,
// before PostToolUse runs. Read that copy only if it lies in this session's tool-results directory.
const SAVED_NOTICE = /exceeds maximum allowed tokens\. Output has been saved to (\/.+?\.txt)\.?\s*\n/;

export function savedOutputPath(notice: string, transcriptPath: unknown): string | null {
  const match = SAVED_NOTICE.exec(notice);
  if (!match || typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  try {
    const allowed = realpathSync(join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'tool-results')) + sep;
    const path = realpathSync(match[1]);
    return path.startsWith(allowed) ? path : null;
  } catch { return null; }
}

export async function postToolHook(input: any, config = hookConfig()): Promise<object | null> {
  const tool = String(input?.tool_name ?? '');
  // Claude Code applies updatedToolOutput to MCP tools; built-in tool output cannot be replaced.
  if (!tool.startsWith('mcp__')) return null;
  let text = mcpText(input.tool_response);
  const saved = text === null ? null : savedOutputPath(text, input.transcript_path);
  // Results Claude Code delivers inline are already cheap to read; evaluations showed condensing them
  // could make agents slower, so by default only oversized results are condensed.
  if (!saved && config.scope === 'oversized') return null;
  if (saved) text = readFileSync(saved, 'utf8');
  if (text === null || Buffer.byteLength(text) <= config.minBytes) return null;
  if (config.scope === 'oversized' && Buffer.byteLength(text) < config.minOversizedBytes) return null;
  const result = await condense(text, {
    query: hookQuery(input.tool_input, input.transcript_path, tool), source: tool,
    budgetBytes: config.budgetBytes, mode: config.mode, typeSafeKey: config.typeSafeKey, model: config.model, timeoutMs: config.timeoutMs, recoverCommand: outputCommand(),
  });
  if (result.outputBytes >= Buffer.byteLength(text)) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: result.text } };
  // condense() throws when Jev cannot run; runHook() turns that into no output, leaving the result unchanged.
}

// Shell commands that load external context. Local search (rg, cat, git) is deliberately excluded.
export const EXTERNAL_COMMAND = /^\s*(?:gh|curl|wget|http|https|xh)\s/;

// True when the command pipes, chains, redirects, or substitutes outside quoted strings.
export function hasShellOperator(command: string): boolean {
  let unquoted = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'") { const end = command.indexOf("'", i + 1); if (end < 0) return true; i = end; unquoted += ' '; continue; }
    if (char === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') { if (command[j] === '\\') j++; else if (command[j] === '`' || (command[j] === '$' && command[j + 1] === '(')) return true; j++; }
      if (j >= command.length) return true;
      i = j; unquoted += ' '; continue;
    }
    if (char === '\\') { i++; unquoted += ' '; continue; }
    unquoted += char;
  }
  return /[|;&<>`\n]|\$\(/.test(unquoted);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Plain paths stay unquoted so a permission rule such as Bash(/path/node /path/cli.js condense:*) matches.
export function shellWord(value: string): string {
  return /^[\w./+-]+$/.test(value) ? value : shellQuote(value);
}

// Prefer a stable PATH entry (e.g. /opt/homebrew/bin/node) over a versioned install path that upgrades break.
export function nodePath(): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'node');
    try { if (dir && existsSync(candidate) && realpathSync(candidate) === realpathSync(process.execPath)) return candidate; } catch { /* keep looking */ }
  }
  return process.execPath;
}

export function condenseCommand(cli = CLI_PATH): string {
  return `${shellWord(nodePath())} ${shellWord(cli)} condense`;
}

export function outputCommand(cli = CLI_PATH): string {
  return `${shellWord(nodePath())} ${shellWord(cli)} output`;
}

// The CLI beside this module: cli.ts when running from source, cli.js from the built package.
export const CLI_PATH = fileURLToPath(new URL(`./cli.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));

export function preBashHook(input: any, cli = CLI_PATH): object | null {
  if (input?.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  // Skip commands that already pipe or chain: rewriting them would change their meaning.
  if (typeof command !== 'string' || !EXTERNAL_COMMAND.test(command) || hasShellOperator(command)) return null;
  const query = hookQuery({ command }, input.transcript_path).slice(0, 600);
  // The original command stays verbatim at the front so the user's permission rules still match it;
  // condense only reads stdin. No permissionDecision: normal permission checks apply to both parts.
  const wrapped = `${command} | ${condenseCommand(cli)} --source bash --query ${shellQuote(query)}`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: wrapped } } };
}

// Runs a command, passes stderr and small stdout through unchanged, condenses large stdout, keeps the exit code.
export async function execCondensed(argv: string[], options: { source: string; query: string }, config = hookConfig()): Promise<number> {
  const run = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['inherit', 'pipe', 'pipe'] });
  if (run.error) throw run.error;
  const stdout = run.stdout ?? '';
  if (run.stderr) process.stderr.write(run.stderr);
  if (Buffer.byteLength(stdout) <= config.minBytes) process.stdout.write(stdout);
  else {
    try {
      const result = await condense(stdout, { query: options.query, source: options.source, budgetBytes: config.budgetBytes,
        mode: config.mode, typeSafeKey: config.typeSafeKey, model: config.model, timeoutMs: config.timeoutMs, recoverCommand: outputCommand() });
      process.stdout.write(result.text);
    } catch {
      process.stdout.write(stdout);
    }
  }
  return run.status ?? 1;
}

// A stdin filter: passes small input through unchanged and condenses large input.
export async function condenseStdin(options: { source: string; query: string }, config = hookConfig()): Promise<void> {
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) <= config.minBytes) { process.stdout.write(input); return; }
  try {
    const result = await condense(input, { query: options.query, source: options.source, budgetBytes: config.budgetBytes,
      mode: config.mode, typeSafeKey: config.typeSafeKey, model: config.model, timeoutMs: config.timeoutMs, recoverCommand: outputCommand() });
    process.stdout.write(result.text);
  } catch {
    process.stdout.write(input);
  }
}

export async function runHook(kind: string, raw: string): Promise<string> {
  try {
    const input = JSON.parse(raw);
    const output = kind === 'post-tool' ? await postToolHook(input) : kind === 'pre-bash' ? preBashHook(input) : null;
    return output ? JSON.stringify(output) : '';
  } catch {
    return '';
  }
}

// The MCP hook is the evaluated feature; the shell rewrite is opt-in because it was only spike-tested.
// Jev ranking is on by default (it uses TYPESAFE_API_KEY from the environment; the key is never
// written to settings). lexicalOnly pins the hook to local keyword selection.
export function hookSettings(cli: string, options: { shell?: boolean; lexicalOnly?: boolean } = {}): any {
  const prefix = options.lexicalOnly ? 'JEVSCOUT_HOOK_MODE=lexical ' : '';
  const command = (kind: string) => `${prefix}${shellWord(nodePath())} ${shellWord(cli)} hook ${kind}`;
  return {
    // Both commands only read (stdin, or JevScout's local output cache). Wrapped fetch commands keep your own rules.
    permissions: { allow: [`Bash(${outputCommand(cli)}:*)`, ...(options.shell ? [`Bash(${condenseCommand(cli)}:*)`] : [])] },
    hooks: {
      PostToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: command('post-tool'), timeout: 30 }] }],
      ...(options.shell ? { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: command('pre-bash'), timeout: 10 }] }] } : {}),
    },
  };
}

export function settingsPath(scope: 'project' | 'user', cwd = process.cwd()): string {
  return scope === 'user' ? join(homedir(), '.claude', 'settings.json') : join(cwd, '.claude', 'settings.json');
}

const isOurs = (cli: string) => (entry: any) => typeof entry?.command === 'string' && entry.command.includes(`${cli} hook `);

// Removes JevScout's hooks and allow rules, leaving everything else untouched.
export function withoutJevScout(settings: any, cli: string): any {
  const next = structuredClone(settings ?? {});
  for (const event of ['PostToolUse', 'PreToolUse']) {
    const groups = next.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    next.hooks[event] = groups.map((group: any) => ({ ...group, hooks: (group.hooks ?? []).filter((hook: any) => !isOurs(cli)(hook)) }))
      .filter((group: any) => group.hooks.length);
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  if (Array.isArray(next.permissions?.allow)) {
    next.permissions.allow = next.permissions.allow.filter((rule: string) => !(rule.includes(`${cli} output`) || rule.includes(`${cli} condense`)));
    if (!next.permissions.allow.length) delete next.permissions.allow;
    if (!Object.keys(next.permissions).length) delete next.permissions;
  }
  return next;
}

export function withJevScout(settings: any, cli: string, options: { shell?: boolean; lexicalOnly?: boolean } = {}): any {
  const next = withoutJevScout(settings, cli);
  const ours = hookSettings(cli, options);
  next.hooks ??= {};
  for (const [event, groups] of Object.entries(ours.hooks)) next.hooks[event] = [...(next.hooks[event] ?? []), ...(groups as unknown[])];
  next.permissions ??= {};
  next.permissions.allow = [...new Set([...(next.permissions.allow ?? []), ...ours.permissions.allow])];
  return next;
}

// Writes a timestamped backup before changing an existing settings file.
export function installNotice(options: { lexicalOnly?: boolean }, env: NodeJS.ProcessEnv = process.env): string {
  if (options.lexicalOnly) return 'Jev ranking is off (--lexical-only): selection is local keyword matching; nothing is sent to TypeSafe.\n';
  const lines = [
    'Jev ranking is on. When a large MCP result is condensed, JevScout sends its segment text and your request',
    '(tool arguments and latest prompt, without URLs) to api.typesafe.ai using TYPESAFE_API_KEY from the environment.',
    'The key is never written to settings. Set JEVSCOUT_HOOK_MODE=lexical to keep everything local.',
  ];
  if (!env.TYPESAFE_API_KEY) lines.push('', 'TYPESAFE_API_KEY is not set, so MCP results pass through unchanged until it is.',
    'Get a key from TypeSafe (https://typesafe.ai), export TYPESAFE_API_KEY in the shell that starts Claude Code, then restart it.');
  return lines.join('\n') + '\n';
}

export function updateSettings(file: string, change: (settings: any) => any, dryRun = false): { file: string; backup: string | null; settings: any } {
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const settings = change(existing);
  if (dryRun) return { file, backup: null, settings };
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) { backup = `${file}.jevscout-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`; copyFileSync(file, backup); }
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, backup, settings };
}

export function readStdin(): string {
  return readFileSync(0, 'utf8');
}
