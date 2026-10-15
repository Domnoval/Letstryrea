import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyApplication, verifyInspection } from '../src/reconstruct.mjs';

const artifactSha256 = 'a'.repeat(64);
const otherSha256 = 'b'.repeat(64);
const inspectionId = `ev_${'1'.repeat(64)}`;
const inventoryId = `ev_${'2'.repeat(64)}`;
const applicationId = `ev_${'3'.repeat(64)}`;

function inspection() {
  return {
    evidence_id: inspectionId,
    operation: 'inspect_artifact',
    subject: { digest: { sha256: artifactSha256 } },
    normalized_result: {
      subject: { root_sha256: artifactSha256 },
      substeps: [{
        operation: 'inventory_artifact', status: 'completed',
        evidence: {
          evidence_id: inventoryId, operation: 'inventory_artifact',
          subject: { digest: { sha256: artifactSha256 } },
          normalized_result: {
            manifest: { root_sha256: artifactSha256 },
            occurrences: [
              { entry_kind: 'file', logical_path: '.' },
              { entry_kind: 'directory', logical_path: 'resources' },
              { entry_kind: 'file', logical_path: 'app.js' },
              { entry_kind: 'file', logical_path: 'package.json' },
            ],
            integrity_contradictions: [], coverage_status: 'partial',
          },
        },
      }],
    },
  };
}

const inventory = (evidence) => evidence.normalized_result.substeps[0].evidence;

function application() {
  return {
    evidence_id: applicationId,
    operation: 'analyze_javascript_application',
    subject: { digest: { sha256: artifactSha256 } },
    normalized_result: {
      root_artifact_sha256: artifactSha256, format: 'asar',
      source_selection: { requested_paths: ['package.json', 'main.js', 'index.html', 'app.js', 'enhance.js'] },
      statistics: { modules: 195, parse_failures: 0 },
      integrity_contradictions: [],
      graph: { coverage: { status: 'partial' } },
      semantic_graph: { coverage: { status: 'partial' }, unknowns: ['dynamic import', 'native dependency'] },
      limitations: ['Only the requested sources were analyzed.'],
    },
  };
}

function rejectMutations(factory, verify, mutations) {
  for (const [label, mutate] of mutations) {
    const evidence = factory();
    mutate(evidence);
    assert.throws(() => verify(evidence, artifactSha256), /REA/, label);
  }
}

test('valid evidence retains partial coverage and unknowns without claiming complete analysis', () => {
  assert.deepEqual(verifyInspection(inspection(), artifactSha256), {
    files: 2, coverage: 'partial', integrityContradictions: 0,
  });
  const evidence = application();
  const result = verifyApplication(evidence, artifactSha256);
  assert.equal(result.evidenceId, applicationId);
  assert.equal(result.applicationCoverage, 'partial');
  assert.equal(result.semanticCoverage, 'partial');
  assert.equal(result.semanticUnknowns, 2);
  assert.deepEqual(result.sourceSelection, evidence.normalized_result.source_selection);
  assert.deepEqual(result.limitations, ['Only the requested sources were analyzed.']);
  delete evidence.normalized_result.graph;
  delete evidence.normalized_result.semantic_graph;
  assert.equal(verifyApplication(evidence, artifactSha256).applicationCoverage, 'unknown');
  assert.equal(verifyApplication(evidence, artifactSha256).semanticUnknowns, null);
});

test('inspection refuses conflicting artifact identities at every evidence layer', () => {
  rejectMutations(inspection, verifyInspection, [
    ['outer subject', (e) => { e.subject.digest.sha256 = otherSha256; }],
    ['normalized root', (e) => { e.normalized_result.subject.root_sha256 = otherSha256; }],
    ['nested inventory subject', (e) => { inventory(e).subject.digest.sha256 = otherSha256; }],
    ['nested manifest root', (e) => { inventory(e).normalized_result.manifest.root_sha256 = otherSha256; }],
  ]);
});

test('inspection requires identifiable completed inventory evidence with usable integrity data', () => {
  rejectMutations(inspection, verifyInspection, [
    ['missing outer ID', (e) => { delete e.evidence_id; }],
    ['malformed outer ID', (e) => { e.evidence_id = 'ev_short'; }],
    ['missing inventory ID', (e) => { delete inventory(e).evidence_id; }],
    ['malformed inventory ID', (e) => { inventory(e).evidence_id = `ev_${'z'.repeat(64)}`; }],
    ['wrong outer operation', (e) => { e.operation = 'analyze_javascript_application'; }],
    ['wrong inventory operation', (e) => { inventory(e).operation = 'inspect_artifact'; }],
    ['incomplete inventory step', (e) => { e.normalized_result.substeps[0].status = 'failed'; }],
    ['missing inventory occurrences', (e) => { delete inventory(e).normalized_result.occurrences; }],
    ['malformed inventory occurrences', (e) => { inventory(e).normalized_result.occurrences = {}; }],
    ['missing integrity result', (e) => { delete inventory(e).normalized_result.integrity_contradictions; }],
    ['integrity contradiction', (e) => { inventory(e).normalized_result.integrity_contradictions = [{ kind: 'digest-mismatch' }]; }],
  ]);
});

test('application evidence requires the same artifact identity and a valid operation and evidence ID', () => {
  rejectMutations(application, verifyApplication, [
    ['outer subject conflict', (e) => { e.subject.digest.sha256 = otherSha256; }],
    ['normalized root conflict despite valid subject', (e) => { e.normalized_result.root_artifact_sha256 = otherSha256; }],
    ['missing ID', (e) => { delete e.evidence_id; }],
    ['malformed ID', (e) => { e.evidence_id = `ev_${'0'.repeat(63)}`; }],
    ['wrong operation', (e) => { e.operation = 'inspect_artifact'; }],
    ['wrong format', (e) => { e.normalized_result.format = 'zip'; }],
  ]);
});

test('application evidence must describe the exact requested source selection', () => {
  rejectMutations(application, verifyApplication, [
    ['missing selection', (e) => { delete e.normalized_result.source_selection; }],
    ['different source', (e) => { e.normalized_result.source_selection.requested_paths[0] = 'other.js'; }],
    ['omitted source', (e) => { e.normalized_result.source_selection.requested_paths.pop(); }],
    ['extra source', (e) => { e.normalized_result.source_selection.requested_paths.push('extra.js'); }],
  ]);
});

test('application evidence rejects parse failures, absent modules, and uncertain integrity', () => {
  rejectMutations(application, verifyApplication, [
    ['parse failure', (e) => { e.normalized_result.statistics.parse_failures = 1; }],
    ['missing parse result', (e) => { delete e.normalized_result.statistics.parse_failures; }],
    ['zero modules', (e) => { e.normalized_result.statistics.modules = 0; }],
    ['fractional module count', (e) => { e.normalized_result.statistics.modules = 1.5; }],
    ['missing module count', (e) => { delete e.normalized_result.statistics.modules; }],
    ['missing integrity result', (e) => { delete e.normalized_result.integrity_contradictions; }],
    ['malformed integrity result', (e) => { e.normalized_result.integrity_contradictions = {}; }],
    ['integrity contradiction', (e) => { e.normalized_result.integrity_contradictions = [{ kind: 'digest-mismatch' }]; }],
  ]);
});
