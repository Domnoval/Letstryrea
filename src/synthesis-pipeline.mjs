import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parsePureProgram } from './pure-program.mjs';
import { buildSynthesisCases, compareSynthesisPrograms, parseSynthesisContract } from './synthesis-cases.mjs';
import { stringifySynthesis } from './synthesis-json.mjs';
import { exportSynthesisProject } from './synthesis-export.mjs';
import { generateWithCodex, runSynthesisProvider } from './synthesis-provider.mjs';
import { createProjectArchive } from './project-export.mjs';
import { requireCommandSuccess, runCommand } from './run-command.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const selectedSources = ['package.json', 'source.js'];
const manifest = '{"name":"synthesis-input","version":"0.0.0","private":true,"type":"commonjs","main":"source.js"}\n';
const MAX_SOURCE_BYTES = 32 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const limitations = [
  'Only the bounded pure numeric-function syntax accepted by the parser is supported; arbitrary applications are not supported.',
  'The original source is parsed as inert text and evaluated only by the bounded IR interpreter. Original JavaScript is never executed.',
  'REA provides static evidence with retained coverage and unknowns; it does not synthesize the candidate or prove behavioral equivalence.',
  'Passing a finite deterministic corpus is behavioral evidence, not a formal proof or a universal reconstruction claim.',
];

export class SynthesisInputError extends Error {
  name = 'SynthesisInputError';
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  return value;
}

function canonical(value) { return stringifySynthesis(ordered(value), 0); }
function requestIdentity(request) {
  const { requestId, ...payload } = request;
  return hash(canonical(payload));
}

function separate(input, output) {
  if (input === output || output.startsWith(input + sep) || input.startsWith(output + sep)) {
    throw new SynthesisInputError('Output must be a new directory separate from the input source.');
  }
}

async function prospectiveRealpath(path) {
  const missing = [];
  let existing = path;
  while (true) {
    try { return join(await realpath(existing), ...missing); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}

async function reserveOutput(input, output) {
  separate(resolve(input), output);
  separate(await prospectiveRealpath(resolve(input)), await prospectiveRealpath(output));
  await mkdir(dirname(output), { recursive: true });
  try { await mkdir(output); }
  catch (error) {
    if (error.code === 'EEXIST') throw new SynthesisInputError('Output already exists. Choose a new directory; existing files are never overwritten.');
    throw error;
  }
  return realpath(output);
}

async function readBounded(path, maximumBytes, label, { ordinary = false } = {}) {
  if (ordinary) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
      throw new Error(`${label} must be an ordinary retained file without symlinks.`);
    }
  }
  if (!(await stat(path)).isFile()) throw new Error(`${label} must be a regular file.`);
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > maximumBytes) throw new Error(`${label} exceeds its supported size or is not a regular file.`);
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const bytes = buffer.subarray(0, count);
    const after = await file.stat();
    if (bytes.length > maximumBytes || bytes.length !== before.size || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${label} changed while being read.`);
    return bytes;
  } finally { await file.close(); }
}

function decodeSource(bytes) { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }

async function saveReport(directory, report) {
  const temporary = join(directory, `.report-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(temporary, stringifySynthesis(report, 2) + '\n', { flag: 'wx' });
  await rename(temporary, join(directory, 'report.json'));
}

async function chooseRea(override) {
  if (override) return /[/\\]/.test(override) ? resolve(override) : override;
  for (const candidate of [resolve(projectRoot, 'tools/rea/node_modules/.bin/rea'), resolve(projectRoot, '../.onboarding/rea-tools/node_modules/.bin/rea')]) {
    try { await access(candidate); return candidate; } catch { /* Try the next runtime. */ }
  }
  return 'rea';
}

