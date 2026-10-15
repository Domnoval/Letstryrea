# Markdown vault search: reconstruction specification

This is an independently written reconstruction of a narrow search capability
observed in Obsidian 1.14.4. It is not a reconstruction of Obsidian as a whole.
The specification below comes from inert inspection of the official application
update ASAR; no original source is copied into this project. Static inspection
does not establish complete runtime equivalence. Any subsequent desktop
comparison must record its actual results and remaining gaps separately.
The completed live comparison for this implementation is recorded in
[validation.md](validation.md).

## Supported query subset

- Search Markdown files, including an uppercase `.MD` suffix. Match each
  unquoted literal token against both the basename **including its extension**
  and the complete file content. A directory name alone is not a filename hit.
- Separate tokens using ASCII spaces (`U+0020`) and require every token to
  match somewhere in the file or its basename. Tokens can match different
  lines; one can match the basename while another matches content. Tabs and
  newlines inside a token are literal characters, not token separators.
- A token matches substrings, rather than whole words. Regex punctuation in
  an otherwise supported token is literal. Quoting, regular-expression query
  syntax, boolean operators, exclusions, grouping, properties, and search
  operators are outside this implementation's supported subset and must be
  rejected explicitly rather than silently interpreted as plain text.
- Match case insensitively by default. Use JavaScript regular expressions
  over escaped tokens with `gmi`, or `gm` when case sensitivity is enabled.
  There is no Unicode `u` flag. Lowercasing both strings is not a substitute:
  JavaScript's non-Unicode regex case behavior is the observed contract.
- An empty query is an error (`Missing required parameter: query` in the
  native handler). A nonempty query containing only ASCII spaces is an error
  (`Invalid search query.`). Quoted empty queries are outside this subset.

Obsidian's quoted matcher applies Unicode word boundaries to content while
allowing partial filename matches. Supporting quotes as a simple substring
would claim behavior that the inspected implementation does not provide.

## Results and context

Each matching file has the shape:

```json
{"file":"notes/example.md","matches":[{"line":2,"text":"A matching line"}]}
```

Find nonoverlapping occurrences of each token across the whole content. Sort
their ranges by start and merge overlapping **or touching** ranges, including
duplicates contributed by repeated query tokens. Return one context entry for
each resulting range, in ascending position order. The line number is one
plus the count of `\n` characters before the range's start. The text is the
entire starting line with JavaScript `trim()` applied; it is not merely the
matched substring. A range spanning a newline still contributes its starting
line only. CRLF line endings work because splitting uses LF and trimming
removes the trailing CR.

There is deliberately no deduplication by line number. For query `alpha`,
`alpha alpha` produces two equal context entries, while `alphaalpha` produces
one because the two occurrence ranges touch and merge. Query `aa` in `aaaa`
also produces one merged context entry. A token matching both basename and
content contributes its content occurrences. A filename-only matching file
appears with `matches: []`.

The CLI exposes `search` for filenames and `search:context` for contexts:

| Mode | JSON output when files match | Text output when files match |
| --- | --- | --- |
| `search` | Array of matching relative file paths | One file path per line |
| `search:context` | Array of objects shown above | `file:line: text` per context; just `file` for a filename-only match |
| `search --total` | `{"total":n}` | Decimal count of matching **files** |

In the original native handlers, without `total`, no matches produces the exact string `No matches found.`
in both commands, even when JSON was requested. The native handlers do not
append a newline; a terminal adapter may add one. `search --total` returns zero
(or `{"total":0}`) for no matches. There is no native `total` flag on
`search:context`.

The reconstruction deliberately returns `[]` for empty JSON results, so its
JSON output stays machine-readable. Its empty text result retains the original
message. Comparisons normalize this adapter difference.

## Filtering, limits, and ordering

The native optional `path` filter appends `/` unless already present, then
performs a case-sensitive prefix check against each relative file path.
`notes` therefore includes `notes/a.md` and excludes `notes-other/a.md`.
The native handler itself does not normalize `.` or a leading slash.

Native `limit` uses decimal `parseInt`; only a result greater than zero
restricts the number of returned **files**. It applies after finding all
matching files and never truncates contexts within a file. `total` counts all
matching files before the limit. The reconstruction can validate CLI values
more strictly as an explicitly documented adapter choice.

Native file order comes from `vault.getMarkdownFiles()`: a stack traversal of
the vault tree in reverse child order, with no search-handler sorting.
The reconstruction uses deterministic sorted relative paths. This is an
intentional difference; comparisons should canonicalize file order and avoid
using a small limit when comparing whole result sets. Context order and
repeated entries remain significant.

Obsidian skips paths matched by its `userIgnoreFilters` setting:

