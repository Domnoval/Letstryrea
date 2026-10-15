import { readFile, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { join, matchesGlob, resolve } from 'node:path';

export class SearchInputError extends Error {
  name = 'SearchInputError';
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile the deliberately small, unquoted AND-query subset. */
export function parseQuery(query, caseSensitive = false) {
  if (typeof query !== 'string' || query.split(' ').every((term) => term === '')) {
    throw new SearchInputError('Provide a nonempty search query.');
  }
  const terms = query.split(' ').filter(Boolean);
  for (const term of terms) {
    if (/["()[\]:<>]/.test(term) || /^(?:-|\/)/.test(term) ||
        /^(?:OR|AND|NOT|TRUE|FALSE|EMPTY)$/.test(term)) {
      throw new SearchInputError('This prototype supports unquoted plain-text terms joined by spaces. Query operators, quotes, and regular expressions are not supported.');
    }
  }
  return terms.map((term) => new RegExp(escapeRegex(term), caseSensitive ? 'gm' : 'gmi'));
}

/** Read Obsidian's excluded-file rules without following configuration symlinks. */
async function ignoreRules(vault) {
  const directory = join(vault, '.obsidian');
  const path = join(directory, 'app.json');
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return [];
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let config;
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Could not parse .obsidian/app.json as JSON.');
    throw error;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('.obsidian/app.json must contain a JSON object.');
  }
  const filters = config.userIgnoreFilters ?? [];
  if (!Array.isArray(filters) || filters.some((value) => typeof value !== 'string')) {
    throw new Error('.obsidian/app.json userIgnoreFilters must be an array of strings.');
  }
  return filters.flatMap((value) => {
    const filter = value.trim();
    if (!filter) return [];
    try {
      return [filter.length > 2 && filter.startsWith('/') && filter.endsWith('/')
        ? new RegExp(filter.slice(1, -1), 'i')
        : new RegExp(`^${escapeRegex(filter)}`, 'i')];
    } catch {
      // Obsidian also ignores invalid configured regular expressions.
      return [];
    }
  });
}

function folderPrefix(path = '') {
  if (typeof path !== 'string' || path.includes('\0')) {
    throw new SearchInputError('Folder path must be a vault-relative path.');
  }
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new SearchInputError('Folder path must stay inside the vault.');
  }
  return normalized && normalized !== '.' ? `${normalized}/` : '';
}

async function markdownFiles(vault) {
  const files = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(relative);
    }
  }
  await visit(vault, '');
  return files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/** Return merged content ranges, or null when any term matches neither name nor text. */
function matchFile(filename, content, expressions) {
  const ranges = [];
  for (const expression of expressions) {
    expression.lastIndex = 0;
    const nameMatches = expression.test(filename);
    expression.lastIndex = 0;
    let contentMatches = false;
    for (const match of content.matchAll(expression)) {
      contentMatches = true;
      ranges.push([match.index, match.index + match[0].length]);
    }
    if (!nameMatches && !contentMatches) return null;
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function contexts(content, ranges) {
  // Ranges are ordered, so each content character is scanned at most once.
  let line = 1;
  let lineStart = 0;
  let cursor = 0;
  return ranges.map(([start]) => {
    while (cursor < start) {
      if (content.charCodeAt(cursor) === 10) {
        line += 1;
        lineStart = cursor + 1;
      }
      cursor += 1;
    }
    const end = content.indexOf('\n', start);
    return { line, text: content.slice(lineStart, end < 0 ? content.length : end).trim() };
  });
}

/** Search Markdown without executing note contents or following vault child symlinks. */
export async function searchVault({ vault, query, caseSensitive = false, path = '', exclude = [] }) {
  const expressions = parseQuery(query, caseSensitive);
  const prefix = folderPrefix(path);
  const root = await realpath(resolve(vault));
  if (!(await stat(root)).isDirectory()) throw new Error('Vault must be a directory.');
  const rules = await ignoreRules(root);
  const results = [];
  for (const file of await markdownFiles(root)) {
    if (!file.startsWith(prefix) || rules.some((rule) => rule.test(file)) ||
        exclude.some((pattern) => matchesGlob(file, pattern))) continue;
    const content = await readFile(join(root, ...file.split('/')), 'utf8');
    const ranges = matchFile(file.slice(file.lastIndexOf('/') + 1), content, expressions);
    if (ranges !== null) results.push({ file, matches: contexts(content, ranges) });
  }
  return results;
}
