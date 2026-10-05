/** Prepare Git dependencies without shell chains or Windows command shims. */
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const environment = { ...process.env };
if (!environment.SOURCE_DATE_EPOCH) {
  const git = spawnSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (git.status === 0) environment.SOURCE_DATE_EPOCH = git.stdout.trim();
}

// --import takes a URL; a Windows drive path must not be interpreted as a scheme.
const tsx = import.meta.resolve('tsx');
for (const script of ['build-runtime.ts', 'build-dist.ts']) {
  const result = spawnSync(
    process.execPath,
    ['--import', tsx, fileURLToPath(new URL(script, import.meta.url))],
    { cwd: root, env: environment, stdio: 'inherit' },
  );
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const asset of ['RichText', 'PreviewBoundary']) {
  copyFileSync(
    new URL(`../src/adapters/astro/${asset}.astro`, import.meta.url),
    new URL(`../dist/adapters/astro/${asset}.astro`, import.meta.url),
  );
}
