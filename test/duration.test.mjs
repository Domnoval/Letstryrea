import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import duration, { duration as namedDuration } from '../src/duration.mjs';

const cliPath = fileURLToPath(new URL('../src/duration-cli.mjs', import.meta.url));

test('named and default exports expose the same duration function', () => {
  assert.equal(duration, namedDuration);
});

test('parses every supported unit spelling', () => {
  const examples = [
    [1, ['millisecond', 'milliseconds', 'msec', 'msecs', 'ms']],
    [1_000, ['second', 'seconds', 'sec', 'secs', 's']],
    [60_000, ['minute', 'minutes', 'min', 'mins', 'm']],
    [3_600_000, ['hour', 'hours', 'hr', 'hrs', 'h']],
    [86_400_000, ['day', 'days', 'd']],
    [604_800_000, ['week', 'weeks', 'w']],
    [31_557_600_000, ['year', 'years', 'yr', 'yrs', 'y']],
  ];
  for (const [expected, aliases] of examples) {
    for (const alias of aliases) {
      assert.equal(duration(`1 ${alias}`), expected, alias);
      assert.equal(duration(`1${alias.toUpperCase()}`), expected, alias.toUpperCase());
    }
  }
});

test('parses decimal, negative, and unitless values without losing negative zero', () => {
  assert.equal(duration('.5h'), 1_800_000);
  assert.equal(duration('-.25 s'), -250);
  assert.equal(duration('001.50min'), 90_000);
  assert.equal(duration('123.45'), 123.45);
  assert.equal(duration('10   '), 10);
  assert.equal(Object.is(duration('-0'), -0), true);
  assert.equal(Object.is(duration('-0 weeks'), -0), true);
});

test('rejects malformed nonempty strings without throwing', () => {
  const invalid = [
    ' ', ' 1s', '1s ', '1\ts', '1\u00a0s', '+1s', '1.s', '.', '-.',
    '1e3', '0x10', 'NaN', 'Infinity', '1 fortnight', '1 second(s)',
    '1h 2m', '1_000', '--1', '1\n', '1\r', '1\u2028', '1\u2029',
    '1s\n', '1s\r\n', '1s\n\n',
  ];
  for (const input of invalid) assert.equal(duration(input), undefined, JSON.stringify(input));
});

test('accepts strings through 100 characters and rejects longer input', () => {
  assert.equal(duration(`1${' '.repeat(99)}`), 1);
  assert.equal(duration(`1${'0'.repeat(99)}`), 1e99);
  assert.equal(duration(`1${' '.repeat(100)}`), undefined);
  assert.equal(duration(`1${'0'.repeat(100)}`), undefined);
});

test('formats using the largest day, hour, minute, or second threshold', () => {
  const examples = [
    [0, '0ms'], [-0, '0ms'], [0.25, '0.25ms'], [-999.5, '-999.5ms'],
    [1_000, '1s'], [1_500, '2s'], [-1_500, '-1s'],
    [59_999, '60s'], [60_000, '1m'], [90_000, '2m'], [-90_000, '-1m'],
    [3_600_000, '1h'], [5_400_000, '2h'], [-5_400_000, '-1h'],
    [86_400_000, '1d'], [129_600_000, '2d'], [-129_600_000, '-1d'],
    [604_800_000, '7d'], [31_557_600_000, '365d'],
  ];
  for (const [input, expected] of examples) assert.equal(duration(input), expected, String(input));
});

test('long formatting uses the original magnitude for singular and plural labels', () => {
  const examples = [
    [0, '0 ms'], [999.5, '999.5 ms'], [1_000, '1 second'],
    [1_499, '1 second'], [1_500, '2 seconds'], [-1_500, '-1 seconds'],
    [60_000, '1 minute'], [90_000, '2 minutes'], [-90_000, '-1 minutes'],
    [3_600_000, '1 hour'], [5_400_000, '2 hours'],
    [86_400_000, '1 day'], [129_600_000, '2 days'], [-129_600_000, '-1 days'],
  ];
  for (const [input, expected] of examples) {
    assert.equal(duration(input, { long: true }), expected, String(input));
  }
  assert.equal(duration(1_000, { long: 'yes' }), '1 second');
  assert.equal(duration(1_000, null), '1s');
  assert.equal(duration(1_000, false), '1s');
  assert.equal(duration('1s', { get long() { throw new Error('unused'); } }), 1_000);
});

test('invalid value types and nonfinite numbers retain the serialized error message', () => {
  for (const input of ['', undefined, null, true, [], {}, NaN, Infinity, -Infinity]) {
    const message = 'val is not a non-empty string or a valid number. val=' + JSON.stringify(input);
    assert.throws(() => duration(input), (error) => error instanceof Error && error.message === message);
  }
  assert.throws(() => duration(1n), TypeError);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => duration(cycle), TypeError);
});

test('CLI works from a disposable working directory with real process exit codes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'duration-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runFrom = (entrypoint, ...args) => {
    const child = spawnSync(process.execPath, [entrypoint, ...args], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  };
  const run = (...args) => runFrom(cliPath, ...args);

  assert.deepEqual(run('parse', '1.5 hours'), { status: 0, stdout: '5400000\n', stderr: '' });
  const linkedCli = join(directory, 'linked-duration.mjs');
  symlinkSync(cliPath, linkedCli);
  assert.deepEqual(runFrom(linkedCli, 'parse', '1s'), {
    status: 0, stdout: '1000\n', stderr: '',
  });
  assert.deepEqual(run('parse', '-0'), { status: 0, stdout: '-0\n', stderr: '' });
  assert.deepEqual(run('parse', 'nonsense'), {
    status: 1, stdout: '{"status":"invalid"}\n', stderr: '',
  });
  assert.deepEqual(run('parse', ''), {
    status: 1, stdout: '',
    stderr: 'Error: val is not a non-empty string or a valid number. val=""\n',
  });
  assert.deepEqual(run('format', '-1500'), { status: 0, stdout: '-1s\n', stderr: '' });
  assert.deepEqual(run('format', '-1500', '--long'), {
    status: 0, stdout: '-1 seconds\n', stderr: '',
  });
  assert.deepEqual(run('format', '.5', '--long'), { status: 0, stdout: '0.5 ms\n', stderr: '' });

  for (const args of [
    [], ['unknown'], ['parse'], ['parse', '1s', '--long'],
    ['format'], ['format', '1', '--unknown'], ['format', '1', '--long', 'extra'],
    ['format', 'Infinity'], ['format', '1e3'], ['format', '+1'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error: .+\n$/);
  }

  for (const option of ['--help', '-h']) {
    const result = run(option);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage:\n/);
    assert.match(result.stdout, /letstryrea parse <duration>/);
    assert.equal(result.stderr, '');
  }
});
