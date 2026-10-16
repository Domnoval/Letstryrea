# Environment recovery

The project and its analysis tooling can be restored from Git without the
original Codex environment snapshot. The application has no third-party runtime
dependencies; REA is a separate development tool with its own checked-in lockfile
under `tools/rea/`.

## Restore a fresh checkout

Use Linux, Bash, npm, procps-compatible `ps`, and Node.js 24.11 or newer on the
24.x release line. `.nvmrc` records the tested Node.js version, 24.19.0; npm 11.9.0
was used for verification. REA has a higher Node.js minimum than the standalone
search implementation.

```sh
git clone https://github.com/Domnoval/Letstryrea.git
cd Letstryrea
npm run setup:environment
```

Setup resolves the checkout from its own script location, uses `npm ci` for both
lockfiles, omits optional analysis integrations, and preserves inherited proxy
and certificate settings. It does not install system packages, change network
policy, configure credentials, or start a persistent application service.

The verification runs the repository tests and search demo, checks REA 6.5.0
through a real stdio MCP connection, and analyzes a small known-source fixture.
The fixture check requires two source modules, three exports, a resolved import,
consistent evidence projection, and unchanged input bytes. Generated fixtures,
logs, and evidence live under ignored `.cache/environment/`.

After dependencies are installed, repeat checks with:

```sh
npm run verify:environment
```

The reconstruction pipeline automatically finds the repository's REA installation.
An explicit `--rea` option takes precedence, and the original cloud installation
and `PATH` remain fallbacks.

## Artifacts and optional comparison runtime

The original Obsidian artifact, full analysis evidence, generated output, and
optional desktop comparison runtime are separate from the repository. Setup
does not download or distribute them. A fresh checkout can run the CLI tests,
search demo, MCP check, and known-source analysis without those files.

To rerun the supported reconstruction, separately provide the exact Obsidian
1.14.4 application-update ASAR described in
[the pipeline contract](pipeline.md). In the retained cloud workspace it is at
`/workspace/.onboarding/artifacts/obsidian/obsidian-1.14.4.asar`.
Recreating the optional live desktop comparison needs the separately documented
Obsidian installation; the historical comparison record is not a new test result.

## Codex Save and Publish

Repository recovery and Codex environment publication are separate operations.
A working cloud instance or a checked-in setup script does not prove that an
environment draft saved, that a publish attempt completed, or that the editor's
error cleared.

If the Environment panel is stuck on a prior publish attempt, use its existing
**Check status** control to retrieve that operation's result. Keep the environment
and draft until that result is known. This repository cannot repair Codex's
server-side draft-save or publish endpoints.

An installation command for a checkout at the original cloud path is:

```sh
cd /workspace/Letstryrea
npm run setup:environment
```

The setup command requires the repository revision containing these recovery
scripts. A clean-checkout setup validates reproducibility without claiming that
Codex itself saved or published a particular configuration.

## Worker model access

`synthesize --provider codex` also needs network access to the model service.
For a CLI signed in through ChatGPT, the observed endpoint is
`wss://chatgpt.com/backend-api/codex/responses` (with HTTPS transport as a
fallback). A working package-manager preset allows dependency installation but
does not include this host.

In the Codex Environment configuration, keep restricted networking and the
package-manager preset, add **`chatgpt.com`** to the custom allowed hosts, then
Save and Publish/apply the configuration. Confirm the running environment has
applied that revision before retrying. Saving and publishing working correctly
does not establish that this particular host is allowed.

A confirmed proxy CONNECT 403 for that endpoint is reported as
`PROVIDER_NETWORK_BLOCKED`. The CLI prints the retained run report path; the
report includes the actual provider command, bounded log paths, and failure
receipt. A plain HTTP 403 may instead be an authentication or service error and
does not establish a blocked proxy connection.

Retry with a new output directory to preserve the failed run:

```sh
npm run synthesize -- examples/synthesis/threshold.cjs \
  --cases examples/synthesis/threshold-cases.json \
  --out .cache/synthesis-jobs/codex-retry --provider codex --json
```

The worker's source request remains available after a connection failure.
Network access alone is not a successful reconstruction: the generated
candidate must still pass syntax, behavior, and exported-project checks before
the pipeline produces a ZIP. Setup scripts do not change the enforced network
policy or credentials.
