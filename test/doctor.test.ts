import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexProxyChecks, doctor, fileContains, formatDoctor } from '../src/doctor.ts';
import { CLI_PATH, hookSettings, jevScoutEntries, withJevScout } from '../src/hook.ts';

function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'jevscout-doctor-test-'));
  const previous = process.env.JEVSCOUT_CACHE_DIR;
  process.env.JEVSCOUT_CACHE_DIR = join(dir, 'cache');
  t.after(() => { process.env.JEVSCOUT_CACHE_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  const home = join(dir, 'home'), cwd = join(dir, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { dir, home, cwd };
}

const byName = <T extends { name: string }>(checks: T[], name: string) => checks.filter(check => check.name === name);
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

test('doctor finds the installed hook, runs it offline on a synthetic oversized result, and never prints the key', async t => {
  const { home, cwd } = scratch(t);
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(withJevScout({ env: { OTHER: 'x' } }, CLI_PATH)));
  const report = await doctor({ home, cwd, claude: null, env: { ...baseEnv, TYPESAFE_API_KEY: 'sk-doctor-secret' } });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(byName(report.checks, 'Claude Code hook')[0].status, 'ok');
  const selfTest = byName(report.checks, 'Self-test')[0];
  assert.equal(selfTest.status, 'ok', selfTest.detail);
  assert.match(selfTest.detail, /^the installed hook condensed a synthetic \d+ KB result offline/);
  assert.equal(byName(report.checks, 'TYPESAFE_API_KEY')[0].status, 'ok');
  assert.ok(!JSON.stringify(report).includes('sk-doctor-secret'));
  assert.ok(!formatDoctor(report).includes('sk-doctor-secret'));
});

test('doctor reports a missing install, a stale hook path, an older entry and a missing key, with fixes', async t => {
  const { home, cwd } = scratch(t);
  const missing = await doctor({ home, cwd, claude: null, env: baseEnv });
  assert.equal(missing.ok, false);
  assert.equal(byName(missing.checks, 'Claude Code hook')[0].fix, 'jevscout install claude');
  assert.equal(byName(missing.checks, 'TYPESAFE_API_KEY')[0].status, 'warn');
  assert.equal(byName(missing.checks, 'Self-test')[0].status, 'ok', 'the package itself still works');

  const stale = hookSettings('/gone/node_modules/jevscout/dist/cli.js');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(stale));
  const report = await doctor({ home, cwd, claude: null, env: baseEnv });
  const [hook] = byName(report.checks, 'Claude Code hook');
  assert.equal(hook.status, 'fail');
  assert.match(hook.detail, /\/gone\/node_modules\/jevscout\/dist\/cli\.js, which no longer exists/);

  const upgraded = withJevScout({}, CLI_PATH);
  upgraded.hooks.PostToolUse[0].hooks[0].command = upgraded.hooks.PostToolUse[0].hooks[0].command.replace(/^\S+/, '/opt/homebrew/Cellar/node/20.0.0/bin/node');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(upgraded));
  const [node] = byName((await doctor({ home, cwd, claude: null, env: baseEnv })).checks, 'Claude Code hook');
  assert.equal(node.status, 'fail');
  assert.match(node.detail, /runs Node\.js from \/opt\/homebrew\/Cellar\/node\/20\.0\.0\/bin\/node, which no longer exists/);

  const old = withJevScout({}, CLI_PATH);
  delete old.hooks.PostToolUse[0].hooks[0].statusMessage;
  old.permissions.allow = [];
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(old));
  const older = await doctor({ home, cwd, claude: null, env: baseEnv });
  assert.ok(byName(older.checks, 'Claude Code hook').some(check => check.status === 'info' && /older JevScout/.test(check.detail)));
  assert.equal(byName(older.checks, 'Recovery')[0].status, 'warn');
});

