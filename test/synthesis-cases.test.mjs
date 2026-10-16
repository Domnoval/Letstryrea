import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePureProgram, PureProgramError } from '../src/pure-program.mjs';
import { stringifySynthesis } from '../src/synthesis-json.mjs';
import {
  buildSynthesisCases,
  compareSynthesisPrograms,
  deserializeSynthesisCases,
  parseSynthesisContract,
  serializeSynthesisCases,
} from '../src/synthesis-cases.mjs';

const program = (body, parameters = 'x') => parsePureProgram(`export default function calculate(${parameters}) { ${body} }`);
const contract = (...cases) => ({ schemaVersion: 1, cases });

test('contract validation requires finite, exact-arity examples and rejects options', () => {
  assert.deepEqual(parseSynthesisContract('{"schemaVersion":1,"cases":[[-0,2]]}', 2).cases[0], [-0, 2]);
  assert.deepEqual(parseSynthesisContract(contract([1], [2])).cases, [[1], [2]]);
  for (const value of [
    null, {}, '{', { schemaVersion: 2, cases: [[1]] },
    { schemaVersion: 1, cases: [[1]], seed: 1 }, contract(), contract([1, 2]),
    contract([NaN]), contract([Infinity]), contract(['1']), contract([]),
    contract(...Array.from({ length: 65 }, () => [1])),
  ]) assert.throws(() => parseSynthesisContract(value, 1), TypeError);
  assert.equal(parseSynthesisContract(contract(...Array.from({ length: 64 }, () => [1])), 1).cases.length, 64);
  for (const arity of [0, 5, -1, 1.5]) assert.throws(() => parseSynthesisContract(contract([1]), arity), TypeError);
});

test('generation is deterministic, bounded, and keeps held-out inputs separate', () => {
  const original = program('return a * b + c / d;', 'a, b, c, d');
  const examples = contract([3, 4, 5, 6], [3, 4, 5, 6]);
  const first = buildSynthesisCases(original, examples);
  const second = buildSynthesisCases(original, examples);
  assert.equal(serializeSynthesisCases(first), serializeSynthesisCases(second));
  assert.equal(first.training.length, 13);
  assert.ok(first.validation.length >= 200);
  assert.ok(first.all.length <= 1024);
  assert.deepEqual(first.training[0].args, [3, 4, 5, 6]);
  const keys = first.all.map((item) => stringifySynthesis(item.args, 0));
  assert.equal(new Set(keys).size, first.all.length);
  assert.ok(first.all.every(({ args }) => args.length === 4 && args.every(Number.isFinite)));
  for (let mask = 0; mask < 16; mask += 1) {
    const signs = Array.from({ length: 4 }, (_, index) => mask & (1 << index) ? -0 : 0);
    assert.ok(keys.includes(stringifySynthesis(signs, 0)));
  }
});

test('source constants contribute exact adjacent values and bounded probes', () => {
  const corpus = buildSynthesisCases(program('if (x < -7.25) return -0; return x;'), contract([3]));
  const values = corpus.all.map(({ args }) => args[0]);
  assert.ok(values.includes(-7.25));
  assert.ok(values.includes(-7.25 - Number.EPSILON * 4));
  assert.ok(values.includes(-7.25 + Number.EPSILON * 4));
  assert.ok(values.some((value) => Math.abs(value) > 0 && Math.abs(value) < 1));
  const bounded = buildSynthesisCases(program('if (x > 10000000000) return 1; return x;'), contract([3]));
  assert.ok(bounded.all.every(({ args }) => Math.abs(args[0]) <= 1e9));
  const edge = buildSynthesisCases(program('if (x > 1000000000) return 1; return x;'), contract([3]));
  assert.ok(edge.all.every(({ args }) => Math.abs(args[0]) <= 1e9));
});

test('many source constants stay within the total corpus cap', () => {
  const additions = Array.from({ length: 90 }, (_, index) => index + 1000).join(' + ');
  const original = program(`return a + b + c + d + ${additions};`, 'a, b, c, d');
  const corpus = buildSynthesisCases(original, contract([3, 4, 5, 6]));
  assert.equal(corpus.all.length, 1024);
  assert.ok(corpus.validation.length >= 200);
  assert.equal(new Set(corpus.all.map(({ args }) => stringifySynthesis(args, 0))).size, 1024);
});

test('build, serialization, and deserialization enforce a 4 MiB corpus budget', () => {
  const largeOutput = program(`return ${JSON.stringify('x'.repeat(20_000))};`);
  assert.throws(() => buildSynthesisCases(largeOutput, contract([1])), /4 MiB serialized byte limit/);
  assert.throws(() => deserializeSynthesisCases(' '.repeat(4 * 1024 * 1024 + 1)), /4 MiB serialized byte limit/);

  const corpus = buildSynthesisCases(program('return x;'), contract([1]));
  const oversized = structuredClone(corpus);
  for (const item of [...oversized.training, ...oversized.validation]) {
    item.expected = { type: 'string', value: 'x'.repeat(20_000) };
  }
  oversized.all = [...oversized.training, ...oversized.validation];
  assert.throws(() => serializeSynthesisCases(oversized), /4 MiB serialized byte limit/);
  assert.throws(() => deserializeSynthesisCases(oversized), /4 MiB serialized byte limit/);
});

