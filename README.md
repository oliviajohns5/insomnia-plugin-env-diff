# insomnia-plugin-env-diff

[![npm version](https://img.shields.io/npm/v/insomnia-plugin-env-diff.svg)](https://www.npmjs.com/package/insomnia-plugin-env-diff)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Local-only environment comparison for Insomnia. v1.0.2 adds desktop export diagnostics and current-environment fallback when Insomnia does not expose environment resources from a menu action.

Env Diff exports a redacted Markdown report showing environment drift: missing keys, prod/dev URL mismatches, duplicate environment names, empty or short secret-like values, and suspicious same values across environments.

## Why

API teams often keep Base, Dev, Staging, and Production environments in one workspace. Over time those environments drift: keys go missing, staging points to prod, prod points to sandbox, and copied secrets leak into the wrong place.

## Features

- Adds a key matrix across all exposed environments
- Adds desktop export diagnostics/current-environment fallback
- Compares all Insomnia environments in the workspace
- Flags keys missing from one or more environments
- Flags dev/staging environments pointing at production-like hosts
- Flags production environments pointing at dev/test hosts
- Flags empty or suspiciously short secret-like values
- Flags same non-secret values across environments
- Flags duplicate environment names
- Exports a local redacted Markdown report
- No cloud, no telemetry, no backend, no dependencies

## Install

From Insomnia:

1. Open **Preferences** → **Plugins**
2. Enter `insomnia-plugin-env-diff`
3. Click **Install Plugin**

Manual macOS install:

```bash
cd "$HOME/Library/Application Support/Insomnia/plugins"
npm install insomnia-plugin-env-diff
```

## Usage

Run:

```text
Env Diff: Export Report
```

The action is exposed through `workspaceActions`, `requestGroupActions`, and `requestActions`. In Insomnia 13 it may appear in the New Request dropdown.

## Example report

```markdown
# Insomnia Env Diff Report

## Summary

- High: 1
- Medium: 2
- Low: 3

| Severity | Type | Location | Message | Preview |
|---|---|---|---|---|
| high | dev-points-to-prod | Dev.base_url | Development/staging environment points at production-like host | Dev: api.production.example.com |
```

## Desktop validation notes

In some Insomnia Desktop menu contexts, `context.data.export.insomnia()` may expose zero environment resources. Env Diff now reports `env-export-empty` and uses `context.request.getEnvironment()` as a current-environment fallback, so single-environment hygiene still works. Pairwise missing-key drift requires Insomnia to expose at least two environments.

## Privacy

- Local-only
- No network calls
- No analytics
- No account required
- Exports with `includePrivate: false`
- Secret-like values are redacted in reports

## Development

```bash
git clone https://github.com/oliviajohns5/insomnia-plugin-env-diff.git
cd insomnia-plugin-env-diff
npm test
npm run test:packaged
npm pack --dry-run
```

## Verified QA

- `node --check main.js`
- `node --check test.js`
- `node --check real-insomnia-packaged-test.js`
- `node --check qa-packaged.js`
- `npm test`
- `npm run test:packaged`
- `npm pack --dry-run`
- isolated tarball install
- package metadata validation
- credential literal scan

## Requirements

- Insomnia
- Node.js/npm only for development or publishing

## License

MIT
