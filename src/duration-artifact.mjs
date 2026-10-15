import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const MS_TARBALL_SHA256 = 'f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6';
export const MS_TARBALL_BYTES = 2967;

export const DURATION_RECIPE = Object.freeze({
  id: 'ms-duration-v1',
  version: 1,
  title: 'ms 2.1.3 duration parsing and formatting',
  description: 'Export an independently written duration parser and formatter verified against the exact studied ms 2.1.3 npm artifact.',
  capability: 'duration-parsing-and-formatting',
});

export const DURATION_SOURCE_FILES = Object.freeze([
  ['package/index.js', 3024, 'e5f0b6a946a9b2b356a28557728410717df54ea2f599edb619f9839df6b7b0e9'],
  ['package/package.json', 732, '1a6b4d9739790c0b94ab96c8cc0507e281c164c311ff4fbf5e57fb8d26290b40'],
  ['package/license.md', 1079, '1662fae9b5314d11cf51284e2dcd1f006a354f7343f08712a730fcff9a359801'],
  ['package/readme.md', 1886, '8bf6c4f414b123ea2a9375b91982882d01d8561ce7d12e3bb4f448c23359f040'],
].map(([path, bytes, sha256]) => Object.freeze({ path, bytes, sha256 })));

const MAX_TAR_BYTES = 64 * 1024;
const expectedPaths = new Set(DURATION_SOURCE_FILES.map(({ path }) => path));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function durationSourceEvidence() {
  return {
    artifactSha256: MS_TARBALL_SHA256,
    sourceSha256: DURATION_SOURCE_FILES[0].sha256,
    sourceVersion: '2.1.3',
    method: 'exact-artifact-and-file-manifest',
    files: DURATION_SOURCE_FILES.map((file) => ({ ...file })),
  };
}

function tarNumber(field, label) {
  // Only the studied ordinary octal headers are supported, never base-256
  // values, extension records, signed numbers, or permissive numeric prefixes.
  if (field.some((byte) => byte > 127)) throw new Error(`Invalid duration TAR ${label}.`);
  const text = field.toString('ascii').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid duration TAR ${label}.`);
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid duration TAR ${label}.`);
  return number;
}

/**
 * Parse only the four ordinary paths used by this recipe. This structural
 * parser does not establish recipe eligibility: extraction additionally checks
 * the compressed artifact digest and every pinned source-file digest.
 */
export function parseDurationTar(tar) {
  if (!Buffer.isBuffer(tar) || tar.length < 1024 || tar.length > MAX_TAR_BYTES || tar.length % 512) {
    throw new Error('Invalid or oversized duration TAR length.');
  }
  const files = new Map();
  let offset = 0;
  let terminated = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error('Invalid duration TAR end marker or trailing data.');
      }
      terminated = true;
      break;
    }
    const checksum = tarNumber(header.subarray(148, 156), 'checksum');
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actualChecksum) throw new Error('Duration TAR header checksum does not match.');
    if (!header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00')) ||
        !header.subarray(345, 500).every((byte) => byte === 0) ||
        !header.subarray(157, 257).every((byte) => byte === 0) ||
        ![0, 48].includes(header[156])) {
      throw new Error('Duration TAR must contain ordinary files without links, prefixes, or extensions.');
    }
    const nameField = header.subarray(0, 100);
    const nameEnd = nameField.indexOf(0);
    if (nameEnd < 0 || nameField.some((byte) => byte > 127) || !nameField.subarray(nameEnd).every((byte) => byte === 0)) {
      throw new Error('Invalid duration TAR path field.');
    }
    const path = nameField.subarray(0, nameEnd).toString('ascii');
    if (!expectedPaths.has(path) || files.has(path)) {
      throw new Error(`Unexpected or duplicate duration TAR path: ${JSON.stringify(path)}.`);
    }
    const size = tarNumber(header.subarray(124, 136), 'file size');
    const start = offset + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    if (size > MAX_TAR_BYTES || next > tar.length || !tar.subarray(end, next).every((byte) => byte === 0)) {
      throw new Error('Invalid duration TAR file size, bounds, or padding.');
    }
    files.set(path, Buffer.from(tar.subarray(start, end)));
    offset = next;
  }
  if (!terminated || files.size !== expectedPaths.size) {
    throw new Error('Duration TAR must contain all four studied package files and an end marker.');
  }
  return files;
}

/** Materialize the exact pinned package as inert bytes in an empty directory. */
export async function extractDurationArtifact({ artifactPath, destination } = {}) {
  if (typeof artifactPath !== 'string' || typeof destination !== 'string') {
    throw new Error('A duration artifact path and extraction destination are required.');
  }
  const directory = resolve(destination);
  const destinationInfo = await lstat(directory);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
    throw new Error('Duration extraction destination must be a regular directory.');
  }
  if ((await readdir(directory)).length) throw new Error('Duration extraction destination must be empty.');

  const canonicalArtifact = await realpath(resolve(artifactPath));
  if (!(await lstat(canonicalArtifact)).isFile()) throw new Error('Duration artifact must be a regular file.');
  const file = await open(canonicalArtifact, 'r');
  let compressed;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== MS_TARBALL_BYTES) {
      throw new Error('Duration artifact is not the exact studied ms 2.1.3 npm tarball.');
    }
    const buffer = Buffer.alloc(MS_TARBALL_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    compressed = buffer.subarray(0, count);
    const after = await file.stat();
    if (compressed.length !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || hash(compressed) !== MS_TARBALL_SHA256) {
      throw new Error('Duration artifact digest does not match the exact studied ms 2.1.3 npm tarball.');
    }
  } finally { await file.close(); }

  const entries = parseDurationTar(gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES }));
  for (const expected of DURATION_SOURCE_FILES) {
    const bytes = entries.get(expected.path);
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) {
      throw new Error(`Duration source file does not match the studied manifest: ${expected.path}.`);
    }
  }
  // Nothing is written until the archive structure and complete source manifest
  // have been verified. No original package code or lifecycle scripts are run.
  const packageDirectory = join(directory, 'package');
  await mkdir(packageDirectory);
  for (const expected of DURATION_SOURCE_FILES) {
    await writeFile(join(directory, expected.path), entries.get(expected.path), { flag: 'wx', mode: 0o600 });
  }
  return {
    artifactSha256: MS_TARBALL_SHA256,
    packageDirectory,
    method: 'exact-artifact-and-file-manifest',
    files: DURATION_SOURCE_FILES.map((item) => ({ ...item })),
  };
}
