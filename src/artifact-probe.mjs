import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { DURATION_RECIPE, MS_TARBALL_SHA256, durationSourceEvidence } from './duration-artifact.mjs';

const KNOWN_ASAR_SHA256 = '146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f';
const KNOWN_APP_SHA256 = '958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9';
const KNOWN_APP_BYTES = 3_942_126;

// The supported release has a 95,908-byte JSON header. This bounded reader
// allows roughly ten times that size without trusting archive length fields.
const MAX_HEADER_BYTES = 1_048_576;
const CHUNK_BYTES = 1_048_576;

const RECIPE = Object.freeze({
  id: 'obsidian-markdown-search-v1',
  version: 1,
  title: 'Obsidian 1.14.4 plain-text Markdown search',
  description: 'Export the independently written, previously verified plain-text Markdown search implementation for the exact studied Obsidian 1.14.4 artifact.',
  capability: 'plain-text-markdown-search',
});

// Source provenance from docs/reconstruction-spec.md. Byte ends are exclusive.
const REGIONS = [
  ['basename-extension', 'Basename and lowercase extension helpers', 547825, 548336, 'b43b5b17676903fc57604459c4d07a19380949e641da0674c187a7b81fd64e85'],
  ['merge-ranges', 'Range sorting and merging', 1260683, 1260850, '63a6a4224d06483b0825827f57beac495b5cc631888dec2ea76e80c27d51719e'],
  ['markdown-enumeration', 'Vault Markdown enumeration', 1433798, 1434094, '34a5801d6e8dd908805727fcc3cfa1dbcc2920712ad5bdc9796ce36a381675ed'],
  ['regex-ranges', 'Regex case flags and occurrence ranges', 1458632, 1459004, 'dc456c15b945b7da0e4e3666b14519416f23cf775f0c6b0cdc39e4512b161f02'],
  ['quoted-matcher', 'Quoted matcher', 1460736, 1461434, '58a7204e7e84929dbd0ecd7cef5266ea8a413b23707909ebb8f9cf9ce3e7266b'],
  ['literal-matcher', 'Literal-token matcher', 1461434, 1461783, 'f787c90c9f2da1cf0c69260c15f733ab0459ee0c370bd1e6f566ee83580465f8'],
  ['and-combination', 'AND combination', 1462263, 1462586, 'afae135e52f93bab82548521e39c7205fa665193f9b29d305cfdfb2372ec3db4'],
  ['query-tokenizer', 'Query tokenizer', 1466974, 1468390, '98c684713ecd7f3d0c22cecbf4abdbc7475d91654bde75c6839cda250c0a9904'],
  ['filename-content', 'Filename/content inputs and range normalization', 1475171, 1477037, '418d0cba2dda7d8e1de747ff4ace78cb8db536edee2b84afd4d37afd412da488'],
  ['cli-arguments', 'Native CLI argument parsing', 1628304, 1628666, '57991476f78ba91b7ffdc06709272083bf5be965053a2a260659e5136a61816a'],
  ['ignore-filters', 'Ignore-filter compilation', 1770651, 1771197, 'f198f6b7d82fa290da473c9bd85d6138842e4b8c10bfa8b10987ade5a2b9b12c'],
  ['search-handlers', 'Shared search loop and both CLI handlers', 2709159, 2711801, 'be4d3919b78c2012623125f6447057bb98c29e1c6afba4977d8ff288eadfd8e6'],
].map(([id, label, start, end, sha256]) => ({ id, label, start, end, sha256 }));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readBytes(file, length, position) {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(data, offset, length - offset, position + offset);
    if (!bytesRead) return data.subarray(0, offset);
    offset += bytesRead;
  }
  return data;
}

async function hashFile(file, bytes) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0;
  while (position < bytes) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
    if (!bytesRead) throw new Error('Artifact changed or was truncated while hashing.');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function magicFormat(prefix) {
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'elf';
  if (prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b &&
      ((prefix[2] === 3 && prefix[3] === 4) || (prefix[2] === 5 && prefix[3] === 6) ||
       (prefix[2] === 7 && prefix[3] === 8))) return 'zip';
  if (prefix.length >= 3 && prefix[0] === 0x1f && prefix[1] === 0x8b && prefix[2] === 8) return 'gzip';
  return 'unknown';
}

async function isPe(file, prefix, bytes) {
  if (prefix.length < 64 || prefix[0] !== 0x4d || prefix[1] !== 0x5a) return false;
  const offset = prefix.readUInt32LE(60);
  if (offset < 64 || offset > bytes - 4) return false;
  return (await readBytes(file, 4, offset)).equals(Buffer.from([0x50, 0x45, 0, 0]));
}

