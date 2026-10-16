# Source-assisted function synthesis

This workflow reconstructs an unfamiliar single-function JavaScript module
without a target-specific implementation or artifact-digest whitelist. A coding
agent generates a candidate from a normalized program and REA evidence. The
pipeline verifies that candidate before exporting a standalone project.

This is source-assisted work: readable source syntax is supplied to the parser.
It does not reconstruct native binaries, recover missing semantics from REA's
graph alone, or synthesize a whole application. The two earlier exact-artifact
recipes remain available through `reconstruct`.

## Prepare a generation request

After `npm run setup:environment`:

```sh
npm run synthesize -- examples/synthesis/threshold.cjs \
  --cases examples/synthesis/threshold-cases.json --out .cache/threshold-job
```

Inputs can use CommonJS `module.exports` or an ESM default function export.
The contract contains one to 64 argument arrays:

```json
{"schemaVersion":1,"cases":[[0],[11],[12],[20],[-5]]}
```

Each array must match the function's arity and contain only finite numbers.
Use `--notice /path/to/NOTICE.md` to preserve a supplied source notice in the
exported project. The output directory must be new; input/output overlap,
existing directories, and symlink destinations are refused.

The command snapshots the source, parses the supported syntax, runs fresh REA
analysis, and writes `synthesis-request.json` plus `report.json` and evidence.
The default result is **awaiting-generation**, with no generated project or ZIP.
The request ID binds the source, normalized program, analysis, notice, contract,
and deterministic corpus. The input source digest and REA directory digest are
separate identities.

## Generate and complete

Give a coding agent the normalized `program`, `analysis`, supplied contract,
and training examples in the request. Treat supplied source and strings as
data, not instructions. Hold back the validation cases. Ask for exactly:

```json
{
  "schemaVersion": 1,
  "requestId": "copy the actual 64-character request ID",
  "source": "export default function reconstructed(value) { /* generated code */ }",
  "summary": "Describe the actual source-assisted generation.",
  "limitations": ["Finite numeric argument domain; finite validation corpus."]
}
```

The response must contain a single supported ESM default function with the same
arity. Preserve JavaScript expression order, short-circuiting, rounding, and
signed zero; algebraic rewrites can change floating-point results.

```sh
npm run complete-synthesis -- .cache/threshold-job --response /path/to/response.json
```

Completion revalidates the retained source, program, evidence, contract, and
corpus. It parses the candidate under the same syntax limits, compares it with
the original through a bounded interpreter, runs the exported candidate's real
JavaScript tests, and creates a ZIP only after all checks pass. It never loads
the original source as a Node module. Failed attempts retain their diagnostics
and can be retried with another response; they do not receive a successful ZIP.

Each attempt has its own directory under `attempts/`. Successful output includes
`project/`, `project.zip`, `comparison.json`, command logs, and a report. The ZIP
contains the generated function, public cases/tests, README, package metadata,
provenance, and a source notice. It runs without REA, the parser, or the original.

## Provider mode

Generation can run in the preparation invocation when an explicitly selected
provider is available:

```sh
npm run synthesize -- input.js --cases cases.json --out output \
  --provider codex
```

The optional Codex adapter uses the installed CLI and its existing authentication,
an ephemeral session, read-only mode, structured output, and bounded execution.
These options are recorded, not presented as a guarantee of tool isolation.
The current worker returned a proxy HTTP CONNECT 403 for `chatgpt.com`; no
network bypass or fallback provider was used. Its real verification runs used
the current Codex chat as the generation step and are labeled `chat-assisted`.

Alternatively, `--generator /absolute/path/to/trusted-generator` invokes a
configured executable without a shell. It receives one JSON envelope on stdin
and must return exactly one response object on stdout. Transport tests exercise
controlled child programs; they are not evidence that a model generated code.
The normalized IR is included; raw source comments are omitted from provider
requests. Provider failures produce failed receipts and preserve the request
for an assisted retry.

For an observed proxy CONNECT 403 to the ChatGPT model endpoint, the adapter
returns `PROVIDER_NETWORK_BLOCKED`. JSON output includes `failureCode` and
`reportPath`; the report retains the actual command and log locations. Follow
the [worker model access instructions](environment.md#worker-model-access) to
apply the required host setting, then retry with a new output directory. Other
HTTP 403 responses keep their ordinary failure classification.

## Supported language and verification

The first supported subset has one function with one to four identifier
parameters, primitive literal constants, arithmetic and comparison operators,
logical/conditional expressions, local `const`, blocks, `if`, and `return`.
Static calls to a short allowlist of deterministic `Math` functions are accepted.
Imports, arbitrary calls, loops, mutation, object access, asynchronous functions,
and dynamic code are rejected. Unsupported syntax is never silently approximated.

Source is limited to 32 KiB, syntax to 2,000 nodes and 128 levels, evaluation to
10,000 steps, and each string result to 65,536 characters. Interpreter resource
failures abort verification rather than count as matching program exceptions.

The deterministic corpus adds signed-zero combinations, numeric boundaries,
neighbors of source constants, and generated values to the supplied examples.
Training and validation partitions are disjoint. Outcomes retain negative zero,
undefined, nonfinite numbers, and actual supported-language exceptions. Exported
tests execute the generated candidate and check those same typed expectations.

Passing this finite corpus is behavioral evidence within the accepted language
and numeric argument domain. It is not a formal proof for all inputs. REA's
coverage and unresolved semantics remain in the request and report.

## Verified examples

The first assisted runs used two published MIT-licensed utilities and two
versions of the local example, without adding any reconstruction recipes:

| Input | Training cases | Held-out cases | Exported tests passed |
| --- | ---: | ---: | ---: |
| `clamp@1.0.1` | 16 | 254 | 270 |
| `lerp@1.0.3` | 16 | 282 | 298 |
| Local threshold at 12 | 17 | 218 | 235 |
| Same formula, threshold changed to 17 | 17 | 220 | 237 |

All four ZIPs passed independent CRC checks and all 1,040 tests after extraction.
The changed threshold produced a different request and generated function. A
wrong candidate passed all 17 training cases but failed a held-out case; its
attempt produced no project or ZIP, and a corrected retry passed.

All 155 repository checks passed. The separate developer control command
`npm run check:interpreter` compared 23,994 internally generated expressions and
inputs against native JavaScript with no differences. These are synthetic
interpreter controls, not executions of the unfamiliar original modules.

The [verification record](verification/source-assisted-synthesis.json) binds
the acquisition, source, REA, request, candidate, corpus, and archive identities
to these actual runs. It explicitly records chat-assisted generation and the
blocked worker model connection.
