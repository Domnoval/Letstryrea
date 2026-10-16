import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const SYNTHESIS_PROJECT_PATHS = Object.freeze([
  'src/index.mjs',
  'test/behavior.test.mjs',
  'test/cases.json',
  'package.json',
  'README.md',
  'provenance.json',
  'NOTICE.md',
]);

const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_CASES = 1024;
const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_NOTICE = 'This project was generated from a supplied JavaScript function. Source and generation identities are recorded in provenance.json.\n';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// JSON numeric -0 must survive the round trip into the standalone suite.
const json = (value) => `${JSON.stringify(value, (_key, item) => Object.is(item, -0) ? JSON.rawJSON('-0') : item, 2)}\n`;

function expectedOutcome(value) {
  if (value?.type === 'undefined') return { type: 'undefined' };
  if (value?.type === 'null' && value.value === null) return { type: 'null', value: null };
  if (value?.type === 'boolean' && typeof value.value === 'boolean') return { type: 'boolean', value: value.value };
  if (value?.type === 'string' && typeof value.value === 'string' && value.value.length <= 65536) {
    return { type: 'string', value: value.value };
  }
  if (value?.type === 'number' && ((typeof value.value === 'number' && Number.isFinite(value.value) && !Object.is(value.value, -0)) ||
      ['NaN', 'Infinity', '-Infinity', '-0'].includes(value.value))) {
    return { type: 'number', value: value.value };
  }
  if (value?.type === 'error' && typeof value.name === 'string' && value.name.length <= 300 &&
      typeof value.message === 'string' && value.message.length <= 65536) {
    return { type: 'error', name: value.name, message: value.message };
  }
  throw new Error('Every synthesis case must contain a valid typed primitive outcome.');
}

function publicCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > MAX_CASES) {
    throw new Error(`Synthesis requires between 1 and ${MAX_CASES} behavioral cases.`);
  }
  return Array.from(cases, (item) => {
    if (!Array.isArray(item?.args) || item.args.length > 4 ||
        !Array.from(item.args).every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Synthesis case arguments must be at most four finite numbers.');
    }
    return { args: [...item.args], expected: expectedOutcome(item.expected) };
  });
}

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function publicProvenance(provenance, source, notice) {
  const result = {
    formatVersion: 1,
    method: 'pure-function-synthesis-v1',
    candidateSha256: hash(source),
    noticeSha256: hash(notice),
  };
  if (typeof provenance?.requestId === 'string' && /^[a-f0-9]{64}$/i.test(provenance.requestId)) {
    result.requestId = provenance.requestId.toLowerCase();
  }
  for (const key of ['inputSha256', 'sourceSha256', 'analysisSha256', 'requestSha256', 'corpusSha256']) {
    const value = digest(provenance?.[key]);
    if (value) result[key] = value;
  }
  if (['chat-assisted', 'provider-generated'].includes(provenance?.mode)) result.mode = provenance.mode;
  if (typeof provenance?.evidenceId === 'string' && /^ev_[a-f0-9]{64}$/i.test(provenance.evidenceId)) {
    result.evidenceId = provenance.evidenceId.toLowerCase();
  }
  if (['complete', 'partial', 'unknown'].includes(provenance?.coverage)) result.coverage = provenance.coverage;
  for (const key of ['trainingCases', 'validationCases', 'semanticUnknowns']) {
    if (Number.isSafeInteger(provenance?.[key]) && provenance[key] >= 0) result[key] = provenance[key];
  }
  return result;
}

const behavioralTest = `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import candidate from '../src/index.mjs';

function encode(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null', value: null };
  if (typeof value === 'number') {
    return { type: 'number', value: Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : value };
  }
  if (typeof value === 'string' || typeof value === 'boolean') return { type: typeof value, value };
  throw new TypeError('Candidate returned a nonprimitive value outside the supported scope.');
}

function observe(args) {
  let value;
  try { value = candidate(...args); }
  catch (error) {
    return { type: 'error', name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  }
  return encode(value);
}

const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
for (const [index, item] of cases.entries()) {
  test('public behavioral case ' + (index + 1), () => {
    assert.deepEqual(observe(item.args), item.expected);
  });
}
`;

/** Export generated source and a public finite corpus, without original code. */
export async function exportSynthesisProject({ destination, source, cases, provenance, notice } = {}) {
  if (typeof destination !== 'string' || !destination) throw new Error('An export destination is required.');
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new Error('Generated source must be nonempty ESM within 32 KiB.');
  }
  if (notice !== undefined && (typeof notice !== 'string' || Buffer.byteLength(notice) > 16 * 1024)) {
    throw new Error('A supplied source notice must be a string within 16 KiB.');
  }
  const sourceNotice = notice === undefined ? DEFAULT_NOTICE : notice.endsWith('\n') ? notice : `${notice}\n`;
  const fixtures = publicCases(cases);
  const fixtureJson = json(fixtures);
  if (Buffer.byteLength(fixtureJson) > MAX_FIXTURE_BYTES) throw new Error('Synthesis public cases exceed the 4 MiB limit.');
  const directory = resolve(destination);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export destination must be a regular directory.');
  if ((await readdir(directory)).length) throw new Error('Export destination must be empty.');

  const files = new Map([
    ['src/index.mjs', Buffer.from(source)],
    ['test/behavior.test.mjs', Buffer.from(behavioralTest)],
    ['test/cases.json', Buffer.from(fixtureJson)],
    ['provenance.json', Buffer.from(json(publicProvenance(provenance, source, sourceNotice)))],
    ['NOTICE.md', Buffer.from(sourceNotice)],
    ['package.json', Buffer.from(json({
      name: 'reconstructed-pure-function',
      version: '0.1.0',
      private: true,
      type: 'module',
      description: 'Source-assisted pure-function reconstruction checked against a finite behavioral corpus.',
      engines: { node: '>=24.0.0' },
      exports: './src/index.mjs',
      scripts: { test: 'node --test' },
    }))],
    ['README.md', Buffer.from(`# Reconstructed pure function

This editable ESM project contains a source-assisted reconstruction of one
pure function. It runs with Node.js 24 or later and has no external dependencies.

\`\`\`sh
npm test
\`\`\`

Import the default function from \`src/index.mjs\` and call it with the finite
numeric arguments shown in \`test/cases.json\`. Edit the source and run the public
behavioral suite to check the recorded outcomes.

The finite corpus records observed behavior for particular argument lists.
Passing it is not a formal proof of equivalence or a guarantee for untested
inputs. This project does not reconstruct arbitrary applications, side effects,
external dependencies, or stateful behavior.

The candidate was generated with access to source analysis. It may be a license
derivative of that source; this export makes no automatic license or independent
authorship claim. Check the source's applicable license before redistribution.
See \`NOTICE.md\` for a supplied source notice or the default provenance note.

\`provenance.json\` contains selected identifiers and hashes. Original module
source, raw analysis, generation prompts, credentials, and machine-local paths
are excluded from the export.
`)],
  ]);
  const manifest = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path);
    const output = join(directory, ...path.split('/'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes, { flag: 'wx', mode: 0o644 });
    manifest.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { files: manifest };
}
