# Duration reconstruction specification

The second experiment reconstructs the public duration-conversion feature of
the MIT-licensed `ms@2.1.3` library. The original is a library, not a CLI; our
command-line adapter is an added interface. Source inspection informed this
specification, and an independently written implementation is checked against
actual calls to the pinned original. This is not a claim of clean-room work or
general automatic source synthesis.

## Artifact and evidence

- Published artifact: `https://registry.npmjs.org/ms/-/ms-2.1.3.tgz`.
- Artifact SHA-256: `f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6`.
- `package/index.js` SHA-256: `e5f0b6a946a9b2b356a28557728410717df54ea2f599edb619f9839df6b7b0e9`.
- Upstream commit: `1c6264b795492e8fdecbc82cb8802fcfbfc08d26`.

The intake accepts only that complete compressed artifact and validates its
four regular files against pinned sizes and digests. It does not offer general
TAR extraction. REA 6.5.0 cannot open this TGZ through `inspect-artifact`; the
pipeline analyzes the verified extracted directory directly. The compressed
artifact identity, extracted file identities, and REA directory identity are
separate links in the report.

REA's selected-source analysis covers `package.json` and `index.js`. The initial
run parsed one CommonJS source module, found its default export and five
function nodes, and reported zero parse failures and 55 semantic unknowns.
The `statistics.modules` count is zero because this is not a recovered bundle;
the application graph still contains the source module. Static coverage and
unknowns remain part of the report.

## Module behavior

`duration(value, options)` is available as a default and named ESM export.

A nonempty string of at most 100 UTF-16 code units can contain a decimal number,
an optional leading minus, zero or more ASCII spaces, and an optional unit.
Leading-dot fractions work. Leading whitespace, plus signs, exponents, trailing
decimal points, tabs, line breaks, and extra text are rejected. Unit matching
is case insensitive. Omitted units mean milliseconds. Invalid nonempty strings
return `undefined`; parsed negative zero remains negative zero.

| Unit | Accepted aliases | Milliseconds |
| --- | --- | ---: |
| Millisecond | millisecond(s), msec(s), ms | 1 |
| Second | second(s), sec(s), s | 1,000 |
| Minute | minute(s), min(s), m | 60,000 |
| Hour | hour(s), hr(s), h | 3,600,000 |
| Day | day(s), d | 86,400,000 |
| Week | week(s), w | 604,800,000 |
| Year | year(s), yr(s), y | 31,557,600,000 |

A finite number formats using the largest reached day, hour, minute, or second
threshold by absolute magnitude. It rounds the signed quotient with JavaScript
`Math.round`. Short output uses `d`, `h`, `m`, or `s`; smaller values retain their
number representation followed by `ms`.

Truthy `options.long` selects full unit names. Pluralization begins at an
absolute magnitude of 1.5 units, independently of signed rounding. For example,
negative half rounding can yield `-1 seconds`. Sub-second long output uses a
space before `ms`. Formatting does not select weeks or years.

Empty strings, invalid argument types, and nonfinite numeric inputs raise the
observed error. The public comparison corpus covers ordinary values and tagged
nonfinite numbers, negative zero, undefined results, and exceptions. Arbitrary
objects with side effects, custom getters, and hostile serialization are outside
the behavioral-equivalence claim.

## Command-line adapter

In Letstryrea, prefix these commands with `duration`; in the exported standalone
project, invoke them directly:

```sh
node bin/letstryrea.mjs parse "2 hours"
node bin/letstryrea.mjs format 5400000 --long
```

Successful parsing emits a JSON numeric literal and preserves `-0`; successful
formatting emits text. Invalid duration text emits `{"status":"invalid"}` and
returns exit code 1. Invalid command arguments return 2, and runtime errors
return 1. Formatting arguments accept finite signed decimal notation; JSON,
scientific notation, and hexadecimal numeric arguments are not CLI formats.

## Verification and limits

Each supported pipeline run analyzes the extracted package, exports our code,
runs its public test suite and demo, and compares fixed synthetic cases with
the verified original in separate bounded child processes. This recipe executes
that known reference intentionally; it never executes unknown inputs or npm
lifecycle scripts. A nonzero comparison count and all matching typed outcomes
are required before ZIP creation. The comparator hashes both implementations
before and after the run.

The project ZIP contains our source, tests, this specification, provenance,
and the upstream MIT notice. It excludes the original implementation, artifact,
comparison runner, and raw REA evidence. The generated project runs without REA
or the original package. Matching the finite comparison corpus does not prove
equivalence for every possible JavaScript object or input.
