import { createHash } from 'node:crypto';
import { encodePureValue, evaluatePureProgram, PURE_PROGRAM_LIMITS, PureProgramError } from './pure-program.mjs';
import { stringifySynthesis } from './synthesis-json.mjs';

export const SYNTHESIS_CASE_LIMITS = Object.freeze({
  userCases: 64, totalCases: 1024, parameters: 4, corpusBytes: 4 * 1024 * 1024,
});
const BOUNDARIES = [-100, -10, -1, -0, 0, 1, 2, 10, 100];
const GENERATED_TRAINING = 12;
const RANDOM_CASES = 200;
const HASH = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new TypeError(message);
}

function record(value, label, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} must contain exactly ${keys.join(', ')}.`);
  }
}

function parameterCount(arity) {
  if (!Number.isInteger(arity) || arity < 1 || arity > SYNTHESIS_CASE_LIMITS.parameters) {
    fail('Synthesis requires between 1 and 4 parameters.');
  }
  return arity;
}

function numericArguments(args, arity) {
  if (!Array.isArray(args) || args.length !== arity) fail('Case arguments must match the exact parameter count.');
  for (const value of args) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('Case arguments must be finite numbers.');
  }
  return [...args];
}

function readJson(value, label) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} must be valid JSON.`);
  }
}

/** Validate caller-supplied examples; options and additional schema fields are rejected. */
export function parseSynthesisContract(value, arity) {
  const contract = readJson(value, 'Synthesis contract');
  record(contract, 'Synthesis contract', ['schemaVersion', 'cases']);
  if (contract.schemaVersion !== 1) fail('Synthesis contract schemaVersion must be 1.');
  if (!Array.isArray(contract.cases) || contract.cases.length < 1 ||
      contract.cases.length > SYNTHESIS_CASE_LIMITS.userCases) {
    fail('Synthesis contract must contain between 1 and 64 cases.');
  }
  const count = parameterCount(arity ?? contract.cases[0]?.length);
  return { schemaVersion: 1, cases: Array.from(contract.cases, (args) => numericArguments(args, count)) };
}

const canonical = (value) => stringifySynthesis(value, 0);
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);

function corpusBudgetError() {
  fail('Synthesis corpus exceeds the 4 MiB serialized byte limit.');
}

function serializeWithinBudget(corpus) {
  const serialized = stringifySynthesis(corpus);
  if (Buffer.byteLength(serialized, 'utf8') > SYNTHESIS_CASE_LIMITS.corpusBytes) corpusBudgetError();
  return serialized;
}

function caseBudget() {
  let bytes = 0;
  return (item) => {
    // Every row appears once in its partition and once in all. This lower bound
    // stops large outcomes before constructing the complete serialized corpus.
    bytes += 2 * Buffer.byteLength(stringifySynthesis(item), 'utf8');
    if (bytes > SYNTHESIS_CASE_LIMITS.corpusBytes) corpusBudgetError();
    return item;
  };
}

