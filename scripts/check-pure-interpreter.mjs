#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodePureValue, evaluatePureProgram, parsePureProgram,
} from '../src/pure-program.mjs';

const MAX_CASES = 24_000;
const INPUTS = Object.freeze([
  -Number.MAX_VALUE, -9999, -1, -0, 0, 1, 1.5, 9999, Number.MAX_VALUE,
]);

/** Only these internally authored tokens can enter the native JS controls. */
function syntheticExpressions() {
  const leaves = ['x', '0', '-0', '"2"', 'true', 'false', 'null', 'void x', '0/0', '1/0'];
  const binary = [
    '+', '-', '*', '/', '%', '**', '<', '<=', '>', '>=', '==', '!=', '===', '!==',
    '|', '&', '^', '<<', '>>', '>>>', '&&', '||', '??',
  ];
  const expressions = [];
  for (const left of leaves) {
    for (const right of leaves) {
      for (const operator of binary) expressions.push(`(${left}) ${operator} (${right})`);
    }
  }
  for (const leaf of leaves) {
    for (const operator of ['+', '-', '!', '~', 'typeof ', 'void ']) {
      expressions.push(`${operator}(${leaf})`);
    }
  }
  for (const left of leaves) {
    for (const right of leaves) expressions.push(`x ? (${left}) : (${right})`);
  }
  for (const name of ['min', 'max', 'abs', 'round', 'floor', 'ceil', 'trunc', 'sqrt', 'pow', 'sign']) {
    for (const args of ['', ...leaves, ...leaves.map((leaf) => `x,(${leaf})`)]) {
      expressions.push(`Math.${name}(${args})`);
    }
  }
  // Keep a complete nine-input matrix within the fixed 24,000-case budget.
  // The omitted tail consists of redundant ignored second arguments to sign.
  return expressions.slice(0, Math.floor(MAX_CASES / INPUTS.length));
}

function outcome(call) {
  try { return encodePureValue(call()); }
  catch (error) { return { type: 'error', name: error.name, message: error.message }; }
}

/**
 * Development controls for the interpreter's JavaScript semantics. These are
 * synthetic expressions, never source from an application, file, CLI argument,
 * downloaded artifact, or generated project. Only the fixed whitelist above
 * reaches Function; the reconstruction pipeline does not call this script.
 */
export function checkPureInterpreter() {
  const expressions = syntheticExpressions();
  const mismatches = [];
  let cases = 0;
  let passed = 0;
  for (const expression of expressions) {
    const program = parsePureProgram(`module.exports = x => ${expression};`);
    const nativeControl = new Function('x', `return (${expression});`);
    for (const input of INPUTS) {
      const expected = outcome(() => nativeControl(input));
      const actual = outcome(() => evaluatePureProgram(program, [input]));
      cases += 1;
      if (JSON.stringify(expected) === JSON.stringify(actual)) passed += 1;
      else mismatches.push({ expression, input: encodePureValue(input), expected, actual });
    }
  }
  if (cases === 0 || cases > MAX_CASES) throw new Error('Synthetic control corpus violated its nonzero bounded case count.');
  return {
    kind: 'synthetic-interpreter-controls',
    expressions: expressions.length, cases, passed, failed: cases - passed,
    node: process.version,
    scope: 'Internally authored primitive operator, coercion, short-circuit, conditional, and allowed Math controls. These are interpreter checks, not original application comparisons.',
    ...(mismatches.length ? { mismatches } : {}),
  };
}

async function main(args) {
  let output;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--out' || !args[1]) {
      throw new Error('Usage: node scripts/check-pure-interpreter.mjs [--out <new.json>]');
    }
    output = resolve(args[1]);
  }
  const result = checkPureInterpreter();
  if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    kind: result.kind, expressions: result.expressions, cases: result.cases,
    passed: result.passed, failed: result.failed, ...(output ? { output } : {}),
  })}\n`);
  if (result.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
