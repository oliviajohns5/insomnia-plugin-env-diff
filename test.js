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
  assert(report.includes('## Priority Fixes'));
  assert(!report.includes('shortsecretlongvalue'));

  // Synthetic fixture, not a credential: exercise both root and nested header keys.
  const bearer = 'Bearer fixture-only-not-a-credential-12345';
  const authWorkspace = JSON.stringify({ resources: ['Dev', 'Prod'].map(name => ({
    _type: 'environment', name, data: { Authorization: bearer, headers: { Authorization: bearer }, shared: 'safe' }
  })) });
  const authFindings = t.diffEnvironments(authWorkspace);
  assert(!authFindings.some(f => f.type === 'same-value' && /Authorization$/i.test(f.location)), 'Authorization must not be a same-value finding');
  assert(authFindings.some(f => f.type === 'same-value' && f.location === 'shared'), 'ordinary same values remain visible');
  const authTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-auth-'));
  try {
    const out = path.join(authTmp, 'report.md');
    await plugin.workspaceActions[0].action({ data: { export: { insomnia: async () => authWorkspace } }, app: { showSaveDialog: async () => out } });
    for (const file of [out, out.replace(/\.md$/, '.json')]) {
      assert(!fs.readFileSync(file, 'utf8').includes(bearer), `${path.extname(file)} must not export bearer value`);
    }
  } finally { fs.rmSync(authTmp, { recursive: true, force: true }); }
  assert.strictEqual(t.redactValue('Authorization', bearer), '***', 'credential headers must not expose even a token prefix/suffix');
  assert.strictEqual(t.redactValue('headers.authorization', 'Bearer x'), '***', 'nested, case-insensitive Authorization is masked');
  const shortAuth = JSON.stringify({ resources: [{ _type: 'environment', name: 'Dev', data: { Authorization: 'Bearer x' } }] });
  assert(t.diffEnvironments(shortAuth).some(f => f.type === 'short-secret' && f.preview === 'Dev: ***'), 'short Authorization preview must be masked');
  assert.strictEqual(t.redactValue('documentationAuthorizationNote', 'public'), 'public', 'unrelated keys retain ordinary previews');

  // Nested objects and arrays must not export credential values after flattening.
  const objectFixture = 'Bearer fixture-object-xyz-not-a-credential';
  const arrayFixture = 'Bearer fixture-array-xyz-not-a-credential';
  const hostFixture = 'fixture-production.example.invalid';
  const nestedAuthWorkspace = JSON.stringify({ resources: ['Dev', 'Prod'].map(name => ({
    _type: 'environment', name, data: {
      headers: { aUtHoRiZaTiOn: { value: objectFixture, details: { raw: objectFixture }, endpoint: `https://${hostFixture}` } },
      Authorization: [arrayFixture, { value: arrayFixture }],
      documentationAuthorizationNote: 'public-note'
    }
  })) });
  const nestedFindings = t.diffEnvironments(nestedAuthWorkspace);
  assert(!nestedFindings.some(f => f.type === 'same-value' && /(?:^|\.)authorization(?:\.|$)/i.test(f.location)), 'Authorization descendants must not create same-value previews');
  assert(nestedFindings.some(f => f.type === 'same-value' && f.location === 'documentationAuthorizationNote' && f.preview.includes('public-note')), 'unrelated key still has an ordinary preview');
  const nestedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-nested-auth-'));
  try {
    const out = path.join(nestedTmp, 'report.md');
    await plugin.workspaceActions[0].action({ data: { export: { insomnia: async () => nestedAuthWorkspace } }, app: { showSaveDialog: async () => out } });
    for (const file of [out, out.replace(/\.md$/, '.json')]) {
      const body = fs.readFileSync(file, 'utf8');
      for (const fixture of [objectFixture, arrayFixture, hostFixture]) {
        assert(!body.includes(fixture), `${path.extname(file)} must not export nested Authorization fixture`);
      }
      assert(body.includes('public-note'), `${path.extname(file)} retains unrelated value`);
    }
  } finally { fs.rmSync(nestedTmp, { recursive: true, force: true }); }

  const pipeWorkspace = JSON.stringify({ resources: [
    { _type: 'environment', name: 'Dev|East', data: { 'base|url': 'https://api.production.example.com', shared: 'same' } },
    { _type: 'environment', name: 'Prod\nWest', data: { 'base|url': 'https://api.dev.example.com', shared: 'same' } }
  ] });
  const pipeFindings = t.diffEnvironments(pipeWorkspace);
  pipeFindings.push({ severity: 'medium', type: 'custom|type', location: 'Dev|East.base|url', message: 'line one\nline | two', preview: 'preview | value\nnext' });
  const pipeReport = t.makeMarkdown(pipeFindings, pipeWorkspace);
  assert(pipeReport.includes('Dev\\|East'), 'escapes env name pipes in matrix header');
  assert(pipeReport.includes('Prod<br>West'), 'escapes env name newlines in matrix header');
  assert(pipeReport.includes('base\\|url'), 'escapes key/location pipes');
  assert(pipeReport.includes('custom\\|type'), 'escapes finding type pipes');
  assert(pipeReport.includes('line one<br>line \\| two'), 'escapes finding message pipes and newlines');
  assert(pipeReport.includes('preview \\| value<br>next'), 'escapes preview pipes and newlines');
  assert.strictEqual(t.markdownCell(' a|b\nc '), 'a\\|b<br>c');

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
  assert.strictEqual(t.normalizeSaveDialogResult('/tmp/report.md'), '/tmp/report.md');
  assert.strictEqual(t.normalizeSaveDialogResult({ filePath: '/tmp/report.md', canceled: false }), '/tmp/report.md');
  assert.strictEqual(t.normalizeSaveDialogResult({ canceled: true }), null);

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
      assert.strictEqual(sidecar.usedFallback, false, 'sidecar records fallback metadata');
      assert(sidecar.sourceDiagnostics && sidecar.sourceDiagnostics.environments === 3, 'sidecar records source diagnostics');
      assert(Array.isArray(sidecar.priority), 'sidecar includes priority list');
      assert(fs.readFileSync(out, 'utf8').includes('Insomnia Env Diff Report'));
      assert.strictEqual(c.alerts.length, 1);
    }
    const objectOut = path.join(tmp, 'object.md');
    await plugin.requestActions[0].action({ ...ctx({ filePath: objectOut, canceled: false }) }, {});
    assert(fs.existsSync(objectOut), 'object save dialog writes Markdown');
    assert(fs.existsSync(objectOut.replace(/\.md$/i, '.json')), 'object save dialog writes JSON sidecar');
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
    assert.strictEqual(sidecar.usedFallback, true, 'prompted pasted envs set fallback metadata');
    assert(sidecar.sourceDiagnostics && sidecar.sourceDiagnostics.environments === 0, 'prompted sidecar keeps empty export diagnostics');
    assert.strictEqual(prompts.length, 1, 'prompt shown for empty env export');
    assert(body.includes('dev-points-to-prod'), 'prompt action report includes pasted findings');
    assert(body.includes('## Key Matrix'), 'prompt action report includes matrix');
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }

  console.log('PASS: all tests');
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
