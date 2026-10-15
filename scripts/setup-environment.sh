#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$(dirname -- "$script_directory")"
cd -- "$project_directory"

if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'Environment setup currently supports Linux with procps.' >&2
  exit 1
fi
for prerequisite in node npm ps; do
  if ! command -v "$prerequisite" >/dev/null; then
    printf 'Missing required command: %s\n' "$prerequisite" >&2
    exit 1
  fi
done
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 24 && minor >= 11) || major >= 26)) {
    throw new Error("Use Node.js 24.11+ within 24.x, or Node.js 26+; REA 6.5.0 does not support Node.js 25.");
  }
  console.log(`Node.js ${process.versions.node}; repository preference: ${readFileSync(".nvmrc", "utf8").trim()}`);
'
ps_version="$(ps --version)"
if [[ "$ps_version" != *procps* ]]; then
  printf '%s\n' 'Install procps: REA static analysis requires a procps-compatible ps.' >&2
  exit 1
fi

# Inherit the caller's registry, proxy, CA trust and cache configuration.
# Install only the committed dependency graph; never rewrite manifests here.
npm ci --ignore-scripts --omit=optional --engine-strict --no-audit --no-fund
npm ci --prefix "$project_directory/tools/rea" --ignore-scripts --omit=optional --engine-strict --no-audit --no-fund
node "$project_directory/scripts/verify-environment.mjs"
