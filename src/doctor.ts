import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { readActivity, summarizeActivity, formatBytes } from './activity.ts';
import { noulOf, readBounded, sendJev } from './core/jev.ts';
import { CLI_PATH, hookSettings, jevScoutEntries } from './hook.ts';

// Checks that JevScout is installed and working where it runs. It reports whether TYPESAFE_API_KEY is
// set but never prints it, and it reads Codex's config.toml only for server names and key forwarding.
export interface Check { name: string; status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; fix?: string }
export interface DoctorOptions {
  live?: boolean;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  // The Claude Code executable to inspect; found on PATH by default. null skips the Claude Code checks.
  claude?: string | null;
}

// The notice Claude Code writes when an MCP result is too large to show inline; hook.ts parses it.
const SAVED_NOTICE = 'exceeds maximum allowed tokens. Output has been saved to ';

function packageVersion(cli: string): string | null {
  try { return JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try { if (dir && existsSync(candidate)) return realpathSync(candidate); } catch { /* keep looking */ }
  }
  return null;
}

// Streams a file looking for a byte string, so a 200 MB executable is never held in memory at once.
export function fileContains(file: string, needle: string): boolean {
  const target = Buffer.from(needle);
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    let carry = Buffer.alloc(0);
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (window.includes(target)) return true;
      carry = window.subarray(Math.max(0, window.length - target.length + 1));
    }
    return false;
  } finally { closeSync(fd); }
}

function claudeChecks(claude: string | null, env: NodeJS.ProcessEnv): Check[] {
  if (!claude) return [{ name: 'Claude Code', status: 'warn', detail: 'claude was not found on PATH, so its version and result notice were not checked.' }];
  const run = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 10_000, env });
  const version = run.status === 0 ? run.stdout.trim().split('\n')[0] : 'version unknown';
  const checks: Check[] = [{ name: 'Claude Code', status: 'ok', detail: version }];
  let found: boolean | null = null;
  try { found = fileContains(claude, SAVED_NOTICE); } catch { /* unreadable: say so below */ }
  if (found === true) checks.push({ name: 'Oversized results', status: 'ok', detail: 'Claude Code saves oversized MCP results with the notice JevScout reads.' });
  else checks.push({ name: 'Oversized results', status: 'warn',
    detail: found === null ? `Could not read ${claude} to check how it reports oversized results.`
      : 'This Claude Code build does not contain the saved-output notice JevScout reads, so oversized MCP results may pass through unchanged.',
    fix: found === null ? undefined : 'Please open an issue at https://github.com/yctimlin/JevScout/issues with your Claude Code version.' });
  if (env.MAX_MCP_OUTPUT_TOKENS) checks.push({ name: 'MAX_MCP_OUTPUT_TOKENS', status: 'info', detail: `Set to ${env.MAX_MCP_OUTPUT_TOKENS}; it changes which MCP results Claude Code treats as oversized.` });
  return checks;
}

interface Installed { file: string; label: string; entries: ReturnType<typeof jevScoutEntries>; keyInEnv: boolean }
interface Plugin { key: string; installPath: string; version: string | null; enabledIn: string | null; command: string | null }

function readInstalls(cwd: string, home: string): { installs: Installed[]; checks: Check[]; enabled: Map<string, string> } {
  const files = [
    [join(home, '.claude', 'settings.json'), '~/.claude/settings.json'],
    [join(cwd, '.claude', 'settings.json'), '.claude/settings.json'],
    [join(cwd, '.claude', 'settings.local.json'), '.claude/settings.local.json'],
  ];
  const installs: Installed[] = [];
  const checks: Check[] = [];
  // Plugin keys enabled in these settings. A later (more specific) file overrides an earlier one.
  const enabled = new Map<string, string>();
  for (const [file, label] of files) {
    if (!existsSync(file)) continue;
    let settings;
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch {
      checks.push({ name: 'Settings', status: 'warn', detail: `${label} is not valid JSON, so Claude Code may ignore it.` });
      continue;
    }
    const entries = jevScoutEntries(settings);
    if (entries.hooks.length || entries.rules.length) installs.push({ file, label, entries, keyInEnv: typeof settings?.env?.TYPESAFE_API_KEY === 'string' });
    for (const [key, on] of Object.entries(settings?.enabledPlugins ?? {})) {
      if (!key.startsWith('jevscout@')) continue;
      if (on === true) enabled.set(key, label); else enabled.delete(key);
    }
  }
  return { installs, checks, enabled };
}

