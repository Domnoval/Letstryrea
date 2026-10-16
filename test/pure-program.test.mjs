import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PURE_PROGRAM_LIMITS, PureProgramError, encodePureValue, evaluatePureProgram, parsePureProgram,
} from '../src/pure-program.mjs';

const evaluate = (source, ...args) => evaluatePureProgram(parsePureProgram(source), args);

test('unfamiliar CommonJS functions become explicit IR without source comments or executable wrappers', () => {
  const source = `
    // PRIVATE_COMMENT_SHOULD_NOT_ENTER_PACKET
    const rate = 0.07;
    function fee(amount) {
      const raw = amount * rate;
      if (raw < 2) return 2;
      return Math.round(raw * 100) / 100;
    }
    module.exports = fee;
  `;
  const program = parsePureProgram(source);
  assert.equal(program.schemaVersion, 1);
  assert.equal(program.format, 'commonjs');
  assert.equal(program.name, 'fee');
  assert.deepEqual(program.parameters, ['amount']);
  assert.deepEqual(program.constants, [{ name: 'rate', value: { kind: 'literal', value: 0.07 } }]);
  assert.ok(program.stats.nodes > 0);
  assert.ok(program.stats.statements > 0);
  assert.ok(program.stats.expressions > 0);
  assert.doesNotMatch(JSON.stringify(program), /PRIVATE_COMMENT|module\.exports|FunctionDeclaration|sourceRange/);
  assert.equal(evaluatePureProgram(program, [10]), 2);
  assert.equal(evaluatePureProgram(program, [100]), 7);
  assert.equal(evaluatePureProgram(program, [123.45]), 8.64);
});

test('default function, arrow, and identifier exports preserve arithmetic and branch behavior', () => {
  for (const source of [
    'export default function clamp(value, lower, upper) { return Math.min(upper, Math.max(lower, value)); }',
    'export default (value, lower, upper) => value < lower ? lower : value > upper ? upper : value;',
    'function clamp(value, lower, upper) { if (value < lower) { return lower; } else if (value > upper) { return upper; } return value; } export default clamp;',
  ]) {
    const program = parsePureProgram(source);
    assert.equal(program.format, 'esm-default');
    assert.equal(evaluatePureProgram(program, [-8, -3, 5]), -3);
    assert.equal(evaluatePureProgram(program, [8, -3, 5]), 5);
    assert.equal(evaluatePureProgram(program, [2, -3, 5]), 2);
  }
  assert.equal(evaluate('module.exports = function (x) { return x * x + 3 * x - 1; };', 4), 27);
});

test('block scopes, const initialization order, and early returns match ordinary JavaScript', () => {
  const source = `const offset = 10;
    export default function compute(x) {
      const base = x + offset, twice = base * 2;
      if (x < 0) { const offset = 3; return base - offset; }
      { const base = twice + 1; if (x === 0) return base; }
      return base;
    }`;
  assert.equal(evaluate(source, -1), 6);
  assert.equal(evaluate(source, 0), 21);
  assert.equal(evaluate(source, 1), 11);
  assert.equal(evaluate('export default function (x) { if (x > 0) return; }', 1), undefined);
  assert.equal(evaluate('export default function (x) { if (x > 0) return; }', -1), undefined);
  assert.throws(() => evaluate('const x = 10; export default function (input) { const y = x; const x = 2; return y; }', 1),
    { name: 'ReferenceError', message: "Cannot access 'x' before initialization" });
  assert.equal(evaluate('module.exports = function same(same) { return same + 1; };', 2), 3);
  assert.equal(evaluate('module.exports = function same(x) { const same = x + 1; return same; };', 2), 3);
  assert.throws(() => parsePureProgram('const same = 7; module.exports = function same(x) { return same + x; };'), /self-references/);
});

test('logical and conditional expressions preserve short-circuiting and primitive values', () => {
  const and = 'export default function (x) { const value = x && later; const later = 3; return value; }';
  assert.equal(evaluate(and, 0), 0);
  assert.throws(() => evaluate(and, 1), { name: 'ReferenceError' });
  const or = 'export default function (x) { const value = x || later; const later = 3; return value; }';
  assert.equal(evaluate(or, 1), 1);
  assert.throws(() => evaluate(or, 0), { name: 'ReferenceError' });
  assert.equal(evaluate('export default x => (x > 0 ? null : -x) ?? 10;', 2), 10);
  assert.equal(evaluate('export default x => (x > 0 ? null : -x) ?? 10;', -2), 2);
  assert.equal(evaluate('export default x => x ? "yes" : false;', 0), false);
  assert.equal(evaluate('export default x => x ? "yes" : false;', 1), 'yes');
});

