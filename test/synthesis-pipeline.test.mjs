import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { completeSynthesis, prepareSynthesis, SynthesisInputError, verifySynthesisAnalysis } from '../src/synthesis-pipeline.mjs';
import { stringifySynthesis } from '../src/synthesis-json.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = 'module.exports = function original(value) { return value * 2 + 1; };\n';
const candidate = 'export default function rebuilt(number) { return 1 + number * 2; }\n';
const contract = { schemaVersion: 1, cases: [[0], [2], [-3]] };

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'letstryrea-synthesis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// This fixture verifies the orchestration boundary. Real REA analysis is tested
// separately by recorded end-to-end runs, rather than replaced by this fixture.
function analysis(sourceSha256, directorySha256 = 'd'.repeat(64)) {
  const observed = () => ({ artifact: { sha256: sourceSha256 }, location: { value: { source: 'source.js' } } });
  return {
    evidence_id: `ev_${'e'.repeat(64)}`, operation: 'analyze_javascript_application',
    subject: { digest: { sha256: directorySha256 }, format: 'directory' },
    normalized_result: {
      root_artifact_sha256: directorySha256, format: 'directory',
      source_selection: { requested_paths: ['package.json', 'source.js'] },
      statistics: { relevant_files: 2, parsed_javascript_files: 1, invalid_utf8_files: 0, parse_failures: 0 },
      integrity_contradictions: [],
      graph: { coverage: { status: 'complete' }, nodes: [{
        identity: { namespace: 'source-module', artifact_sha256: sourceSha256, key: `${directorySha256}:source.js` },
        observations: [{ properties: { semantic_role: 'source-module', path: 'source.js', container_sha256: directorySha256, module_format: 'commonjs', export_names: ['default'] }, evidence: observed() }],
      }, {
        identity: { namespace: 'module-export', artifact_sha256: sourceSha256, key: JSON.stringify([directorySha256, 'source.js', 'default']) },
        observations: [{ properties: { semantic_role: 'export-binding', module_path: 'source.js', exported_name: 'default' }, evidence: observed() }],
      }] },
      semantic_graph: { root_artifact_sha256: directorySha256, nodes: [{ kind: 'module', identity: { artifact_sha256: sourceSha256, module_path: 'source.js' } }], unknowns: [{ reason: 'unknown-value' }], coverage: { status: 'unknown' } },
    },
  };
}

async function fakeRea(root) {
  const path = join(root, 'fake-rea');
  await writeFile(path, `#!${process.execPath}\nconst fs = require('node:fs');\nconst { createHash } = require('node:crypto');\nif (process.argv[2] === '--version') { console.log('6.5.0'); process.exit(0); }\nconst sourceSha256 = createHash('sha256').update(fs.readFileSync(require('node:path').join(process.argv[3], 'source.js'))).digest('hex');\nconst make = ${analysis.toString()};\nconsole.log(JSON.stringify(make(sourceSha256)));\n`);
  await chmod(path, 0o755);
  return path;
}

async function prepare(t, source = original) {
  const root = await workspace(t);
  const input = join(root, 'unknown-input.js');
  const output = join(root, 'job');
  await writeFile(input, source);
  const result = await prepareSynthesis({ input, contract, output, rea: await fakeRea(root) });
  assert.equal(result.exitCode, 0, result.report.error);
  assert.equal(result.report.status, 'awaiting-generation');
  const request = JSON.parse(await readFile(result.report.requestPath));
  return { root, input, output, request, report: result.report };
}

function response(request, source = candidate) {
  return { schemaVersion: 1, requestId: request.requestId, source, summary: 'Preserves the arithmetic function.', limitations: ['Finite numeric corpus only.'] };
}

async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

function canonical(value) {
  const ordered = (item) => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])])) : item;
  return stringifySynthesis(ordered(value), 0);
}

async function replaceRequest(job, request) {
  const { requestId, ...payload } = request;
  request.requestId = hash(canonical(payload));
  await writeFile(join(job, 'synthesis-request.json'), canonical(request) + '\n');
}

