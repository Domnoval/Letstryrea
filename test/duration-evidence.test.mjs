import assert from 'node:assert/strict';
import test from 'node:test';
import { DURATION_DIRECTORY_SHA256, verifyDurationApplication } from '../src/reconstruct.mjs';

const sourceSha256 = 'e5f0b6a946a9b2b356a28557728410717df54ea2f599edb619f9839df6b7b0e9';
const tarballSha256 = 'f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6';
const evidenceId = `ev_${'1'.repeat(64)}`;
const otherSha256 = 'b'.repeat(64);
const sourceEvidence = () => ({ artifact: { sha256: sourceSha256 }, location: { value: { source: 'index.js' } } });

// Minimal synthetic REA Evidence. Tests run without downloads, original source,
// REA, or historical machine-local analysis files.
function evidence() {
  return {
    evidence_id: evidenceId,
    operation: 'analyze_javascript_application',
    subject: { digest: { sha256: DURATION_DIRECTORY_SHA256 }, format: 'directory' },
    normalized_result: {
      root_artifact_sha256: DURATION_DIRECTORY_SHA256,
      format: 'directory',
      source_selection: { requested_paths: ['package.json', 'index.js'] },
      statistics: { modules: 0, parsed_javascript_files: 1, relevant_files: 2, parse_failures: 0, invalid_utf8_files: 0 },
      integrity_contradictions: [],
      graph: {
        coverage: { status: 'complete' },
        nodes: [{
          kind: 'javascript-module',
          identity: { namespace: 'source-module', artifact_sha256: sourceSha256, key: `${DURATION_DIRECTORY_SHA256}:index.js` },
          observations: [{
            properties: { semantic_role: 'source-module', path: 'index.js', container_sha256: DURATION_DIRECTORY_SHA256, module_format: 'commonjs', export_names: ['default'] },
            evidence: sourceEvidence(),
          }],
        }, {
          kind: 'javascript-module',
          identity: { namespace: 'module-export', artifact_sha256: sourceSha256, key: JSON.stringify([DURATION_DIRECTORY_SHA256, 'index.js', 'default']) },
          observations: [{
            properties: { semantic_role: 'export-binding', module_path: 'index.js', relationship_kind: 'commonjs-export', exported_name: 'default' },
            evidence: sourceEvidence(),
          }],
        }],
      },
      semantic_graph: {
        root_artifact_sha256: DURATION_DIRECTORY_SHA256,
        nodes: [{ kind: 'module', identity: { artifact_sha256: sourceSha256, module_path: 'index.js' } }],
        coverage: { status: 'unknown' },
        unknowns: [{ reason: 'dynamic-call' }, { reason: 'unknown-value' }],
      },
      limitations: ['Static candidates do not prove runtime execution.'],
    },
  };
}

const source = (e) => e.normalized_result.graph.nodes[0];
const exported = (e) => e.normalized_result.graph.nodes[1];
const semantic = (e) => e.normalized_result.semantic_graph;

function refuses(mutations) {
  for (const [label, mutate] of mutations) {
    const item = evidence();
    mutate(item);
    assert.throws(() => verifyDurationApplication(item), /REA duration application Evidence/, label);
  }
}

test('duration Evidence accepts an unbundled CommonJS source module with zero bundle modules and preserves unknowns', () => {
  const item = evidence();
  const result = verifyDurationApplication(item);
  assert.equal(result.evidenceId, evidenceId);
  assert.equal(result.statistics.modules, 0);
  assert.equal(result.statistics.parsed_javascript_files, 1);
  assert.equal(result.analyzedDirectorySha256, DURATION_DIRECTORY_SHA256);
  assert.notEqual(result.analyzedDirectorySha256, tarballSha256);
  assert.equal(result.sourceSha256, sourceSha256);
  assert.equal(result.applicationCoverage, 'complete');
  assert.equal(result.semanticCoverage, 'unknown');
  assert.equal(result.semanticUnknowns, 2);
  assert.deepEqual(result.limitations, item.normalized_result.limitations);
});

