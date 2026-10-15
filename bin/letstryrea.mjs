#!/usr/bin/env node
import { runSearchCli, searchHelp } from '../src/search-cli.mjs';

const args = process.argv.slice(2);
if (args[0] === 'reconstruct') {
  const { runReconstructionCli } = await import('../src/reconstruct-cli.mjs');
  await runReconstructionCli(args.slice(1));
} else if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  process.stdout.write(searchHelp + '\nArtifact pipeline:\n  letstryrea reconstruct <artifact> --out <new-directory> [--rea <executable>] [--json]\n\nRun reconstruct --help for supported artifacts and output details.\n');
} else {
  await runSearchCli(args);
}