/** Bind fresh static analysis to this source without a target name or digest whitelist. */
export function verifySynthesisAnalysis(evidence, { sourceSha256, format }) {
  const normalized = evidence?.normalized_result;
  const directorySha256 = evidence?.subject?.digest?.sha256;
  const nodes = Array.isArray(normalized?.graph?.nodes) ? normalized.graph.nodes : [];
  const modules = nodes.filter((node) => node?.identity?.namespace === 'source-module');
  const source = modules[0];
  const observation = Array.isArray(source?.observations) ? source.observations.find((item) => item?.properties?.semantic_role === 'source-module') : undefined;
  const properties = observation?.properties;
  const exports = nodes.filter((node) => node?.identity?.namespace === 'module-export');
  const exported = exports[0];
  const binding = Array.isArray(exported?.observations) ? exported.observations.find((item) => item?.properties?.semantic_role === 'export-binding') : undefined;
  const semantics = normalized?.semantic_graph;
  const semanticModules = Array.isArray(semantics?.nodes) ? semantics.nodes.filter((node) => node?.kind === 'module') : [];
  const observedSource = (item) => item?.evidence?.artifact?.sha256 === sourceSha256 && item.evidence.location?.value?.source === 'source.js';
  const moduleFormat = format === 'commonjs' ? 'commonjs' : 'esm';
  if (!digest(sourceSha256) || !digest(directorySha256) || !/^ev_[a-f0-9]{64}$/.test(evidence?.evidence_id ?? '') ||
      evidence.operation !== 'analyze_javascript_application' || evidence.subject?.format !== 'directory' ||
      normalized?.format !== 'directory' || normalized.root_artifact_sha256 !== directorySha256 ||
      !isDeepStrictEqual(normalized.source_selection?.requested_paths, selectedSources) ||
      normalized.statistics?.parse_failures !== 0 || normalized.statistics?.invalid_utf8_files !== 0 ||
      normalized.statistics?.parsed_javascript_files !== 1 || normalized.statistics?.relevant_files !== 2 ||
      !Array.isArray(normalized.integrity_contradictions) || normalized.integrity_contradictions.length ||
      modules.length !== 1 || source.identity.artifact_sha256 !== sourceSha256 || source.identity.key !== `${directorySha256}:source.js` ||
      properties?.path !== 'source.js' || properties.container_sha256 !== directorySha256 || properties.module_format !== moduleFormat ||
      !isDeepStrictEqual(properties.export_names, ['default']) || !observedSource(observation) ||
      exports.length !== 1 || exported.identity.artifact_sha256 !== sourceSha256 ||
      exported.identity.key !== JSON.stringify([directorySha256, 'source.js', 'default']) ||
      binding?.properties?.module_path !== 'source.js' || binding.properties.exported_name !== 'default' || !observedSource(binding) ||
      semantics?.root_artifact_sha256 !== directorySha256 || semanticModules.length !== 1 ||
      semanticModules[0].identity?.artifact_sha256 !== sourceSha256 || semanticModules[0].identity?.module_path !== 'source.js' ||
      !Array.isArray(semantics.unknowns)) {
    throw new Error('REA synthesis Evidence does not match the retained source, directory, or default export.');
  }
  return {
    evidenceId: evidence.evidence_id, sourceSha256, directorySha256,
    coverage: { application: normalized.graph.coverage?.status ?? 'unknown', semantic: semantics.coverage?.status ?? 'unknown' },
    unknowns: semantics.unknowns,
  };
}

function baseReport(directory) {
  return { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), outputDirectory: directory,
    commands: [], originalSourceExecution: false, limitations: [...limitations] };
}

