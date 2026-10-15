import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const cli = fileURLToPath(new URL('../bin/letstryrea.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(...args) {
  const result = spawnSync(process.execPath, [cli, 'reconstruct', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `CLI terminated: ${result.stderr}`);
  return result;
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

async function reports(out, status) {
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  const markdown = await readFile(join(out, 'report.md'), 'utf8');
  assert.equal(report.status, status);
  assert.match(markdown, new RegExp(status, 'i'));
  assert.match(markdown, /\S/);
  await absent(join(out, 'project'));
  await absent(join(out, 'project.zip'));
  return report;
}

// A valid Electron archive containing source that looks relevant still cannot
// stand in for the exact artifact whose behavior was studied.
function asar(source) {
  const app = Buffer.from(source);
  const header = Buffer.from(JSON.stringify({ files: { 'app.js': { size: app.length, offset: '0' } } }));
  const headerSize = 8 + Math.ceil(header.length / 4) * 4;
  const bytes = Buffer.alloc(8 + headerSize + app.length);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(headerSize, 4);
  bytes.writeUInt32LE(headerSize - 4, 8);
  bytes.writeUInt32LE(header.length, 12);
  header.copy(bytes, 16);
  app.copy(bytes, 8 + headerSize);
  return bytes;
}

async function fakeRea(root) {
  const executable = join(root, 'fake-rea');
  const sentinel = join(root, 'rea-was-executed');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\nprocess.exit(77);\n`);
  await chmod(executable, 0o755);
  return { executable, sentinel };
}

test('unsupported inputs produce honest classified reports without running REA or producing a project', async (t) => {
  const root = await workspace(t);
  const rea = await fakeRea(root);
  const fixtures = [
    ['plain.txt', Buffer.from('Obsidian 1.14.4 app.js search:context Markdown search'), 'unknown'],
    ['native.elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'elf'],
    ['archive.zip', Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]), 'zip'],
    ['archive.gz', gzipSync('Obsidian app.js search:context'), 'gzip'],
    ['lookalike.asar', asar('/* Obsidian 1.14.4 */ function search() {} // search:context'), 'asar'],
    ['malformed.asar', Buffer.from([4, 0, 0, 0, 255, 255, 255, 255]), 'unknown'],
  ];
  for (const [name, bytes, format] of fixtures) {
    await t.test(name, async () => {
      const input = join(root, name);
      const out = join(root, `${name}-output`);
      await writeFile(input, bytes);
      const result = run(input, '--out', out, '--rea', rea.executable, '--json');
      assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, 'unsupported');
      const report = await reports(out, 'unsupported');
      assert.equal(report.artifact.format, format);
      assert.equal(report.artifact.sha256, sha256(bytes));
      assert.equal(report.artifact.bytes, bytes.length);
      assert.equal(sha256(await readFile(input)), sha256(bytes), 'Artifact bytes must be unchanged.');
      await absent(rea.sentinel);
    });
  }
});

test('an executable artifact is read as data and never executed', async (t) => {
  const root = await workspace(t);
  const sentinel = join(root, 'artifact-was-executed');
  const artifact = join(root, 'artifact');
  const bytes = Buffer.from(`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`);
  await writeFile(artifact, bytes);
  await chmod(artifact, 0o755);
  const out = join(root, 'result');
  const result = run(artifact, '--out', out, '--json');
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).status, 'unsupported');
  await reports(out, 'unsupported');
  await absent(sentinel);
  assert.equal(sha256(await readFile(artifact)), sha256(bytes));
});

test('existing empty and populated output directories and output files are preserved', async (t) => {
  const root = await workspace(t);
  const artifact = join(root, 'artifact.bin');
  await writeFile(artifact, 'unknown artifact');
  const rea = await fakeRea(root);
  const empty = join(root, 'empty');
  await mkdir(empty);
  const populated = join(root, 'populated');
  await mkdir(populated);
  await writeFile(join(populated, 'report.json'), 'user content');
  const outputFile = join(root, 'output-file');
  await writeFile(outputFile, 'user file');

  for (const out of [empty, populated, outputFile]) {
    const result = run(artifact, '--out', out, '--rea', rea.executable, '--json');
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /\S/, 'Refusals must explain the problem.');
  }
  assert.deepEqual(await readdir(empty), []);
  assert.deepEqual(await readdir(populated), ['report.json']);
  assert.equal(await readFile(join(populated, 'report.json'), 'utf8'), 'user content');
  assert.equal(await readFile(outputFile, 'utf8'), 'user file');
  await absent(rea.sentinel);
});

test('output symlinks, including dangling links, are refused and preserved', async (t) => {
  const root = await workspace(t);
  const artifact = join(root, 'artifact.bin');
  await writeFile(artifact, 'unknown artifact');
  const target = join(root, 'target');
  await mkdir(target);
  await writeFile(join(target, 'keep'), 'user content');
  const linked = join(root, 'linked');
  const dangling = join(root, 'dangling');
  const missingTarget = join(root, 'missing-target');
  try {
    await symlink(target, linked, 'dir');
    await symlink(missingTarget, dangling, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }
  const rea = await fakeRea(root);
  for (const out of [linked, dangling]) {
    const result = run(artifact, '--out', out, '--rea', rea.executable);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /\S/);
  }
  assert.equal(await readlink(linked), target);
  assert.equal(await readlink(dangling), missingTarget);
  assert.deepEqual(await readdir(target), ['keep']);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'user content');
  await absent(missingTarget);
  await absent(rea.sentinel);
});

test('overlapping source and output paths are refused before modifying the artifact', async (t) => {
  const root = await workspace(t);
  const artifact = join(root, 'artifact.bin');
  const bytes = Buffer.from('preserve this source');
  await writeFile(artifact, bytes);
  for (const out of [artifact, join(artifact, 'result'), root]) {
    const result = run(artifact, '--out', out);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /\S/);
  }
  assert.deepEqual(await readdir(root), ['artifact.bin']);
  assert.equal(sha256(await readFile(artifact)), sha256(bytes));
});

test('directory aliases cannot hide source/output overlap or cause output parents to be created', async (t) => {
  const root = await workspace(t);
  const directory = join(root, 'source');
  const alias = join(root, 'source-alias');
  await mkdir(directory);
  await writeFile(join(directory, 'keep.txt'), 'preserve source contents');
  try {
    await symlink(directory, alias, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform disallows fixture symlinks.'); return; }
    throw error;
  }

  const cases = [
    [alias, join(directory, 'new-parent-from-aliased-input', 'output')],
    [directory, join(alias, 'new-parent-from-aliased-output', 'output')],
  ];
  for (const [input, out] of cases) {
    const result = run(input, '--out', out);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /separate|overlap/i);
  }
  assert.deepEqual(await readdir(directory), ['keep.txt']);
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'preserve source contents');
  assert.equal(await readlink(alias), directory);
  assert.deepEqual((await readdir(root)).sort(), ['source', 'source-alias']);
});

test('missing and non-file input failures leave diagnostic reports in the newly reserved output', async (t) => {
  const root = await workspace(t);
  const directory = join(root, 'directory');
  await mkdir(directory);
  for (const [input, name] of [[join(root, 'missing.bin'), 'missing'], [directory, 'directory']]) {
    const out = join(root, `${name}-output`);
    const result = run(input, '--out', out, '--json');
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    const report = await reports(out, 'failed');
    assert.match(JSON.stringify(report), /missing|ENOENT|regular file|directory/i);
  }
});

test('help is usable without an artifact and malformed requests do not reserve output', async (t) => {
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /reconstruct/i);
  assert.match(help.stdout, /--out/);

  const root = await workspace(t);
  const out = join(root, 'output');
  const result = run('--out', out);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /\S/);
  await absent(out);
});
