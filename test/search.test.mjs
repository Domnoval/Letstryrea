import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/letstryrea.mjs', import.meta.url));

function vault(t, files = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'letstryrea-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `CLI terminated: ${result.stderr}`);
  return result;
}

function json(command, directory, query, ...flags) {
  const result = run(command, directory, query, '--format', 'json', ...flags);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function usageError(...args) {
  const result = run(...args);
  assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
  assert.match(result.stderr, /\S/, 'Usage errors must explain the problem.');
}

test('search combines literal terms across filename and content, but not directory names', (t) => {
  const directory = vault(t, {
    'Alpha.md': 'Only beta is in the contents.',
    'beta.md': 'Only ALPHA is in the contents.',
    'both.md': 'alpha on one line\nbeta on another',
    'incomplete.md': 'alpha alone',
    'alpha-folder/neutral.md': 'beta alone',
  });
  assert.deepEqual(json('search', directory, 'alpha beta'), [
    'Alpha.md',
    'beta.md',
    'both.md',
  ]);
});

test('literal metacharacters are escaped and do not become regular expressions', (t) => {
  const directory = vault(t, {
    'literal.md': 'release v1.2; use a+b and c*d?; price $5; braces {ok}',
    'lookalike.md': 'release v1x2; use aaab and cd; price 5; braces ok',
  });
  for (const query of ['v1.2', 'a+b', 'c*d?', '$5', '{ok}']) {
    assert.deepEqual(json('search', directory, query), ['literal.md'], query);
  }
});

test('leading and repeated ASCII spaces do not introduce empty search terms', (t) => {
  const directory = vault(t, { 'match.md': 'alpha\nbeta', 'other.md': 'alpha' });
  assert.deepEqual(json('search', directory, '   alpha  beta   '), ['match.md']);
});

test('tabs and newlines inside a query stay literal instead of separating terms', (t) => {
  const directory = vault(t, {
    'tab.md': 'alpha\tbeta',
    'newline.md': 'alpha\nbeta',
    'spaces.md': 'alpha beta',
    'separate.md': 'alpha and later beta',
  });
  assert.deepEqual(json('search', directory, 'alpha\tbeta'), ['tab.md']);
  assert.deepEqual(json('search', directory, 'alpha\nbeta'), ['newline.md']);
});

test('case-sensitive search applies to both filenames and content', (t) => {
  const directory = vault(t, {
    'Alpha.md': 'beta',
    'alpha.md': 'BETA',
    'lower.md': 'alpha beta',
  });
  assert.deepEqual(json('search', directory, 'alpha beta'), [
    'Alpha.md', 'alpha.md', 'lower.md',
  ]);
  assert.deepEqual(json('search', directory, 'alpha beta', '--case'), ['lower.md']);
});

test('case folding follows non-Unicode JavaScript regex semantics', (t) => {
  const directory = vault(t, {
    'final.md': 'ς',
    'lower.md': 'σ',
    'upper.md': 'Σ',
    'symbol.md': 'K',
    'latin.md': 'k',
    'capitals.md': 'K',
  });
  assert.deepEqual(json('search', directory, 'σ'), ['final.md', 'lower.md', 'upper.md']);
  assert.deepEqual(json('search', directory, 'σ', '--case'), ['lower.md']);
  assert.deepEqual(json('search', directory, 'k'), ['capitals.md', 'latin.md']);
});

test('apostrophes remain literal text within a search term', (t) => {
  const directory = vault(t, {
    'match.md': "Please don't forget.",
    'other.md': 'Please do not forget.',
  });
  assert.deepEqual(json('search', directory, "don't"), ['match.md']);
});

test('filename matching includes the Markdown extension', (t) => {
  const directory = vault(t, { 'note.md': 'empty of the query', 'upper.MD': 'also empty' });
  assert.deepEqual(json('search', directory, '.md'), ['note.md', 'upper.MD']);
  assert.deepEqual(json('search', directory, '.md', '--case'), ['note.md']);
});

test('context includes trimmed one-based lines and preserves separate occurrences', (t) => {
  const directory = vault(t, {
    'notes.md': 'intro\r\n  needle and needle  \r\n\tNEEDLE\t\r\nlast',
  });
  assert.deepEqual(json('search:context', directory, 'needle'), [{
    file: 'notes.md',
    matches: [
      { line: 2, text: 'needle and needle' },
      { line: 2, text: 'needle and needle' },
      { line: 3, text: 'NEEDLE' },
    ],
  }]);
});

test('context merges adjacent ranges across terms while preserving gaps', (t) => {
  const directory = vault(t, { 'notes.md': '  catdog  \n cat and dog \n' });
  assert.deepEqual(json('search:context', directory, 'cat dog'), [{
    file: 'notes.md',
    matches: [
      { line: 1, text: 'catdog' },
      { line: 2, text: 'cat and dog' },
      { line: 2, text: 'cat and dog' },
    ],
  }]);
});

test('context merges overlapping ranges and repeated query terms', (t) => {
  const directory = vault(t, { 'notes.md': 'banana' });
  const expected = [{ file: 'notes.md', matches: [{ line: 1, text: 'banana' }] }];
  assert.deepEqual(json('search:context', directory, 'ana nana'), expected);
  assert.deepEqual(json('search:context', directory, 'ana ana'), expected);
});

test('filename-only matches have no content contexts', (t) => {
  const directory = vault(t, {
    'needle.md': 'Different text.',
    'needle plus.md': 'the second term',
  });
  assert.deepEqual(json('search:context', directory, 'needle'), [
    { file: 'needle plus.md', matches: [] },
    { file: 'needle.md', matches: [] },
  ]);
  assert.deepEqual(json('search:context', directory, 'needle second'), [{
    file: 'needle plus.md', matches: [{ line: 1, text: 'the second term' }],
  }]);
});

test('context keeps content matches even when the filename also matches', (t) => {
  const directory = vault(t, { 'needle.md': 'first\n needle \n' });
  assert.deepEqual(json('search:context', directory, 'needle'), [{
    file: 'needle.md', matches: [{ line: 2, text: 'needle' }],
  }]);
});

test('results use codepoint path order and limits are applied after sorting', (t) => {
  const directory = vault(t, {
    'z.md': 'target',
    'a.md': 'target',
    'Z.md': 'target',
    'A.md': 'target',
    'a/nested.md': 'target',
  });
  assert.deepEqual(json('search', directory, 'target'), [
    'A.md', 'Z.md', 'a.md', 'a/nested.md', 'z.md',
  ]);
  assert.deepEqual(json('search', directory, 'target', '--limit', '2'), ['A.md', 'Z.md']);
  assert.deepEqual(json('search', directory, 'target', '--limit', '0'), [
    'A.md', 'Z.md', 'a.md', 'a/nested.md', 'z.md',
  ]);
  assert.deepEqual(json('search:context', directory, 'target', '--limit', '1'), [{
    file: 'A.md', matches: [{ line: 1, text: 'target' }],
  }]);
});

test('total counts matching files before the display limit', (t) => {
  const directory = vault(t, {
    'a.md': 'target target\ntarget',
    'b.md': 'target',
    'c.md': 'absent',
  });
  const result = run('search', directory, 'target', '--total', '--limit', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2');
  const asJson = run('search', directory, 'target', '--total', '--format', 'json');
  assert.equal(asJson.status, 0, asJson.stderr);
  assert.deepEqual(JSON.parse(asJson.stdout), { total: 2 });
});

test('path restriction normalizes a folder and requires a directory boundary', (t) => {
  const directory = vault(t, {
    'notes/a.md': 'target',
    'notes/deeper/b.md': 'target',
    'notes-old/c.md': 'target',
    'elsewhere/d.md': 'target',
  });
  assert.deepEqual(json('search', directory, 'target', '--path', './notes/'), [
    'notes/a.md', 'notes/deeper/b.md',
  ]);
});

test('discovery scans Markdown, ignores hidden paths, and does not follow symlinks', (t) => {
  const directory = vault(t, {
    'visible.md': 'target',
    'upper.MD': 'target',
    'nested/note.md': 'target',
    '.hidden.md': 'target',
    '.hidden/note.md': 'target',
    'nested/.secret.md': 'target',
    'plain.txt': 'target',
    'image.svg': 'target',
  });
  const outside = vault(t, { 'external.md': 'target' });
  try {
    symlinkSync(path.join(outside, 'external.md'), path.join(directory, 'linked.md'));
    symlinkSync(outside, path.join(directory, 'linked-directory'), 'dir');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip('This platform does not permit fixture symlinks.');
    return;
  }
  assert.deepEqual(json('search', directory, 'target'), [
    'nested/note.md', 'upper.MD', 'visible.md',
  ]);
});

test('explicit glob exclusions are repeatable and apply to vault-relative paths', (t) => {
  const directory = vault(t, {
    'keep.md': 'target',
    'drafts/a.md': 'target',
    'drafts/deeper/b.md': 'target',
    'notes/discard.md': 'target',
    'notes/keep.md': 'target',
  });
  assert.deepEqual(json('search', directory, 'target',
    '--exclude', 'drafts/**', '--exclude', '**/discard.md'), [
    'keep.md', 'notes/keep.md',
  ]);
});

test('Obsidian ignore filters use case-insensitive prefixes without a directory boundary', (t) => {
  const directory = vault(t, {
    '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['ARCHIVE'] }),
    'archive/old.md': 'target',
    'Archive-old.md': 'target',
    'keep.md': 'target',
    'notes/archive.md': 'target',
  });
  assert.deepEqual(json('search', directory, 'target'), ['keep.md', 'notes/archive.md']);
});

test('Obsidian ignore regexes are case-insensitive and invalid regexes are ignored', (t) => {
  const directory = vault(t, {
    '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['/secret\\.md$/', '/[/'] }),
    'Secret.md': 'target',
    'nested/SECRET.md': 'target',
    'keep.md': 'target',
  });
  assert.deepEqual(json('search', directory, 'target'), ['keep.md']);
});

test('a double-slash ignore filter remains a literal prefix rather than matching every path', (t) => {
  const directory = vault(t, {
    '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['//'] }),
    'keep.md': 'target',
    'nested/note.md': 'target',
  });
  assert.deepEqual(json('search', directory, 'target'), ['keep.md', 'nested/note.md']);
});

test('no matches returns an empty JSON array or an explicit text message', (t) => {
  const directory = vault(t, { 'note.md': 'unrelated' });
  for (const command of ['search', 'search:context']) {
    assert.deepEqual(json(command, directory, 'missing'), []);
    const result = run(command, directory, 'missing');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'No matches found.');
  }
});

test('text output lists paths and prints file, line, and trimmed context', (t) => {
  const directory = vault(t, {
    'a.md': 'intro\n  needle  ',
    'needle.md': 'unrelated',
  });
  const search = run('search', directory, 'needle');
  assert.equal(search.status, 0, search.stderr);
  assert.equal(search.stdout, 'a.md\nneedle.md\n');
  const context = run('search:context', directory, 'needle');
  assert.equal(context.status, 0, context.stderr);
  assert.equal(context.stdout, 'a.md:2: needle\nneedle.md\n');
});

test('help succeeds without requiring a vault', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /search/);
});

