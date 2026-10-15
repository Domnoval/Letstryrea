#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/obsidian-search.json', import.meta.url), 'utf8'));
const help = `Compare the reconstructed search with an installed, running Obsidian desktop app.

Usage:
  node scripts/compare-obsidian.mjs --prepare <empty-dir>
  node scripts/compare-obsidian.mjs --obsidian-cli <executable> --vault <fixture-dir>
      [--vault-name <name>] [--report <path>]

Prepare a dedicated synthetic vault, then open it in Obsidian with its CLI enabled.
Restart/reopen the vault after setting its excluded files so the app loads the config.
The comparison verifies the fixture contents and the running vault's path and filters.
The default report is .cache/obsidian-comparison.json relative to this project.
No application download or startup is performed by this script.
`;

function argumentsFor(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const options = {};
  const allowed = new Set(['--prepare', '--obsidian-cli', '--vault', '--vault-name', '--report']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: ${key}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value.`);
    options[key] = value;
  }
  if (options['--prepare']) {
    if (Object.keys(options).length !== 1) throw new Error('--prepare cannot be combined with comparison options.');
  } else if (!options['--obsidian-cli'] || !options['--vault']) {
    throw new Error('Provide --obsidian-cli and --vault, or use --prepare.');
  }
  return options;
}

const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function prepare(destination) {
  const root = path.resolve(destination);
  if (existsSync(root)) {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
      throw new Error('Preparation destination must be an ordinary empty directory.');
    }
    if (readdirSync(root).length) throw new Error('Preparation refused: destination is not empty.');
  } else mkdirSync(root, { recursive: true });
  for (const [relative, contents] of Object.entries(fixture.fixtureFiles)) {
    const destinationFile = path.join(root, relative);
    mkdirSync(path.dirname(destinationFile), { recursive: true });
    writeFileSync(destinationFile, contents, { flag: 'wx' });
  }
  mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  writeFileSync(path.join(root, '.obsidian', 'app.json'), `${JSON.stringify(fixture.fixtureConfig, null, 2)}\n`, { flag: 'wx' });
  console.log(`Prepared ${Object.keys(fixture.fixtureFiles).length} synthetic files at ${root}.`);
}

function verifyFixture(directory) {
  const root = realpathSync(path.resolve(directory));
  if (!lstatSync(root).isDirectory()) throw new Error('Fixture vault must be a directory.');
  const expectedPaths = Object.keys(fixture.fixtureFiles).sort(order);
  const observedPaths = [];
  function visit(parent, prefix = '') {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!prefix && entry.name === '.obsidian') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Fixture must not contain symlinks: ${relative}`);
      if (entry.isDirectory()) visit(path.join(parent, entry.name), relative);
      else if (entry.isFile()) observedPaths.push(relative);
      else throw new Error(`Fixture contains an unsupported entry: ${relative}`);
    }
  }
  visit(root);
  if (!isDeepStrictEqual(observedPaths.sort(order), expectedPaths)) {
    throw new Error('Fixture file list differs from the prepared corpus. Use a dedicated --prepare directory.');
  }
  const files = {};
  for (const relative of expectedPaths) {
    const contents = readFileSync(path.join(root, relative));
    if (!contents.equals(Buffer.from(fixture.fixtureFiles[relative], 'utf8'))) {
      throw new Error(`Fixture contents differ: ${relative}`);
    }
    files[relative] = hash(contents);
  }
  const configDirectory = path.join(root, '.obsidian');
  const configFile = path.join(configDirectory, 'app.json');
  if (lstatSync(configDirectory).isSymbolicLink() || lstatSync(configFile).isSymbolicLink()) {
    throw new Error('Fixture Obsidian configuration must not be a symlink.');
  }
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (!isDeepStrictEqual(config, fixture.fixtureConfig)) {
    throw new Error('Fixture .obsidian/app.json differs from the expected excluded-file configuration.');
  }
  return {
    path: root,
    fileCount: expectedPaths.length,
    filesSha256: files,
    corpusSha256: hash(JSON.stringify(files)),
    config: fixture.fixtureConfig,
  };
}

