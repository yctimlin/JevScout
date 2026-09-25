import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

test('--version and -v print package.json version and succeed even with a missing --path', () => {
  for (const args of [['--version'], ['-v'], ['--version', '--path', '/no/such/jevscout-missing'], ['-v', '--path', '/no/such/jevscout-missing']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${version}\n`);
  }
});
