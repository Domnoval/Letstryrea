import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const copiedPaths = [
  'src/search.mjs',
  'src/search-cli.mjs',
  'test/search.test.mjs',
  'examples/vault/Welcome.md',
  'examples/vault/notes/Observing.md',
  'examples/vault/notes/Shopping.md',
];
const projectPaths = new Set([
  ...copiedPaths,
  'bin/letstryrea.mjs',
  'docs/reconstruction-spec.md',
  'package.json',
  'README.md',
  'recipe.json',
]);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function publicString(value, maximum = 300) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f]/.test(value)) return undefined;
  return value;
}

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

// Deliberately copy metadata fields, never arbitrary analysis objects or paths.
function publicMetadata(recipe, sourceEvidence) {
  const selection = {};
  for (const key of ['id', 'version', 'title', 'description', 'capability']) {
    const value = publicString(recipe?.[key]);
    if (value !== undefined) selection[key] = value;
  }
  if (Number.isSafeInteger(recipe?.version) && recipe.version >= 0) selection.version = recipe.version;
  const evidence = {};
  for (const key of ['artifactSha256', 'appJsSha256']) {
    const value = digest(sourceEvidence?.[key]);
    if (value) evidence[key] = value;
  }
  for (const key of ['sourceVersion', 'method']) {
    const value = publicString(sourceEvidence?.[key]);
    if (value !== undefined) evidence[key] = value;
  }
  if (Array.isArray(sourceEvidence?.regions)) {
    evidence.regions = sourceEvidence.regions.slice(0, 100).flatMap((region) => {
      const regionHash = digest(region?.sha256);
      if (!regionHash || !Number.isSafeInteger(region.start) || !Number.isSafeInteger(region.end) ||
          region.start < 0 || region.end <= region.start) return [];
      return [{
        ...(publicString(region.id) === undefined ? {} : { id: region.id }),
        ...(publicString(region.label) === undefined ? {} : { label: region.label }),
        start: region.start,
        end: region.end,
        sha256: regionHash,
      }];
    });
  }
  return {
    formatVersion: 1,
    recipe: selection,
    sourceEvidence: evidence,
    implementation: 'Previously implemented, independently written Markdown search recipe.',
    limitation: 'This export applies a known reconstruction recipe. It does not synthesize arbitrary application source from an artifact.',
    validation: 'The included tests exercise the reconstructed implementation. This run does not perform a fresh comparison with the original application.',
  };
}

async function requireRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  return info;
}

