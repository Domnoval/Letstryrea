import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { SYNTHESIS_PROJECT_PATHS, exportSynthesisProject } from '../src/synthesis-export.mjs';
import { createProjectArchive } from '../src/project-export.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = 'export default function quotient(value, divisor) { return value / divisor; }\n';
const defaultNotice = 'This project was generated from a supplied JavaScript function. Source and generation identities are recorded in provenance.json.\n';
const cases = [
  { args: [9, 2], expected: { type: 'number', value: 4.5 } },
  { args: [-0, 1], expected: { type: 'number', value: '-0' } },
  { args: [0, 0], expected: { type: 'number', value: 'NaN' } },
  { args: [1, 0], expected: { type: 'number', value: 'Infinity' } },
  { args: [-1, 0], expected: { type: 'number', value: '-Infinity' } },
];
const provenance = {
  requestId: 'A'.repeat(64),
  inputSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
  candidateSha256: 'd'.repeat(64), analysisSha256: 'e'.repeat(64),
  requestSha256: 'f'.repeat(64), corpusSha256: '1'.repeat(64),
  mode: 'chat-assisted', evidenceId: `ev_${'2'.repeat(64)}`,
  coverage: 'partial', trainingCases: 4, validationCases: 1, semanticUnknowns: 3,
  source: 'PRIVATE_SOURCE_SENTINEL', prompt: 'PRIVATE_PROMPT_SENTINEL',
  evidence: { secret: 'PRIVATE_EVIDENCE_SENTINEL' },
  path: '/workspace/PRIVATE_PATH_SENTINEL', token: 'PRIVATE_CREDENTIAL_SENTINEL',
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-synthesis-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  return { root, project };
}

async function generated(t, options = {}) {
  const paths = await workspace(t);
  const manifest = await exportSynthesisProject({ destination: paths.project, source, cases, provenance, ...options });
  return { ...paths, manifest };
}

function runNode(project, args) {
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', timeout: 60_000, env });
  assert.ifError(result.error);
  return result;
}

test('synthesis export runs independently and preserves negative-zero inputs and exceptional numeric outcomes', async (t) => {
  const { project, manifest } = await generated(t);
  assert.deepEqual(manifest.files.map(({ path }) => path).sort(), [...SYNTHESIS_PROJECT_PATHS].sort());
  for (const file of manifest.files) {
    const bytes = await readFile(join(project, file.path));
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, sha256(bytes));
    assert.doesNotMatch(bytes.toString('utf8'), /PRIVATE_(?:SOURCE|PROMPT|EVIDENCE|PATH|CREDENTIAL)_SENTINEL/);
  }
  assert.equal(await readFile(join(project, 'src/index.mjs'), 'utf8'), source);
  const fixtures = JSON.parse(await readFile(join(project, 'test/cases.json'), 'utf8'));
  assert.ok(Object.is(fixtures[1].args[0], -0));
  const metadata = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  assert.equal(metadata.exports, './src/index.mjs');
  assert.equal(metadata.dependencies, undefined);
  assert.equal(metadata.devDependencies, undefined);
  const passed = runNode(project, ['--test', '--test-reporter=tap']);
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /^# tests [1-9]\d*$/m);
  assert.match(passed.stdout, /^# fail 0$/m);
  const api = runNode(project, ['--input-type=module', '-e', "import candidate from './src/index.mjs'; console.log(candidate(9, 2));"]);
  assert.equal(api.status, 0, api.stderr);
  assert.equal(api.stdout.trim(), '4.5');
  await writeFile(join(project, 'src/index.mjs'), 'export default () => 999;\n');
  const regression = runNode(project, ['--test', '--test-reporter=tap']);
  assert.notEqual(regression.status, 0, 'The public suite must reject changed behavior.');
});

test('standalone public suite distinguishes primitive values and thrown error outcomes', async (t) => {
  const { project } = await generated(t, {
    source: `export default function outcome(value) {
      if (value === 0) return undefined;
      if (value === 1) return null;
      if (value === 2) return true;
      if (value === 3) return 'observed';
      throw new RangeError('outside fixture');
    }\n`,
    cases: [
      { args: [0], expected: { type: 'undefined' } },
      { args: [1], expected: { type: 'null', value: null } },
      { args: [2], expected: { type: 'boolean', value: true } },
      { args: [3], expected: { type: 'string', value: 'observed' } },
      { args: [4], expected: { type: 'error', name: 'RangeError', message: 'outside fixture' } },
    ],
  });
  const passed = runNode(project, ['--test', '--test-reporter=tap']);
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /^# fail 0$/m);
});

