#!/usr/bin/env node
import { runSearchCli, searchHelp } from '../src/search-cli.mjs';

const args = process.argv.slice(2);
if (args[0] === 'reconstruct') {
  const { runReconstructionCli } = await import('../src/reconstruct-cli.mjs');
  await runReconstructionCli(args.slice(1));
} else if (args[0] === 'duration') {
  const { runDurationCli } = await import('../src/duration-cli.mjs');
  process.exitCode = runDurationCli(args.slice(1));
} else if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  process.stdout.write(searchHelp + '\nDuration conversion:\n  letstryrea duration <parse|format> <value> [--long]\n\nArtifact pipeline:\n  letstryrea reconstruct <artifact> --out <new-directory> [--rea <executable>] [--json]\n\nRun reconstruct --help for supported artifacts and output details.\n');
} else {
  await runSearchCli(args);
}
