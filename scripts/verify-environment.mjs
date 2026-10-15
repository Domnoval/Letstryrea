#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCommandSuccess, runCommand } from '../src/run-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = join(root, '.cache', 'environment');
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, 'verification-'));
const rea = join(root, 'tools', 'rea', 'node_modules', '.bin', 'rea');
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.versions.node, commands: [] };
const reportPath = join(directory, 'report.json');
const saveReport = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await saveReport();

async function run(label, executable, args, timeoutMs = 120_000) {
  console.log(`Verifying ${label}…`);
  const result = await runCommand({ executable, args, cwd: root, timeoutMs,
    stdoutPath: join(directory, `${label}.stdout`), stderrPath: join(directory, `${label}.stderr`) });
  report.commands.push(result);
  requireCommandSuccess(result, label);
  return readFile(result.stdoutPath, 'utf8');
}

try {
  const installed = JSON.parse(await readFile(join(root, 'tools', 'rea', 'node_modules', 'rea-agents', 'package.json'), 'utf8'));
  assert.equal(installed.version, '6.5.0', 'Install the locked REA tooling with npm run setup:environment.');
  assert.equal((await run('rea-version', rea, ['--version'])).trim(), '6.5.0');

  const doctor = JSON.parse(await run('mcp-doctor', rea, ['mcp', 'doctor', '--json']));
  assert.equal(doctor.healthy, true, 'REA MCP readiness failed.');
  assert.equal(doctor.server.name, 'rea');
  assert.equal(doctor.server.version, '6.5.0');
  assert.equal(doctor.identity.expected_package_version, '6.5.0');
  assert.equal(doctor.identity.observed_package_version, '6.5.0');
  assert.match(doctor.identity.expected_catalog_digest, /^[a-f0-9]{64}$/);
  assert.equal(doctor.identity.observed_catalog_digest, doctor.identity.expected_catalog_digest);
  assert.equal(doctor.inventory.tools.expected, 207);
  assert.equal(doctor.inventory.tools.observed, 207);
  assert.equal(doctor.inventory.prompts.expected, 6);
  assert.equal(doctor.inventory.prompts.observed, 6);
  assert.equal(doctor.request_flow.tool, 'binary_session');
  assert.equal(doctor.request_flow.ok, true);
  report.rea = { version: installed.version, healthy: true, tools: 207, prompts: 6,
    catalogDigest: doctor.identity.observed_catalog_digest, requestFlow: 'binary_session' };

  const tap = await run('repository-tests', 'npm', ['test', '--', '--test-reporter=tap'], 180_000);
  const count = (name) => Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
  const tests = { tests: count('tests'), pass: count('pass'), fail: count('fail'),
    cancelled: count('cancelled'), skipped: count('skipped'), todo: count('todo') };
  assert(tests.tests > 0, 'Repository checks must run actual tests.');
  assert.equal(tests.pass, tests.tests);
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(tests[name], 0);
  report.tests = tests;

  // npm's --silent suppresses its script banner so the actual demo JSON is checked.
  const demo = JSON.parse(await run('search-demo', 'npm', ['run', '--silent', 'demo'], 30_000));
  assert.deepEqual(demo, [{ file: 'Welcome.md', matches: [
    { line: 4, text: 'Search these notes for nebula, telescope, or observing.' },
  ] }, { file: 'notes/Observing.md', matches: [
    { line: 3, text: 'Use a telescope to find the Orion Nebula.' },
    { line: 4, text: 'The nebula is visible on a clear night.' },
  ] }]);
  report.demo = { status: 'passed', files: demo.length, contexts: demo.reduce((count, file) => count + file.matches.length, 0) };

  const smoke = JSON.parse(await run('static-analysis', process.execPath, [join(root, 'scripts', 'smoke-rea.mjs')], 300_000));
  assert.equal(smoke.status, 'passed');
  report.staticAnalysis = smoke;
  report.status = 'passed';
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(JSON.stringify({ status: report.status, tests: tests.tests, rea: installed.version,
    fixture_unchanged: smoke.fixture_unchanged, report: reportPath }, null, 2));
} catch (error) {
  report.status = 'failed';
  report.finishedAt = new Date().toISOString();
  report.error = error.message;
  await saveReport();
  console.error(`Environment verification failed: ${error.message}\nReport: ${reportPath}`);
  process.exitCode = 1;
}
