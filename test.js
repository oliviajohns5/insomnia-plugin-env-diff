'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('./main');
const t = plugin.__test;

const workspace = JSON.stringify({ resources: [
  { _type: 'environment', name: 'Dev', data: { base_url: 'https://api.production.example.com', api_key: 'short', shared: 'same', nested: { region: 'us' }, feature_flag: true } },
  { _type: 'environment', name: 'Prod', data: { base_url: 'https://api.dev.example.com', shared: 'same', nested: { region: 'us' }, feature_flag: 'true', client_secret: '' } },
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
  for (const expected of ['missing-key', 'same-value', 'type-drift', 'short-secret', 'empty-secret', 'dev-points-to-prod', 'prod-points-to-dev', 'duplicate-environment-name']) assert(types.has(expected), expected);
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


  const pasted = '{"Dev":{"base_url":"https://api.production.example.com","api_key":"short","shared":"same"},"Prod":{"base_url":"https://api.dev.example.com","shared":"same","client_secret":""}}';
  const prompted = t.promptedEnvironmentsFromText(pasted);
  assert.strictEqual(prompted.length, 2, 'parses pasted two-env object');
  const promptedRaw = t.mergeSyntheticEnvironments(emptyExport, prompted);
  const promptedTypes = new Set(t.diffEnvironments(promptedRaw, { diagnostics: t.exportDiagnostics(emptyExport, t.parseExport(emptyExport)) }).map(f => f.type));
  assert(promptedTypes.has('dev-points-to-prod'), 'pasted env catches dev prod URL');
  assert(promptedTypes.has('prod-points-to-dev'), 'pasted env catches prod dev URL');
  assert(promptedTypes.has('missing-key'), 'pasted env catches missing key');
  assert(t.makeKeyMatrix(promptedRaw).includes('| base_url |'), 'pasted key matrix works');

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
      const jsonOut = out.replace(/\.md$/i, '.json');
      assert(fs.existsSync(jsonOut), 'action writes JSON sidecar');
      const sidecar = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
      assert.strictEqual(sidecar.schema, 'insomnia-env-diff/v1');
      assert(sidecar.summary.totalFindings > 0, 'sidecar has findings summary');
      assert(Array.isArray(sidecar.findings), 'sidecar findings array');
      assert(fs.readFileSync(out, 'utf8').includes('Insomnia Env Diff Report'));
      assert.strictEqual(c.alerts.length, 1);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-prompt-'));
  try {
    const out = path.join(tmp2, 'prompt.md');
    const prompts = [];
    const c = {
      alerts: [],
      data: { export: { insomnia: async () => emptyExport } },
      app: {
        prompt: async (title, opts) => { prompts.push({ title, opts }); return pasted; },
        showSaveDialog: async () => out,
        alert: async (title, msg) => c.alerts.push({ title, msg }),
      }
    };
    await plugin.requestActions[0].action(c, {});
    const body = fs.readFileSync(out, 'utf8');
    const jsonOut = out.replace(/\.md$/i, '.json');
    assert(fs.existsSync(jsonOut), 'prompt action writes JSON sidecar');
    const sidecar = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    assert(sidecar.findings.some(f => f.type === 'dev-points-to-prod'), 'sidecar includes pasted findings');
    assert.strictEqual(prompts.length, 1, 'prompt shown for empty env export');
    assert(body.includes('dev-points-to-prod'), 'prompt action report includes pasted findings');
    assert(body.includes('## Key Matrix'), 'prompt action report includes matrix');
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }

  console.log('PASS: all tests');
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
