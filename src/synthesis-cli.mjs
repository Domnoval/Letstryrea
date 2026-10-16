import { join } from 'node:path';
import { completeSynthesis, prepareSynthesis, SynthesisInputError } from './synthesis-pipeline.mjs';

export const synthesisHelp = `Source-assisted reconstruction of a bounded JavaScript function

Usage:
  letstryrea synthesize <input.js> --cases <contract.json> --out <new-directory>
    [--provider codex | --generator <executable>] [--notice <file>] [--rea <executable>] [--json]
  letstryrea complete-synthesis <job-directory> --response <response.json> [--json]

The first command snapshots and analyzes an unfamiliar function, then writes a
generation request. Without a provider it stops at awaiting-generation. Supply
the response from a coding agent to complete-synthesis, or explicitly select a
trusted generator for a single invocation. Generator responses are data; their
code must pass the supported syntax and behavior checks before export.

Supported scope: one exported function with 1–4 finite numeric arguments,
bounded arithmetic, branches, local constants, and allowlisted Math operations.
Original code is interpreted as validated syntax, never loaded or executed.
Unknown syntax is rejected. Validation covers a finite corpus, not every input.

The contract is {"schemaVersion":1,"cases":[[1],[2]]}, with one argument array
per case and the correct arity for the input function. Existing output paths
are preserved. Run reports distinguish chat-assisted and provider generation.
`;

function parse(args, completion) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = {};
  const positional = [];
  const flags = completion ? ['--response'] : ['--cases', '--out', '--provider', '--generator', '--notice', '--rea'];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') {
      if (options.json) throw new SynthesisInputError('Duplicate --json option.');
      options.json = true;
    } else if (flags.includes(argument)) {
      const name = argument.slice(2);
      if (options[name] !== undefined) throw new SynthesisInputError(`Duplicate ${argument} option.`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new SynthesisInputError(`${argument} requires a value.`);
      options[name] = value;
    } else if (argument.startsWith('-')) throw new SynthesisInputError(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  if (positional.length !== 1) throw new SynthesisInputError('Provide exactly one input or job directory.');
  if (completion) {
    if (!options.response) throw new SynthesisInputError('Provide --response <response.json>.');
    return { ...options, job: positional[0] };
  }
  if (!options.cases || !options.out) throw new SynthesisInputError('Provide --cases and --out.');
  if (options.provider && options.generator) throw new SynthesisInputError('Select one provider or generator.');
  if (options.provider && options.provider !== 'codex') throw new SynthesisInputError('The supported provider is codex.');
  return { ...options, input: positional[0] };
}

export async function runSynthesisCli(args, { completion = false } = {}) {
  try {
    const options = parse(args, completion);
    if (options.help) { process.stdout.write(synthesisHelp); return; }
    const result = completion
      ? await completeSynthesis({ job: options.job, response: options.response })
      : await prepareSynthesis({ input: options.input, contract: options.cases, output: options.out,
        rea: options.rea, provider: options.provider, generator: options.generator, notice: options.notice });
    const { report, exitCode } = result;
    const summary = { status: report.status, outputDirectory: report.outputDirectory,
      reportPath: join(report.outputDirectory, 'report.json'),
      requestPath: report.requestPath, archivePath: report.archive?.path,
      ...(report.failureCode ? { failureCode: report.failureCode } : {}),
      ...(report.error ? { error: report.error } : {}) };
    if (options.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    else {
      process.stdout.write(`Synthesis ${report.status}.\n`);
      if (summary.requestPath) process.stdout.write(`Generation request: ${summary.requestPath}\n`);
      if (summary.archivePath) process.stdout.write(`Standalone project ZIP: ${summary.archivePath}\n`);
      process.stdout.write(`Run report: ${summary.reportPath}\n`);
      if (summary.error) process.stderr.write(`${typeof summary.error === 'string' ? summary.error : JSON.stringify(summary.error)}\n`);
    }
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`letstryrea: ${error.message}\n`);
    process.exitCode = error instanceof SynthesisInputError ? 2 : 1;
  }
}