/** Export the proven, independently written search project into an empty directory. */
export async function exportSearchProject({ destination, recipe, sourceEvidence } = {}) {
  if (typeof destination !== 'string' || !destination) throw new Error('An export destination is required.');
  const directory = resolve(destination);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export destination must be a regular directory.');
  if ((await readdir(directory)).length) throw new Error('Export destination must be empty.');

  // Read every source before making changes, so an unavailable adapter cannot
  // leave a partially written project that looks ready for validation.
  const files = new Map();
  for (const path of copiedPaths) {
    const source = join(sourceRoot, ...path.split('/'));
    await requireRegularFile(source);
    files.set(path, await readFile(source));
  }
  const specificationPath = join(sourceRoot, 'docs', 'reconstruction-spec.md');
  await requireRegularFile(specificationPath);
  const specification = (await readFile(specificationPath, 'utf8'))
    .replace('The completed live comparison for this implementation is recorded in\n[validation.md](validation.md).',
      'The recipe implementation was previously compared with Obsidian 1.14.4.\nThe included tests validate this exported implementation; exporting does not\nperform a fresh comparison with the original application.')
    .replace('Acquisition and earlier analysis receipts are stored\noutside the checkout under `/workspace/.onboarding`; the archive and copied\nproprietary source are intentionally not project dependencies.',
      'The original artifact, analysis receipts, and proprietary source are not\nincluded in this exported project. Artifact identifiers and byte-region hashes\nabove provide provenance without redistributing the original application.');
  files.set('docs/reconstruction-spec.md', Buffer.from(specification));
  files.set('bin/letstryrea.mjs', Buffer.from('#!/usr/bin/env node\nimport { runSearchCli } from \'../src/search-cli.mjs\';\n\nawait runSearchCli(process.argv.slice(2));\n'));
  files.set('package.json', Buffer.from(json({
    name: 'reconstructed-markdown-search',
    version: '0.1.0',
    private: true,
    description: 'Independent reconstruction of a verified plain-text Markdown search capability.',
    type: 'module',
    engines: { node: '>=24.0.0' },
    bin: { letstryrea: 'bin/letstryrea.mjs' },
    scripts: {
      start: 'node bin/letstryrea.mjs',
      test: 'node --test',
      demo: 'node bin/letstryrea.mjs search:context examples/vault nebula --format json',
    },
  })));
  files.set('recipe.json', Buffer.from(json(publicMetadata(recipe, sourceEvidence))));
  files.set('README.md', Buffer.from(`# Reconstructed Markdown search

This editable project independently implements a small search capability
observed in Obsidian 1.14.4. It runs using Node.js 24 or later and has no external
dependencies. You do not need REA, Obsidian, or the original artifact to run it.

\`\`\`sh
npm test
npm run demo
node bin/letstryrea.mjs search:context /path/to/notes "two terms" --format json
\`\`\`

Supported: unquoted plain-text terms, filename/content matching, line context,
case sensitivity, folder restrictions, file limits, and exclusions. Run
\`node bin/letstryrea.mjs --help\` for options. Edit \`src/search.mjs\` to develop
the implementation and run \`npm test\` to check its behavior.

This is a known reconstruction recipe, not a reconstruction of the entire
application or arbitrary artifact-to-source generation. The included public
fixtures and behavioral tests run independently. A passing test run is not a
fresh comparison with the original application. See
[the behavioral specification](docs/reconstruction-spec.md) and
[the recipe metadata](recipe.json) for scope and provenance.

No original application source, artifact bundles, credentials, or machine-local
analysis reports are included.
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

async function archiveFiles(directory) {
  const files = [];
  let totalBytes = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const archivePath = relative(directory, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (![...projectPaths].some((known) => known.startsWith(`${archivePath}/`))) {
          throw new Error(`Unexpected directory in generated project: ${archivePath}`);
        }
        await visit(full);
      } else {
        if (!entry.isFile() || entry.isSymbolicLink() || !projectPaths.has(archivePath)) {
          throw new Error(`Unexpected file in generated project: ${archivePath}`);
        }
        const info = await requireRegularFile(full);
        totalBytes += info.size;
        if (totalBytes > 64 * 1024 * 1024) throw new Error('Generated project exceeds the 64 MiB archive limit.');
        files.push({ path: archivePath, bytes: await readFile(full) });
      }
    }
  }
  await visit(directory);
  if (files.length !== projectPaths.size) throw new Error('Generated project is missing required export files.');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Create a deterministic, portable ZIP using only Node builtins. */
export async function createProjectArchive({ projectDirectory, archivePath } = {}) {
  if (typeof projectDirectory !== 'string' || typeof archivePath !== 'string') {
    throw new Error('A project directory and archive path are required.');
  }
  const directory = resolve(projectDirectory);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Project must be a regular directory.');
  const output = resolve(archivePath);
  const outputRelative = relative(directory, output);
  if (!outputRelative.startsWith(`..${sep}`) && outputRelative !== '..') {
    throw new Error('Archive must be outside the generated project.');
  }
  const files = await archiveFiles(directory);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const compressed = deflateRawSync(file.bytes, { level: 9 });
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // ZIP 2.0 / DEFLATE.
    local.writeUInt16LE(0x800, 6); // UTF-8 names.
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // Fixed 1980-01-01 date.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = file.path.startsWith('bin/') ? 0o100755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...localParts, centralDirectory, end]);
  await writeFile(output, archive, { flag: 'wx', mode: 0o644 });
  return { path: output, bytes: archive.length, sha256: hash(archive), files: files.length };
}
