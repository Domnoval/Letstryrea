# Letstryrea

Give the pipeline a supported application artifact and get an editable,
tested project plus a downloadable ZIP and verification report. The first
recipe exports the independently written Markdown search capability we
studied and compared with Obsidian 1.14.4.

The pipeline currently recognizes **only the exact studied Obsidian 1.14.4
application-update ASAR**. It applies a known reconstruction recipe. General
artifact-to-source synthesis and other apps/releases remain future work.

The implementation uses independently written JavaScript and Node.js built-ins.
It runs without Obsidian, REA, or third-party runtime dependencies. Node.js 24+
is required; the development runtime is pinned in `.nvmrc`.

## Run the artifact pipeline

On Linux with Node.js 24.11+ within 24.x (24.19.0 is pinned in `.nvmrc`),
npm, Bash, and procps installed, restore and verify the development tools:

```sh
npm run setup:environment
```

This installs the locked REA 6.5.0 tooling separately from the application,
checks its real MCP connection and JavaScript analysis, and runs the project
tests and demo. It works from a fresh checkout without the original cloud
snapshot. See [environment recovery](docs/environment.md).

Then run:

```sh
npm run reconstruct -- /path/to/obsidian-1.14.4.asar --out output/obsidian
```

In the prepared cloud environment, REA is already installed. The tested artifact
is `/workspace/.onboarding/artifacts/obsidian/obsidian-1.14.4.asar`.
You can select another REA executable with `--rea /path/to/rea`.
Analyzer discovery prefers `tools/rea/node_modules/.bin/rea`, then the legacy
cloud tools, then `rea` on `PATH`.

The output directory must be new. A successful run contains:

```text
output/obsidian/
  project/       Editable standalone search project
  project.zip    Downloadable copy of that project
  report.json    Machine-readable run result
  report.md      Human-readable result and limitations
  evidence/     Fresh REA analysis and command/test logs
```

The pipeline verifies the artifact's full digest, embedded source digest, and
12 recorded source anchors. It then runs fresh REA inspection/selected-source
analysis, exports our existing search implementation, runs its 28 tests and a
functional demo, and creates the ZIP only after those checks pass. The original
application is read as data, never executed by this pipeline.

Fresh generated-project checks are separate from the recipe's earlier 69
live Obsidian comparisons. The reports preserve that distinction and retain
partial analysis coverage. The ZIP excludes the original artifact and raw
analysis; complete Evidence remains in the local job directory.

Unsupported inputs produce an explanation and report with exit code 3,
without a generated project or ZIP. Failures return 1, invalid requests/output
collisions return 2, and successful jobs return 0. Existing output paths are
never overwritten. `--json` emits a small result suitable for a future upload
interface. See [the pipeline contract](docs/pipeline.md) for stage details.

## Try it

```sh
npm run demo
npm start -- search examples/vault "nebula telescope" --format json
npm start -- search:context examples/vault nebula --path notes --format json
npm test
```

You can also invoke the executable directly:

```sh
node bin/letstryrea.mjs search:context /path/to/your/vault nebula --format json
```

The context command returns editable, ordinary JSON:

```json
[
  {
    "file": "notes/Observing.md",
    "matches": [
      {"line": 3, "text": "Use a telescope to find the Orion Nebula."},
      {"line": 4, "text": "The nebula is visible on a clear night."}
    ]
  }
]
```

The example above uses `--path notes`. All paths in results are relative to
the supplied vault; line numbers start at one. A file can match by its basename
alone and have an empty `matches` array. Separate occurrences on one line can
produce repeated line contexts, matching the inspected search behavior.

## Search behavior

Use unquoted literal search terms separated by spaces. Every term must match
the Markdown filename or the file's contents. For example, the shell argument
`"nebula telescope"` requires both words; the shell removes those quotes before
the tool receives the query. Matching is case insensitive by default.

| Option | Purpose |
| --- | --- |
| `--case` | Match case sensitively. |
| `--path notes` | Restrict to a folder, with a directory boundary. |
| `--limit 10` | Return at most ten files; zero means unlimited. |
| `--total` | Count matching files before the limit; available on `search`. |
| `--format json` | Return structured JSON; text is the default. |
| `--exclude 'archive/**'` | Exclude a vault-relative glob; repeat as needed. |

Markdown extensions are case insensitive. Hidden paths and child symlinks are
skipped. Excluded-file settings in `.obsidian/app.json` are supported through
`userIgnoreFilters`: literal case-insensitive path prefixes and `/regex/`
patterns. These settings are different from the explicit `--exclude` globs.
The tool reads notes and configuration without changing them.

Results have deterministic path order. Empty JSON results are `[]`, and total
JSON results are `{"total":0}` when no files match. Errors go to stderr; exit
code 2 identifies invalid arguments/unsupported queries, and code 1 identifies
filesystem or configuration failures.

## Scope and evidence

The prototype supports ordinary unquoted terms. Search-language phrases,
regular-expression queries, negation, grouping, property operators, metadata,
Canvas search, the graphical editor, and application-wide reconstruction are
outside its scope. Unsupported query constructs are rejected explicitly.

Obsidian 1.14.4's official application-update ASAR was the analysis target.
REA supplied an inventory and partial static application graph. Further inert
inspection established a narrow behavior specification; an independently
written implementation and executable tests exercise that specification.
The artifact and proprietary source are not distributed with this project.

See [the reconstruction specification](docs/reconstruction-spec.md) for the
source digests, byte-level evidence anchors, supported semantics, and adapter
differences. Tests use disposable synthetic vaults and invoke the actual CLI.

The first verification run passed **28 CLI tests and 69 comparisons against
the real Obsidian 1.14.4 desktop CLI**. The comparison covers 35 cases over
21 synthetic files. See [the validation record](docs/validation.md) for exact
scope, normalization rules, receipts, and reproduction instructions.

## Compare with a running Obsidian

The optional comparison requires Obsidian 1.14.4 with its CLI enabled. Create
a dedicated synthetic vault:

```sh
npm run compare:obsidian -- --prepare /tmp/letstryrea-comparison
```

Open that folder as a vault in Obsidian, then run:

```sh
npm run compare:obsidian -- \
  --obsidian-cli /absolute/path/to/obsidian-cli \
  --vault /tmp/letstryrea-comparison
```

The runner checks the fixture bytes, version, running vault identity, and
cached excluded-file settings before comparing outputs. It preserves context
order and duplicate contexts while normalizing file order and the native
no-match sentinel. A failed preflight or comparison returns a failing exit
status. Fresh results go to `.cache/obsidian-comparison.json`.

The first manually verified reconstruction is now available through an
automated, recipe-based intake/analysis/export/test/package workflow. A web
upload interface and general code synthesis remain future work.
