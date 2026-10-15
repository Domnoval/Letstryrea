# Verification of the first reconstruction

The reconstruction is now also available through an automated recipe-based
pipeline. Its separate [end-to-end record](pipeline.md#verified-example-run)
documents fresh artifact analysis, generated-project tests, ZIP extraction,
and failure handling. The original search comparison below remains historical
evidence and is not presented as a fresh comparison on every pipeline run.

The executable prototype passed 28 Node CLI tests and 69 differential
observations against the real Obsidian 1.14.4 Linux desktop CLI. No checks
were skipped. This validates the selected search behavior on the recorded
synthetic corpus; it does not establish equivalence for arbitrary vaults or
the rest of Obsidian.

## What ran

`npm test` invokes the actual reconstructed CLI with disposable vaults. It
checks filename/content AND matching, repeated and overlapping contexts,
literal punctuation, Unicode case folding, folder boundaries, exclusions,
Markdown discovery, symlink policy, output shapes, limits/counts, invalid
query syntax, malformed configuration, and filesystem errors.

`scripts/compare-obsidian.mjs` exercised 35 cases over 21 synthetic files.
The corpus includes filename-only results, terms spread across lines or
filename/content, adjacent ranges, repeated matches on one line, CRLF,
literal tabs/newlines/nonbreaking spaces, apostrophes, Greek sigma, Kelvin
sign, Turkish I, folder restrictions, uppercase extensions, configured
excluded files, hidden/non-Markdown files, no results, a single-match limit,
and totals before limits. It performs both `search` and `search:context`
for ordinary cases and `search` for the total case, giving 69 observations.

Before running, the included comparator verifies the exact fixture bytes,
on-disk configuration, installed app version, running vault path, and the
running app's cached excluded-file rules. It requires successful exits from
both processes. Disk state is checked again after comparison. This prevents
comparison against a different vault or inactive exclusion settings.

The recorded exclusion case returned only `VisibleIgnore.md`; the matching
file count before limiting the apple search was three. These known cases
also confirm that exclusions were active during the run.

## Comparison rules and limits

- File result order is normalized. The reconstruction sorts paths; native
  Obsidian uses vault enumeration order. Context order and duplicates remain
  significant.
- Obsidian's native JSON-mode no-match response is the text
  `No matches found.`; the reconstruction returns `[]`. The runner normalizes
  that explicit adapter difference.
- Count results normalize to `{total:N}`.
- A limit is tested with a single matching file and by counting before the
  limit. Selecting the same subset under a multi-match limit is not claimed
  because enumeration order differs.
- Advanced query operators, quoted phrases, regex queries, metadata/Canvas
  search, UI behavior, plugins, and full application reconstruction were not
  tested or implemented. Local hidden-file/symlink and error policies remain
  explicit implementation choices.

The JavaScript implementation was written independently from observed
behavior. No Obsidian application code or binary is included in the project.

## Recorded evidence

- [Live comparison receipt](verification/obsidian-1.14.4.json): actual
  commands, exits, raw/normalized results, version, live vault/config identity,
  fixture hashes, and timings. All 69 observations passed.
- [Artifact integrity receipt](verification/artifact-integrity.json): the
  official installer digest, matching analyzed/runtime ASAR digests, verified
  update signature, and signed Debian package chain for the virtual display.
- [Synthetic corpus](../test/fixtures/obsidian-search.json): public fixture
  contents, configuration, and cases, with no proprietary application code.
- [Static behavior specification](reconstruction-spec.md): source identity,
  hashed byte intervals, supported behavior, and remaining gaps.

The official installer SHA-256 is
`e70b7cd63787e7f798a84fec453f5c446b91877bd3f612e8fb98e9b76cc81120`.
Its application ASAR SHA-256 is
`146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`,
which matches the earlier statically analyzed artifact.

## Reproduce

The ordinary tests and demo need only Node.js 24+:

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

For another desktop, use the fixture preparation and live-comparison commands
in the [README](../README.md). An installed, running Obsidian 1.14.4 with its
CLI enabled is a separate prerequisite; the reconstruction runs independently.

The current cloud environment also retains an isolated official app and
userspace Xvfb under `/workspace/.onboarding/runtime-obsidian`. Its profile,
vault, socket, and cache are disposable and separate from personal data.
Its display uses Xauthority and has X11 TCP disabled. Electron runs with
`--no-sandbox` within the cloud task's existing isolation because the extracted
installer cannot set up its root-owned setuid sandbox. Use this fixture setup
only for the synthetic comparison data.

From `/workspace/Letstryrea`, the repeatable cloud-specific check is:

```sh
python3 /workspace/.onboarding/runtime-obsidian/runtime.py start
XDG_RUNTIME_DIR=/workspace/.onboarding/runtime-obsidian/xdg-runtime \
  npm run compare:obsidian -- \
  --obsidian-cli /workspace/.onboarding/runtime-obsidian/obsidian-1.14.4/obsidian-cli \
  --vault /workspace/.onboarding/runtime-obsidian/vault \
  --vault-name reaconstruction
python3 /workspace/.onboarding/runtime-obsidian/runtime.py stop
```

This requires the prepared corpus and expected configuration already present
in the disposable vault. To recreate that controlled state first, run
`python3 /workspace/.onboarding/runtime-obsidian/compare.py`; it creates the
fixture, writes settings while Obsidian is stopped, checks loaded settings,
and performs the comparison. To refresh missing runtime files, use its
`setup.py`, which verifies downloads before extraction.

Live desktop/display processes must be restarted after a cloud snapshot is
restored. No publication or fresh-task restoration is claimed by these tests.