async function readAsarHeader(file, prefix, bytes) {
  if (prefix.length < 4 || prefix.readUInt32LE(0) !== 4) return null;
  if (prefix.length < 16) return { error: 'Truncated ASAR header.' };
  const headerSize = prefix.readUInt32LE(4);
  const payloadSize = prefix.readUInt32LE(8);
  const jsonSize = prefix.readUInt32LE(12);
  // Chromium Pickle: a 4-byte payload length, followed by a length-prefixed
  // JSON string and up to three zero-padding bytes to a four-byte boundary.
  if (headerSize < 8 || headerSize % 4 || payloadSize !== headerSize - 4 ||
      jsonSize < 2 || headerSize !== 8 + Math.ceil(jsonSize / 4) * 4 ||
      headerSize + 8 > bytes) {
    return { error: 'Invalid or truncated ASAR header lengths.' };
  }
  if (jsonSize > MAX_HEADER_BYTES) return { error: 'ASAR header exceeds the 1 MiB supported inspection limit.' };
  let header;
  try {
    const json = await readBytes(file, jsonSize, 16);
    if (json.length !== jsonSize) return { error: 'Truncated ASAR header JSON.' };
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    return { error: 'Invalid ASAR header JSON or UTF-8.' };
  }
  if (!isObject(header) || !Object.hasOwn(header, 'files') || !isObject(header.files)) {
    return { error: 'ASAR header must contain a files object.' };
  }
  const dataOffset = headerSize + 8;
  if (!Object.hasOwn(header.files, 'app.js')) return { dataOffset, app: null };
  const app = header.files['app.js'];
  if (!isObject(app) || Object.hasOwn(app, 'link') || app.unpacked ||
      Object.hasOwn(app, 'files') || !Number.isSafeInteger(app.size) || app.size < 0 ||
      typeof app.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(app.offset)) {
    return { error: 'ASAR app.js must be an ordinary packed file with a valid size and offset.' };
  }
  const offset = Number(app.offset);
  if (!Number.isSafeInteger(offset) || offset > bytes - dataOffset ||
      app.size > bytes - dataOffset - offset) {
    return { error: 'ASAR app.js extends outside the artifact.' };
  }
  return { dataOffset, app: { offset, size: app.size } };
}

/**
 * Inspect inert artifact bytes. Symlinks are explicitly resolved and the result
 * identifies the canonical file. Only exact studied artifact bytes enable a recipe;
 * names, keyword strings, and archive metadata never establish eligibility.
 */
export async function probeArtifact(inputPath) {
  const path = await realpath(resolve(inputPath));
  // Check before opening so a named pipe cannot block awaiting a writer.
  if (!(await stat(path)).isFile()) throw new Error('Artifact must be a regular file.');
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('Artifact must be a regular file.');
    if (!Number.isSafeInteger(before.size)) throw new Error('Artifact size is outside the supported integer range.');
    const digest = await hashFile(file, before.size);
    const prefix = await readBytes(file, Math.min(64, before.size), 0);
    const result = {
      path,
      name: basename(path),
      bytes: before.size,
      sha256: digest,
      format: magicFormat(prefix),
      supported: false,
      recipe: null,
      sourceEvidence: null,
      reasons: [],
    };
    if (await isPe(file, prefix, before.size)) result.format = 'pe';
    const asar = await readAsarHeader(file, prefix, before.size);
    if (digest === MS_TARBALL_SHA256) {
      result.supported = true;
      result.recipe = { ...DURATION_RECIPE };
      result.sourceEvidence = durationSourceEvidence();
    } else if (asar?.error) {
      result.reasons.push(asar.error);
    } else if (asar) {
      result.format = 'asar';
      if (digest !== KNOWN_ASAR_SHA256) {
        result.reasons.push('ASAR SHA-256 does not match the exact studied Obsidian 1.14.4 release; no reconstruction recipe is supported.');
      } else if (!asar.app || asar.app.size !== KNOWN_APP_BYTES) {
        result.reasons.push('The studied artifact must contain the expected packed app.js source.');
      } else {
        // This allocation happens only after the full artifact digest matches.
        const app = await readBytes(file, KNOWN_APP_BYTES, asar.dataOffset + asar.app.offset);
        if (app.length !== KNOWN_APP_BYTES || sha256(app) !== KNOWN_APP_SHA256) {
          result.reasons.push('Embedded app.js does not match the studied source digest.');
        } else if (REGIONS.some((region) => sha256(app.subarray(region.start, region.end)) !== region.sha256)) {
          result.reasons.push('Embedded app.js static evidence anchors do not match the reconstruction specification.');
        } else {
          result.supported = true;
          result.recipe = { ...RECIPE };
          result.sourceEvidence = {
            artifactSha256: digest,
            appJsSha256: KNOWN_APP_SHA256,
            sourceVersion: '1.14.4',
            method: 'exact-artifact-and-static-anchors',
            regions: REGIONS.map((region) => ({ ...region })),
          };
        }
      }
    } else {
      result.reasons.push(result.format === 'unknown'
        ? 'Unrecognized artifact format; no reconstruction recipe is supported.'
        : `The ${result.format} format has no supported reconstruction recipe.`);
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Artifact changed during inspection; retry with a stable file.');
    }
    return result;
  } finally {
    await file.close();
  }
}
