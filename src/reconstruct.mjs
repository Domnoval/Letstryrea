import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { probeArtifact } from './artifact-probe.mjs';
import { exportSearchProject, createProjectArchive } from './project-export.mjs';
import { runCommand, requireCommandSuccess } from './run-command.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const selectedSources = ['package.json', 'main.js', 'index.html', 'app.js', 'enhance.js'];
const expectedDemo = [{ file: 'notes/Observing.md', matches: [
  { line: 3, text: 'Use a telescope to find the Orion Nebula.' },
  { line: 4, text: 'The nebula is visible on a clear night.' },
] }];

export class PipelineInputError extends Error {
  name = 'PipelineInputError';
}

function assertSeparatePaths(input, output) {
  if (input === output || output.startsWith(input + sep) || input.startsWith(output + sep)) {
    throw new PipelineInputError('Output must be a new directory separate from the input artifact.');
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
  assertSeparatePaths(resolve(input), output);
  // Resolve aliases before creating even an output parent, including when the
  // input will later be rejected because it is a directory rather than a file.
  assertSeparatePaths(await prospectiveRealpath(resolve(input)), await prospectiveRealpath(output));
  await mkdir(dirname(output), { recursive: true });
  try {
    await mkdir(output);
  } catch (error) {
    if (error.code === 'EEXIST') throw new PipelineInputError('Output already exists. Choose a new directory; existing files are never overwritten.');
    throw error;
  }
  return realpath(output);
}

async function readJson(path, maximumBytes = 512 * 1024 * 1024) {
  if ((await stat(path)).size > maximumBytes) throw new Error(`${basename(path)} exceeds the supported evidence size.`);
  return JSON.parse(await readFile(path, 'utf8'));
}

export function verifyInspection(evidence, sha256) {
  const normalized = evidence?.normalized_result;
  const inventory = normalized?.substeps?.find((step) => step.operation === 'inventory_artifact' && step.status === 'completed')?.evidence;
  if (!/^ev_[a-f0-9]{64}$/.test(evidence?.evidence_id ?? '') || evidence.operation !== 'inspect_artifact' || evidence.subject?.digest?.sha256 !== sha256 ||
      normalized?.subject?.root_sha256 !== sha256 || inventory?.subject?.digest?.sha256 !== sha256 ||
      !/^ev_[a-f0-9]{64}$/.test(inventory?.evidence_id ?? '') || inventory.operation !== 'inventory_artifact' ||
      inventory.normalized_result?.manifest?.root_sha256 !== sha256 ||
      !Array.isArray(inventory.normalized_result?.occurrences) ||
      !Array.isArray(inventory.normalized_result.integrity_contradictions) || inventory.normalized_result.integrity_contradictions.length) {
    throw new Error('REA inventory identity or integrity does not match the supplied artifact.');
  }
  return { files: inventory.normalized_result.occurrences.filter((entry) => entry.entry_kind === 'file' && entry.logical_path !== '.').length,
    coverage: inventory.normalized_result.coverage_status, integrityContradictions: 0 };
}

export function verifyApplication(evidence, sha256) {
  const normalized = evidence?.normalized_result;
  if (!/^ev_[a-f0-9]{64}$/.test(evidence?.evidence_id ?? '') || evidence.operation !== 'analyze_javascript_application' || evidence.subject?.digest?.sha256 !== sha256 ||
      normalized?.root_artifact_sha256 !== sha256 || normalized.format !== 'asar' ||
      !isDeepStrictEqual(normalized.source_selection?.requested_paths, selectedSources) ||
      normalized.statistics?.parse_failures !== 0 || !Number.isSafeInteger(normalized.statistics?.modules) ||
      normalized.statistics.modules <= 0 || !Array.isArray(normalized.integrity_contradictions) || normalized.integrity_contradictions.length) {
    throw new Error('REA application Evidence is incomplete, failed parsing, or does not match this artifact and source selection.');
  }
  return {
    evidenceId: evidence.evidence_id,
    statistics: normalized.statistics,
    sourceSelection: normalized.source_selection,
    applicationCoverage: normalized.graph?.coverage?.status ?? 'unknown',
    semanticCoverage: normalized.semantic_graph?.coverage?.status ?? 'unknown',
    semanticUnknowns: normalized.semantic_graph?.unknowns?.length ?? null,
    limitations: normalized.limitations,
  };
}

function testCounts(tap) {
  const counts = {};
  for (const match of tap.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) counts[match[1]] = Number(match[2]);
  if (!(counts.tests > 0) || counts.pass !== counts.tests || ['fail', 'cancelled', 'skipped', 'todo'].some((key) => counts[key] !== 0)) {
    throw new Error('Generated project did not execute a complete passing test suite.');
  }
  return counts;
}

async function historicalComparison(sha256) {
  const path = join(projectRoot, 'docs/verification/obsidian-1.14.4.json');
  const bytes = await readFile(path);
  const evidence = JSON.parse(bytes);
  if (!evidence.success || evidence.source?.studiedRuntimeAsarSha256 !== sha256 ||
      evidence.passed !== evidence.total || !(evidence.total > 0) ||
      !evidence.observations?.every((row) => row.passed && row.native?.exit === 0 && row.reconstructed?.exit === 0)) {
    throw new Error('The supported recipe has no valid historical comparison record.');
  }
  return { status: 'historical-only', rerunInThisJob: false, version: evidence.native.version,
    passed: evidence.passed, total: evidence.total, recordedAt: evidence.finishedAt,
    recordSha256: createHash('sha256').update(bytes).digest('hex'),
    note: 'These are the earlier recipe comparisons, not fresh comparisons of this generated project.' };
}

function markdownReport(report) {
  const lines = ['# Reconstruction run', '', `Status: **${report.status}**`, '',
    'This job applies a known, independently written reconstruction recipe. It does not synthesize arbitrary application source.', '',
    `Input: ${JSON.stringify(report.artifact?.name ?? report.input)}`,
    `Format: ${report.artifact?.format ?? 'unconfirmed'}`,
    `Artifact SHA-256: ${report.artifact?.sha256 ?? 'unconfirmed'}`, ''];
  if (report.error) lines.push(`Error: ${report.error}`, '');
  if (report.artifact?.reasons?.length) lines.push('## Eligibility', '', ...report.artifact.reasons.map((reason) => `- ${reason}`), '');
  if (report.verification?.generatedProject) lines.push('## Fresh verification', '',
    `${report.verification.generatedProject.pass}/${report.verification.generatedProject.tests} generated-project tests passed.`,
    `Demo: ${report.verification.demo?.status ?? 'not completed'}.`, '');
  if (report.verification?.originalApplication) lines.push('## Earlier evidence', '',
    `${report.verification.originalApplication.passed}/${report.verification.originalApplication.total} original-app comparisons were recorded previously. They were not rerun in this job.`, '');
  if (report.archive) lines.push('## Output', '', '- Editable project: `project/`', '- Downloadable project: `project.zip`',
    '- Full local analysis and logs: `evidence/`', '', 'The ZIP contains independently authored source, public fixtures, tests, and provenance. It excludes the original ASAR and raw analysis.', '');
  if (report.limitations?.length) lines.push('## Limits', '', ...report.limitations.map((item) => `- ${item}`), '');
  return lines.join('\n') + '\n';
}

async function writeReports(output, report) {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(output, 'report.md'), markdownReport(report));
}