test('unsupported query constructs are rejected instead of silently approximated', (t) => {
  const directory = vault(t, { 'note.md': 'alpha beta' });
  for (const query of [
    '', '   ', '"alpha beta"', '(alpha)', '[status:done]', '/alpha/',
    '-alpha', 'alpha OR beta', 'alpha AND beta', 'NOT alpha', 'path:notes', 'tag:work',
    '<alpha', 'alpha>beta', '1:23', 'foo.bar:baz', 'α:beta', 'TRUE', 'FALSE', 'EMPTY',
  ]) {
    usageError('search', directory, query);
  }
});

test('malformed arguments have a distinct usage exit code', (t) => {
  const directory = vault(t, { 'note.md': 'alpha' });
  usageError('unknown', directory, 'alpha');
  usageError('search', directory);
  usageError('search', directory, 'alpha', '--unknown');
  usageError('search', directory, 'alpha', '--format', 'xml');
  usageError('search', directory, 'alpha', '--limit', '-1');
  usageError('search', directory, 'alpha', '--limit', '1.5');
  usageError('search', directory, 'alpha', '--limit', 'abc');
  usageError('search', directory, 'alpha', '--limit', '1e2');
  usageError('search', directory, 'alpha', '--case=false');
  usageError('search', directory, 'alpha', '--exclude');
  usageError('search:context', directory, 'alpha', '--total');
});

test('missing vaults and paths that are not directories report an I/O failure', (t) => {
  const directory = vault(t, { 'note.md': 'alpha' });
  for (const location of [path.join(directory, 'missing'), path.join(directory, 'note.md')]) {
    const result = run('search', location, 'alpha');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\S/, 'I/O errors must explain the problem.');
  }
});

test('malformed Obsidian configuration reports the file that needs attention', (t) => {
  const directory = vault(t, { '.obsidian/app.json': '{broken', 'note.md': 'alpha' });
  const result = run('search', directory, 'alpha');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /app\.json/);
});
