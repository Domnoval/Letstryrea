import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { createProjectArchive, exportSearchProject } from '../src/project-export.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const recipe = { id: 'obsidian-markdown-search-v1', version: 1, title: 'Markdown search', capability: 'plain-text-markdown-search' };
const sourceEvidence = {
  artifactSha256: 'a'.repeat(64),
  appJsSha256: 'b'.repeat(64),
  sourceVersion: '1.14.4',
  method: 'exact-artifact-and-static-anchors',
  regions: [{ id: 'search', label: 'Search handlers', start: 10, end: 20, sha256: 'c'.repeat(64), source: 'do not export original source' }],
  source: 'do not export original source',
  reportPath: '/workspace/private-report.json',
  credentials: { token: 'do not export credentials' },
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  return { root, project };
}

async function generated(t) {
  const paths = await workspace(t);
  const manifest = await exportSearchProject({ destination: paths.project, recipe, sourceEvidence });
  return { ...paths, manifest };
}

test('export is standalone, includes provenance without raw evidence, and passes its public behavioral suite', async (t) => {
  const { project, manifest } = await generated(t);
  assert.ok(manifest.files.some(({ path }) => path === 'test/search.test.mjs'));
  assert.ok(manifest.files.some(({ path }) => path === 'examples/vault/Welcome.md'));
  for (const file of manifest.files) {
    const bytes = await readFile(join(project, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
    assert.doesNotMatch(bytes.toString('utf8'), /\/workspace\/|do not export|credentials.*token/);
  }
  const metadata = JSON.parse(await readFile(join(project, 'recipe.json'), 'utf8'));
  assert.equal(metadata.recipe.version, 1);
  assert.equal(metadata.sourceEvidence.artifactSha256, 'a'.repeat(64));
  assert.deepEqual(metadata.sourceEvidence.regions, [{
    id: 'search', label: 'Search handlers', start: 10, end: 20, sha256: 'c'.repeat(64),
  }]);
  const packageJson = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.scripts.test, 'node --test');
  const testEnvironment = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
  // The parent node:test runner sets this internal variable. Inheriting it
  // makes another test runner behave as an IPC worker instead of a fresh run.
  delete testEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    env: testEnvironment,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 28/);
  const demo = spawnSync(process.execPath, ['bin/letstryrea.mjs', 'search:context', 'examples/vault', 'nebula', '--format', 'json'], {
    cwd: project, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(demo.error);
  assert.equal(demo.status, 0, demo.stderr);
  assert.deepEqual(JSON.parse(demo.stdout).map(({ file }) => file), ['Welcome.md', 'notes/Observing.md']);
});

test('export preserves a nonempty destination and refuses symlink destinations', async (t) => {
  const { root, project } = await workspace(t);
  await writeFile(join(project, 'keep.txt'), 'user content');
  await assert.rejects(exportSearchProject({ destination: project, recipe, sourceEvidence }), /must be empty/);
  assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'user content');
  assert.deepEqual(await readdir(project), ['keep.txt']);
  const linked = join(root, 'linked');
  try {
    await symlink(project, linked, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  await assert.rejects(exportSearchProject({ destination: linked, recipe, sourceEvidence }), /regular directory/);
});

function decodeZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const entryCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let centralOffset = bytes.readUInt32LE(end + 16);
  assert.equal(centralOffset + directorySize, end);
  const result = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(bytes.readUInt32LE(centralOffset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(centralOffset + 10), 8);
    const compressedLength = bytes.readUInt32LE(centralOffset + 20);
    const originalLength = bytes.readUInt32LE(centralOffset + 24);
    const nameLength = bytes.readUInt16LE(centralOffset + 28);
    const name = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    const localOffset = bytes.readUInt32LE(centralOffset + 42);
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(bytes.readUInt16LE(localOffset + 26), nameLength);
    assert.equal(bytes.subarray(localOffset + 30, localOffset + 30 + nameLength).toString('utf8'), name);
    const content = inflateRawSync(bytes.subarray(localOffset + 30 + nameLength, localOffset + 30 + nameLength + compressedLength));
    assert.equal(content.length, originalLength);
    assert.equal(crc32(content), bytes.readUInt32LE(centralOffset + 16));
    assert.equal(crc32(content), bytes.readUInt32LE(localOffset + 14));
    assert.ok(!result.has(name), 'ZIP entries must be unique');
    result.set(name, { content, mode: bytes.readUInt32LE(centralOffset + 38) >>> 16 });
    centralOffset += 46 + nameLength;
  }
  assert.equal(centralOffset, end);
  return result;
}

test('ZIP is deterministic and every CRC-checked entry matches its manifest', async (t) => {
  const { root, project, manifest } = await generated(t);
  const first = await createProjectArchive({ projectDirectory: project, archivePath: join(root, 'first.zip') });
  const second = await createProjectArchive({ projectDirectory: project, archivePath: join(root, 'second.zip') });
  assert.equal(first.sha256, second.sha256);
  const archive = await readFile(first.path);
  assert.equal(first.bytes, archive.length);
  assert.equal(first.sha256, sha256(archive));
  const entries = decodeZip(archive);
  assert.equal(entries.size, manifest.files.length);
  assert.equal(first.files, entries.size);
  for (const file of manifest.files) {
    const entry = entries.get(file.path);
    assert.ok(entry, file.path);
    assert.equal(sha256(entry.content), file.sha256);
  }
  assert.equal(entries.get('bin/letstryrea.mjs').mode, 0o100755);
  assert.equal(entries.get('src/search.mjs').mode, 0o100644);
  await assert.rejects(createProjectArchive({ projectDirectory: project, archivePath: first.path }), /EEXIST/);
});

test('archive rejects unexpected files, symlinks, and writing inside the project', async (t) => {
  const { root, project } = await generated(t);
  await assert.rejects(createProjectArchive({ projectDirectory: project, archivePath: join(project, 'project.zip') }), /outside/);
  await writeFile(join(project, '.env'), 'PRIVATE=fixture');
  await assert.rejects(createProjectArchive({ projectDirectory: project, archivePath: join(root, 'private.zip') }), /Unexpected file/);
  await rm(join(project, '.env'));
  await rm(join(project, 'README.md'));
  try {
    await symlink(join(project, 'recipe.json'), join(project, 'README.md'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  await assert.rejects(createProjectArchive({ projectDirectory: project, archivePath: join(root, 'linked.zip') }), /Unexpected file/);
});