function execute(executable, args, cwd) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
    shell: false,
  });
  return {
    executable, args, cwd, startedAt,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exit: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function requireSuccess(result, label) {
  if (result.error || result.exit !== 0 || result.signal) {
    throw new Error(`${label} failed (${result.error ?? result.signal ?? `exit ${result.exit}`}): ${result.stderr.trim()}`);
  }
}

function nativeArguments(command, item, name) {
  const args = [`vault=${name}`, command, `query=${item.query}`, 'format=json'];
  if (item.path !== undefined) args.push(`path=${item.path}`);
  if (item.limit !== undefined) args.push(`limit=${item.limit}`);
  if (item.case) args.push('case');
  if (item.total) args.push('total');
  return args;
}

function reconstructionArguments(command, item, root) {
  const args = [path.join(project, 'bin', 'letstryrea.mjs'), command, root, item.query, '--format', 'json'];
  if (item.path !== undefined) args.push('--path', item.path);
  if (item.limit !== undefined) args.push('--limit', String(item.limit));
  if (item.case) args.push('--case');
  if (item.total) args.push('--total');
  return args;
}

function normalize(stdout, command, total) {
  const raw = stdout.trim();
  const value = raw === 'No matches found.' ? [] : JSON.parse(raw);
  if (total) {
    const count = typeof value === 'number' ? value : value?.total;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Expected a nonnegative total count.');
    return { total: count };
  }
  if (!Array.isArray(value)) throw new Error('Expected a JSON array.');
  if (command === 'search') {
    if (!value.every((file) => typeof file === 'string')) throw new Error('Expected file paths in search results.');
    return value.toSorted(order);
  }
  if (!value.every((item) => item && typeof item.file === 'string' && Array.isArray(item.matches) &&
      item.matches.every((match) => match && Number.isSafeInteger(match.line) && match.line >= 1 && typeof match.text === 'string'))) {
    throw new Error('Expected files with one-based line/text context entries.');
  }
  return value.toSorted((a, b) => order(a.file, b.file));
}

function evalIdentity(stdout) {
  const text = stdout.trim();
  const arrow = text.split(/\r?\n/).findLast((line) => /^\s*=>\s*/.test(line));
  let value = JSON.parse(arrow ? arrow.replace(/^\s*=>\s*/, '') : text);
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value.path !== 'string' || !Array.isArray(value.filters)) {
    throw new Error('Native eval did not provide the running vault path and excluded-file filters.');
  }
  return value;
}

function writeReport(filename, report) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(report, null, 2)}\n`);
}

function compare(options) {
  const reportPath = path.resolve(options['--report'] ?? path.join(project, '.cache', 'obsidian-comparison.json'));
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    source: fixture.source,
    scope: fixture.scope,
    normalization: [
      'Sort files only; preserve context occurrence order and repeated entries.',
      'Convert the native no-match text sentinel to an empty array.',
      'Normalize count output to {total:N}.',
    ],
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    preflight: {},
    observations: [],
    passed: 0,
    total: 0,
    success: false,
  };
  try {
    report.fixture = verifyFixture(options['--vault']);
    const root = report.fixture.path;
    const name = options['--vault-name'] ?? path.basename(root);
    let executable = options['--obsidian-cli'];
    if (!path.isAbsolute(executable) && /[/\\]/.test(executable)) executable = path.resolve(executable);
    report.native = { executable, vaultName: name };
    report.preflight.version = execute(executable, ['version'], root);
    requireSuccess(report.preflight.version, 'Native version query');
    const version = report.preflight.version.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
    if (!version) throw new Error('Native version query did not return a recognizable version.');
    report.native.version = version[0];
    if (report.native.version !== fixture.source.studiedVersion) {
      throw new Error(`Native version ${report.native.version} differs from the studied version ${fixture.source.studiedVersion}.`);
    }
    report.preflight.identity = execute(executable, [
      `vault=${name}`, 'eval',
      "code=JSON.stringify({path:app.vault.adapter.basePath,filters:app.vault.getConfig('userIgnoreFilters')})",
    ], root);
    requireSuccess(report.preflight.identity, 'Native running-vault identity query');
    const identity = evalIdentity(report.preflight.identity.stdout);
    if (realpathSync(identity.path) !== root) throw new Error('Obsidian is serving a different vault path.');
    if (!isDeepStrictEqual(identity.filters, fixture.fixtureConfig.userIgnoreFilters)) {
      throw new Error('Obsidian has different cached excluded-file filters. Restart/reopen the prepared vault and retry.');
    }
    report.native.liveIdentity = identity;
    for (const item of fixture.cases) {
      for (const command of item.total ? ['search'] : ['search', 'search:context']) {
        const native = execute(executable, nativeArguments(command, item, name), root);
        const reconstructed = execute(process.execPath, reconstructionArguments(command, item, root), root);
        const observation = { id: `${item.id}:${command}`, case: item, command, native, reconstructed, passed: false };
        try {
          requireSuccess(native, 'Native search');
          requireSuccess(reconstructed, 'Reconstructed search');
          observation.expected = normalize(native.stdout, command, item.total);
          observation.actual = normalize(reconstructed.stdout, command, item.total);
          observation.passed = isDeepStrictEqual(observation.actual, observation.expected);
          if (!observation.passed) observation.error = 'Normalized search results differ.';
        } catch (error) {
          observation.error = error.message;
        }
        report.observations.push(observation);
      }
    }
    // Recheck disk state after querying to detect edits during the run.
    verifyFixture(root);
    report.total = report.observations.length;
    report.passed = report.observations.filter((item) => item.passed).length;
    report.success = report.total > 0 && report.passed === report.total;
  } catch (error) {
    report.error = error.message;
  }
  report.finishedAt = new Date().toISOString();
  report.total = report.observations.length;
  report.passed = report.observations.filter((item) => item.passed).length;
  writeReport(reportPath, report);
  if (report.error) console.error(report.error);
  for (const observation of report.observations.filter((item) => !item.passed)) {
    console.error(`${observation.id}: ${observation.error}`);
  }
  console.log(`${report.passed}/${report.total} real Obsidian comparisons passed. Report: ${reportPath}`);
  if (!report.success) process.exitCode = 1;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) console.log(help);
  else if (options['--prepare']) prepare(options['--prepare']);
  else compare(options);
} catch (error) {
  console.error(`compare-obsidian: ${error.message}`);
  process.exitCode = 1;
}