- Read the array of strings from the vault setting (normally
  `.obsidian/app.json`); trim each string and skip empty entries.
- A string longer than two characters beginning and ending in `/` is a
  case-insensitive JavaScript regex over the relative path. Invalid regexes
  are logged and skipped by the native implementation.
- Every other string is a case-insensitive literal path **prefix**. There
  is no directory-boundary requirement: `private` excludes both
  `private/a.md` and `private-other.md`. Use `private/` to restrict a folder.
- There is no gitignore glob or negation behavior in these inspected filters.

Filesystem symlinks, hidden files, unreadable files, resource limits, malformed
configuration, and traversal outside a supplied vault need explicit local
policies. Such policies are reconstruction choices, not behavior established
by these native search handlers. Metadata-dependent search and Canvas files
are outside the selected Markdown workflow.

## CLI adapter and verification boundary

This project uses ordinary CLI `--flags` and positional vault/query arguments.
Obsidian's native CLI instead receives arguments such as `query=alpha`,
`path=notes`, `limit=2`, `format=json`, and the bare `case` or `total` flags.
Its argument parser stores raw strings: `case=false` and `case=0` are truthy
and enable case sensitivity, while `case=` does not. This quirk need not be
reproduced by the ergonomic adapter. Behavioral comparisons should translate
the arguments to the native names and values.

The observations here are certain about the inspected code's control flow,
not about the surrounding application's file loading, caching, configuration
initialization, or behavior on every desktop platform. The prior REA run
analyzed five selected files and reported 195 modules without parse failures;
it retained partial source and semantic coverage. It did not itself execute
Obsidian or validate a reconstruction. A differential check against a complete
running application is separate evidence; static expectations alone must not
be described as a successful Obsidian comparison.

## Source provenance

Official artifact: Obsidian 1.14.4 application-update ASAR from
`obsidianmd/obsidian-releases`, acquired using the manifest at commit
`21b8529434931f20d86aa65b942501e9090488c0`.

- ASAR SHA-256:
  `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`
- Embedded `app.js`: 3,942,126 bytes; SHA-256:
  `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9`

The following are zero-based UTF-8 byte intervals in embedded `app.js`;
end offsets are exclusive. They allow inspection without redistributing
proprietary source. Hashes cover the exact bytes in each interval.

| Observation | Byte interval | Region SHA-256 |
| --- | --- | --- |
| Basename and lowercase extension helpers | 547825–548336 | `b43b5b17676903fc57604459c4d07a19380949e641da0674c187a7b81fd64e85` |
| Range sorting and merging | 1260683–1260850 | `63a6a4224d06483b0825827f57beac495b5cc631888dec2ea76e80c27d51719e` |
| Vault Markdown enumeration | 1433798–1434094 | `34a5801d6e8dd908805727fcc3cfa1dbcc2920712ad5bdc9796ce36a381675ed` |
| Regex case flags and occurrence ranges | 1458632–1459004 | `dc456c15b945b7da0e4e3666b14519416f23cf775f0c6b0cdc39e4512b161f02` |
| Quoted matcher | 1460736–1461434 | `58a7204e7e84929dbd0ecd7cef5266ea8a413b23707909ebb8f9cf9ce3e7266b` |
| Literal-token matcher | 1461434–1461783 | `f787c90c9f2da1cf0c69260c15f733ab0459ee0c370bd1e6f566ee83580465f8` |
| AND combination | 1462263–1462586 | `afae135e52f93bab82548521e39c7205fa665193f9b29d305cfdfb2372ec3db4` |
| Query tokenizer | 1466974–1468390 | `98c684713ecd7f3d0c22cecbf4abdbc7475d91654bde75c6839cda250c0a9904` |
| Filename/content inputs and range normalization | 1475171–1477037 | `418d0cba2dda7d8e1de747ff4ace78cb8db536edee2b84afd4d37afd412da488` |
| Native CLI argument parsing | 1628304–1628666 | `57991476f78ba91b7ffdc06709272083bf5be965053a2a260659e5136a61816a` |
| Ignore-filter compilation | 1770651–1771197 | `f198f6b7d82fa290da473c9bd85d6138842e4b8c10bfa8b10987ade5a2b9b12c` |
| Shared search loop and both CLI handlers | 2709159–2711801 | `be4d3919b78c2012623125f6447057bb98c29e1c6afba4977d8ff288eadfd8e6` |

Native `search` registration begins at byte 2709983 and `search:context`
begins at byte 2710855. Acquisition and earlier analysis receipts are stored
outside the checkout under `/workspace/.onboarding`; the archive and copied
proprietary source are intentionally not project dependencies.