test('duration Evidence binds the extracted directory identity separately from the compressed tarball', () => {
  refuses([
    ['compressed hash at outer subject', (e) => { e.subject.digest.sha256 = tarballSha256; }],
    ['compressed hash in normalized result', (e) => { e.normalized_result.root_artifact_sha256 = tarballSha256; }],
    ['wrong semantic root', (e) => { semantic(e).root_artifact_sha256 = otherSha256; }],
    ['missing evidence identity', (e) => { delete e.evidence_id; }],
    ['invalid evidence identity', (e) => { e.evidence_id = 'ev_unverified'; }],
    ['different operation', (e) => { e.operation = 'inspect_artifact'; }],
    ['different subject format', (e) => { e.subject.format = 'gzip'; }],
    ['different analysis format', (e) => { e.normalized_result.format = 'asar'; }],
  ]);
});

test('duration Evidence requires the selected sources and completed parsing with certain integrity', () => {
  refuses([
    ['wrong source selection', (e) => { e.normalized_result.source_selection.requested_paths = ['package.json', 'other.js']; }],
    ['missing selection', (e) => { delete e.normalized_result.source_selection; }],
    ['parse failure', (e) => { e.normalized_result.statistics.parse_failures = 1; }],
    ['absent parse result', (e) => { delete e.normalized_result.statistics.parse_failures; }],
    ['no parsed source', (e) => { e.normalized_result.statistics.parsed_javascript_files = 0; }],
    ['missing package source', (e) => { e.normalized_result.statistics.relevant_files = 1; }],
    ['invalid UTF-8 source', (e) => { e.normalized_result.statistics.invalid_utf8_files = 1; }],
    ['unexpected bundle modules', (e) => { e.normalized_result.statistics.modules = 1; }],
    ['missing integrity result', (e) => { delete e.normalized_result.integrity_contradictions; }],
    ['integrity contradiction', (e) => { e.normalized_result.integrity_contradictions.push({ kind: 'digest-mismatch' }); }],
  ]);
});

test('duration Evidence requires the exact source module and default export rather than module counts alone', () => {
  refuses([
    ['missing graph', (e) => { delete e.normalized_result.graph; }],
    ['malformed graph nodes', (e) => { e.normalized_result.graph.nodes = {}; }],
    ['missing source module', (e) => { e.normalized_result.graph.nodes.shift(); }],
    ['duplicate source module', (e) => { e.normalized_result.graph.nodes.push(structuredClone(source(e))); }],
    ['wrong source digest', (e) => { source(e).identity.artifact_sha256 = otherSha256; }],
    ['wrong source identity key', (e) => { source(e).identity.key = `${DURATION_DIRECTORY_SHA256}:other.js`; }],
    ['wrong module format', (e) => { source(e).observations[0].properties.module_format = 'esm'; }],
    ['wrong source container', (e) => { source(e).observations[0].properties.container_sha256 = tarballSha256; }],
    ['wrong source path', (e) => { source(e).observations[0].properties.path = 'other.js'; }],
    ['missing default export', (e) => { source(e).observations[0].properties.export_names = []; }],
    ['conflicting observed source digest', (e) => { source(e).observations[0].evidence.artifact.sha256 = otherSha256; }],
    ['wrong source observation location', (e) => { source(e).observations[0].evidence.location.value.source = 'other.js'; }],
    ['missing export binding', (e) => { exported(e).observations = []; }],
    ['wrong export identity', (e) => { exported(e).identity.artifact_sha256 = otherSha256; }],
    ['wrong export key', (e) => { exported(e).identity.key = 'default'; }],
    ['wrong export relationship', (e) => { exported(e).observations[0].properties.relationship_kind = 'esm-export'; }],
    ['wrong export name', (e) => { exported(e).observations[0].properties.exported_name = 'duration'; }],
    ['wrong export source evidence', (e) => { exported(e).observations[0].evidence.artifact.sha256 = otherSha256; }],
  ]);
});

test('duration Evidence binds its semantic module to the same source and retains an explicit unknown list', () => {
  refuses([
    ['missing semantic graph', (e) => { delete e.normalized_result.semantic_graph; }],
    ['missing semantic module', (e) => { semantic(e).nodes = []; }],
    ['malformed semantic modules', (e) => { semantic(e).nodes = {}; }],
    ['duplicate semantic module', (e) => { semantic(e).nodes.push(structuredClone(semantic(e).nodes[0])); }],
    ['wrong semantic module digest', (e) => { semantic(e).nodes[0].identity.artifact_sha256 = otherSha256; }],
    ['wrong semantic path', (e) => { semantic(e).nodes[0].identity.module_path = 'other.js'; }],
    ['missing unknown list', (e) => { delete semantic(e).unknowns; }],
  ]);
});
