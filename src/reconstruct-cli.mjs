import { PipelineInputError, reconstruct } from './reconstruct.mjs';

const help = `Letstryrea artifact reconstruction pipeline

Usage:
  letstryrea reconstruct <artifact> --out <new-directory> [--rea <executable>] [--json]

Recipes support the exact studied Obsidian 1.14.4 application-update ASAR
(Markdown search) and ms 2.1.3 npm tarball (duration parsing and formatting).
The pipeline verifies artifact/source hashes, performs fresh REA analysis,
exports an existing independently written recipe, runs its tests, and creates
project.zip plus a verification report. The duration recipe additionally runs
fresh comparisons against the pinned MIT reference in separate bounded child
processes using a fixed synthetic corpus. Obsidian comparisons are historical;
the original Obsidian artifact is never executed.
It does not synthesize arbitrary application source. Other inputs produce an
unsupported report without a generated project. Original artifacts and extracted
reference source are excluded from the project ZIP. REA analyzes the verified
ms extraction as a directory; its archive-inspection step is not used for ms.

Options:
  --out <directory>   Required new output directory; existing paths are refused
  --rea <executable>  REA 6.5.0 executable (defaults to retained tools or PATH)
  --json              Emit a small machine-readable result on stdout
  --help              Show this help

Exit codes: 0 completed, 1 failed, 2 invalid request/output collision, 3 unsupported.
`;

function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (['--out', '--rea'].includes(arg)) {
      if (options[arg.slice(2)]) throw new PipelineInputError(`Duplicate option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new PipelineInputError(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('-')) throw new PipelineInputError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1 || !options.out) throw new PipelineInputError('Provide one artifact and --out <new-directory>.');
  return { ...options, input: positional[0] };
}

export async function runReconstructionCli(args) {
  try {
    const options = parseArguments(args);
    if (options.help) { process.stdout.write(help); return; }
    const { report, exitCode } = await reconstruct({ input: options.input, output: options.out, rea: options.rea,
      onProgress: (stage) => process.stderr.write(`${stage}\n`) });
    const result = { status: report.status, outputDirectory: report.outputDirectory,
      reportPath: report.outputDirectory + '/report.json',
      artifact: report.artifact && { name: report.artifact.name, format: report.artifact.format, sha256: report.artifact.sha256 },
      ...(report.archive ? { archivePath: report.archive.path, generatedProjectTests: report.verification.generatedProject } : {}),
      ...(report.error ? { error: report.error } : {}),
      ...(report.status === 'unsupported' ? { reasons: report.artifact.reasons } : {}),
    };
    if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      process.stdout.write(`Reconstruction ${report.status}. Report: ${result.reportPath}\n`);
      if (report.archive) process.stdout.write(`Editable project: ${report.outputDirectory}/project\nZIP: ${report.archive.path}\n`);
      if (report.error) process.stderr.write(report.error + '\n');
      if (report.status === 'unsupported') process.stdout.write(report.artifact.reasons.join('\n') + '\n');
    }
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`letstryrea: ${error.message}\n`);
    process.exitCode = error instanceof PipelineInputError ? 2 : 1;
  }
}