test('case serialization preserves signed zero and checks corpus integrity', () => {
  const original = program('return 1 / x;');
  const negative = buildSynthesisCases(original, contract([-0]));
  const positive = buildSynthesisCases(original, contract([0]));
  assert.notEqual(negative.contractSha256, positive.contractSha256);
  const serialized = serializeSynthesisCases(negative);
  const restored = deserializeSynthesisCases(serialized);
  assert.equal(Object.is(restored.training[0].args[0], -0), true);
  assert.deepEqual(restored.training[0].expected, { type: 'number', value: '-Infinity' });
  assert.equal(serializeSynthesisCases(restored), serialized);

  const changed = JSON.parse(serialized);
  changed.training[0].expected = { type: 'number', value: 42 };
  changed.all[0].expected = { type: 'number', value: 42 };
  assert.throws(() => deserializeSynthesisCases(changed), /hash/);
  const reordered = JSON.parse(serialized);
  reordered.all.reverse();
  assert.throws(() => deserializeSynthesisCases(reordered), /all must equal/);
  const duplicate = JSON.parse(serialized);
  duplicate.validation[0] = duplicate.training[0];
  assert.throws(() => deserializeSynthesisCases(duplicate), /unique/);
  for (const field of ['contractSha256', 'corpusSha256']) {
    const malformed = JSON.parse(serialized);
    malformed[field] = [malformed[field]];
    assert.throws(() => deserializeSynthesisCases(malformed), /SHA-256 hashes/);
  }
  const oversized = JSON.parse(serialized);
  oversized.training[0].expected = { type: 'string', value: 'a'.repeat(65_537) };
  assert.throws(() => deserializeSynthesisCases(oversized), /Invalid string outcome/);
});

test('an equivalent candidate passes every held-out input in the interpreter', () => {
  const original = program('return x * x + 1;');
  const candidate = program('const squared = x ** 2; return 1 + squared;');
  const corpus = buildSynthesisCases(original, contract([3]));
  const result = compareSynthesisPrograms(original, candidate, corpus);
  assert.equal(result.passed, true);
  assert.equal(result.failed, 0);
  assert.equal(result.passedCount, result.total);
  assert.equal(result.trainingPassed, corpus.training.length);
  assert.equal(result.validationPassed, corpus.validation.length);
});

test('a candidate that memorizes all training inputs fails held-out behavior', () => {
  const original = program('return x * x;');
  const corpus = buildSynthesisCases(original, contract([3]));
  const condition = corpus.training.map(({ args }) => `x === ${stringifySynthesis(args[0], 0)}`).join(' || ');
  const candidate = program(`if (${condition}) return x * x; return x * x + 1;`);
  const result = compareSynthesisPrograms(original, candidate, corpus);
  assert.equal(result.passed, false);
  assert.equal(result.trainingPassed, corpus.training.length);
  assert.ok(result.validationPassed < corpus.validation.length);
  assert.ok(result.failed > 0);
  assert.ok(result.observations.some((item) => item.partition === 'validation' && !item.passed));
});

test('comparisons distinguish signed-zero, nonfinite, undefined, and ordinary errors', () => {
  const reciprocal = program('return 1 / x;');
  const reciprocalCorpus = buildSynthesisCases(reciprocal, contract([-0], [0]));
  assert.deepEqual(reciprocalCorpus.training.slice(0, 2).map((item) => item.expected.value), ['-Infinity', 'Infinity']);
  const signed = program('return x * 0;');
  const zero = program('return 0;');
  assert.equal(compareSynthesisPrograms(signed, zero, buildSynthesisCases(signed, contract([-1]))).passed, false);
  const undefinedProgram = program('if (x < 0) return 0 / 0; return;');
  const outcomes = buildSynthesisCases(undefinedProgram, contract([-1], [1])).training.slice(0, 2);
  assert.deepEqual(outcomes.map((item) => item.expected), [{ type: 'number', value: 'NaN' }, { type: 'undefined' }]);
  const throws = program('const value = value; return value;');
  const errors = buildSynthesisCases(throws, contract([1]));
  assert.equal(errors.training[0].expected.type, 'error');
  assert.equal(errors.training[0].expected.name, 'ReferenceError');
  assert.equal(compareSynthesisPrograms(throws, throws, errors).passed, true);
});

test('comparison rejects a corpus generated for a different original program', () => {
  const original = program('return x + 1;');
  const different = program('return x + 2;');
  const corpus = buildSynthesisCases(original, contract([1]));
  assert.throws(() => compareSynthesisPrograms(different, different, corpus), /does not match the original/);
});

test('unsupported interpreter input cannot count as a matching program error', () => {
  const original = program('return x + 1;');
  const corpus = buildSynthesisCases(original, contract([1]));
  const rejected = structuredClone(original);
  rejected.body.body[0].value = { kind: 'unsupported-expression' };
  assert.throws(() => compareSynthesisPrograms(original, rejected, corpus), PureProgramError);
  assert.throws(() => buildSynthesisCases(rejected, contract([1])), PureProgramError);

  const cyclic = structuredClone(original);
  const inner = { kind: 'unary', operator: '-' };
  inner.argument = inner;
  cyclic.body.body[0].value = { kind: 'unary', operator: '-', argument: inner };
  assert.throws(() => buildSynthesisCases(cyclic, contract([1])), /unbounded unary expression/);
});
