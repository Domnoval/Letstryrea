import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { DURATION_PROJECT_PATHS, exportDurationProject } from '../src/duration-export.mjs';
import { createProjectArchive } from '../src/project-export.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const recipe = { id: 'ms-duration-v1', version: 1, title: '/workspace/PRIVATE_METADATA_SENTINEL' };
const sourceEvidence = {
  artifactSha256: 'A'.repeat(64),
  sourceSha256: 'b'.repeat(64),
  sourceVersion: '2.1.3',
  files: [
    { path: 'package/index.js', bytes: 3024, sha256: 'c'.repeat(64), source: 'PRIVATE_SOURCE_SENTINEL' },
    { path: 'package/index.js', bytes: 1, sha256: 'd'.repeat(64) },
    { path: '/workspace/private.js', bytes: 12, sha256: 'd'.repeat(64) },
    { path: '../credentials', bytes: 12, sha256: 'd'.repeat(64) },
    { path: 'package/package.json', bytes: -1, sha256: 'd'.repeat(64) },
    { path: 'package/readme.md', bytes: 10, sha256: 'invalid-digest' },
  ],
  source: 'PRIVATE_SOURCE_SENTINEL',
  reportPath: '/workspace/PRIVATE_PATH_SENTINEL',
  credentials: { token: 'PRIVATE_CREDENTIAL_SENTINEL' },
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-duration-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  return { root, project };
}

async function generated(t) {
  const paths = await workspace(t);
  const manifest = await exportDurationProject({ destination: paths.project, recipe, sourceEvidence });
  return { ...paths, manifest };
}

