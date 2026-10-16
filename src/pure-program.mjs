import { createRequire } from 'node:module';

const requireTool = createRequire(new URL('../tools/rea/package.json', import.meta.url));
let parseJavaScript;

export const PURE_PROGRAM_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024,
  parameters: 4,
  nodes: 2000,
  depth: 128,
  evaluationSteps: 10_000,
  stringLength: 65_536,
  mathArguments: 16,
});

const unaryOperators = new Set(['+', '-', '!', '~', 'typeof', 'void']);
const binaryOperators = new Set([
  '+', '-', '*', '/', '%', '**', '<', '<=', '>', '>=', '==', '!=', '===', '!==',
  '|', '&', '^', '<<', '>>', '>>>',
]);
const logicalOperators = new Set(['&&', '||', '??']);
const mathFunctions = Object.freeze({
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sqrt: Math.sqrt,
  pow: Math.pow,
  sign: Math.sign,
});
const uninitialized = Symbol('uninitialized pure binding');

export class PureProgramError extends Error {
  name = 'PureProgramError';
}

function unsupported(message) {
  throw new PureProgramError(message);
}

function requireDepth(depth) {
  if (depth > PURE_PROGRAM_LIMITS.depth) unsupported('Pure program exceeds the supported nesting depth.');
}

function identifier(node, label) {
  if (node?.type !== 'Identifier') unsupported(`${label} must be a plain identifier.`);
  if (node.name === 'Math') unsupported('Bindings named Math would shadow the allowed built-in and are unsupported.');
  return node.name;
}

function isFunction(node) {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);
}

function isExportAssignment(node) {
  const left = node?.left;
  return node?.type === 'AssignmentExpression' && node.operator === '=' &&
    left?.type === 'MemberExpression' && !left.computed && !left.optional &&
    left.object?.type === 'Identifier' && left.object.name === 'module' &&
    left.property?.type === 'Identifier' && left.property.name === 'exports';
}

function countNodes(ast) {
  const pending = [ast];
  let count = 0;
  while (pending.length) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    if (typeof node.type === 'string') {
      count += 1;
      if (count > PURE_PROGRAM_LIMITS.nodes) unsupported('Pure program exceeds the 2000-node syntax limit.');
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'errors'].includes(key)) continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value !== null && typeof value === 'object') pending.push(value);
    }
  }
  return count;
}

function literal(node) {
  if (['NumericLiteral', 'BooleanLiteral', 'StringLiteral', 'NullLiteral'].includes(node?.type)) {
    const value = node.type === 'NullLiteral' ? null : node.value;
    if (typeof value === 'number' && !Number.isFinite(value)) unsupported('Numeric literals must be finite.');
    return { kind: 'literal', value };
  }
  return null;
}

function constantExpression(node, depth = 0) {
  requireDepth(depth);
  const value = literal(node);
  if (value) return value;
  if (node?.type === 'UnaryExpression' && unaryOperators.has(node.operator)) {
    return { kind: 'unary', operator: node.operator, argument: constantExpression(node.argument, depth + 1) };
  }
  unsupported('Top-level constants must contain only primitive literals or unary literal expressions.');
}