async function chooseRea(override) {
  if (override) return /[/\\]/.test(override) ? resolve(override) : override;
  for (const candidate of [
    resolve(projectRoot, 'tools/rea/node_modules/.bin/rea'),
    resolve(projectRoot, '../.onboarding/rea-tools/node_modules/.bin/rea'),
  ]) {
    try { await access(candidate); return candidate; } catch { /* Try the next installation. */ }
  }
  return 'rea';
}

/** Automate the supported recipe, keeping analysis, generation and verification distinct. */
export async function reconstruct({ input, output, rea, onProgress = () => {} }) {
  const directory = await reserveOutput(input, resolve(output));
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', input: resolve(input),
    outputDirectory: directory, stages: [], commands: [], generation: { mode: 'verified-recipe-export' }, verification: {} };
  async function stage(name, action) {
    const entry = { name, status: 'running', startedAt: new Date().toISOString() };
    report.stages.push(entry);
    onProgress(name);
    try { const value = await action(); entry.status = 'completed'; return value; }
    catch (error) { entry.status = 'failed'; entry.error = error.message; throw error; }
    finally { entry.finishedAt = new Date().toISOString(); }
  }
  try {
    const artifact = await stage('Identify artifact and verify recipe evidence', () => probeArtifact(input));
    assertSeparatePaths(artifact.path, directory);
    report.artifact = artifact;
    if (!artifact.supported) {
      report.status = 'unsupported';
      report.finishedAt = new Date().toISOString();
      await writeReports(directory, report);
      return { report, exitCode: 3 };
    }
    report.generation.recipe = artifact.recipe;
    report.limitations = [
      'Only the exact studied Obsidian 1.14.4 application-update ASAR is supported by this recipe.',
      'The generated project implements plain-text Markdown search, not the complete original application.',
      'Generation exports an existing verified implementation; general artifact-to-source synthesis is not implemented.',
      'REA source selection and semantic coverage are partial; unresolved behavior remains unknown.',
      'Generated-project checks run fresh. The 69 original-app comparisons are historical evidence.',
    ];
    const evidenceDirectory = join(directory, 'evidence');
    await mkdir(evidenceDirectory);
    const executable = await chooseRea(rea);
    async function command(label, args, stdoutName, timeoutMs = 180000, cwd = projectRoot, program = executable) {
      const run = await runCommand({ executable: program, args, cwd, timeoutMs,
        stdoutPath: join(evidenceDirectory, stdoutName), stderrPath: join(evidenceDirectory, stdoutName + '.stderr') });
      report.commands.push(run);
      requireCommandSuccess(run, label);
      return run;
    }
    await stage('Check REA runtime', async () => {
      await command('REA version check', ['--version'], 'rea-version.txt', 30000);
      const version = (await readFile(join(evidenceDirectory, 'rea-version.txt'), 'utf8')).trim();
      if (version !== '6.5.0') throw new Error(`This pipeline requires REA 6.5.0; received ${version}.`);
      report.analyzer = { name: 'rea-agents', version };
    });
    report.inventory = await stage('Inspect archive with REA', async () => {
      await command('REA artifact inspection', ['inspect-artifact', artifact.path, '--json'], 'inventory.json');
      return verifyInspection(await readJson(join(evidenceDirectory, 'inventory.json'), 8 * 1024 * 1024), artifact.sha256);
    });
    await stage('Analyze selected application sources with REA', async () => {
      const args = ['analyze-javascript-application', artifact.path, '--artifact-format', 'asar',
        '--integrity-policy', 'fail', '--max-heap-mb', '1024', '--analysis-timeout-ms', '120000'];
      for (const source of selectedSources) args.push('--source-path', source);
      args.push('--json');
      await command('REA application analysis', args, 'application.json', 900000);
      const analysisPath = join(evidenceDirectory, 'application.json');
      const analysis = await readJson(analysisPath);
      report.analysis = verifyApplication(analysis, artifact.sha256);
      const requestPath = join(evidenceDirectory, '.summary-request.json');
      await writeFile(requestPath, '{"source":{"kind":"inline","evidence":');
      await pipeline(createReadStream(analysisPath), createWriteStream(requestPath, { flags: 'a' }));
      await appendFile(requestPath, '},"view":{"kind":"summary"}}');
      try {
        await command('REA Evidence summary', ['inspect-analysis-view', requestPath, '--json'], 'summary.json');
        const summary = (await readJson(join(evidenceDirectory, 'summary.json'), 4 * 1024 * 1024)).normalized_result;
        if (summary?.parent_evidence_id !== analysis.evidence_id || summary.artifact?.sha256 !== artifact.sha256 ||
            !isDeepStrictEqual(summary.summary?.statistics, analysis.normalized_result.statistics)) {
          throw new Error('REA summary does not match the completed application Evidence.');
        }
      } finally { await unlink(requestPath); }
    });
    const confirmation = await stage('Recheck artifact before export', () => probeArtifact(artifact.path));
    if (!confirmation.supported || confirmation.sha256 !== artifact.sha256) throw new Error('Input artifact changed before export.');
    report.verification.originalApplication = await historicalComparison(artifact.sha256);
    const generated = join(directory, 'project');
    await mkdir(generated);
    report.generation.manifest = await stage('Generate editable search project', () => exportSearchProject({
      destination: generated, recipe: artifact.recipe, sourceEvidence: artifact.sourceEvidence,
    }));
    await stage('Run generated project tests and demo', async () => {
      await command('Generated project tests', ['--test', '--test-reporter=tap', 'test/search.test.mjs'], 'project-tests.tap', 120000, generated, process.execPath);
      report.verification.generatedProject = testCounts(await readFile(join(evidenceDirectory, 'project-tests.tap'), 'utf8'));
      await command('Generated project demo', ['bin/letstryrea.mjs', 'search:context', 'examples/vault', 'nebula', '--path', 'notes', '--format', 'json'], 'project-demo.json', 30000, generated, process.execPath);
      if (!isDeepStrictEqual(await readJson(join(evidenceDirectory, 'project-demo.json'), 1024 * 1024), expectedDemo)) {
        throw new Error('Generated project demo did not return the expected search results.');
      }
      report.verification.demo = { status: 'passed', matchingFiles: 1, contexts: 2 };
    });
    report.archive = await stage('Package verified project ZIP', () => createProjectArchive({ projectDirectory: generated, archivePath: join(directory, 'project.zip') }));
    report.status = 'completed';
    report.finishedAt = new Date().toISOString();
    await writeReports(directory, report);
    return { report, exitCode: 0 };
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    report.finishedAt = new Date().toISOString();
    await writeReports(directory, report);
    return { report, exitCode: error instanceof PipelineInputError ? 2 : 1 };
  }
}
