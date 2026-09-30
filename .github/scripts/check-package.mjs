// Checks the npm package before release: it ships the expected files and nothing internal, every
// relative import in the shipped JavaScript resolves to a shipped file, and the packed CLI and both
// entry points work when installed from the tarball.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const problems = [];
const work = mkdtempSync(join(tmpdir(), 'jevscout-package-'));

try {
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work]));
  const files = new Set(pack.files.map(file => file.path));
  const required = ['package.json', 'README.md', 'LICENSE', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts',
    'dist/hosts/codex-app-server.js', 'dist/hosts/codex-app-server.d.ts', 'docs/evaluation.md', 'docs/codex-operation-adapter.md'];
  for (const file of required) if (!files.has(file)) problems.push(`missing ${file}`);
  for (const file of files) {
    if (/^(src|test|bench|assets|hooks|bin|\.claude-plugin|\.github)\//.test(file) || /^dist\/codex-(decision|verification)/.test(file) ||
      (file.startsWith('docs/') && !required.includes(file))) problems.push(`ships an internal file: ${file}`);
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, spec] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (!files.has(target)) problems.push(`${file} imports ${spec}, which is not in the package`);
    }
  }

  // Install the tarball the way a user would, then use the CLI and both entry points.
  try {
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'jevscout-package-check', private: true, type: 'module' }));
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(work, pack.filename)], work);
    const cli = join(work, 'node_modules', '.bin', 'jevscout');
    const version = run(cli, ['--version'], work).trim();
    if (version !== pack.version) problems.push(`installed CLI reports ${version}, expected ${pack.version}`);
    const settings = JSON.parse(run(cli, ['hook', 'settings'], work));
    if (!settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command?.includes('hook post-tool')) problems.push('hook settings lack the PostToolUse command');
    const exported = JSON.parse(run(process.execPath, ['--input-type=module', '-e',
      "const main = await import('jevscout'); const codex = await import('jevscout/codex'); console.log(JSON.stringify({ main: Object.keys(main), codex: Object.keys(codex) }));"], work));
    for (const name of ['condense', 'recoverOutput', 'chooseOperation']) if (!exported.main.includes(name)) problems.push(`'jevscout' does not export ${name}`);
    if (!exported.codex.includes('createCodexOperationSession')) problems.push("'jevscout/codex' does not export createCodexOperationSession");
  } catch (error) {
    problems.push(`the installed package failed: ${String(error.message).split('\n')[0]}`);
  }
  console.log(`${pack.filename}: ${files.size} files, ${pack.size} bytes packed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  console.error(problems.map(problem => `- ${problem}`).join('\n'));
  process.exit(1);
}
console.log('Package check passed.');
