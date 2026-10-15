#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, realpath, stat, lstat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ORIGINAL_SHA256 = 'e5f0b6a946a9b2b356a28557728410717df54ea2f599edb619f9839df6b7b0e9';
const FIXTURE_PATH = fileURLToPath(new URL('../test/fixtures/ms-cases.json', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// The worker receives only this runner's fixed synthetic corpus. Original and
// candidate execute in different owned processes; neither sees the other.
const WORKER = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
function decode(value) {
  if (value.type === 'json') return value.value;
  const specials = {
    undefined: undefined,
    nan: NaN,
    'positive-infinity': Infinity,
    'negative-infinity': -Infinity,
    'negative-zero': -0
  };
  if (value.type !== 'special' || !Object.hasOwn(specials, value.value)) {
    throw new Error('Invalid comparison input descriptor');
  }
  return specials[value.value];
}
function encode(value) {
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
    if (value === Infinity) return { type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { type: 'number', value: '-0' };
  }
  if (typeof value === 'number' || typeof value === 'string' ||
      typeof value === 'boolean' || value === null) {
    return { type: value === null ? 'null' : typeof value, value };
  }
  throw new Error('Implementation returned an unsupported result type');
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const cases = JSON.parse(input);
const implementation = process.argv[1] === 'original'
  ? createRequire(import.meta.url)(process.argv[2])
  : (await import(pathToFileURL(process.argv[2]).href)).default;
if (typeof implementation !== 'function') throw new Error('Expected a default function export');
const observations = cases.map((item) => {
  let result;
  try {
    result = encode(implementation(decode(item.input), item.options ? decode(item.options) : undefined));
  } catch (error) {
    result = { type: 'error', name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  }
  return { id: item.id, result };
});
process.stdout.write(JSON.stringify({ observations }));
`;

function descriptor(value) { return { type: 'json', value }; }

function buildCases(fixture) {
  if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error('Comparison fixture must contain nonzero schema-version-1 cases.');
  }
  const cases = fixture.cases.map((item) => ({ ...item }));
  const add = (id, value, options) => cases.push({
    id, input: descriptor(value), ...(options === undefined ? {} : { options: descriptor(options) }),
  });
  const aliases = [
    'ms', 'msec', 'msecs', 'millisecond', 'milliseconds',
    's', 'sec', 'secs', 'second', 'seconds',
    'm', 'min', 'mins', 'minute', 'minutes',
    'h', 'hr', 'hrs', 'hour', 'hours',
    'd', 'day', 'days', 'w', 'week', 'weeks', 'y', 'yr', 'yrs', 'year', 'years',
  ];
  for (const [index, alias] of aliases.entries()) {
    for (const [numberIndex, value] of ['0', '-0', '1', '-1', '1.25', '.5', '-.5', '0002'].entries()) {
      for (const [spaceIndex, space] of ['', ' ', '   '].entries()) {
        add(`alias-${index}-${numberIndex}-${spaceIndex}`, `${value}${space}${alias}`);
      }
    }
    add(`alias-uppercase-${index}`, `2 ${alias.toUpperCase()}`);
    add(`alias-mixedcase-${index}`, `2 ${alias[0].toUpperCase()}${alias.slice(1)}`);
  }
  for (const [index, text] of [
    '1 ', '1  ', '1\r', '1\n', '1\r\n', '1s\r', '1s\r\n', '1s\n\n',
    '1\vs', '1\fs', '1\rs', '1\u2003s', '1\u2028s', '1\u2029s',
    '- 1s', '--1s', '1s!', '1msx', 's', '-', '.', '-.', '01', '00.5',
    '1.0', '0.', '1. s', '1..0s', '1,5s', '1_000s', '1e309', 'Infinity', 'NaN',
    '1 milliseconds\n', '1 milliseconds\u2028',
  ].entries()) add(`parser-edge-${index}`, text);
  // Input lengths on both sides of the upstream parser's bounded-text domain.
  for (const length of [99, 100, 101, 102, 1000]) {
    add(`length-numeric-${length}`, '1'.repeat(length));
    add(`length-spaces-${length}`, `1${' '.repeat(length - 2)}s`);
  }
  // Every unit-selection boundary, and the rounding/pluralization boundaries
  // within that unit, in both signs and both display modes.
  const units = [1, 1000, 60_000, 3_600_000, 86_400_000];
  for (const [unitIndex, unit] of units.entries()) {
    for (const [factorIndex, factor] of [0, 0.5, 1, 1.499, 1.5, 1.501, 2, 2.5, 10].entries()) {
      const boundary = unit * factor;
      for (const [deltaIndex, delta] of [-0.5, -0.001, 0, 0.001, 0.5].entries()) {
        for (const sign of [-1, 1]) {
          const value = sign * (boundary + delta);
          for (const long of [false, true]) {
            add(`numeric-${unitIndex}-${factorIndex}-${deltaIndex}-${sign}-${long}`, value, { long });
          }
        }
      }
    }
  }
  for (const [index, value] of [
    Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 315_576_000_000,
    1e-20, -1e-20, 999.999999999, -999.999999999,
  ].entries()) {
    add(`extreme-short-${index}`, value);
    add(`extreme-long-${index}`, value, { long: true });
  }
  const ids = new Set();
  for (const item of cases) {
    if (typeof item.id !== 'string' || ids.has(item.id)) throw new Error('Comparison case IDs must be unique strings.');
    ids.add(item.id);
  }
  return cases;
}

async function sourceIdentity(input, label) {
  const path = await realpath(resolve(input));
  const info = await stat(path);
  if (!info.isFile() || info.size > 1_048_576) throw new Error(`${label} must be a regular source file no larger than 1 MiB.`);
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

async function worker(kind, target, cases) {
  const args = ['--input-type=module', '-e', WORKER, kind, target];
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.NODE_TEST_CONTEXT;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: dirname(target), env, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let error;
    let timedOut = false;
    let hardStop;
    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (failure) { if (failure.code !== 'ESRCH') error ??= failure.message; }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      hardStop = setTimeout(() => terminate('SIGKILL'), 500);
    }, 15_000);
    const collect = (stream) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4_194_304) {
        error ??= 'Comparison worker exceeded its 4 MiB output limit.';
        terminate('SIGKILL');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (failure) => { error = failure.message; });
    // EPIPE after an early load failure is captured by the child's result.
    child.stdin.on('error', (failure) => { if (failure.code !== 'EPIPE') error ??= failure.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(deadline);
      if (timedOut && process.platform !== 'win32') terminate('SIGKILL');
      clearTimeout(hardStop);
      resolvePromise({
        command: {
          executable: process.execPath, args, cwd: dirname(target), startedAt,
          durationMs: Math.round(performance.now() - start), exitCode, signal, timedOut,
          stdoutSha256: sha256(stdout), stderr, ...(error ? { error } : {}),
        }, stdout,
      });
    });
    child.stdin.end(JSON.stringify(cases));
  });
  if (result.command.error || result.command.timedOut || result.command.exitCode !== 0 || result.command.signal) {
    throw new Error(`${kind} comparison worker failed: ${result.command.error ?? (result.command.timedOut ? 'deadline exceeded' : result.command.signal ?? `exit ${result.command.exitCode}`)}. ${result.command.stderr}`);
  }
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error(`${kind} comparison worker did not return valid JSON.`); }
  if (!Array.isArray(data.observations) || data.observations.length !== cases.length ||
      data.observations.some((item, index) => item.id !== cases[index].id || !item.result)) {
    throw new Error(`${kind} comparison worker returned an incomplete or reordered corpus.`);
  }
  return { command: result.command, observations: data.observations };
}

/** Execute only the pinned ms 2.1.3 source and an explicitly supplied candidate. */
export async function compareMs({ original, candidate, output } = {}) {
  if (typeof original !== 'string' || typeof candidate !== 'string') throw new Error('Original and candidate source paths are required.');
  if (output !== undefined) {
    try {
      await lstat(resolve(output));
      throw new Error('Comparison output already exists; choose a new JSON file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const originalIdentity = await sourceIdentity(original, 'Original');
  if (originalIdentity.sha256 !== ORIGINAL_SHA256) throw new Error('Original source does not match the pinned ms 2.1.3 SHA-256; refusing execution.');
  const candidateIdentity = await sourceIdentity(candidate, 'Candidate');
  if (originalIdentity.path === candidateIdentity.path || originalIdentity.sha256 === candidateIdentity.sha256) {
    throw new Error('Candidate must be independently supplied and differ from the original source.');
  }
  const fixtureBytes = await readFile(FIXTURE_PATH);
  const cases = buildCases(JSON.parse(fixtureBytes.toString('utf8')));
  const startedAt = new Date().toISOString();
  const expected = await worker('original', originalIdentity.path, cases);
  const actual = await worker('candidate', candidateIdentity.path, cases);
  const [originalAfter, candidateAfter] = await Promise.all([
    sourceIdentity(originalIdentity.path, 'Original'), sourceIdentity(candidateIdentity.path, 'Candidate'),
  ]);
  if (originalIdentity.sha256 !== originalAfter.sha256 || candidateIdentity.sha256 !== candidateAfter.sha256) {
    throw new Error('Comparison source changed during execution.');
  }
  const observations = cases.map((item, index) => ({
    ...item, expected: expected.observations[index].result, actual: actual.observations[index].result,
    passed: JSON.stringify(expected.observations[index].result) === JSON.stringify(actual.observations[index].result),
  }));
  const passed = observations.filter((item) => item.passed).length;
  const success = observations.length > 0 && passed === observations.length;
  const receipt = {
    schemaVersion: 1, status: success ? 'passed' : 'failed', success,
    target: 'ms@2.1.3', startedAt, completedAt: new Date().toISOString(),
    node: process.version, originalReferenceExecution: true,
    scope: 'Fixed synthetic API cases: documented parsing aliases, malformed inputs, length limits, numeric thresholds, rounding, long formatting, and ordinary invalid JSON types. Exotic objects/functions/proxies and resource behavior are outside this comparison.',
    original: { ...originalIdentity, sha256After: originalAfter.sha256 },
    candidate: { ...candidateIdentity, sha256After: candidateAfter.sha256 },
    corpus: { curatedFixtureSha256: sha256(fixtureBytes), combinedCasesSha256: sha256(JSON.stringify(cases)), runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))) },
    total: observations.length, passed, failed: observations.length - passed,
    commands: [expected.command, actual.command], observations,
  };
  if (output !== undefined) await writeFile(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

async function main(args) {
  const options = {};
  const flags = { '--original': 'original', '--candidate': 'candidate', '--out': 'output' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!Object.hasOwn(flags, flag) || options[flags[flag]] !== undefined || !args[index + 1]) {
      throw new Error('Usage: node scripts/compare-ms.mjs --original <ms-2.1.3/index.js> --candidate <duration.mjs> --out <new.json>');
    }
    options[flags[flag]] = args[++index];
  }
  if (!options.output) throw new Error('--out <new.json> is required.');
  const receipt = await compareMs(options);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, total: receipt.total, passed: receipt.passed, failed: receipt.failed, output: resolve(options.output) })}\n`);
  if (!receipt.success) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
