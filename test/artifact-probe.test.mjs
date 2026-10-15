import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeArtifact } from '../src/artifact-probe.mjs';

async function fixture(t, bytes, name = 'artifact.asar') {
  const directory = await mkdtemp(join(tmpdir(), 'letstryrea-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

function asar(header, body = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(headerSize - 8 - json.length), body]);
}

test('unknown bytes retain canonical identity and a streaming SHA-256', async (t) => {
  const bytes = Buffer.alloc(2_500_000, 0x61);
  const path = await fixture(t, bytes);
  const result = await probeArtifact(path);
  assert.equal(result.path, await realpath(path));
  assert.equal(result.name, 'artifact.asar');
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.format, 'unknown');
  assert.equal(result.supported, false);
  assert.equal(result.recipe, null);
  assert.equal(result.sourceEvidence, null);
  assert.match(result.reasons.join(' '), /Unrecognized/);
});

test('magic identifies unsupported containers independently of extension', async (t) => {
  const cases = [
    ['zip', Buffer.from([0x50, 0x4b, 3, 4])],
    ['zip', Buffer.from([0x50, 0x4b, 5, 6])],
    ['gzip', Buffer.from([0x1f, 0x8b, 8])],
    ['elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ];
  for (const [format, bytes] of cases) {
    const result = await probeArtifact(await fixture(t, bytes));
    assert.equal(result.format, format);
    assert.equal(result.supported, false);
    assert.match(result.reasons[0], /no supported reconstruction recipe/);
  }
});

test('PE classification requires its actual PE signature, not only DOS magic', async (t) => {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ', 0);
  bytes.writeUInt32LE(96, 60);
  bytes.write('PE\0\0', 96);
  assert.equal((await probeArtifact(await fixture(t, bytes))).format, 'pe');
  bytes[96] = 0;
  assert.equal((await probeArtifact(await fixture(t, bytes))).format, 'unknown');
});

test('valid ASAR with convincing names and metadata cannot select a recipe', async (t) => {
  const source = Buffer.from('Obsidian 1.14.4 search search:context app.vault.getMarkdownFiles()');
  const bytes = asar({ files: { 'app.js': {
    size: source.length,
    offset: '0',
    integrity: { algorithm: 'SHA256', hash: '958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9' },
  } } }, source);
  const result = await probeArtifact(await fixture(t, bytes, 'obsidian-1.14.4.asar'));
  assert.equal(result.format, 'asar');
  assert.equal(result.supported, false);
  assert.equal(result.sourceEvidence, null);
  assert.match(result.reasons[0], /SHA-256 does not match/);
});

test('ASAR without app.js is identified but unsupported', async (t) => {
  const result = await probeArtifact(await fixture(t, asar({ files: {} })));
  assert.equal(result.format, 'asar');
  assert.equal(result.supported, false);
});

test('truncated and malformed ASAR headers fail closed', async (t) => {
  const truncated = Buffer.from([4, 0, 0, 0]);
  const valid = asar({ files: {} });
  const invalidJson = Buffer.from(valid);
  invalidJson[16] = 0xff;
  const mismatchedLength = Buffer.from(valid);
  mismatchedLength.writeUInt32LE(99, 8);
  const noFiles = asar({ files: [] });
  for (const bytes of [truncated, valid.subarray(0, valid.length - 1), invalidJson, mismatchedLength, noFiles]) {
    const result = await probeArtifact(await fixture(t, bytes));
    assert.equal(result.format, 'unknown');
    assert.equal(result.supported, false);
    assert.equal(result.sourceEvidence, null);
    assert.match(result.reasons[0], /ASAR/);
  }
});

test('oversized header is bounded and unsupported', async (t) => {
  const bytes = asar({ files: {}, padding: 'a'.repeat(1_048_577) });
  const result = await probeArtifact(await fixture(t, bytes));
  assert.equal(result.supported, false);
  assert.match(result.reasons[0], /1 MiB/);
});

test('app.js cannot be redirected, unpacked, fractional, or outside archive bounds', async (t) => {
  const entries = [
    { link: '../app.js' },
    { unpacked: true, size: 0, offset: '0' },
    { size: 1.5, offset: '0' },
    { size: -1, offset: '0' },
    { size: 0, offset: '-1' },
    { size: 0, offset: '9007199254740992' },
    { size: 10, offset: '0' },
    { size: 0, offset: '1' },
    { files: {}, size: 0, offset: '0' },
  ];
  for (const entry of entries) {
    const result = await probeArtifact(await fixture(t, asar({ files: { 'app.js': entry } })));
    assert.equal(result.supported, false);
    assert.equal(result.format, 'unknown');
    assert.match(result.reasons[0], /app.js/);
  }
});

test('canonicalizes a symlink and reports the file actually inspected', async (t) => {
  const path = await fixture(t, Buffer.from('source'));
  const link = join(path, '..', 'alias.asar');
  await symlink(path, link);
  const result = await probeArtifact(link);
  assert.equal(result.path, await realpath(path));
  assert.equal(result.name, 'artifact.asar');
});

test('empty files stay unsupported; filesystem errors are surfaced', async (t) => {
  const path = await fixture(t, Buffer.alloc(0));
  assert.equal((await probeArtifact(path)).supported, false);
  await assert.rejects(probeArtifact(`${path}.missing`), { code: 'ENOENT' });
  await assert.rejects(probeArtifact(join(path, '..')), /regular file/);
});

test('anchor constants continue to match the public reconstruction specification', async () => {
  const specification = await readFile(new URL('../docs/reconstruction-spec.md', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/artifact-probe.mjs', import.meta.url), 'utf8');
  const hashes = [...specification.matchAll(/\| [^\n]+ \| (\d+)–(\d+) \| `([a-f0-9]{64})` \|/g)];
  assert.equal(hashes.length, 12);
  for (const [, start, end, digest] of hashes) {
    assert.ok(source.includes(`${start}, ${end}, '${digest}'`), `missing documented anchor ${start}–${end}`);
  }
});