/** Parse inert source into a small, explicit language; source is never loaded. */
export function parsePureProgram(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > PURE_PROGRAM_LIMITS.sourceBytes) {
    unsupported('Pure source must be a UTF-8 string no larger than 32 KiB.');
  }
  if (!parseJavaScript) {
    try { parseJavaScript = requireTool('@babel/parser').parse; }
    catch (error) {
      throw new PureProgramError('The pinned @babel/parser tool is unavailable; run npm run setup:environment.', { cause: error });
    }
  }
  let ast;
  try { ast = parseJavaScript(source, { sourceType: 'unambiguous', attachComment: false }); }
  catch (error) { unsupported(`Invalid JavaScript source: ${error.message}`); }
  const nodes = countNodes(ast);
  const topStatements = ast.program.body.filter((node) => node.type !== 'EmptyStatement');
  const declarations = [];
  const constants = [];
  const constantNames = new Set();
  let exported;
  let format;
  for (const node of topStatements) {
    if (node.type === 'FunctionDeclaration') {
      declarations.push(node);
    } else if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const declaration of node.declarations) {
        const name = identifier(declaration.id, 'Top-level constant');
        if (constantNames.has(name)) unsupported(`Duplicate constant binding ${name}.`);
        constantNames.add(name);
        constants.push({ name, value: constantExpression(declaration.init) });
      }
    } else if (node.type === 'ExportDefaultDeclaration' ||
        (node.type === 'ExpressionStatement' && isExportAssignment(node.expression))) {
      if (exported) unsupported('Exactly one default or module.exports function is supported.');
      exported = node.type === 'ExportDefaultDeclaration' ? node.declaration : node.expression.right;
      format = node.type === 'ExportDefaultDeclaration' ? 'esm-default' : 'commonjs';
    } else {
      unsupported(`Unsupported top-level ${node.type}; only literal constants and one exported function are allowed.`);
    }
  }
  if (!exported) unsupported('A single default or module.exports function export is required.');
  if (format === 'commonjs' &&
      (['module', 'exports', 'require', '__filename', '__dirname'].some((name) => constantNames.has(name)) ||
       declarations.some((declaration) => declaration.id?.name === 'module'))) {
    unsupported('CommonJS wrapper bindings must not be redeclared or shadow the module.exports receiver.');
  }
  let fn;
  if (exported.type === 'Identifier') {
    if (declarations.length !== 1 || declarations[0].id?.name !== exported.name) {
      unsupported('An exported identifier must select the only named function declaration.');
    }
    fn = declarations[0];
  } else {
    if (!isFunction(exported) || declarations.length) unsupported('Exactly one exported function is supported.');
    fn = exported;
  }
  if (fn.async || fn.generator) unsupported('Async and generator functions are unsupported.');
  if (fn.id?.name === 'Math') unsupported('A function named Math would shadow the allowed built-in.');
  if (fn.params.length < 1 || fn.params.length > PURE_PROGRAM_LIMITS.parameters) unsupported('Pure functions require between one and four parameters.');
  const parameters = fn.params.map((node) => identifier(node, 'Function parameter'));
  if (new Set(parameters).size !== parameters.length) unsupported('Function parameters must be distinct.');
  // A named function's self-binding shadows outer constants, but it is a
  // function value outside this primitive language. Parameters and local
  // constants may themselves shadow that self-binding with primitive values.
  const functionSelfScope = new Set(fn.id ? [fn.id.name] : []);
  const scopes = [constantNames, functionSelfScope, new Set(parameters)];
  const stats = { nodes, statements: 0, expressions: 0 };

  function expression(node, depth = 0) {
    requireDepth(depth);
    stats.expressions += 1;
    const value = literal(node);
    if (value) return value;
    if (node?.type === 'Identifier') {
      const scope = scopes.findLast((item) => item.has(node.name));
      if (!scope) unsupported(`Unbound identifier ${node.name} is unsupported.`);
      if (scope === functionSelfScope) unsupported('Function self-references are outside the supported primitive language.');
      return { kind: 'identifier', name: node.name };
    }
    if (node?.type === 'UnaryExpression' && unaryOperators.has(node.operator)) {
      return { kind: 'unary', operator: node.operator, argument: expression(node.argument, depth + 1) };
    }
    if (node?.type === 'BinaryExpression' && binaryOperators.has(node.operator)) {
      return { kind: 'binary', operator: node.operator, left: expression(node.left, depth + 1), right: expression(node.right, depth + 1) };
    }
    if (node?.type === 'LogicalExpression' && logicalOperators.has(node.operator)) {
      return { kind: 'logical', operator: node.operator, left: expression(node.left, depth + 1), right: expression(node.right, depth + 1) };
    }
    if (node?.type === 'ConditionalExpression') {
      return { kind: 'conditional', test: expression(node.test, depth + 1),
        consequent: expression(node.consequent, depth + 1), alternate: expression(node.alternate, depth + 1) };
    }
    if (node?.type === 'CallExpression') {
      const callee = node.callee;
      const name = callee?.property?.name;
      if (node.optional || callee?.type !== 'MemberExpression' || callee.computed || callee.optional ||
          callee.object?.type !== 'Identifier' || callee.object.name !== 'Math' ||
          callee.property?.type !== 'Identifier' || !Object.hasOwn(mathFunctions, name)) {
        unsupported('Only the documented static Math function calls are supported.');
      }
      if (node.arguments.length > PURE_PROGRAM_LIMITS.mathArguments) unsupported('Math calls support at most 16 arguments.');
      return { kind: 'math-call', name, arguments: node.arguments.map((argument) => expression(argument, depth + 1)) };
    }
    unsupported(`Unsupported pure expression ${node?.type ?? 'missing'}${node?.operator ? ` (${node.operator})` : ''}.`);
  }

  function predeclare(body, scope) {
    for (const node of body) {
      if (node.type !== 'VariableDeclaration') continue;
      if (node.kind !== 'const') unsupported('Only const local declarations are supported.');
      for (const declaration of node.declarations) {
        const name = identifier(declaration.id, 'Local constant');
        if (scope.has(name)) unsupported(`Duplicate local binding ${name}.`);
        scope.add(name);
      }
    }
  }

  function block(node, depth = 0, functionBody = false) {
    requireDepth(depth);
    const scope = functionBody ? scopes.at(-1) : new Set();
    if (!functionBody) scopes.push(scope);
    predeclare(node.body, scope);
    const body = node.body.filter((item) => item.type !== 'EmptyStatement').map((item) => statement(item, depth + 1));
    if (!functionBody) scopes.pop();
    return { kind: 'block', body };
  }

  function statement(node, depth = 0) {
    requireDepth(depth);
    stats.statements += 1;
    if (node.type === 'BlockStatement') return block(node, depth + 1);
    if (node.type === 'ReturnStatement') return { kind: 'return', value: node.argument ? expression(node.argument, depth + 1) : null };
    if (node.type === 'IfStatement') return { kind: 'if', test: expression(node.test, depth + 1),
      consequent: statement(node.consequent, depth + 1), alternate: node.alternate ? statement(node.alternate, depth + 1) : null };
    if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      return { kind: 'const', declarations: node.declarations.map((declaration) => {
        const name = identifier(declaration.id, 'Local constant');
        if (!declaration.init) unsupported('Local constants require an initializer.');
        return { name, value: expression(declaration.init, depth + 1) };
      }) };
    }
    unsupported(`Unsupported pure statement ${node.type}.`);
  }

  const body = fn.body.type === 'BlockStatement'
    ? block(fn.body, 0, true)
    : { kind: 'block', body: [{ kind: 'return', value: expression(fn.body, 2) }] };
  if (fn.body.type !== 'BlockStatement') stats.statements += 1;
  return { schemaVersion: 1, format, name: fn.id?.name ?? 'reconstructed', parameters, constants, body, stats };
}

