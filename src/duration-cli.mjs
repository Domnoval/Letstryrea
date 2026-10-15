#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import duration from './duration.mjs';

const HELP = `Usage:
  letstryrea parse <duration>
  letstryrea format <milliseconds> [--long]
  letstryrea --help

Quote duration strings that contain spaces. Milliseconds use signed decimal notation.
`;

const DECIMAL = /^-?(?:[0-9]*\.[0-9]+|[0-9]+)$/;

function usageError(message) {
  process.stderr.write(`Error: ${message}\n`);
  return 2;
}

/** Write one command result and return its exit code without exiting the caller. */
export function runDurationCli(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return usageError('arguments must be an array of strings');
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const [command, input, option] = args;
  if (command === 'parse') {
    if (args.length !== 2) return usageError('parse requires exactly one duration string');
  } else if (command === 'format') {
    if ((args.length !== 2 && args.length !== 3) || (args.length === 3 && option !== '--long')) {
      return usageError('format requires a numeric value and optional --long');
    }
    if (!DECIMAL.test(input) || !Number.isFinite(Number(input))) {
      return usageError('milliseconds must be a finite signed decimal number');
    }
  } else {
    return usageError('expected parse or format; use --help for usage');
  }

  try {
    const result = command === 'parse'
      ? duration(input)
      : duration(Number(input), { long: option === '--long' });

    if (result === undefined) {
      process.stdout.write('{"status":"invalid"}\n');
      return 1;
    }

    const output = command === 'parse'
      ? (Object.is(result, -0) ? '-0' : JSON.stringify(result))
      : result;
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    // A module consumer can supply a non-file first argument (for example, node -e).
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = runDurationCli(process.argv.slice(2));
}
