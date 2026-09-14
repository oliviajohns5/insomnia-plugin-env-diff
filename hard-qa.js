'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const plugin = require('./main');
const t = plugin.__test;

const workspace = JSON.stringify({ resources: [
  { _type: 'environment', name: 'Dev', data: { base_url: 'https://api.production.example.com', api_key: 'short', shared: 'same', nested: { region: 'us' } } },
  { _type: 'environment', name: 'Prod', data: { base_url: 'https://api.dev.example.com', shared: 'same', nested: { region: 'us' }, client_secret: '' } },
  { _type: 'environment', name: 'Prod', data: { base_url: 'https://api.production.example.com', shared: 'same', extra: 'x' } }
] });

async function run() {
  const results = [];
  async function check(name, fn) {
    await fn();
    results.push(name);
    console.log('PASS | ' + name);
  }

  await check('exports action aliases', () => {
    assert(Array.isArray(plugin.workspaceActions));
    assert(Array.isArray(plugin.requestGroupActions));
    assert(Array.isArray(plugin.requestActions));
  });

  await check('environment flattening and collection', () => {
    const parsed = t.parseExport(workspace);
    assert.strictEqual(t.collectEnvironments(parsed).length, 3);
    assert.strictEqual(t.flatten({ a: { b: 1 } })['a.b'], 1);
  });

  await check('detects all core drift types', () => {
    const types = new Set(t.diffEnvironments(workspace).map(f => f.type));
    for (const expected of ['missing-key', 'same-value', 'short-secret', 'empty-secret', 'dev-points-to-prod', 'prod-points-to-dev', 'duplicate-environment-name']) assert(types.has(expected), expected);
  });

  await check('markdown report is complete and escaped', () => {
    const findings = t.diffEnvironments(workspace);
    const md = t.makeMarkdown(findings, workspace);
    assert(md.includes('# Insomnia Env Diff Report'));
    assert(md.includes('## Key Matrix'));
    assert(md.includes('## Priority Fixes'));
    assert(md.includes('| Severity | Type | Location | Message | Preview |'));
    assert(!md.includes('undefined'));
    const weirdRaw = JSON.stringify({ resources: [
      { _type: 'environment', name: 'Dev|QA', data: { 'api|url': 'https://api.production.example.com' } },
      { _type: 'environment', name: 'Prod\nLive', data: { 'api|url': 'https://api.dev.example.com' } }
    ] });
    const weirdFindings = t.diffEnvironments(weirdRaw);
    weirdFindings.push({ severity: 'medium', type: 'manual|check', location: 'Dev|QA.api|url', message: 'message | pipe\nnewline', preview: 'preview | pipe\nnewline' });
    const weirdMd = t.makeMarkdown(weirdFindings, weirdRaw);
    assert(weirdMd.includes('Dev\\|QA'));
    assert(weirdMd.includes('Prod<br>Live'));
    assert(weirdMd.includes('api\\|url'));
    assert(weirdMd.includes('manual\\|check'));
    assert(weirdMd.includes('message \\| pipe<br>newline'));
    assert(weirdMd.includes('preview \\| pipe<br>newline'));
  });

  await check('json sidecar schema and summary are complete', () => {
    const findings = t.diffEnvironments(workspace);
    const sidecar = t.makeJsonSidecar(findings, workspace);
    assert.strictEqual(sidecar.schema, 'insomnia-env-diff/v1');
    assert.strictEqual(sidecar.summary.environmentsCompared, 3);
    assert(sidecar.summary.totalFindings > 0);
    assert(sidecar.summary.typeCounts['missing-key'] > 0);
    assert(Array.isArray(sidecar.matrix));
    assert(sidecar.matrix.some(row => row.key === 'base_url'));
    assert(Array.isArray(sidecar.priority));
    assert.strictEqual(sidecar.usedFallback, false);
    assert.strictEqual(sidecar.sourceDiagnostics, null);
    assert(Array.isArray(sidecar.findings));
  });

  await check('json sidecar path handles md and non-md names', () => {
    assert.strictEqual(t.jsonSidecarPath('/tmp/report.md'), '/tmp/report.json');
    assert.strictEqual(t.jsonSidecarPath('/tmp/report'), '/tmp/report.json');
  });

  await check('empty export diagnostics and current-env fallback', () => {
    const emptyExport = JSON.stringify({ resources: [] });
    const built = t.buildActionExport(emptyExport, { request: { getEnvironment: () => ({ base_url: 'https://api.production.example.com', api_key: 'short' }) } }, {});
    assert.strictEqual(built.usedFallback, true);
    const types = new Set(t.diffEnvironments(built.raw, { diagnostics: built.diagnostics }).map(f => f.type));
    assert(types.has('env-export-empty'));
    assert(types.has('single-env-prod-url'));
  });

  await check('prompted JSON fallback parses two-env object', () => {
    const pasted = '{"Dev":{"base_url":"https://api.production.example.com","api_key":"short"},"Prod":{"base_url":"https://api.dev.example.com","client_secret":""}}';
    const envs = t.promptedEnvironmentsFromText(pasted);
    assert.strictEqual(envs.length, 2);
    const raw = t.mergeSyntheticEnvironments(JSON.stringify({ resources: [] }), envs);
    const types = new Set(t.diffEnvironments(raw).map(f => f.type));
    assert(types.has('dev-points-to-prod'));
    assert(types.has('prod-points-to-dev'));
  });

  await check('all action aliases write md and json files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-hard-'));
    try {
      for (const [name, action] of [['workspace', plugin.workspaceActions[0]], ['group', plugin.requestGroupActions[0]], ['request', plugin.requestActions[0]]]) {
        const out = path.join(dir, name + '.md');
        const alerts = [];
        await action.action({ data: { export: { insomnia: async () => workspace } }, app: { showSaveDialog: async () => out, alert: async (...a) => alerts.push(a) } });
        const jsonOut = out.replace(/\.md$/i, '.json');
        assert(fs.existsSync(out));
        assert(fs.existsSync(jsonOut));
        const sidecar = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
        assert(sidecar.summary.totalFindings > 0);
        assert.strictEqual(sidecar.usedFallback, false);
        assert(sidecar.sourceDiagnostics && sidecar.sourceDiagnostics.environments === 3);
        assert.strictEqual(alerts.length, 1);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await check('prompt action writes md and json sidecar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-hard-prompt-'));
    try {
      const out = path.join(dir, 'prompt.md');
      const pasted = '{"Dev":{"base_url":"https://api.production.example.com"},"Prod":{"base_url":"https://api.dev.example.com"}}';
      const ctx = { data: { export: { insomnia: async () => JSON.stringify({ resources: [] }) } }, app: { prompt: async () => pasted, showSaveDialog: async () => out, alert: async () => {} } };
      await plugin.requestActions[0].action(ctx, {});
      const sidecar = JSON.parse(fs.readFileSync(out.replace(/\.md$/i, '.json'), 'utf8'));
      assert(sidecar.findings.some(f => f.type === 'dev-points-to-prod'));
      assert.strictEqual(sidecar.usedFallback, true);
      assert(sidecar.sourceDiagnostics && sidecar.sourceDiagnostics.environments === 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await check('packaged install harness passes', () => {
    childProcess.execFileSync('node', ['qa-packaged.js'], { cwd: process.cwd(), stdio: 'pipe' });
  });

  console.log('HARD_QA_PASS ' + results.length + ' checks');
}

run().catch(err => { console.error(err.stack || err); process.exit(1); });
