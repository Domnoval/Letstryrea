#!/usr/bin/env node
// Static REA CLI smoke check. Target JavaScript is analyzed, never executed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCommandSuccess, runCommand } from '../src/run-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = join(root, '.cache', 'environment');
mkdirSync(base, { recursive: true });
const fixture = join(base, 'fixtures', 'js-app');
const validation = mkdtempSync(join(base, 'static-analysis-'));
const rea = join(root, 'tools', 'rea', 'node_modules', '.bin', 'rea');
const fixtureFiles = {
  'package.json': '{\n  "name": "rea-onboarding-static-fixture",\n  "version": "1.0.0",\n  "private": true,\n  "type": "commonjs",\n  "main": "main.js"\n}\n',
  'main.js': "'use strict';\nconst { normalizeQuery } = require('./helper.js');\n\nfunction searchRecords(records, query) {\n  const normalized = normalizeQuery(query);\n  return records.filter((record) => record.label.toLowerCase().includes(normalized));\n}\n\nmodule.exports.searchRecords = searchRecords;\nmodule.exports.resultKind = 'search-result';\n",
  'helper.js': "'use strict';\n\nfunction normalizeQuery(query) {\n  return String(query).trim().toLowerCase();\n}\n\nmodule.exports.normalizeQuery = normalizeQuery;\n",
};
mkdirSync(fixture, { recursive: true });
mkdirSync(validation, { recursive: true });
for (const [name, source] of Object.entries(fixtureFiles)) {
  const path = join(fixture, name);
  if (existsSync(path)) {
    assert.equal(readFileSync(path, 'utf8'), source, `Preserving changed fixture: ${path}`);
  } else {
    writeFileSync(path, source, { flag: 'wx' });
  }
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshot = () => Object.fromEntries(Object.keys(fixtureFiles).sort().map((name) => [name, sha256(readFileSync(join(fixture, name)))]));
const before = snapshot();
writeFileSync(join(validation, 'js-checksums-before.json'), `${JSON.stringify(before, null, 2)}\n`);
const runs = [];
async function run(label, args, outputName) {
  const result = await runCommand({ executable: rea, args, cwd: root, timeoutMs: 120_000,
    stdoutPath: join(validation, outputName), stderrPath: join(validation, `${label}.stderr`) });
  writeFileSync(join(validation, `${label}.exit`), `${result.exitCode ?? 'NO_EXIT_STATUS'}\n`);
  runs.push(result);
  requireCommandSuccess(result, label);
  return JSON.parse(readFileSync(result.stdoutPath, 'utf8'));
}

const evidence = await run('js-analyze', ['analyze-javascript-application', fixture, '--json'], 'js-evidence.json');
assert.equal(evidence.operation, 'analyze_javascript_application');
const analysis = evidence.normalized_result;
assert.equal(analysis.format, 'directory');
assert.equal(analysis.statistics.relevant_files, 3);
assert.equal(analysis.statistics.parsed_javascript_files, 2);
assert.equal(analysis.statistics.parse_failures, 0);
assert.equal(analysis.integrity_contradictions.length, 0);
const sourceModules = analysis.graph.nodes.flatMap((node) => node.observations)
  .filter((observation) => observation.properties.semantic_role === 'source-module')
  .map((observation) => observation.properties);
assert.deepEqual(sourceModules.map((module) => module.path).sort(), ['helper.js', 'main.js']);
const main = sourceModules.find((module) => module.path === 'main.js');
const helper = sourceModules.find((module) => module.path === 'helper.js');
assert.equal(main.module_format, 'commonjs');
assert.deepEqual(main.export_names, ['resultKind', 'searchRecords']);
assert.deepEqual(helper.export_names, ['normalizeQuery']);
const imports = analysis.graph.edges.filter((edge) => edge.relation === 'imports');
assert(imports.some((edge) => edge.properties.specifier === './helper.js' &&
  edge.properties.imported_name === 'normalizeQuery' &&
  edge.properties.resolved_path === 'helper.js' && edge.properties.resolution_status === 'resolved'));
const exports = analysis.graph.edges.filter((edge) => edge.relation === 'exposes' && edge.properties.module_link_kind === 'commonjs-export');
assert.deepEqual(exports.map((edge) => edge.properties.exported_name).sort(), ['normalizeQuery', 'resultKind', 'searchRecords']);

const viewInput = join(validation, 'js-view-input.json');
writeFileSync(viewInput, JSON.stringify({ source: { kind: 'inline', evidence }, view: { kind: 'summary' } }));
const summaryEvidence = await run('js-view', ['inspect-analysis-view', viewInput, '--json'], 'js-summary.json');
const summaryView = summaryEvidence.normalized_result;
assert.equal(summaryView.kind, 'summary');
assert.equal(summaryView.parent_evidence_id, evidence.evidence_id);
assert.equal(summaryView.artifact.sha256, analysis.root_artifact_sha256);
assert.deepEqual(summaryView.summary.statistics, analysis.statistics);
assert.deepEqual(summaryView.summary.electron, analysis.summary);
assert.equal(summaryView.summary.coverage.semantic_unknowns, analysis.semantic_graph.unknowns.length);
assert.equal(summaryView.summary.coverage.application.status, analysis.graph.coverage.status);
assert.equal(summaryView.summary.coverage.semantic.status, analysis.semantic_graph.coverage.status);
assert(analysis.limitations.every((limitation) => summaryView.limitations.includes(limitation)));

const after = snapshot();
writeFileSync(join(validation, 'js-checksums-after.json'), `${JSON.stringify(after, null, 2)}\n`);
assert.deepEqual(after, before, 'Static analysis changed fixture bytes');
const report = {
  status: 'passed',
  fixture,
  cli_version: JSON.parse(readFileSync(join(root, 'tools', 'rea', 'node_modules', 'rea-agents', 'package.json'), 'utf8')).version,
  runs,
  root_artifact_sha256: analysis.root_artifact_sha256,
  fixture_sha256_before: before,
  fixture_sha256_after: after,
  fixture_unchanged: true,
  relevant_files: analysis.statistics.relevant_files,
  parsed_javascript_files: analysis.statistics.parsed_javascript_files,
  source_module_count: sourceModules.length,
  source_modules: sourceModules.map((module) => ({ path: module.path, format: module.module_format, exports: module.export_names })),
  resolved_import_specifier: './helper.js',
  resolved_import_name: 'normalizeQuery',
  commonjs_export_count: exports.length,
  application_graph: { nodes: analysis.graph.nodes.length, edges: analysis.graph.edges.length, coverage: analysis.graph.coverage },
  semantic_graph: { nodes: analysis.semantic_graph.nodes.length, relations: analysis.semantic_graph.relations.length, unknowns: analysis.semantic_graph.unknowns.length, coverage_status: analysis.semantic_graph.coverage.status },
  parse_failures: analysis.statistics.parse_failures,
  integrity_contradictions: analysis.integrity_contradictions.length,
  summary_matches_evidence: true,
  evidence_bytes: statSync(join(validation, 'js-evidence.json')).size,
  summary_bytes: statSync(join(validation, 'js-summary.json')).size,
  limitations: [
    'This validates static analysis of a tiny extracted CommonJS fixture only.',
    'Target JavaScript was not executed; static relationships do not establish runtime behavior.',
    'No actual Electron runtime, ASAR input, obfuscation recovery, or original-source reconstruction was verified.',
    `${analysis.semantic_graph.unknowns.length} semantic unknowns remain; semantic coverage is ${analysis.semantic_graph.coverage.status}.`,
  ],
};
writeFileSync(join(validation, 'js-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, source_modules: report.source_module_count, exports: report.commonjs_export_count, semantic_unknowns: report.semantic_graph.unknowns, fixture_unchanged: report.fixture_unchanged, report: join(validation, 'js-smoke-report.json') }, null, 2));