test('doctor warns when the hook is installed twice from different paths', async t => {
  const { home, cwd, dir } = scratch(t);
  const other = join(dir, 'other', 'jevscout');
  mkdirSync(join(other, 'dist'), { recursive: true });
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'jevscout', version: '0.4.0' }));
  writeFileSync(join(other, 'dist', 'cli.js'), '');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(withJevScout({}, CLI_PATH)));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(hookSettings(join(other, 'dist', 'cli.js'))));
  const checks = byName((await doctor({ home, cwd, claude: null, env: baseEnv })).checks, 'Claude Code hook');
  assert.ok(checks.some(check => check.status === 'warn' && /runs JevScout 0\.4\.0/.test(check.detail)));
  assert.ok(checks.some(check => check.status === 'warn' && /installed more than once/.test(check.detail)));
});

test('the live check sends one tiny ranking request and reports the model TypeSafe used', async t => {
  const { home, cwd } = scratch(t);
  let calls = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer k');
    return new Response(JSON.stringify({ model: 'jev-9.9.9', answers: { 0: { type: 'noul', noul: 0.9 }, 1: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 5, output_tokens: 1 } }));
  }) as unknown as typeof fetch;
  const live = byName((await doctor({ home, cwd, claude: null, live: true, env: { ...baseEnv, TYPESAFE_API_KEY: 'k' }, fetcher })).checks, 'Jev (live)')[0];
  assert.equal(calls, 1);
  assert.equal(live.status, 'ok');
  assert.match(live.detail, /jev-9\.9\.9/);
  const rejected = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
  const denied = byName((await doctor({ home, cwd, claude: null, live: true, env: { ...baseEnv, TYPESAFE_API_KEY: 'k' }, fetcher: rejected })).checks, 'Jev (live)')[0];
  assert.equal(denied.status, 'fail');
  assert.match(denied.detail, /rejected the key \(HTTP 401\)/);
});

test('doctor checks that Claude Code still writes the saved-output notice the hook reads', async t => {
  const { home, cwd, dir } = scratch(t);
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/bin/sh\necho "9.9.9 (Claude Code)"\n# ${'x'.repeat(100)} exceeds maximum allowed tokens. Output has been saved to \n`, { mode: 0o755 });
  const checks = (await doctor({ home, cwd, claude: fake, env: baseEnv })).checks;
  assert.equal(byName(checks, 'Claude Code')[0].detail, '9.9.9 (Claude Code)');
  assert.equal(byName(checks, 'Oversized results')[0].status, 'ok');
  writeFileSync(fake, '#!/bin/sh\necho "10.0.0 (Claude Code)"\n', { mode: 0o755 });
  assert.equal(byName((await doctor({ home, cwd, claude: fake, env: baseEnv })).checks, 'Oversized results')[0].status, 'warn');
});

test('fileContains finds a string that straddles two read chunks', t => {
  const { dir } = scratch(t);
  const file = join(dir, 'big.bin');
  const needle = 'exceeds maximum allowed tokens. Output has been saved to ';
  const at = 8 * 1024 * 1024 - 10;
  writeFileSync(file, Buffer.concat([Buffer.alloc(at, 0x61), Buffer.from(needle), Buffer.alloc(100, 0x62)]));
  assert.equal(fileContains(file, needle), true);
  assert.equal(fileContains(file, 'not in there'), false);
});

