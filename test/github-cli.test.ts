import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[]) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.GITHUB_TOKEN;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
}

test('GitHub commands are discoverable without network access', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /github search/);
  assert.match(help.stdout, /github open/);
});

test('GitHub CLI rejects incomplete or invalid commands before fetching', () => {
  for (const args of [
    ['github', 'search', 'abort'],
    ['github', 'search', 'abort', '--repo', 'invalid', '--mode', 'github'],
    ['github', 'open', 'not-an-issue'],
    ['github', 'open', 'owner/repo#0'],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /^JevScout:/);
    assert.equal(result.stdout, '');
  }
});