test('synthesis accepts arbitrary source identity and retains a request without producing a ZIP or calling a provider', async (t) => {
  const { output, request, report } = await prepare(t);
  assert.equal(request.input.name, 'unknown-input.js');
  assert.equal(request.input.sha256, hash(original));
  assert.equal(request.source, original);
  assert.equal(request.program.format, 'commonjs');
  assert.equal(request.analysis.sourceSha256, hash(original));
  assert.equal(request.analysis.coverage.semantic, 'unknown');
  assert.equal(request.analysis.unknowns.length, 1);
  assert.ok(request.corpus.training.length > 0);
  assert.ok(request.corpus.validation.length > 0);
  assert.equal(report.originalSourceExecution, false);
  await absent(join(output, 'provider'));
  await absent(join(output, 'project.zip'));
  await absent(join(output, 'attempts'));
});

test('a wrong candidate fails before export and a corrected retry produces an independently tested project', async (t) => {
  const { output, request } = await prepare(t);
  const wrong = await completeSynthesis({ job: output, response: response(request, 'export default function wrong(x) { return x * 2; }') });
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.report.error, /differs.*corpus/);
  await absent(join(wrong.report.attemptDirectory, 'project.zip'));
  await absent(join(wrong.report.attemptDirectory, 'project'));
  const responsePath = join(output, 'supplied-response.json');
  await writeFile(responsePath, stringifySynthesis(response(request)));
  const completed = await completeSynthesis({ job: output, response: responsePath });
  assert.equal(completed.exitCode, 0, completed.report.error);
  assert.equal(completed.report.status, 'completed');
  assert.equal(completed.report.generation.mode, 'chat-assisted');
  assert.equal(completed.report.originalSourceExecution, false);
  assert.ok(completed.report.verification.generatedProject.pass > 0);
  assert.equal(completed.report.verification.comparison.passed, request.corpus.all.length);
  assert.notEqual(completed.report.attemptDirectory, wrong.report.attemptDirectory);
  assert.ok((await lstat(completed.report.archive.path)).isFile());
  assert.equal(await readFile(join(completed.report.attemptDirectory, 'project/src/index.mjs'), 'utf8'), candidate);
  assert.deepEqual((await readdir(join(output, 'attempts'))).sort(), [wrong.report.attemptDirectory.split('/').at(-1), completed.report.attemptDirectory.split('/').at(-1)].sort());
});