/** Prepare a verifiable synthesis request; invoke a model only when requested. */
export async function prepareSynthesis({ input, contract, output, rea, provider, generator, notice }) {
  if (typeof input !== 'string' || typeof output !== 'string') throw new SynthesisInputError('Provide an input JavaScript file and a new output directory.');
  if (provider && generator) throw new SynthesisInputError('Choose either a provider or a generator executable.');
  if (provider && provider !== 'codex') throw new SynthesisInputError('The supported provider is codex.');
  const directory = await reserveOutput(input, resolve(output));
  const report = baseReport(directory);
  try {
    const sourceBytes = await readBounded(await realpath(resolve(input)), MAX_SOURCE_BYTES, 'Input source');
    const source = decodeSource(sourceBytes);
    const sourceSha256 = hash(sourceBytes);
    report.input = { name: basename(input), sha256: sourceSha256, bytes: sourceBytes.length };
    let program;
    try { program = parsePureProgram(source); }
    catch (error) {
      report.status = 'unsupported'; report.error = error.message; report.finishedAt = new Date().toISOString();
      await saveReport(directory, report);
      return { report, exitCode: 3 };
    }
    const contractValue = typeof contract === 'string' ? JSON.parse(decodeSource(await readBounded(resolve(contract), 256 * 1024, 'Synthesis contract'))) : contract;
    const parsedContract = parseSynthesisContract(contractValue, program.parameters.length);
    const corpus = buildSynthesisCases(program, parsedContract);
    const evidenceDirectory = join(directory, 'evidence');
    const inputDirectory = join(evidenceDirectory, 'input');
    await mkdir(inputDirectory, { recursive: true });
    await writeFile(join(inputDirectory, 'source.js'), sourceBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(inputDirectory, 'package.json'), manifest, { flag: 'wx', mode: 0o600 });
    const executable = await chooseRea(rea);
    async function command(label, args, name, timeoutMs) {
      const run = await runCommand({ executable, args, cwd: directory, timeoutMs,
        stdoutPath: join(evidenceDirectory, name), stderrPath: join(evidenceDirectory, `${name}.stderr`) });
      report.commands.push(run); requireCommandSuccess(run, label);
    }
    await command('REA version check', ['--version'], 'rea-version.txt', 30000);
    const version = (await readFile(join(evidenceDirectory, 'rea-version.txt'), 'utf8')).trim();
    if (version !== '6.5.0') throw new Error(`This pipeline requires REA 6.5.0; received ${version}.`);
    report.analyzer = { name: 'rea-agents', version };
    await command('REA source analysis', ['analyze-javascript-application', inputDirectory, '--artifact-format', 'directory',
      '--source-path', 'package.json', '--source-path', 'source.js', '--integrity-policy', 'fail',
      '--max-heap-mb', '1024', '--analysis-timeout-ms', '120000', '--json'], 'application.json', 180000);
    const analysisBytes = await readBounded(join(evidenceDirectory, 'application.json'), 128 * 1024 * 1024, 'REA analysis', { ordinary: true });
    const analysis = { ...verifySynthesisAnalysis(JSON.parse(analysisBytes), { sourceSha256, format: program.format }), evidenceSha256: hash(analysisBytes) };
    const noticeText = notice === undefined ? undefined : decodeSource(await readBounded(resolve(notice), 16 * 1024, 'Source notice'));
    const payload = { schemaVersion: 1, input: { name: basename(input), sha256: sourceSha256 }, source, program,
      analysis, contract: parsedContract, corpus, ...(noticeText === undefined ? {} : { notice: noticeText, noticeSha256: hash(noticeText) }) };
    const request = { ...payload, requestId: hash(canonical(payload)) };
    const requestPath = join(directory, 'synthesis-request.json');
    const requestBytes = canonical(request) + '\n';
    await writeFile(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
    report.requestPath = requestPath;
    report.requestId = request.requestId;
    report.requestSha256 = hash(requestBytes);
    report.analysis = { ...analysis, unknowns: analysis.unknowns.length };
    report.corpus = { training: corpus.training.length, validation: corpus.validation.length, total: corpus.all.length, sha256: corpus.corpusSha256 };
    report.status = 'awaiting-generation';
    report.finishedAt = new Date().toISOString();
    await saveReport(directory, report);
    if (!provider && !generator) return { report, exitCode: 0 };
    const workspace = join(directory, 'provider');
    await mkdir(workspace);
    const result = provider === 'codex' ? await generateWithCodex({ request, workspace }) : await runSynthesisProvider({ request, workspace, executable: generator });
    report.providerReceipt = result.receipt;
    await saveReport(directory, report);
    return completeSynthesis({ job: directory, response: result.response, mode: 'provider-generated' });
  } catch (error) {
    report.status = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString();
    if (error.receipt) report.providerReceipt = error.receipt;
    if (error.code) report.failureCode = error.code;
    await saveReport(directory, report);
    return { report, exitCode: error instanceof SynthesisInputError ? 2 : 1 };
  }
}

async function retainedRequest(directory) {
  const requestPath = join(directory, 'synthesis-request.json');
  const requestBytes = await readBounded(requestPath, 8 * 1024 * 1024, 'Synthesis request', { ordinary: true });
  const request = JSON.parse(requestBytes);
  if (request.schemaVersion !== 1 || !digest(request.requestId) || requestIdentity(request) !== request.requestId) throw new Error('Synthesis request identity does not match its contents.');
  if (request.notice !== undefined && (typeof request.notice !== 'string' || Buffer.byteLength(request.notice) > 16 * 1024 || hash(request.notice) !== request.noticeSha256)) {
    throw new Error('Source notice does not match its retained identity.');
  }
  const sourceBytes = await readBounded(join(directory, 'evidence/input/source.js'), MAX_SOURCE_BYTES, 'Retained input source', { ordinary: true });
  const source = decodeSource(sourceBytes);
  if (hash(sourceBytes) !== request.input?.sha256 || request.source !== source) throw new Error('Retained input source does not match the synthesis request.');
  if (decodeSource(await readBounded(join(directory, 'evidence/input/package.json'), 1024, 'Retained input manifest', { ordinary: true })) !== manifest) {
    throw new Error('Retained input manifest changed after analysis.');
  }
  const program = parsePureProgram(source);
  if (canonical(program) !== canonical(request.program)) throw new Error('Retained source program does not match the synthesis request IR.');
  const contract = parseSynthesisContract(request.contract, program.parameters.length);
  const corpus = buildSynthesisCases(program, contract);
  if (canonical(corpus) !== canonical(request.corpus)) throw new Error('Retained synthesis corpus does not match the source and contract.');
  const evidenceBytes = await readBounded(join(directory, 'evidence/application.json'), 128 * 1024 * 1024, 'Retained REA analysis', { ordinary: true });
  if (hash(evidenceBytes) !== request.analysis?.evidenceSha256) throw new Error('Retained REA analysis hash does not match the synthesis request.');
  const analysis = { ...verifySynthesisAnalysis(JSON.parse(evidenceBytes), { sourceSha256: request.input.sha256, format: program.format }), evidenceSha256: hash(evidenceBytes) };
  if (canonical(analysis) !== canonical(request.analysis)) throw new Error('Retained REA analysis identity does not match the synthesis request.');
  return { request, requestPath, requestSha256: hash(requestBytes), program, corpus };
}

function passingTests(tap) {
  const result = {};
  for (const item of tap.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) result[item[1]] = Number(item[2]);
  if (!(result.tests > 0) || result.pass !== result.tests || ['fail', 'cancelled', 'skipped', 'todo'].some((key) => result[key] !== 0)) {
    throw new Error('Generated project did not execute a nonzero complete passing test suite.');
  }
  return result;
}

/** Complete one generation attempt without executing the original JavaScript. */
export async function completeSynthesis({ job, response, mode = 'chat-assisted' }) {
  if (typeof job !== 'string' || !['chat-assisted', 'provider-generated'].includes(mode)) throw new SynthesisInputError('Provide a synthesis job and a supported generation mode.');
  const info = await lstat(resolve(job));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SynthesisInputError('Synthesis job must be an ordinary directory.');
  const directory = await realpath(resolve(job));
  const report = baseReport(directory);
  report.mode = mode;
  report.requestPath = join(directory, 'synthesis-request.json');
  let attempt;
  try {
    try {
      const previous = JSON.parse(await readBounded(join(directory, 'report.json'), 4 * 1024 * 1024, 'Previous synthesis report', { ordinary: true }));
      report.commands = Array.isArray(previous.commands) ? previous.commands.filter((command) => command.cwd === directory) : [];
      if (previous.analyzer) report.analyzer = previous.analyzer;
      if (previous.providerReceipt) report.providerReceipt = previous.providerReceipt;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const attempts = join(directory, 'attempts');
    try { await mkdir(attempts); }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await lstat(attempts)).isDirectory() || await realpath(attempts) !== attempts) throw error;
    }
    attempt = await mkdtemp(join(attempts, 'attempt-'));
    report.attemptDirectory = attempt;
    const retained = await retainedRequest(directory);
    const { request, program, corpus } = retained;
    report.requestId = request.requestId;
    report.requestSha256 = retained.requestSha256;
    report.input = request.input;
    report.analysis = { ...request.analysis, unknowns: request.analysis.unknowns.length };
    let candidate = typeof response === 'string' ? JSON.parse(decodeSource(await readBounded(resolve(response), 256 * 1024, 'Candidate response'))) : response;
    const responseKeys = ['schemaVersion', 'requestId', 'source', 'summary', 'limitations'];
    if (!candidate || Array.isArray(candidate) || Object.keys(candidate).length !== responseKeys.length || responseKeys.some((key) => !Object.hasOwn(candidate, key)) ||
        candidate.schemaVersion !== 1 || candidate.requestId !== request.requestId ||
        typeof candidate.source !== 'string' || !candidate.source.trim() || Buffer.byteLength(candidate.source) > MAX_SOURCE_BYTES ||
        typeof candidate.summary !== 'string' || !candidate.summary.trim() || Buffer.byteLength(candidate.summary) > 4096 ||
        !Array.isArray(candidate.limitations) || candidate.limitations.length > 32 || candidate.limitations.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 2048)) {
      throw new Error('Candidate response must match the request ID and provide schemaVersion 1, bounded source, summary, and limitations.');
    }
    // Snapshot supplied data before any interpreter or generated-project work.
    candidate = JSON.parse(stringifySynthesis(candidate));
    await writeFile(join(attempt, 'response.json'), stringifySynthesis(candidate, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const candidateProgram = parsePureProgram(candidate.source);
    if (candidateProgram.format !== 'esm-default' || candidateProgram.parameters.length !== program.parameters.length) {
      throw new Error('Candidate must be an ESM default pure function with the same parameter arity as the input.');
    }
    const comparison = compareSynthesisPrograms(program, candidateProgram, corpus);
    const comparisonPath = join(attempt, 'comparison.json');
    await writeFile(comparisonPath, stringifySynthesis(comparison, 2) + '\n', { flag: 'wx' });
    report.verification = { comparison: { passed: comparison.passedCount, total: comparison.total, failed: comparison.failed,
      trainingPassed: comparison.trainingPassed, validationPassed: comparison.validationPassed }, interpreter: 'bounded-pure-program-ir' };
    if (comparison.passed !== true || !(comparison.total > 0) || comparison.total !== corpus.all.length || comparison.passedCount !== comparison.total || comparison.failed !== 0 ||
        comparison.trainingPassed !== corpus.training.length || comparison.validationPassed !== corpus.validation.length ||
        !Array.isArray(comparison.observations) || comparison.observations.length !== comparison.total || !comparison.observations.every((item) => item.passed)) {
      throw new Error('Candidate differs from the original IR on the deterministic synthesis corpus.');
    }
    const candidateSha256 = hash(candidate.source);
    report.generation = { mode, candidateSha256, summary: candidate.summary, limitations: candidate.limitations };
    const provenance = { requestId: request.requestId, inputSha256: request.input.sha256, sourceSha256: request.input.sha256,
      candidateSha256, analysisSha256: request.analysis.evidenceSha256, requestSha256: retained.requestSha256,
      corpusSha256: corpus.corpusSha256, mode, evidenceId: request.analysis.evidenceId, coverage: request.analysis.coverage.semantic,
      trainingCases: corpus.training.length, validationCases: corpus.validation.length, semanticUnknowns: request.analysis.unknowns.length };
    const generated = join(attempt, 'project');
    await mkdir(generated);
    report.manifest = await exportSynthesisProject({ destination: generated, source: candidate.source, cases: corpus.all, provenance, notice: request.notice });
    const publicCorpus = report.manifest.files.find((file) => file.path === 'test/cases.json');
    if (!publicCorpus || hash(await readBounded(join(generated, 'test/cases.json'), 4 * 1024 * 1024, 'Exported public corpus', { ordinary: true })) !== publicCorpus.sha256) {
      throw new Error('Exported public corpus does not match its generated manifest.');
    }
    report.verification.publicCorpus = { path: publicCorpus.path, sha256: publicCorpus.sha256, cases: corpus.all.length };
    const run = await runCommand({ executable: process.execPath, args: ['--test', '--test-reporter=tap', 'test/behavior.test.mjs'], cwd: generated,
      stdoutPath: join(attempt, 'project-tests.tap'), stderrPath: join(attempt, 'project-tests.stderr'), timeoutMs: 120000 });
    report.commands.push(run);
    requireCommandSuccess(run, 'Generated synthesis project tests');
    report.verification.generatedProject = passingTests(await readFile(join(attempt, 'project-tests.tap'), 'utf8'));
    report.archive = await createProjectArchive({ projectDirectory: generated, archivePath: join(attempt, 'project.zip'), recipeId: 'pure-function-synthesis-v1' });
    report.status = 'completed';
    report.finishedAt = new Date().toISOString();
    await writeFile(join(attempt, 'report.json'), stringifySynthesis(report, 2) + '\n', { flag: 'wx' });
    await saveReport(directory, report);
    return { report, exitCode: 0 };
  } catch (error) {
    report.status = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString();
    if (attempt) await writeFile(join(attempt, 'report.json'), stringifySynthesis(report, 2) + '\n', { flag: 'wx' });
    await saveReport(directory, report);
    return { report, exitCode: error instanceof SynthesisInputError ? 2 : 1 };
  }
}
