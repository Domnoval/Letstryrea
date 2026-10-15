import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeArtifact } from '../src/artifact-probe.mjs';
import {
  DURATION_RECIPE, DURATION_SOURCE_FILES, MS_TARBALL_BYTES, MS_TARBALL_SHA256,
  durationSourceEvidence, extractDurationArtifact, parseDurationTar,
} from '../src/duration-artifact.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureEntries = DURATION_SOURCE_FILES.map(({ path }, index) => ({ path, bytes: Buffer.from(`public synthetic fixture ${index}\n`) }));

function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
}

function tar(entries = fixtureEntries) {
  const chunks = [];
  for (const { path, bytes } of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 'ascii');
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header[156] = 48;
    header.write('ustar\0' + '00', 257, 'ascii');
    checksum(header);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function mutateHeader(action) {
  const bytes = tar();
  const header = bytes.subarray(0, 512);
  action(header);
  checksum(header);
  return bytes;
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-duration-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('bounded duration TAR parser retains inert files without authorizing a recipe', () => {
  const archive = tar();
  const files = parseDurationTar(archive);
  assert.equal(files.size, 4);
  for (const { path, bytes } of fixtureEntries) assert.deepEqual(files.get(path), bytes);
  assert.notEqual(hash(archive), MS_TARBALL_SHA256);
  const evidence = durationSourceEvidence();
  assert.equal(evidence.artifactSha256, MS_TARBALL_SHA256);
  assert.equal(evidence.sourceSha256, DURATION_SOURCE_FILES[0].sha256);
  assert.equal(DURATION_RECIPE.id, 'ms-duration-v1');
  evidence.files[0].sha256 = 'changed';
  assert.notEqual(durationSourceEvidence().files[0].sha256, 'changed', 'Public evidence must not mutate the pinned manifest.');
});

test('duration TAR parser rejects path traversal, absolute paths, duplicate and unknown entries', () => {
  for (const path of ['../escape', '/package/index.js', 'package/../index.js', 'package/extra.js']) {
    const bytes = mutateHeader((header) => { header.fill(0, 0, 100); header.write(path); });
    assert.throws(() => parseDurationTar(bytes), /path/);
  }
  assert.throws(() => parseDurationTar(tar([...fixtureEntries, fixtureEntries[0]])), /duplicate/);
  assert.throws(() => parseDurationTar(tar(fixtureEntries.slice(0, 3))), /all four/);
  assert.throws(() => parseDurationTar(mutateHeader((header) => { header[0] |= 0x80; })), /path field/);
});

test('duration TAR parser refuses links, directories, extension records, and prefixed names', () => {
  for (const type of ['1', '2', '5', 'x', 'L']) {
    assert.throws(() => parseDurationTar(mutateHeader((header) => { header.write(type, 156); })), /ordinary files/);
  }
  assert.throws(() => parseDurationTar(mutateHeader((header) => { header.write('target', 157); })), /ordinary files/);
  assert.throws(() => parseDurationTar(mutateHeader((header) => { header.write('prefix', 345); })), /ordinary files/);
  assert.throws(() => parseDurationTar(mutateHeader((header) => { header.write('other', 257); })), /ordinary files/);
});

test('duration TAR parser rejects bad checksums, malformed sizes, bounds, and nonzero padding', () => {
  const invalidChecksum = tar();
  invalidChecksum[0] ^= 1;
  assert.throws(() => parseDurationTar(invalidChecksum), /checksum/);
  for (const size of ['-0000000001\0', '0000000012x\0', '77777777777\0']) {
    assert.throws(() => parseDurationTar(mutateHeader((header) => { header.write(size, 124); })), /size|bounds/);
  }
  assert.throws(() => parseDurationTar(mutateHeader((header) => { header[124] = 0x80; })), /size/);
  const badPadding = tar();
  badPadding[512 + fixtureEntries[0].bytes.length] = 1;
  assert.throws(() => parseDurationTar(badPadding), /padding/);
});

test('duration TAR parser requires bounded aligned data and two final zero blocks', () => {
  const archive = tar();
  for (const bytes of [Buffer.alloc(0), archive.subarray(0, -1), Buffer.alloc(65 * 1024), archive.subarray(0, -1024), archive.subarray(0, -512)]) {
    assert.throws(() => parseDurationTar(bytes), /length|end marker/);
  }
  const trailingData = tar();
  trailingData[trailingData.length - 1] = 1;
  assert.throws(() => parseDurationTar(trailingData), /trailing data/);
});

test('lookalike compressed artifacts cannot select the duration recipe or write extracted files', async (t) => {
  const root = await workspace(t);
  const artifactPath = join(root, 'ms-2.1.3.tgz');
  const destination = join(root, 'reference');
  await mkdir(destination);
  // Equal size and convincing names do not establish the pinned package identity.
  const bytes = Buffer.alloc(MS_TARBALL_BYTES);
  bytes.set([0x1f, 0x8b, 8]);
  Buffer.from('ms 2.1.3 package/index.js').copy(bytes, 32);
  await writeFile(artifactPath, bytes);
  const result = await probeArtifact(artifactPath);
  assert.equal(result.format, 'gzip');
  assert.equal(result.supported, false);
  assert.equal(result.recipe, null);
  await assert.rejects(extractDurationArtifact({ artifactPath, destination }), /digest does not match/);
  assert.deepEqual(await readdir(destination), []);
  assert.deepEqual(await readFile(artifactPath), bytes);

  await writeFile(artifactPath, tar());
  await assert.rejects(extractDurationArtifact({ artifactPath, destination }), /exact studied/);
  assert.deepEqual(await readdir(destination), []);
});

test('duration extraction preserves existing output and refuses destination symlinks', async (t) => {
  const root = await workspace(t);
  const destination = join(root, 'reference');
  await mkdir(destination);
  await writeFile(join(destination, 'keep.txt'), 'user content');
  const artifactPath = join(root, 'missing.tgz');
  await assert.rejects(extractDurationArtifact({ artifactPath, destination }), /must be empty/);
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'user content');
  const linked = join(root, 'linked');
  await symlink(destination, linked, 'dir');
  await assert.rejects(extractDurationArtifact({ artifactPath, destination: linked }), /regular directory/);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(destination), ['keep.txt']);
});

test('duration extraction rejects non-file inputs before opening them', async (t) => {
  const root = await workspace(t);
  const inputDirectory = join(root, 'input');
  const destination = join(root, 'reference');
  await mkdir(inputDirectory);
  await mkdir(destination);
  await assert.rejects(extractDurationArtifact({ artifactPath: inputDirectory, destination }), /regular file/);
  assert.deepEqual(await readdir(destination), []);
});