test('a failed opted-in provider retains its real failure receipt and request for a later chat-assisted completion', async (t) => {
  const root = await workspace(t);
  const input = join(root, 'input.js');
  const output = join(root, 'job');
  const executable = join(root, 'failed-provider');
  await writeFile(input, original);
  await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write('fixture: upstream refused request (403)\\n');\nprocess.exit(23);\n`);
  await chmod(executable, 0o755);
  const failed = await prepareSynthesis({ input, contract, output, rea: await fakeRea(root), generator: executable });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.report.status, 'failed');
  assert.equal(failed.report.failureCode, 'PROVIDER_FAILED');
  assert.equal(failed.report.providerReceipt.state, 'failed');
  assert.equal(failed.report.providerReceipt.command.exitCode, 23);
  assert.match(await readFile(join(output, 'provider/provider-stderr.log'), 'utf8'), /403/);
  const request = JSON.parse(await readFile(failed.report.requestPath));
  await absent(join(output, 'project.zip'));
  const completed = await completeSynthesis({ job: output, response: response(request) });
  assert.equal(completed.exitCode, 0, completed.report.error);
  assert.equal(completed.report.generation.mode, 'chat-assisted');
  assert.equal(completed.report.providerReceipt.state, 'failed');
});

test('CLI JSON exposes the failure code and retained report when generation fails', async (t) => {
  const root = await workspace(t);
  const input = join(root, 'input.js');
  const cases = join(root, 'cases.json');
  const output = join(root, 'failed CLI job');
  const generator = join(root, 'failed-generator');
  await writeFile(input, original);
  await writeFile(cases, JSON.stringify(contract));
  await writeFile(generator, `#!${process.execPath}\nprocess.exit(23);\n`);
  await chmod(generator, 0o755);
  const cli = fileURLToPath(new URL('../bin/letstryrea.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'synthesize', input, '--cases', cases,
    '--out', output, '--rea', await fakeRea(root), '--generator', generator, '--json'],
  { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failureCode, 'PROVIDER_FAILED');
  assert.equal(summary.reportPath, join(output, 'report.json'));
  const report = JSON.parse(await readFile(summary.reportPath, 'utf8'));
  assert.equal(report.failureCode, summary.failureCode);
  assert.equal(report.providerReceipt.command.exitCode, 23);
  assert.equal(summary.requestPath, report.requestPath);
  assert.equal(JSON.parse(await readFile(summary.requestPath, 'utf8')).requestId, report.requestId);
  await absent(join(output, 'project.zip'));
});

test('Codex authentication failure reaches CLI output and retained reports without creating an attempt', async (t) => {
  const root = await workspace(t);
  const input = join(root, 'input.js');
  const cases = join(root, 'cases.json');
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(input, original);
  await writeFile(cases, JSON.stringify(contract));
  const codex = join(bin, 'codex');
  const message = 'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
  await writeFile(codex, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: ${JSON.stringify(message)} } }) + '\\n');\nprocess.exitCode = 1;\n`);
  await chmod(codex, 0o755);
  const rea = await fakeRea(root);
  const cli = fileURLToPath(new URL('../bin/letstryrea.mjs', import.meta.url));
  for (const json of [true, false]) {
    const output = join(root, json ? 'json job' : 'text job');
    const result = spawnSync(process.execPath, [cli, 'synthesize', input, '--cases', cases,
      '--out', output, '--rea', rea, '--provider', 'codex', ...(json ? ['--json'] : [])],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const reportPath = join(output, 'report.json');
    if (json) {
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.failureCode, 'PROVIDER_AUTH_FAILED');
      assert.equal(summary.reportPath, reportPath);
      assert.match(summary.error, /sign in/i);
    } else {
      assert(result.stdout.includes(reportPath));
      assert.match(result.stderr, /sign in/i);
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const receipt = JSON.parse(await readFile(join(output, 'provider/provider-receipt.json'), 'utf8'));
    assert.equal(report.failureCode, 'PROVIDER_AUTH_FAILED');
    assert.equal(report.originalSourceExecution, false);
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.error.code, report.failureCode);
    assert.deepEqual(report.providerReceipt, receipt);
    await absent(join(output, 'attempts'));
    await absent(join(output, 'project.zip'));
  }
});

test('a supplied source notice remains bound to the request and is included exactly in the generated project', async (t) => {
  const root = await workspace(t);
  const input = join(root, 'input.js');
  const notice = join(root, 'license.txt');
  const noticeText = 'Copyright Example Author\nPermission notice supplied by the caller.\n';
  await writeFile(input, original);
  await writeFile(notice, noticeText);
  const prepared = await prepareSynthesis({ input, contract, notice, output: join(root, 'job'), rea: await fakeRea(root) });
  assert.equal(prepared.exitCode, 0, prepared.report.error);
  const request = JSON.parse(await readFile(prepared.report.requestPath));
  assert.equal(request.notice, noticeText);
  assert.equal(request.noticeSha256, hash(noticeText));
  const completed = await completeSynthesis({ job: prepared.report.outputDirectory, response: response(request) });
  assert.equal(completed.exitCode, 0, completed.report.error);
  assert.equal(await readFile(join(completed.report.attemptDirectory, 'project/NOTICE.md'), 'utf8'), noticeText);
});

test('unsupported source is refused before REA or an explicitly supplied generator can run', async (t) => {
  const root = await workspace(t);
  const sentinel = join(root, 'executed');
  const executable = join(root, 'must-not-run');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);
  await chmod(executable, 0o755);
  const input = join(root, 'effects.js');
  await writeFile(input, 'module.exports = function (x) { return process.exit(x); };');
  const result = await prepareSynthesis({ input, contract, output: join(root, 'job'), rea: executable, generator: executable });
  assert.equal(result.exitCode, 3);
  assert.equal(result.report.status, 'unsupported');
  await absent(sentinel);
  await absent(join(root, 'job/synthesis-request.json'));
});

test('synthesis output collisions, symlinks, and aliased overlaps preserve existing source and output files', async (t) => {
  const root = await workspace(t);
  const input = join(root, 'input.js');
  await writeFile(input, original);
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'keep'), 'preserve me');
  await assert.rejects(prepareSynthesis({ input, contract, output: existing }), SynthesisInputError);
  await assert.rejects(prepareSynthesis({ input, contract, output: input }), SynthesisInputError);
  const alias = join(root, 'alias');
  await symlink(root, alias, 'dir');
  await assert.rejects(prepareSynthesis({ input, contract, output: join(alias, 'input.js/child') }), SynthesisInputError);
  const linkedOutput = join(root, 'linked-output');
  await symlink(existing, linkedOutput, 'dir');
  await assert.rejects(prepareSynthesis({ input, contract, output: linkedOutput }), SynthesisInputError);
  assert.equal(await readFile(input, 'utf8'), original);
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'preserve me');
});

test('completion rejects mismatched IDs and effectful or wrong-arity candidates before any project execution', async (t) => {
  const { output, request } = await prepare(t);
  const bad = [
    { ...response(request), requestId: 'f'.repeat(64) },
    response(request, 'export default function (x) { return process.exit(x); }'),
    response(request, 'export default function (x, y) { return x + y; }'),
    response(request, 'module.exports = function (x) { return x * 2 + 1; };'),
  ];
  for (const value of bad) {
    const result = await completeSynthesis({ job: output, response: value });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    await absent(join(result.report.attemptDirectory, 'project.zip'));
    await absent(join(result.report.attemptDirectory, 'project'));
  }
});

test('completion rechecks snapshot, IR, corpus and analysis rather than trusting a supplied request ID', async (t) => {
  const mutations = [
    ['snapshot', async (job) => writeFile(join(job.output, 'evidence/input/source.js'), original.replace('* 2', '* 3')), /source.*match/],
    ['IR', async (job) => { job.request.program.parameters = ['renamed']; await replaceRequest(job.output, job.request); }, /program.*IR/],
    ['corpus', async (job) => { job.request.corpus.all[0].expected = { type: 'number', value: 1234 }; await replaceRequest(job.output, job.request); }, /corpus.*match/],
    ['analysis', async (job) => writeFile(join(job.output, 'evidence/application.json'), '{}'), /analysis hash/],
    ['request identity', async (job) => { job.request.input.name = 'changed.js'; await writeFile(join(job.output, 'synthesis-request.json'), stringifySynthesis(job.request)); }, /request identity/],
  ];
  for (const [label, mutate, expected] of mutations) {
    await t.test(label, async (subtest) => {
      const job = await prepare(subtest);
      await mutate(job);
      const result = await completeSynthesis({ job: job.output, response: response(job.request) });
      assert.equal(result.exitCode, 1);
      assert.match(result.report.error, expected);
      await absent(join(result.report.attemptDirectory, 'project.zip'));
    });
  }
});

test('REA synthesis validation binds source observations and every directory identity while preserving unknowns', () => {
  const sourceSha256 = hash(original);
  const good = analysis(sourceSha256);
  assert.equal(verifySynthesisAnalysis(good, { sourceSha256, format: 'commonjs' }).unknowns.length, 1);
  const mutations = [
    (e) => { e.subject.digest.sha256 = 'a'.repeat(64); },
    (e) => { e.normalized_result.graph.nodes[0].observations[0].evidence.artifact.sha256 = 'a'.repeat(64); },
    (e) => { e.normalized_result.semantic_graph.nodes[0].identity.artifact_sha256 = 'a'.repeat(64); },
    (e) => { e.normalized_result.source_selection.requested_paths = ['source.js']; },
    (e) => { e.normalized_result.statistics.parse_failures = 1; },
    (e) => { e.normalized_result.integrity_contradictions.push({ kind: 'digest-mismatch' }); },
    (e) => { e.normalized_result.graph.nodes.pop(); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(good);
    mutate(value);
    assert.throws(() => verifySynthesisAnalysis(value, { sourceSha256, format: 'commonjs' }), /REA synthesis Evidence/);
  }
});