function observe(program, args) {
  try {
    return encodePureValue(evaluatePureProgram(program, args));
  } catch (error) {
    // Unsupported IR and resource limits are verification failures, not program results.
    if (error instanceof PureProgramError) throw error;
    return {
      type: 'error',
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceNumbers(program) {
  const pending = [program];
  const visited = new Set();
  const values = new Map();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);
    if (visited.size > 20_000) fail('Pure program is too large for bounded corpus construction.');
    let literal = node;
    let sign = 1;
    const unaryVisited = new Set();
    while (literal?.kind === 'unary' && ['+', '-'].includes(literal.operator)) {
      if (unaryVisited.has(literal) || unaryVisited.size >= 128) {
        fail('Pure program contains an unbounded unary expression.');
      }
      unaryVisited.add(literal);
      if (literal.operator === '-') sign *= -1;
      literal = literal.argument;
    }
    if (literal?.kind === 'literal' && typeof literal.value === 'number' && Number.isFinite(literal.value)) {
      const value = sign * literal.value;
      if (Math.abs(value) <= 1e9) values.set(canonical(value), value);
    }
    const children = Object.values(node);
    // Reverse the stack insertion to retain the IR's source order.
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return [...values.values()];
}

function adjacent(value, direction) {
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits + (Math.sign(value) === direction ? 1n : -1n));
  return view.getFloat64(0);
}

function generatedArguments(program, supplied) {
  const arity = program.parameters.length;
  const seen = new Set(supplied.map(canonical));
  const generated = [];
  const maximum = SYNTHESIS_CASE_LIMITS.totalCases - supplied.length;
  const probeMaximum = maximum - RANDOM_CASES;
  const add = (args, limit = maximum) => {
    if (generated.length >= limit) return false;
    const key = canonical(args);
    if (seen.has(key)) return false;
    seen.add(key);
    generated.push(args);
    return true;
  };
  const axes = (value) => {
    for (const baseline of [0, 1]) {
      for (let axis = 0; axis < arity; axis += 1) {
        const args = Array(arity).fill(baseline);
        args[axis] = value;
        add(args, probeMaximum);
      }
    }
  };

  for (const value of BOUNDARIES) {
    axes(value);
    add(Array(arity).fill(value), probeMaximum);
    add(Array.from({ length: arity }, (_, index) => index % 2 ? -value : value), probeMaximum);
  }
  for (let mask = 0; mask < 2 ** arity; mask += 1) {
    add(Array.from({ length: arity }, (_, index) => mask & (1 << index) ? -0 : 0), probeMaximum);
  }
  for (const value of sourceNumbers(program)) {
    for (const probe of [value, adjacent(value, -1), adjacent(value, 1), value - 1, value + 1, value - 0.5, value + 0.5]) {
      if (!Number.isFinite(probe) || Math.abs(probe) > 1e9) continue;
      axes(probe);
      add(Array(arity).fill(probe), probeMaximum);
    }
    if (generated.length >= probeMaximum) break;
  }

  let state = 0x6d2b79f5;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  let accepted = 0;
  for (let attempt = 0; accepted < RANDOM_CASES && attempt < RANDOM_CASES * 20; attempt += 1) {
    const args = Array.from({ length: arity }, (_, axis) => {
      const value = random();
      switch ((attempt + axis) % 4) {
        case 0: return Math.floor(value * 101) - 50;
        case 1: return (Math.floor(value * 2001) - 1000) / 8;
        case 2: return value * 20 - 10;
        default: return (value - 0.5) / 1000;
      }
    });
    if (add(args)) accepted += 1;
  }
  if (accepted !== RANDOM_CASES) fail('Could not construct the bounded deterministic validation corpus.');
  return generated;
}

function corpusDigest(corpus) {
  return digest({
    schemaVersion: 1,
    contractSha256: corpus.contractSha256,
    training: corpus.training,
    validation: corpus.validation,
  });
}

/** Build independent, deterministic probes before any candidate program is requested. */
export function buildSynthesisCases(program, value) {
  const arity = parameterCount(program?.parameters?.length);
  const contract = parseSynthesisContract(value, arity);
  const supplied = [...new Map(contract.cases.map((args) => [canonical(args), args])).values()];
  const generated = generatedArguments(program, supplied);
  const reserve = caseBudget();
  const makeCase = (args) => reserve({ args: [...args], expected: observe(program, args) });
  const corpus = {
    schemaVersion: 1,
    contractSha256: digest(contract),
    training: [...supplied, ...generated.slice(0, GENERATED_TRAINING)].map(makeCase),
    validation: generated.slice(GENERATED_TRAINING).map(makeCase),
  };
  if (corpus.validation.length === 0) fail('Synthesis requires nonempty held-out validation inputs.');
  corpus.all = [...corpus.training, ...corpus.validation];
  corpus.corpusSha256 = corpusDigest(corpus);
  serializeWithinBudget(corpus);
  return corpus;
}

function outcome(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Case outcomes must use primitive type tags.');
  const keys = value.type === 'undefined' ? ['type']
    : value.type === 'error' ? ['type', 'name', 'message'] : ['type', 'value'];
  record(value, 'Case outcome', keys);
  switch (value.type) {
    case 'undefined': break;
    case 'null': if (value.value !== null) fail('Invalid null outcome.'); break;
    case 'boolean': if (typeof value.value !== 'boolean') fail('Invalid boolean outcome.'); break;
    case 'string':
      if (typeof value.value !== 'string' || value.value.length > PURE_PROGRAM_LIMITS.stringLength) fail('Invalid string outcome.');
      break;
    case 'number':
      if (!(typeof value.value === 'number' && Number.isFinite(value.value) && !Object.is(value.value, -0)) &&
          !['NaN', 'Infinity', '-Infinity', '-0'].includes(value.value)) fail('Invalid number outcome.');
      break;
    case 'error':
      if (typeof value.name !== 'string' || typeof value.message !== 'string' ||
          value.name.length > PURE_PROGRAM_LIMITS.stringLength || value.message.length > PURE_PROGRAM_LIMITS.stringLength) {
        fail('Invalid error outcome.');
      }
      break;
    default: fail('Unknown outcome type.');
  }
  return { ...value };
}

/** Validate persisted cases, including their partition, signed zeros, and content hash. */
export function deserializeSynthesisCases(value) {
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > SYNTHESIS_CASE_LIMITS.corpusBytes) {
    corpusBudgetError();
  }
  const input = readJson(value, 'Synthesis corpus');
  record(input, 'Synthesis corpus', ['schemaVersion', 'contractSha256', 'corpusSha256', 'training', 'validation', 'all']);
  if (input.schemaVersion !== 1 || typeof input.contractSha256 !== 'string' ||
      typeof input.corpusSha256 !== 'string' || !HASH.test(input.contractSha256) || !HASH.test(input.corpusSha256)) {
    fail('Synthesis corpus requires schemaVersion 1 and SHA-256 hashes.');
  }
  if (!Array.isArray(input.training) || input.training.length < 1 || input.training.length > 76 ||
      !Array.isArray(input.validation) || input.validation.length < 1 ||
      input.training.length + input.validation.length > SYNTHESIS_CASE_LIMITS.totalCases) {
    fail('Synthesis corpus partitions exceed the case limits or are empty.');
  }
  if (!Array.isArray(input.all) || input.all.length !== input.training.length + input.validation.length) {
    fail('Synthesis corpus all must equal training followed by validation.');
  }
  const arity = parameterCount(input.training[0]?.args?.length);
  const seen = new Set();
  const reserve = caseBudget();
  const copyRecord = (item) => {
    record(item, 'Corpus case', ['args', 'expected']);
    return { args: numericArguments(item.args, arity), expected: outcome(item.expected) };
  };
  const copyCase = (item) => {
    const result = copyRecord(item);
    const key = canonical(result.args);
    if (seen.has(key)) fail('Synthesis corpus inputs must be unique across both partitions.');
    seen.add(key);
    return reserve(result);
  };
  const corpus = {
    schemaVersion: 1,
    contractSha256: input.contractSha256,
    training: Array.from(input.training, copyCase),
    validation: Array.from(input.validation, copyCase),
  };
  corpus.all = [...corpus.training, ...corpus.validation];
  for (let index = 0; index < corpus.all.length; index += 1) {
    if (!same(copyRecord(input.all[index]), corpus.all[index])) {
      fail('Synthesis corpus all must equal training followed by validation.');
    }
  }
  corpus.corpusSha256 = corpusDigest(corpus);
  if (corpus.corpusSha256 !== input.corpusSha256) fail('Synthesis corpus hash does not match its contents.');
  serializeWithinBudget(corpus);
  return corpus;
}

export function serializeSynthesisCases(corpus) {
  return serializeWithinBudget(deserializeSynthesisCases(corpus));
}

/** Compare parsed programs in the bounded interpreter; executable source is never loaded. */
export function compareSynthesisPrograms(original, candidate, value) {
  const corpus = deserializeSynthesisCases(value);
  const observations = [];
  let trainingPassed = 0;
  let validationPassed = 0;
  for (const partition of ['training', 'validation']) {
    for (const item of corpus[partition]) {
      const expected = observe(original, item.args);
      if (!same(expected, item.expected)) fail('Corpus expected outcome does not match the original program.');
      const actual = observe(candidate, item.args);
      const passed = same(expected, actual);
      if (passed && partition === 'training') trainingPassed += 1;
      if (passed && partition === 'validation') validationPassed += 1;
      observations.push({ partition, args: [...item.args], expected, actual, passed });
    }
  }
  const total = observations.length;
  const passedCount = trainingPassed + validationPassed;
  return {
    passed: passedCount === total,
    total,
    failed: total - passedCount,
    passedCount,
    trainingPassed,
    trainingTotal: corpus.training.length,
    validationPassed,
    validationTotal: corpus.validation.length,
    observations,
  };
}