test('primitive coercion, unary, comparison, and bitwise operations retain their JavaScript meaning', () => {
  const cases = [
    ['x + "2"', 6, '62'], ['x - "2"', 6, 4], ['+"3" + x', 6, 9],
    ['x + null', 6, 6], ['true * x', 6, 6], ['x == "2"', 2, true],
    ['x === "2"', 2, false], ['x != "2"', 3, true], ['x !== "2"', 2, true],
    ['"10" < "2"', 0, true], ['x <= 2', 2, true], ['x >= 2', 2, true],
    ['x % 3', 8, 2], ['x ** 3', 2, 8], ['x | 3', 4, 7], ['x & 3', 6, 2],
    ['x ^ 3', 6, 5], ['x << 2', 3, 12], ['x >> 2', -12, -3], ['x >>> 0', -1, 4_294_967_295],
    ['~x', 2, -3], ['!x', 0, true], ['typeof x', 1, 'number'], ['void x', 1, undefined],
  ];
  for (const [expression, input, expected] of cases) {
    assert.equal(evaluate(`export default x => ${expression};`, input), expected, expression);
  }
});

test('only static allowed Math calls run, retaining rounding and exceptional number results', () => {
  const cases = [
    ['min', 'x, 10', 12, 10], ['max', 'x, -3', -12, -3], ['abs', 'x', -2, 2],
    ['round', 'x', -1.5, -1], ['floor', 'x', -1.5, -2], ['ceil', 'x', -1.5, -1],
    ['trunc', 'x', -1.5, -1], ['sqrt', 'x', 4, 2], ['pow', 'x, 3', 2, 8], ['sign', 'x', -2, -1],
  ];
  for (const [name, args, input, expected] of cases) {
    assert.equal(evaluate(`export default x => Math.${name}(${args});`, input), expected, name);
  }
  assert.ok(Object.is(evaluate('export default x => Math.round(x);', -0.1), -0));
  assert.ok(Object.is(evaluate('export default x => Math.sign(x);', -0), -0));
  assert.equal(evaluate('export default x => Math.min();', 0), Infinity);
  assert.equal(evaluate('export default x => Math.max();', 0), -Infinity);
  assert.ok(Number.isNaN(evaluate('export default x => Math.sqrt(-x);', 1)));
});

test('primitive encoding survives JSON without losing undefined, negative zero, or nonfinite values', () => {
  const cases = [
    [undefined, { type: 'undefined' }], [null, { type: 'null', value: null }],
    [true, { type: 'boolean', value: true }], ['text', { type: 'string', value: 'text' }],
    [12.5, { type: 'number', value: 12.5 }], [-0, { type: 'number', value: '-0' }],
    [NaN, { type: 'number', value: 'NaN' }], [Infinity, { type: 'number', value: 'Infinity' }],
    [-Infinity, { type: 'number', value: '-Infinity' }],
  ];
  for (const [value, expected] of cases) assert.deepEqual(JSON.parse(JSON.stringify(encodePureValue(value))), expected);
  for (const value of [[], {}, () => 1, 1n, Symbol('x')]) assert.throws(() => encodePureValue(value), /nonprimitive/);
  assert.deepEqual(encodePureValue(evaluate('const zero = -0; export default x => zero * x;', 1)), { type: 'number', value: '-0' });
});

test('serialized normalized IR preserves its behavior and excludes parser internals', () => {
  const program = parsePureProgram('const zero = -0; export default x => x < 0 ? zero : 1 / x;');
  const restored = JSON.parse(JSON.stringify(program));
  assert.ok(Object.is(evaluatePureProgram(restored, [-1]), -0));
  assert.equal(evaluatePureProgram(restored, [0]), Infinity);
  assert.equal(evaluatePureProgram(restored, [2]), 0.5);
});

test('no globals, arbitrary calls, property reads, computed Math calls, or shadowed Math enter the language', () => {
  const rejected = [
    'module.exports = x => require("node:fs");',
    'module.exports = x => process.exit(1);',
    'module.exports = x => globalThis;',
    'module.exports = x => console.log(x);',
    'module.exports = x => eval("1");',
    'module.exports = x => Function("return 1")();',
    'module.exports = x => x.constructor;',
    'module.exports = x => Math.PI;',
    'module.exports = x => Math["abs"](x);',
    'module.exports = x => Math.random();',
    'module.exports = x => Math.abs.call(null, x);',
    'module.exports = x => Math.max.constructor("return process")();',
    'module.exports = x => Math.abs(...x);',
    'module.exports = x => this;',
    'module.exports = x => arguments;',
    'module.exports = Math => Math.abs(1);',
    'const Math = 1; module.exports = x => x;',
    'module.exports = function Math(x) { return Math.abs(x); };',
    'module.exports = function (x) { const Math = 2; return x; };',
  ];
  for (const source of rejected) assert.throws(() => parsePureProgram(source), PureProgramError, source);
});

