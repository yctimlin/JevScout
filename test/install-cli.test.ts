import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(args: string[], home: string, cwd = home) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, TYPESAFE_API_KEY: '' } });
}

test('install claude defaults to user scope and uninstall claude removes only JevScout entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'jevscout-home-'));
  const project = mkdtempSync(join(tmpdir(), 'jevscout-project-'));
  const dry = run(['install', 'claude', '--dry-run'], home, project);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(JSON.parse(dry.stdout.split('\n\n')[0]).hooks.PostToolUse[0].hooks[0].command, / hook post-tool$/);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
  const installed = run(['install', 'claude'], home, project);
  assert.equal(installed.status, 0, installed.stderr);
  const file = join(home, '.claude', 'settings.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.PostToolUse.length, 1);
  assert.equal(existsSync(join(project, '.claude', 'settings.json')), false);
  const removed = run(['uninstall', 'claude'], home, project);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
});

test('hook install keeps its project-scope default', () => {
  const home = mkdtempSync(join(tmpdir(), 'jevscout-home-'));
  const project = mkdtempSync(join(tmpdir(), 'jevscout-project-'));
  assert.equal(run(['hook', 'install'], home, project).status, 0);
  assert.equal(existsSync(join(project, '.claude', 'settings.json')), true);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
});

test('install codex prints the library guide and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'jevscout-home-'));
  const result = run(['install', 'codex'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm install jevscout/);
  assert.match(result.stdout, /from 'jevscout\/codex'/);
  assert.equal(existsSync(join(home, '.claude')), false);
  assert.equal(existsSync(join(home, '.codex')), false);
  assert.notEqual(run(['uninstall', 'codex'], home).status, 0);
  assert.notEqual(run(['install', 'cursor'], home).status, 0);
});