test('Codex proxy checks read only server names and whether the key is forwarded', () => {
  const config = [
    'model = "gpt-6-sol"',
    'experimental_bearer_token = "tok-should-never-print"',
    '[mcp_servers.fetch]', 'command = "jevscout"', 'args = ["mcp-proxy", "--source", "fetch", "--", "uvx", "mcp-server-fetch"]', 'env_vars = ["TYPESAFE_API_KEY"]',
    '[mcp_servers.docs]', 'command = "jevscout"', 'args = ["mcp-proxy", "--", "docs-mcp"]',
    '[mcp_servers."notes"]', 'command = "npx"', 'args = ["jevscout", "mcp-proxy", "--", "notes"]',
    '[mcp_servers."notes".env]', 'TYPESAFE_API_KEY = "sk-in-file"',
    '[mcp_servers.plain]', 'command = "uvx"', 'args = ["mcp-server-time"]',
    '[profiles.x]', 'jevscout = "mcp-proxy"',
  ].join('\n');
  const checks = codexProxyChecks(config);
  assert.deepEqual(checks.map(check => [check.status, check.detail.split(':')[0]]), [['ok', 'fetch'], ['warn', 'docs'], ['warn', 'notes']]);
  assert.match(checks[1].fix!, /env_vars = \["TYPESAFE_API_KEY"\]/);
  assert.ok(!JSON.stringify(checks).includes('tok-should-never-print') && !JSON.stringify(checks).includes('sk-in-file'));
  assert.equal(codexProxyChecks('model = "x"')[0].detail, 'Not configured (optional).');
  assert.equal(codexProxyChecks(null)[0].status, 'info');
});

test('jevScoutEntries recognizes JevScout hooks from any install path and ignores others', () => {
  const settings = withJevScout({ hooks: { PostToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }, '/opt/jevscout/dist/cli.js', { lexicalOnly: true });
  const entries = jevScoutEntries(settings);
  assert.deepEqual(entries.hooks.map(hook => [hook.event, hook.cli, hook.lexicalOnly, hook.statusMessage]), [['PostToolUse', '/opt/jevscout/dist/cli.js', true, true]]);
  assert.equal(entries.rules.length, 1);
  assert.deepEqual(jevScoutEntries(null), { hooks: [], rules: [] });
});

test('doctor finds an enabled plugin install, self-tests its hook, and warns when a settings hook also runs', async t => {
  const { home, cwd, dir } = scratch(t);
  const { symlinkSync, copyFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const repo = dirname(dirname(CLI_PATH));
  const installPath = join(dir, 'plugins', 'cache', 'jevscout', 'jevscout', '0.6.0');
  mkdirSync(join(installPath, 'hooks'), { recursive: true });
  symlinkSync(join(repo, 'src'), join(installPath, 'src'));
  copyFileSync(join(repo, 'package.json'), join(installPath, 'package.json'));
  writeFileSync(join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command',
    command: 'NODE_COMPILE_CACHE="${CLAUDE_PLUGIN_DATA}/compile-cache" node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" hook post-tool', timeout: 30, statusMessage: 'JevScout is checking this result' }] }] } }));
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'jevscout@jevscout': [{ scope: 'user', installPath, version: '0.6.0' }] } }));

  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'jevscout@jevscout': false } }));
  const disabled = await doctor({ home, cwd, claude: null, env: baseEnv });
  assert.equal(byName(disabled.checks, 'Claude Code plugin')[0].status, 'info');
  assert.equal(byName(disabled.checks, 'Claude Code hook')[0].status, 'fail', 'a disabled plugin is not an install');

  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'jevscout@jevscout': true } }));
  const report = await doctor({ home, cwd, claude: null, env: baseEnv });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.match(byName(report.checks, 'Claude Code plugin')[0].detail, /jevscout@jevscout 0\.6\.0 is enabled in ~\/\.claude\/settings\.json/);
  const [selfTest] = byName(report.checks, 'Self-test');
  assert.equal(selfTest.status, 'ok', selfTest.detail);
  assert.match(selfTest.detail, /^the plugin hook condensed/);
  assert.match(byName(report.checks, 'TYPESAFE_API_KEY')[0].detail, /credential store/);

  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(withJevScout({ enabledPlugins: { 'jevscout@jevscout': true } }, CLI_PATH)));
  const both = await doctor({ home, cwd, claude: null, env: baseEnv });
  assert.ok(byName(both.checks, 'Claude Code plugin').some(check => check.status === 'warn' && /both as a plugin and as a settings hook/.test(check.detail)));
  assert.equal(byName(both.checks, 'Self-test').length, 2, 'both hooks are self-tested');
});