function primitive(value) {
  if (value !== null && !['undefined', 'number', 'string', 'boolean'].includes(typeof value)) {
    unsupported('Pure evaluation produced an unsupported nonprimitive value.');
  }
  if (typeof value === 'string' && value.length > PURE_PROGRAM_LIMITS.stringLength) {
    unsupported('Pure evaluation exceeds the supported string length.');
  }
  return value;
}

/** Evaluate only the explicit normalized IR, never JavaScript source or AST. */
export function evaluatePureProgram(program, args) {
  if (program?.schemaVersion !== 1 || !Array.isArray(program.parameters) ||
      program.parameters.length < 1 || program.parameters.length > PURE_PROGRAM_LIMITS.parameters ||
      !Array.isArray(program.constants) || program.constants.length > PURE_PROGRAM_LIMITS.nodes || program.body?.kind !== 'block') {
    unsupported('A parsed schema-version-1 pure program is required.');
  }
  if (!Array.isArray(args) || args.length !== program.parameters.length || Array.from(args).some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    unsupported('Pure arguments must be finite numbers matching the exact parameter count.');
  }
  let steps = 0;
  const scopes = [new Map(program.constants.map(({ name }) => [name, uninitialized])),
    new Map(program.parameters.map((name, index) => [name, args[index]]))];
  function step(depth) {
    requireDepth(depth);
    steps += 1;
    if (steps > PURE_PROGRAM_LIMITS.evaluationSteps) unsupported('Pure evaluation exceeded its step limit.');
  }
  function read(name) {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (!scopes[index].has(name)) continue;
      const value = scopes[index].get(name);
      if (value === uninitialized) throw new ReferenceError(`Cannot access '${name}' before initialization`);
      return value;
    }
    unsupported(`Unbound pure identifier ${name}.`);
  }
  function expression(node, depth = 0) {
    step(depth);
    if (node?.kind === 'literal') return primitive(node.value);
    if (node?.kind === 'identifier') return read(node.name);
    if (node?.kind === 'unary') {
      const value = expression(node.argument, depth + 1);
      switch (node.operator) {
        case '+': return +value;
        case '-': return -value;
        case '!': return !value;
        case '~': return ~value;
        case 'typeof': return typeof value;
        case 'void': return undefined;
        default: unsupported('Unsupported pure unary operator.');
      }
    }
    if (node?.kind === 'logical') {
      const left = expression(node.left, depth + 1);
      if (node.operator === '&&') return left ? expression(node.right, depth + 1) : left;
      if (node.operator === '||') return left ? left : expression(node.right, depth + 1);
      if (node.operator === '??') return left === null || left === undefined ? expression(node.right, depth + 1) : left;
      unsupported('Unsupported pure logical operator.');
    }
    if (node?.kind === 'conditional') {
      return expression(expression(node.test, depth + 1) ? node.consequent : node.alternate, depth + 1);
    }
    if (node?.kind === 'binary') {
      const left = expression(node.left, depth + 1);
      const right = expression(node.right, depth + 1);
      switch (node.operator) {
        case '+': {
          if ((typeof left === 'string' || typeof right === 'string') &&
              String(left).length + String(right).length > PURE_PROGRAM_LIMITS.stringLength) {
            unsupported('Pure evaluation exceeds the supported string length.');
          }
          return primitive(left + right);
        }
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '**': return left ** right;
        case '<': return left < right;
        case '<=': return left <= right;
        case '>': return left > right;
        case '>=': return left >= right;
        case '==': return left == right;
        case '!=': return left != right;
        case '===': return left === right;
        case '!==': return left !== right;
        case '|': return left | right;
        case '&': return left & right;
        case '^': return left ^ right;
        case '<<': return left << right;
        case '>>': return left >> right;
        case '>>>': return left >>> right;
        default: unsupported('Unsupported pure binary operator.');
      }
    }
    if (node?.kind === 'math-call' && Object.hasOwn(mathFunctions, node.name) &&
        Array.isArray(node.arguments) && node.arguments.length <= PURE_PROGRAM_LIMITS.mathArguments) {
      return primitive(mathFunctions[node.name](...node.arguments.map((argument) => expression(argument, depth + 1))));
    }
    unsupported(`Unsupported normalized pure expression ${node?.kind}.`);
  }
  function block(node, depth = 0, functionBody = false) {
    step(depth);
    if (!Array.isArray(node.body)) unsupported('Malformed pure block.');
    const scope = functionBody ? scopes.at(-1) : new Map();
    if (!functionBody) scopes.push(scope);
    for (const item of node.body) {
      if (item.kind !== 'const') continue;
      for (const declaration of item.declarations) {
        if (scope.has(declaration.name)) unsupported('Duplicate normalized pure binding.');
        scope.set(declaration.name, uninitialized);
      }
    }
    try {
      for (const item of node.body) {
        const result = statement(item, depth + 1);
        if (result) return result;
      }
      return null;
    } finally { if (!functionBody) scopes.pop(); }
  }
  function statement(node, depth = 0) {
    step(depth);
    if (node?.kind === 'block') return block(node, depth + 1);
    if (node?.kind === 'return') return { value: node.value === null ? undefined : expression(node.value, depth + 1) };
    if (node?.kind === 'if') {
      const branch = expression(node.test, depth + 1) ? node.consequent : node.alternate;
      return branch ? statement(branch, depth + 1) : null;
    }
    if (node?.kind === 'const' && Array.isArray(node.declarations)) {
      for (const declaration of node.declarations) {
        if (!scopes.at(-1).has(declaration.name)) unsupported('Undeclared normalized pure binding.');
        scopes.at(-1).set(declaration.name, expression(declaration.value, depth + 1));
      }
      return null;
    }
    unsupported(`Unsupported normalized pure statement ${node?.kind}.`);
  }
  for (const declaration of program.constants) {
    scopes[0].set(declaration.name, expression(declaration.value));
  }
  return primitive(block(program.body, 0, true)?.value);
}

/** Preserve primitive results across JSON, including values JSON cannot encode. */
export function encodePureValue(value) {
  primitive(value);
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
    if (value === Infinity) return { type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { type: 'number', value: '-0' };
  }
  return { type: value === null ? 'null' : typeof value, value };
}