test('assignments, loops, mutation, objects, unsupported bindings and extra module code are refused', () => {
  const rejected = [
    'module.exports = x => x++;', 'module.exports = x => x = 1;',
    'module.exports = x => ({ value: x });', 'module.exports = x => [x];',
    'module.exports = x => `value ${x}`;', 'module.exports = x => new Number(x);',
    'module.exports = x => x in 1;', 'module.exports = x => x instanceof 1;',
    'module.exports = async x => x;', 'module.exports = function* (x) { return x; };',
    'module.exports = function (x) { while(x) {} return x; };',
    'module.exports = function (x) { for(;;) {} };',
    'module.exports = function (x) { let y = x; return y; };',
    'module.exports = function (x) { var y = x; return y; };',
    'module.exports = function (x) { throw x; };',
    'module.exports = function ({x}) { return x; };',
    'module.exports = function (x=1) { return x; };',
    'module.exports = function (...x) { return x; };',
    'module.exports = function (x) { const {a} = x; return a; };',
    'const fs = require("node:fs"); module.exports = x => x;',
    'import fs from "node:fs"; export default x => x;',
    'module.exports = 3;', 'exports.value = x => x;',
    'function extra(x) { return x; } module.exports = x => x;',
    'module.exports = x => x; module.exports = x => x+1;',
    'const coefficient = 1 + 2; module.exports = x => coefficient * x;',
    'const module = 1; module.exports = x => x;',
    'const require = 1; module.exports = x => require + x;',
    'function module(x) { return x; } module.exports = module;',
  ];
  for (const source of rejected) assert.throws(() => parsePureProgram(source), PureProgramError, source);
});

test('function arity and numeric argument domain are enforced before evaluation', () => {
  for (const source of ['export default () => 1;', 'export default (a,b,c,d,e) => a;', 'module.exports = function(a,a) { return a; };']) {
    assert.throws(() => parsePureProgram(source), PureProgramError);
  }
  const program = parsePureProgram('export default (a,b,c,d) => a+b+c+d;');
  assert.equal(evaluatePureProgram(program, [1, 2, 3, 4]), 10);
  for (const args of [[], [1], Array(4), [1, 2, 3, 4, 5], [1, 2, 3, NaN], [1, 2, 3, Infinity], [1, 2, 3, '4'], [1, 2, 3, null], [1, 2, 3, {}]]) {
    assert.throws(() => evaluatePureProgram(program, args), /finite numbers.*exact parameter count/);
  }
});

test('source bytes, AST nodes, nesting, strings, and evaluation steps have explicit bounds', () => {
  assert.throws(() => parsePureProgram(' '.repeat(PURE_PROGRAM_LIMITS.sourceBytes + 1)), /32 KiB/);
  assert.throws(() => parsePureProgram(null), /32 KiB/);
  const manyDeclarations = Array.from({ length: 600 }, (_, index) => `const v${index}=1;`).join('');
  assert.throws(() => parsePureProgram(`export default function(x) { ${manyDeclarations} return x; }`), /2000-node/);
  assert.throws(() => parsePureProgram(`export default x => ${'!'.repeat(130)}x;`), /nesting depth/);
  const doubling = Array.from({ length: 17 }, (_, index) => `const s${index + 1} = s${index} + s${index};`).join('');
  assert.throws(() => evaluate(`export default function(x) { const s0 = "a"; ${doubling} return s17; }`, 1), /string length/);
  assert.throws(() => encodePureValue('x'.repeat(PURE_PROGRAM_LIMITS.stringLength + 1)), /string length/);
  const program = parsePureProgram('export default x => x;');
  program.body.body = Array.from({ length: PURE_PROGRAM_LIMITS.evaluationSteps }, (_, index) => ({
    kind: 'const', declarations: [{ name: `v${index}`, value: { kind: 'literal', value: index } }],
  }));
  assert.throws(() => evaluatePureProgram(program, [1]), /step limit/);
  assert.throws(() => parsePureProgram('export default x => Math.max(' + Array(17).fill('x').join(',') + ');'), /16 arguments/);
});

test('invalid source and malformed normalized operations fail with clear errors', () => {
  assert.throws(() => parsePureProgram('export default function('), /Invalid JavaScript source/);
  assert.throws(() => parsePureProgram(''), /function export is required/);
  assert.throws(() => evaluatePureProgram({}, [1]), /parsed schema-version-1/);
  const program = parsePureProgram('export default x => x;');
  program.body.body[0].value = { kind: 'binary', operator: 'arbitrary-code', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 2 } };
  assert.throws(() => evaluatePureProgram(program, [1]), /Unsupported pure binary operator/);
});
