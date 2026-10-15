import { searchVault, SearchInputError } from './search.mjs';

export const searchHelp = `Letstryrea — reconstructed plain-text Markdown vault search

Usage:
  letstryrea search <vault> <query> [options]
  letstryrea search:context <vault> <query> [options]

Options:
  --path <folder>       Restrict to a folder inside the vault
  --case                Match case sensitively (default: insensitive)
  --limit <number>      Maximum files to return; 0 means unlimited
  --total               Count matching files before limiting (search only)
  --format <json|text>  Output format (default: text)
  --exclude <glob>      Exclude a vault-relative glob; repeat as needed
  --help                Show this help

Queries support unquoted literal terms separated by spaces (AND).
Results are sorted by vault-relative path. No Obsidian installation is needed.
`;

function parseArguments(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { help: true };
  const command = args[0];
  if (!['search', 'search:context'].includes(command)) throw new SearchInputError(`Unknown command: ${command}`);
  const options = { command, exclude: [], caseSensitive: false, total: false, limit: 0, format: 'text' };
  const positional = [];
  let positionalOnly = false;
  const takesValue = new Set(['--path', '--limit', '--format', '--exclude']);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (!positionalOnly && argument.startsWith('--')) {
      const equal = argument.indexOf('=');
      const key = equal < 0 ? argument : argument.slice(0, equal);
      if (key === '--case' || key === '--total') {
        if (equal >= 0) throw new SearchInputError(`${key} is a flag and does not take a value.`);
        options[key === '--case' ? 'caseSensitive' : 'total'] = true;
      } else if (takesValue.has(key)) {
        const value = equal >= 0 ? argument.slice(equal + 1) : args[++index];
        if (value === undefined || value.startsWith('--')) throw new SearchInputError(`${key} requires a value.`);
        if (key === '--exclude') options.exclude.push(value);
        else options[key.slice(2)] = value;
      } else throw new SearchInputError(`Unknown option: ${key}`);
    } else positional.push(argument);
  }
  if (positional.length !== 2) throw new SearchInputError('Provide a vault directory and one query argument. Put multiword queries in shell quotes.');
  if (!['json', 'text'].includes(options.format)) throw new SearchInputError('--format must be json or text.');
  if (!/^\d+$/.test(String(options.limit)) || !Number.isSafeInteger(Number(options.limit))) {
    throw new SearchInputError('--limit must be a nonnegative integer.');
  }
  options.limit = Number(options.limit);
  if (options.total && command !== 'search') throw new SearchInputError('--total is supported only by search.');
  return { ...options, vault: positional[0], query: positional[1] };
}

function render(options, matches) {
  if (options.total) return options.format === 'json' ? JSON.stringify({ total: matches.length }) : String(matches.length);
  const selected = options.limit ? matches.slice(0, options.limit) : matches;
  if (options.format === 'json') return JSON.stringify(options.command === 'search' ? selected.map(({ file }) => file) : selected, null, 2);
  if (!selected.length) return 'No matches found.';
  if (options.command === 'search') return selected.map(({ file }) => file).join('\n');
  return selected.flatMap(({ file, matches: contexts }) => contexts.length
    ? contexts.map(({ line, text }) => `${file}:${line}: ${text}`)
    : [file]).join('\n');
}

export async function runSearchCli(args = process.argv.slice(2)) {
try {
  const options = parseArguments(args);
  if (options.help) process.stdout.write(searchHelp);
  else process.stdout.write(`${render(options, await searchVault(options))}\n`);
} catch (error) {
  process.stderr.write(`letstryrea: ${error.message}\n`);
  process.exitCode = error instanceof SearchInputError ? 2 : 1;
}
}