function runNode(project, args) {
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, {
    cwd: project, encoding: 'utf8', timeout: 60_000, env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('duration export runs its public suite and CLI without the original package or dependencies', async (t) => {
  const { project, manifest } = await generated(t);
  assert.deepEqual(manifest.files.map(({ path }) => path).sort(), [...DURATION_PROJECT_PATHS].sort());
  for (const file of manifest.files) {
    const bytes = await readFile(join(project, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
    assert.doesNotMatch(bytes.toString('utf8'), /PRIVATE_(?:METADATA|SOURCE|PATH|CREDENTIAL)_SENTINEL/);
  }
  const packageJson = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.exports, './src/duration.mjs');
  assert.match(await readFile(join(project, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /MIT|Permission is hereby granted/);
  const output = runNode(project, ['--test', '--test-reporter=tap']);
  assert.match(output, /^# tests [1-9]\d*$/m);
  assert.match(output, /^# fail 0$/m);
  assert.equal(JSON.parse(runNode(project, ['bin/letstryrea.mjs', 'parse', '2 hours'])), 7200000);
  assert.equal(runNode(project, ['bin/letstryrea.mjs', 'format', '5400000', '--long']).trim(), '2 hours');
  const invalid = spawnSync(process.execPath, ['bin/letstryrea.mjs', 'parse', 'not a duration'], {
    cwd: project, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.deepEqual(JSON.parse(invalid.stdout), { status: 'invalid' });
  assert.equal(runNode(project, ['--input-type=module', '-e', "import duration, { duration as named } from './src/duration.mjs'; console.log(duration === named && duration('2 hours') === 7200000);"]).trim(), 'true');
});

test('duration export keeps only bounded public provenance and source-file hashes', async (t) => {
  const { project } = await generated(t);
  const metadata = JSON.parse(await readFile(join(project, 'recipe.json'), 'utf8'));
  assert.equal(metadata.recipe.id, 'ms-duration-v1');
  assert.equal(metadata.recipe.version, 1);
  assert.equal(metadata.sourceEvidence.artifactSha256, 'a'.repeat(64));
  assert.equal(metadata.sourceEvidence.sourceSha256, 'b'.repeat(64));
  assert.equal(metadata.sourceEvidence.sourceVersion, '2.1.3');
  assert.deepEqual(metadata.sourceEvidence.files, [{ path: 'package/index.js', bytes: 3024, sha256: 'c'.repeat(64) }]);
  assert.deepEqual(Object.keys(metadata.sourceEvidence).sort(), ['artifactSha256', 'files', 'sourceSha256', 'sourceVersion']);
});

test('duration exporter preserves nonempty directories and rejects symlink destinations or another recipe', async (t) => {
  const { root, project } = await workspace(t);
  await assert.rejects(exportDurationProject({ destination: project, recipe: { id: 'unknown' } }), /requires recipe/);
  assert.deepEqual(await readdir(project), []);
  await writeFile(join(project, 'keep.txt'), 'user content');
  await assert.rejects(exportDurationProject({ destination: project, recipe, sourceEvidence }), /must be empty/);
  assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'user content');
  assert.deepEqual(await readdir(project), ['keep.txt']);
  const linked = join(root, 'linked');
  try {
    await symlink(project, linked, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  await assert.rejects(exportDurationProject({ destination: linked, recipe, sourceEvidence }), /regular directory/);
});

function zipEntries(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let offset = bytes.readUInt32LE(end + 16);
  assert.equal(offset + bytes.readUInt32LE(end + 12), end);
  const entries = new Map();
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 8);
    const length = bytes.readUInt16LE(offset + 28);
    const path = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 26), length);
    assert.equal(bytes.subarray(local + 30, local + 30 + length).toString('utf8'), path);
    const start = local + 30 + length;
    const content = inflateRawSync(bytes.subarray(start, start + bytes.readUInt32LE(offset + 20)));
    assert.equal(content.length, bytes.readUInt32LE(offset + 24));
    assert.equal(crc32(content), bytes.readUInt32LE(offset + 16));
    assert.equal(crc32(content), bytes.readUInt32LE(local + 14));
    assert.ok(!entries.has(path), 'ZIP paths must be unique');
    entries.set(path, { content, mode: bytes.readUInt32LE(offset + 38) >>> 16 });
    offset += 46 + length;
  }
  assert.equal(offset, end);
  return entries;
}

test('duration ZIP is deterministic and contains exactly the approved standalone files', async (t) => {
  const { root, project, manifest } = await generated(t);
  const args = { projectDirectory: project, recipeId: 'ms-duration-v1' };
  const first = await createProjectArchive({ ...args, archivePath: join(root, 'first.zip') });
  const second = await createProjectArchive({ ...args, archivePath: join(root, 'second.zip') });
  assert.equal(first.sha256, second.sha256);
  const bytes = await readFile(first.path);
  assert.equal(first.bytes, bytes.length);
  assert.equal(first.sha256, sha256(bytes));
  const entries = zipEntries(bytes);
  assert.equal(first.files, entries.size);
  assert.deepEqual([...entries.keys()].sort(), [...DURATION_PROJECT_PATHS].sort());
  for (const file of manifest.files) assert.equal(sha256(entries.get(file.path).content), file.sha256);
  assert.equal(entries.get('bin/letstryrea.mjs').mode, 0o100755);
  assert.equal(entries.get('src/duration.mjs').mode, 0o100644);
  await assert.rejects(createProjectArchive({ ...args, archivePath: first.path }), /EEXIST/);
});

test('archive rejects unknown recipe IDs, wrong recipe file sets, missing files, and injected content', async (t) => {
  const { root, project } = await generated(t);
  const args = { projectDirectory: project, archivePath: join(root, 'project.zip'), recipeId: 'ms-duration-v1' };
  await assert.rejects(createProjectArchive({ ...args, recipeId: 'unknown' }), /Unknown project archive recipe/);
  await assert.rejects(createProjectArchive({ ...args, recipeId: 'obsidian-markdown-search-v1' }), /Unexpected/);
  await assert.rejects(createProjectArchive({ ...args, archivePath: join(project, 'project.zip') }), /outside/);
  await writeFile(join(project, '.env'), 'PRIVATE_CREDENTIAL_SENTINEL');
  await assert.rejects(createProjectArchive(args), /Unexpected file/);
  await rm(join(project, '.env'));
  await mkdir(join(project, 'original-source'));
  await assert.rejects(createProjectArchive(args), /Unexpected directory/);
  await rm(join(project, 'original-source'), { recursive: true });
  await rm(join(project, 'README.md'));
  await assert.rejects(createProjectArchive(args), /missing required/);
  try {
    await symlink(join(project, 'recipe.json'), join(project, 'README.md'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  await assert.rejects(createProjectArchive(args), /Unexpected file/);
});
