'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('./main');
const t = plugin.__test;

const workspace = JSON.stringify({ resources: [
  { _type: 'environment', name: 'Dev', data: { base_url: 'https://api.production.example.com', api_key: 'short', shared: 'same', nested: { region: 'us' } } },
  { _type: 'environment', name: 'Prod', data: { base_url: 'https://api.dev.example.com', shared: 'same', nested: { region: 'us' }, client_secret: '' } },
  { _type: 'environment', name: 'Prod', data: { base_url: 'https://api.production.example.com', shared: 'same', extra: 'x' } }
] });

function ctx(out) {
  const alerts = [];
  return { alerts, data: { export: { insomnia: async () => workspace } }, app: { showSaveDialog: async () => out, getPath: async key => key === 'documents' ? os.tmpdir() : '', alert: async (title, msg) => alerts.push({ title, msg }) } };
}

async function main() {
  assert(Array.isArray(plugin.workspaceActions));
  assert(Array.isArray(plugin.requestGroupActions));
  assert(Array.isArray(plugin.requestActions));
  const parsed = t.parseExport(workspace);
  assert.strictEqual(t.collectEnvironments(parsed).length, 3);
  assert.strictEqual(t.flatten({ a: { b: 1 }, c: 2 })['a.b'], 1);
  assert.strictEqual(t.hostOf('https://api.example.com/x'), 'api.example.com');
  const findings = t.diffEnvironments(workspace);
  const types = new Set(findings.map(f => f.type));
  for (const expected of ['missing-key', 'same-value', 'short-secret', 'empty-secret', 'dev-points-to-prod', 'prod-points-to-dev', 'duplicate-environment-name']) assert(types.has(expected), expected);
  const report = t.makeMarkdown(findings, workspace);
  assert(report.includes('# Insomnia Env Diff Report'));
  assert(report.includes('## Key Matrix'));
  assert(report.includes('| base_url |'));
  assert(t.makeKeyMatrix(workspace).includes('missing'));
  assert(report.includes('| Severity | Type | Location | Message | Preview |'));
  assert(!report.includes('shortsecretlongvalue'));

  const emptyExport = JSON.stringify({ resources: [] });
  const fallbackContext = { request: { getEnvironment: () => ({ base_url: 'https://api.production.example.com', api_key: 'short', shared: 'same' }) } };
  const built = t.buildActionExport(emptyExport, fallbackContext, {});
  assert.strictEqual(built.usedFallback, true, 'uses current environment fallback');
  const fallbackEnvFindings = t.diffEnvironments(built.raw, { diagnostics: built.diagnostics });
  const fallbackTypes = new Set(fallbackEnvFindings.map(f => f.type));
  assert(fallbackTypes.has('env-export-empty'), 'reports empty env export diagnostic');
  assert(fallbackTypes.has('not-enough-environments'), 'reports single env limit');
  assert(fallbackTypes.has('short-secret'), 'single env catches short secret');
  assert(fallbackTypes.has('single-env-prod-url'), 'single env catches prod-like URL');
  assert(t.makeKeyMatrix(built.raw).includes('base_url'), 'fallback key matrix has current env keys');

  const clean = t.diffEnvironments(JSON.stringify({ resources: [{ _type: 'environment', name: 'Dev', data: { base_url: 'https://dev.example.com' } }, { _type: 'environment', name: 'Prod', data: { base_url: 'https://prod.example.com' } }] }));
  assert.strictEqual(t.summarize(clean).high, 0);
  const one = t.diffEnvironments(JSON.stringify({ resources: [{ _type: 'environment', name: 'Only', data: {} }] }));
  assert(one.some(f => f.type === 'not-enough-environments'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-'));
  try {
    for (const action of [plugin.workspaceActions[0], plugin.requestGroupActions[0], plugin.requestActions[0]]) {
      const out = path.join(tmp, Math.random().toString(36).slice(2) + '.md');
      const c = ctx(out);
      await action.action(c);
      assert(fs.existsSync(out));
      assert(fs.readFileSync(out, 'utf8').includes('Insomnia Env Diff Report'));
      assert.strictEqual(c.alerts.length, 1);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('PASS: all tests');
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
