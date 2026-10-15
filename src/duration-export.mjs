import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const copiedPaths = ['src/duration.mjs', 'src/duration-cli.mjs', 'test/duration.test.mjs'];
export const DURATION_PROJECT_PATHS = Object.freeze([
  ...copiedPaths,
  'bin/letstryrea.mjs',
  'docs/duration-spec.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'README.md',
  'recipe.json',
]);
const originalPaths = new Set([
  'package/index.js', 'package/package.json', 'package/license.md', 'package/readme.md',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function publicMetadata(sourceEvidence) {
  const evidence = { sourceVersion: '2.1.3' };
  for (const key of ['artifactSha256', 'sourceSha256']) {
    const value = digest(sourceEvidence?.[key]);
    if (value) evidence[key] = value;
  }
  if (Array.isArray(sourceEvidence?.files)) {
    const seen = new Set();
    evidence.files = sourceEvidence.files.slice(0, 100).flatMap((file) => {
      const sha256 = digest(file?.sha256);
      if (!originalPaths.has(file?.path) || seen.has(file.path) || !sha256 ||
          !Number.isSafeInteger(file.bytes) || file.bytes < 0) return [];
      seen.add(file.path);
      return [{ path: file.path, bytes: file.bytes, sha256 }];
    }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  }
  return {
    formatVersion: 1,
    recipe: {
      id: 'ms-duration-v1',
      version: 1,
      title: 'ms 2.1.3 duration parsing and formatting',
      capability: 'duration-parsing-and-formatting',
    },
    sourceEvidence: evidence,
    implementation: 'Independently written duration parsing and formatting implementation derived from ms 2.1.3 behavior.',
    limitation: 'This export applies a known reconstruction recipe. It does not synthesize arbitrary application source from an artifact.',
    validation: 'The included public tests exercise this implementation without the original package. A fresh original-package comparison is recorded separately by the reconstruction pipeline.',
  };
}

async function readSource(path) {
  const source = join(sourceRoot, ...path.split('/'));
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${source}`);
  return readFile(source);
}

/** Export an editable duration project with only public source and provenance. */
export async function exportDurationProject({ destination, recipe, sourceEvidence } = {}) {
  if (typeof destination !== 'string' || !destination) throw new Error('An export destination is required.');
  if (recipe?.id !== 'ms-duration-v1') throw new Error('The duration exporter requires recipe ms-duration-v1.');
  const directory = resolve(destination);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export destination must be a regular directory.');
  if ((await readdir(directory)).length) throw new Error('Export destination must be empty.');

  // Read every source first: an unavailable recipe must not leave a project
  // that appears ready to build and validate.
  const files = new Map();
  for (const path of copiedPaths) files.set(path, await readSource(path));
  files.set('docs/duration-spec.md', await readSource('docs/duration-spec.md'));
  files.set('THIRD_PARTY_NOTICES.md', await readSource('docs/ms-license.txt'));
  files.set('bin/letstryrea.mjs', Buffer.from('#!/usr/bin/env node\nimport { runDurationCli } from \'../src/duration-cli.mjs\';\n\nprocess.exitCode = runDurationCli(process.argv.slice(2));\n'));
  files.set('package.json', Buffer.from(json({
    name: 'reconstructed-duration',
    version: '0.1.0',
    private: true,
    description: 'Independent reconstruction of ms 2.1.3 duration parsing and formatting behavior.',
    type: 'module',
    engines: { node: '>=24.0.0' },
    exports: './src/duration.mjs',
    bin: { letstryrea: 'bin/letstryrea.mjs' },
    scripts: {
      start: 'node bin/letstryrea.mjs',
      test: 'node --test',
      demo: 'node bin/letstryrea.mjs parse "2 hours"',
    },
  })));
  files.set('recipe.json', Buffer.from(json(publicMetadata(sourceEvidence))));
  files.set('README.md', Buffer.from(`# Reconstructed duration parsing and formatting

This editable project independently implements duration behavior from
\`ms@2.1.3\`. It runs with Node.js 24 or later and has no external dependencies.

\`\`\`sh
npm test
node bin/letstryrea.mjs parse "2 hours"
node bin/letstryrea.mjs format 5400000 --long
\`\`\`

The parse command prints \`7200000\`; the format command prints \`2 hours\`.
Run \`node bin/letstryrea.mjs --help\` for usage.

Use the same API from your code:

\`\`\`js
import duration from './src/duration.mjs';

duration('2 hours'); // 7200000
duration(5400000); // '2h'
duration(5400000, { long: true }); // '2 hours'
\`\`\`

Edit \`src/duration.mjs\` and run \`npm test\` to check the implementation.
The public suite runs without REA, the original package, or the original
artifact. The separate reconstruction report records any fresh comparison
against the original package; a passing exported suite alone is not such a
comparison.

This is a known reconstruction recipe with a defined compatibility scope.
See [the behavioral specification](docs/duration-spec.md),
[the provenance metadata](recipe.json), and
[third-party notices](THIRD_PARTY_NOTICES.md).
Original package source and machine-local analysis reports are not included.
`));

  const manifest = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path);
    const output = join(directory, ...path.split('/'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes, { flag: 'wx', mode: path.startsWith('bin/') ? 0o755 : 0o644 });
    manifest.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { files: manifest };
}