test('synthesis provenance includes only approved identifiers, hashes, mode, coverage, and numeric counts', async (t) => {
  const { project } = await generated(t);
  const metadata = JSON.parse(await readFile(join(project, 'provenance.json'), 'utf8'));
  assert.deepEqual(metadata, {
    formatVersion: 1, method: 'pure-function-synthesis-v1', candidateSha256: sha256(source),
    noticeSha256: sha256(defaultNotice),
    requestId: 'a'.repeat(64), inputSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
    analysisSha256: 'e'.repeat(64), requestSha256: 'f'.repeat(64), corpusSha256: '1'.repeat(64),
    mode: 'chat-assisted', evidenceId: `ev_${'2'.repeat(64)}`,
    coverage: 'partial', trainingCases: 4, validationCases: 1, semanticUnknowns: 3,
  });
  const malformed = await generated(t, { provenance: {
    requestId: '/workspace/private-request', inputSha256: 'not-a-hash', sourceSha256: null,
    evidenceId: 'ev_private', mode: 'PRIVATE_MODE_SENTINEL', coverage: 'PRIVATE_COVERAGE_SENTINEL',
    trainingCases: -1, validationCases: Infinity, semanticUnknowns: 'PRIVATE_COUNT_SENTINEL',
  } });
  assert.deepEqual(JSON.parse(await readFile(join(malformed.project, 'provenance.json'), 'utf8')), {
    formatVersion: 1, method: 'pure-function-synthesis-v1', candidateSha256: sha256(source),
    noticeSha256: sha256(defaultNotice),
  });
});

test('synthesis preserves supplied source notices and hashes their exact exported bytes', async (t) => {
  for (const supplied of ['MIT License\n\nCopyright (c) Example Author\n', 'MIT License\n\nCopyright (c) Example Author']) {
    const { project } = await generated(t, { notice: supplied });
    const actual = await readFile(join(project, 'NOTICE.md'), 'utf8');
    assert.equal(actual, supplied.endsWith('\n') ? supplied : `${supplied}\n`);
    const metadata = JSON.parse(await readFile(join(project, 'provenance.json'), 'utf8'));
    assert.equal(metadata.noticeSha256, sha256(actual));
  }
  const { project } = await generated(t);
  assert.equal(await readFile(join(project, 'NOTICE.md'), 'utf8'), defaultNotice);
});

test('synthesis rejects invalid source or corpus before writing and protects existing or symlink destinations', async (t) => {
  const { root, project } = await workspace(t);
  for (const options of [
    { source: '' }, { source: 'x'.repeat(32769) }, { notice: null }, { notice: 'x'.repeat(16385) },
    { cases: [] }, { cases: [null] },
    { cases: Array(1) }, { cases: [{ args: Array(1), expected: { type: 'undefined' } }] },
    { cases: [{ args: [Infinity], expected: { type: 'undefined' } }] },
    { cases: [{ args: [1, 2, 3, 4, 5], expected: { type: 'undefined' } }] },
    { cases: [{ args: [1], expected: { type: 'number', value: NaN } }] },
    { cases: [{ args: [1], expected: { type: 'object', value: { secret: 'private' } } }] },
  ]) {
    await assert.rejects(exportSynthesisProject({ destination: project, source, cases, provenance, ...options }));
    assert.deepEqual(await readdir(project), []);
  }
  await writeFile(join(project, 'keep.txt'), 'user content');
  await assert.rejects(exportSynthesisProject({ destination: project, source, cases, provenance }), /must be empty/);
  assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'user content');
  const linked = join(root, 'linked');
  try { await symlink(project, linked, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  await assert.rejects(exportSynthesisProject({ destination: linked, source, cases, provenance }), /regular directory/);
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
    entries.set(path, content);
    offset += 46 + length;
  }
  assert.equal(offset, end);
  return entries;
}

test('synthesis ZIP is deterministic and contains exactly the fixed source, cases, tests, and public metadata', async (t) => {
  const { root, project, manifest } = await generated(t);
  const args = { projectDirectory: project, recipeId: 'pure-function-synthesis-v1' };
  const first = await createProjectArchive({ ...args, archivePath: join(root, 'first.zip') });
  const second = await createProjectArchive({ ...args, archivePath: join(root, 'second.zip') });
  assert.equal(first.sha256, second.sha256);
  const bytes = await readFile(first.path);
  assert.equal(first.sha256, sha256(bytes));
  assert.equal(first.bytes, bytes.length);
  const entries = zipEntries(bytes);
  assert.equal(first.files, entries.size);
  assert.deepEqual([...entries.keys()].sort(), [...SYNTHESIS_PROJECT_PATHS].sort());
  for (const file of manifest.files) assert.equal(sha256(entries.get(file.path)), file.sha256);
});

test('synthesis archive rejects another recipe, injected files, missing files, and source symlinks', async (t) => {
  const { root, project } = await generated(t);
  const args = { projectDirectory: project, archivePath: join(root, 'project.zip'), recipeId: 'pure-function-synthesis-v1' };
  for (const recipeId of ['obsidian-markdown-search-v1', 'ms-duration-v1']) {
    await assert.rejects(createProjectArchive({ ...args, recipeId }), /Unexpected/);
  }
  await writeFile(join(project, '.env'), 'PRIVATE_CREDENTIAL_SENTINEL');
  await assert.rejects(createProjectArchive(args), /Unexpected file/);
  await rm(join(project, '.env'));
  await rm(join(project, 'src/index.mjs'));
  await assert.rejects(createProjectArchive(args), /missing required/);
  try { await symlink(join(project, 'package.json'), join(project, 'src/index.mjs')); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  await assert.rejects(createProjectArchive(args), /Unexpected file/);
});