// The Claude Code plugin install, from ~/.claude/plugins/installed_plugins.json (version 2).
export function readPlugin(home: string, cwd: string, enabled: Map<string, string>): Plugin | null {
  let data: any;
  try { data = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')); } catch { return null; }
  for (const [key, entries] of Object.entries<any>(data?.plugins ?? {})) {
    if (!key.startsWith('jevscout@') || !Array.isArray(entries)) continue;
    const entry = entries.find((item: any) => item?.scope !== 'project' || item?.projectPath === cwd) ?? entries[0];
    if (typeof entry?.installPath !== 'string') continue;
    let command: string | null = null;
    try {
      const hooks = JSON.parse(readFileSync(join(entry.installPath, 'hooks', 'hooks.json'), 'utf8'));
      command = hooks?.hooks?.PostToolUse?.flatMap((group: any) => group?.hooks ?? []).find((hook: any) => typeof hook?.command === 'string')?.command ?? null;
    } catch { /* reported by the caller */ }
    return { key, installPath: entry.installPath, version: typeof entry.version === 'string' ? entry.version : null, enabledIn: enabled.get(key) ?? null, command };
  }
  return null;
}

function pluginChecks(plugin: Plugin | null, installs: Installed[]): Check[] {
  if (!plugin) return [];
  if (!plugin.enabledIn) return [{ name: 'Claude Code plugin', status: 'info', detail: `${plugin.key} ${plugin.version ?? ''} is installed but not enabled.`.replace('  ', ' ') }];
  if (!existsSync(plugin.installPath) || !plugin.command) return [{ name: 'Claude Code plugin', status: 'fail', detail: `${plugin.key} is enabled, but its hook is missing from ${plugin.installPath}.`, fix: `claude plugin install ${plugin.key} (reinstalls it)` }];
  const checks: Check[] = [{ name: 'Claude Code plugin', status: 'ok', detail: `${plugin.key} ${plugin.version ?? ''} is enabled in ${plugin.enabledIn}.`.replace('  ', ' ') }];
  if (installs.some(install => install.entries.hooks.some(hook => hook.event === 'PostToolUse'))) checks.push({ name: 'Claude Code plugin', status: 'warn',
    detail: 'JevScout is installed both as a plugin and as a settings hook. Only one condenses each result, but both run on every MCP call.', fix: 'jevscout uninstall claude (keeps the plugin), or disable the plugin' });
  return checks;
}

function installChecks(installs: Installed[], plugin: Plugin | null): Check[] {
  const posts = installs.flatMap(install => install.entries.hooks.filter(hook => hook.event === 'PostToolUse').map(hook => ({ ...hook, label: install.label })));
  if (!posts.length && plugin?.enabledIn) return [];
  if (!posts.length) return [{ name: 'Claude Code hook', status: 'fail', detail: 'The JevScout MCP result hook is not installed.', fix: 'jevscout install claude' }];
  const checks: Check[] = [];
  const current = packageVersion(CLI_PATH);
  for (const hook of posts) {
    const mode = hook.lexicalOnly ? 'keyword selection only' : 'Jev ranking';
    if (!existsSync(hook.cli)) {
      checks.push({ name: 'Claude Code hook', status: 'fail', detail: `${hook.label} runs JevScout from ${hook.cli}, which no longer exists, so MCP results pass through unchanged.`, fix: 'jevscout install claude (replaces the old entry)' });
      continue;
    }
    if (!existsSync(hook.node)) {
      checks.push({ name: 'Claude Code hook', status: 'fail', detail: `${hook.label} runs Node.js from ${hook.node}, which no longer exists (often after a Node upgrade), so MCP results pass through unchanged.`, fix: 'jevscout install claude (writes the current Node path)' });
      continue;
    }
    const version = packageVersion(hook.cli);
    const where = hook.cli === CLI_PATH ? '' : ` from ${hook.cli}`;
    if (version && current && version !== current) checks.push({ name: 'Claude Code hook', status: 'warn', detail: `${hook.label} runs JevScout ${version}${where}; this is ${current}.`, fix: 'jevscout install claude (points the hook at this version)' });
    else checks.push({ name: 'Claude Code hook', status: 'ok', detail: `Installed in ${hook.label}${where} (${mode}).` });
    if (!hook.statusMessage) checks.push({ name: 'Claude Code hook', status: 'info', detail: `${hook.label} was written by an older JevScout; reinstall to show "JevScout is checking this result" while the hook runs.`, fix: 'jevscout install claude' });
  }
  if (new Set(posts.map(hook => hook.command)).size > 1) checks.push({ name: 'Claude Code hook', status: 'warn', detail: `JevScout is installed more than once (${[...new Set(posts.map(hook => hook.label))].join(', ')}), so large results are checked twice.`, fix: 'jevscout uninstall claude --scope project, or remove the duplicate entry' });
  if (!installs.some(install => install.entries.rules.some(rule => rule.includes(' output:')))) checks.push({ name: 'Recovery', status: 'warn', detail: 'No allow rule for `jevscout output`, so Claude Code asks before each exact recovery.', fix: 'jevscout install claude' });
  return checks;
}

function keyCheck(env: NodeJS.ProcessEnv, installs: Installed[], plugin: Plugin | null): Check {
  const lexicalOnly = installs.length > 0 && installs.every(install => install.entries.hooks.every(hook => hook.lexicalOnly));
  if (lexicalOnly) return { name: 'TYPESAFE_API_KEY', status: 'info', detail: 'Not needed: the hook uses local keyword selection (--lexical-only).' };
  const inSettings = installs.find(install => install.keyInEnv);
  if (env.TYPESAFE_API_KEY) return { name: 'TYPESAFE_API_KEY', status: 'ok', detail: 'Set in this shell. The hook sees the environment Claude Code was started with.' };
  if (inSettings) return { name: 'TYPESAFE_API_KEY', status: 'ok', detail: `Set in the env block of ${inSettings.label} (the value is stored in that file).` };
  if (plugin?.enabledIn) return { name: 'TYPESAFE_API_KEY', status: 'info', detail: "The plugin keeps its key in Claude Code's credential store, which doctor cannot read. The Activity line below shows results that passed through for a missing key.",
    fix: 'Run /plugin configure jevscout@jevscout in Claude Code' };
  return { name: 'TYPESAFE_API_KEY', status: 'warn', detail: 'Not set in this shell, so large MCP results pass through unchanged.',
    fix: 'Export TYPESAFE_API_KEY in the shell that starts Claude Code, then restart it. Keys: https://typesafe.ai' };
}

// Runs the installed hook command exactly as Claude Code would, on a synthetic oversized result, with
// keyword selection and a scratch cache, so nothing is sent anywhere and the user's cache is untouched.
function selfTest(installs: Installed[], env: NodeJS.ProcessEnv, plugin?: Plugin): Check {
  const installed = installs.flatMap(install => install.entries.hooks).find(hook => hook.event === 'PostToolUse' && existsSync(hook.cli));
  const command = plugin?.command ?? installed?.command ?? hookSettings(CLI_PATH).hooks.PostToolUse[0].hooks[0].command;
  const which = plugin ? 'the plugin hook' : installed ? 'the installed hook' : 'this JevScout';
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-doctor-'));
  try {
    const results = join(dir, 'project', 'session', 'tool-results');
    mkdirSync(results, { recursive: true });
    const transcript = join(dir, 'project', 'session.jsonl');
    writeFileSync(transcript, '');
    const items = Array.from({ length: 300 }, (_, i) => ({ id: i, title: i === 211 ? 'Doctor check: webhook retries honor Retry-After' : `Routine record ${i}`,
      body: i === 211 ? 'Retries wait for the Retry-After header on 429 responses.' : `Unrelated maintenance note ${i}. `.repeat(12) }));
    const text = JSON.stringify({ items });
    const saved = join(results, 'mcp-doctor-1.txt');
    writeFileSync(saved, text);
    const input = { hook_event_name: 'PostToolUse', tool_name: 'mcp__doctor__search', tool_input: { query: 'webhook Retry-After 429' }, transcript_path: transcript,
      tool_response: [{ type: 'text', text: `Error: result (${text.length.toLocaleString('en-US')} characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: JSON` }] };
    const hookEnv: NodeJS.ProcessEnv = { ...env, JEVSCOUT_HOOK_MODE: 'lexical', JEVSCOUT_CACHE_DIR: join(dir, 'cache'), JEVSCOUT_ACTIVITY: 'off', JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES: '10000',
      ...(plugin ? { CLAUDE_PLUGIN_ROOT: plugin.installPath, CLAUDE_PLUGIN_DATA: join(dir, 'plugin-data') } : {}) };
    delete hookEnv.TYPESAFE_API_KEY;
    delete hookEnv.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY;
    const started = performance.now();
    const run = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000, env: hookEnv });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    let output: any = null;
    try { output = JSON.parse(run.stdout); } catch { /* reported below */ }
    const packet = output?.hookSpecificOutput?.updatedToolOutput;
    if (typeof packet === 'string' && packet.includes('Retries wait for the Retry-After header') && / output [0-9a-f-]{36}/.test(packet))
      return { name: 'Self-test', status: 'ok', detail: `${which} condensed a synthetic ${formatBytes(Buffer.byteLength(text))} result offline in ${seconds} s.` };
    const why = run.error ? run.error.message : (run.stderr.trim().split('\n').at(-1) || `exit ${run.status}, no condensed result`);
    return { name: 'Self-test', status: 'fail', detail: `${which} did not condense a synthetic oversized result: ${why}`, fix: 'jevscout install claude, then run jevscout doctor again' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function activityCheck(): Check[] {
  const days = 7;
  const summary = summarizeActivity(readActivity(Date.now() - days * 86_400_000));
  const claude = summary.byHost.claude;
  if (!claude) return [{ name: 'Activity', status: 'info', detail: `No Claude Code MCP results checked in the last ${days} days.` }];
  const checks: Check[] = [{ name: 'Activity', status: 'info', detail: `Last ${days} days: ${claude.condensed} condensed, ${claude.passed} passed through unchanged. Details: jevscout stats` }];
  const noKey = claude.reasons['no-key'] ?? 0;
  if (noKey) checks.push({ name: 'Activity', status: 'warn', detail: `${noKey} large result${noKey === 1 ? '' : 's'} passed through because TYPESAFE_API_KEY wasn't set where Claude Code ran.`,
    fix: 'Export TYPESAFE_API_KEY in the shell that starts Claude Code, then restart it.' });
  const provider = claude.reasons.provider ?? 0;
  if (provider) checks.push({ name: 'Activity', status: 'info', detail: `${provider} large result${provider === 1 ? '' : 's'} passed through because Jev returned an error or timed out. jevscout doctor --live checks the connection.` });
  return checks;
}

// Reads only [mcp_servers.*] section names and whether the key is forwarded; other values are never printed.
export function codexProxyChecks(configText: string | null): Check[] {
  if (configText === null) return [{ name: 'Codex MCP proxy', status: 'info', detail: 'No Codex config found (optional).' }];
  const sections = new Map<string, string[]>();
  let name: string | null = null;
  for (const line of configText.split('\n')) {
    const header = /^\s*\[\s*mcp_servers\.("[^"]+"|[\w-]+)(\.env)?\s*\]\s*$/.exec(line);
    if (header) { name = header[1].replace(/^"|"$/g, ''); if (!sections.has(name)) sections.set(name, []); sections.get(name)!.push(header[2] ? '[env]' : ''); continue; }
    if (/^\s*\[/.test(line)) { name = null; continue; }
    if (name) sections.get(name)!.push(line);
  }
  const checks: Check[] = [];
  for (const [server, lines] of sections) {
    const body = lines.join('\n');
    if (!/jevscout/.test(body) || !/mcp-proxy/.test(body)) continue;
    const forwarded = /^\s*env_vars\s*=.*\bTYPESAFE_API_KEY\b/m.test(body);
    const literal = /\[env\][\s\S]*^\s*TYPESAFE_API_KEY\s*=/m.test(body) || /^\s*env\s*=\s*\{[^}]*\bTYPESAFE_API_KEY\b/m.test(body);
    if (forwarded) checks.push({ name: 'Codex MCP proxy', status: 'ok', detail: `${server}: forwards TYPESAFE_API_KEY from Codex's environment.` });
    else if (literal) checks.push({ name: 'Codex MCP proxy', status: 'warn', detail: `${server}: TYPESAFE_API_KEY is written into config.toml.`, fix: 'Use env_vars = ["TYPESAFE_API_KEY"] instead, so the key stays out of the file.' });
    else checks.push({ name: 'Codex MCP proxy', status: 'warn', detail: `${server}: the proxy won't receive TYPESAFE_API_KEY, so its results pass through unchanged.`, fix: `Add env_vars = ["TYPESAFE_API_KEY"] to [mcp_servers.${server}].` });
  }
  return checks.length ? checks : [{ name: 'Codex MCP proxy', status: 'info', detail: 'Not configured (optional).' }];
}

// One tiny ranking request: two short documents, one relevant. Reports latency and the model TypeSafe used.
async function liveCheck(env: NodeJS.ProcessEnv, fetcher?: typeof fetch): Promise<Check> {
  if (!env.TYPESAFE_API_KEY) return { name: 'Jev (live)', status: 'fail', detail: 'TYPESAFE_API_KEY is not set in this shell.' };
  const body = JSON.stringify({
    model: 'jev-latest',
    state: { query: 'How do webhook retries handle HTTP 429?', documents: [{ id: '0', text: 'Retries wait for the Retry-After header on 429 responses.' }, { id: '1', text: 'The logo uses the brand blue.' }] },
    questions: { 0: { type: 'noul', instructions: 'Is document 0 likely part of the answer to state.query?' }, 1: { type: 'noul', instructions: 'Is document 1 likely part of the answer to state.query?' } },
  });
  const started = performance.now();
  try {
    const response = await sendJev(body, { key: env.TYPESAFE_API_KEY, fetcher, timeoutMs: 15_000 });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (response.status === 401 || response.status === 403) return { name: 'Jev (live)', status: 'fail', detail: `TypeSafe rejected the key (HTTP ${response.status}).`, fix: 'Check TYPESAFE_API_KEY at https://typesafe.ai' };
    if (!response.ok) return { name: 'Jev (live)', status: 'fail', detail: `TypeSafe returned HTTP ${response.status} after ${seconds} s.` };
    const data = JSON.parse(await readBounded(response, 100_000));
    const relevant = noulOf(data?.answers?.['0']), other = noulOf(data?.answers?.['1']);
    const model = typeof data?.model === 'string' ? data.model : 'model not reported';
    if (relevant === null || other === null) return { name: 'Jev (live)', status: 'fail', detail: `TypeSafe answered in ${seconds} s, but not with the expected probabilities.` };
    if (relevant <= other) return { name: 'Jev (live)', status: 'warn', detail: `Jev (${model}) answered in ${seconds} s but ranked the unrelated document higher (${relevant.toFixed(2)} vs ${other.toFixed(2)}).` };
    return { name: 'Jev (live)', status: 'ok', detail: `Jev (${model}) answered in ${seconds} s and ranked the relevant document first (${relevant.toFixed(2)} vs ${other.toFixed(2)}).` };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out after 15 s' : error instanceof Error ? error.message : 'request failed';
    return { name: 'Jev (live)', status: 'fail', detail: `Could not reach TypeSafe: ${reason}.` };
  }
}

export async function doctor(options: DoctorOptions = {}): Promise<{ ok: boolean; version: string | null; cli: string; checks: Check[] }> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const checks: Check[] = [];
  const node = Number(process.versions.node.split('.')[0]);
  checks.push(node >= 24 ? { name: 'Node.js', status: 'ok', detail: process.versions.node }
    : { name: 'Node.js', status: 'fail', detail: `${process.versions.node}; JevScout needs Node.js 24 or later.`, fix: 'Install Node.js 24+ and reinstall JevScout.' });
  checks.push(...claudeChecks(options.claude === undefined ? onPath('claude', env) : options.claude, env));
  const cwd = options.cwd ?? process.cwd();
  const { installs, checks: settingsChecks, enabled } = readInstalls(cwd, home);
  const plugin = readPlugin(home, cwd, enabled);
  const activePlugin = plugin?.enabledIn && plugin.command && existsSync(plugin.installPath) ? plugin : undefined;
  const hooked = installs.some(install => install.entries.hooks.some(hook => hook.event === 'PostToolUse'));
  checks.push(...settingsChecks, ...pluginChecks(plugin, installs), ...installChecks(installs, plugin), keyCheck(env, installs, plugin));
  if (hooked || !activePlugin) checks.push(selfTest(installs, env));
  if (activePlugin) checks.push(selfTest(installs, env, activePlugin));
  checks.push(...activityCheck());
  let codexConfig: string | null = null;
  try { codexConfig = readFileSync(join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'utf8'); } catch { /* not configured */ }
  checks.push(...codexProxyChecks(codexConfig));
  if (options.live) checks.push(await liveCheck(env, options.fetcher));
  return { ok: !checks.some(check => check.status === 'fail'), version: packageVersion(CLI_PATH), cli: CLI_PATH, checks };
}

export function formatDoctor(report: Awaited<ReturnType<typeof doctor>>): string {
  const marks = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  const lines = [`JevScout doctor (${report.version ?? 'unknown version'}, ${report.cli})`, ''];
  for (const check of report.checks) {
    lines.push(`${marks[check.status]} ${check.name}: ${check.detail}`);
    if (check.fix && check.status !== 'ok') lines.push(`    fix: ${check.fix}`);
  }
  const failed = report.checks.filter(check => check.status === 'fail').length;
  const warned = report.checks.filter(check => check.status === 'warn').length;
  lines.push('', failed ? `${failed} problem${failed === 1 ? '' : 's'} found.` : warned ? `No problems; ${warned} warning${warned === 1 ? '' : 's'}.` : 'Everything checked out.');
  if (!report.checks.some(check => check.name === 'Jev (live)')) lines.push('Run jevscout doctor --live to also send one tiny ranking request to TypeSafe.');
  return lines.join('\n') + '\n';
}
