'use strict';

const SECRET_KEY_RE = /(?:secret|token|password|passwd|api[_-]?key|client[_-]?secret|private[_-]?key)/i;
const URL_KEY_RE = /(?:url|host|endpoint|base)/i;
const PROD_RE = /(^|[-.])(prod|production|live)([-.]|$)|prod|production|live/i;
const DEV_RE = /(dev|local|test|sandbox|staging|stage)/i;

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parseExport(raw) {
  try { return JSON.parse(safeString(raw)); } catch { return { _raw: safeString(raw) }; }
}

function walk(value, visit, path = '$') {
  if (value == null) return;
  visit(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (typeof value === 'object') Object.keys(value).forEach(k => walk(value[k], visit, `${path}.${k}`));
}

function isEnvironment(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const t = String(obj._type || obj.type || '').toLowerCase();
  return t.includes('environment') || (typeof obj.name === 'string' && obj.data && typeof obj.data === 'object');
}

function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, next, out);
    else out[next] = value;
  }
  return out;
}

function collectEnvironments(parsed) {
  const envs = [];
  walk(parsed, (obj, path) => {
    if (!isEnvironment(obj)) return;
    const name = safeString(obj.name || obj._id || `environment-${envs.length + 1}`);
    const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
    envs.push({ name, path, data, flat: flatten(data) });
  });
  const seen = new Set();
  return envs.filter(e => {
    const sig = `${e.path}:${e.name}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}



function exportDiagnostics(rawExport, parsed) {
  const envs = collectEnvironments(parsed);
  const topKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 12) : [];
  return { bytes: safeString(rawExport).length, topKeys, environments: envs.length };
}

function currentEnvironmentFromContext(context) {
  const req = context && context.request;
  if (!req || typeof req.getEnvironment !== 'function') return null;
  try {
    const data = req.getEnvironment();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return { _type: 'environment', name: 'Current Environment', data };
  } catch { return null; }
}

function collectEnvironmentLikesFromModels(models) {
  const found = [];
  walk(models, (obj, path) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (isEnvironment(obj)) found.push({ obj, path: `models${path.slice(1)}` });
  });
  return found;
}

function buildActionExport(rawExport, context, models) {
  const parsed = parseExport(rawExport);
  const diagnostics = exportDiagnostics(rawExport, parsed);
  const envs = collectEnvironments(parsed);
  const synthetic = [];
  if (!envs.length) {
    const current = currentEnvironmentFromContext(context);
    if (current) synthetic.push(current);
    for (const item of collectEnvironmentLikesFromModels(models || {})) synthetic.push(item.obj);
  }
  if (!synthetic.length) return { raw: rawExport, diagnostics, usedFallback: false };
  const merged = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.assign({}, parsed) : { originalExport: parsed };
  const existing = Array.isArray(merged.resources) ? merged.resources : [];
  merged.resources = existing.concat(synthetic);
  return { raw: JSON.stringify(merged), diagnostics, usedFallback: true };
}

function redact(value) {
  const s = safeString(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function redactValue(key, value) {
  return SECRET_KEY_RE.test(key) ? redact(value) : safeString(value).slice(0, 160);
}

function hostOf(value) {
  try { return new URL(safeString(value)).hostname; } catch { return ''; }
}

function add(findings, severity, type, location, message, preview) {
  findings.push({ severity, type, location, message, preview: safeString(preview) });
}

function diffEnvironments(rawExport, config) {
  const parsed = parseExport(rawExport);
  const envs = collectEnvironments(parsed);
  const findings = [];
  if (config && config.diagnostics && config.diagnostics.environments === 0) {
    add(findings, 'low', 'env-export-empty', 'context.data.export.insomnia', 'Insomnia did not expose environment resources from this menu action; current-environment fallback may be used', `exportBytes=${config.diagnostics.bytes}; parsedKeys=${config.diagnostics.topKeys.join(',') || 'none'}; fallback=current-environment`);
  }
  if (envs.length < 2) {
    add(findings, 'low', 'not-enough-environments', 'workspace.environments', 'Need at least two environments for pairwise diff; single-environment hygiene checks still run', `${envs.length} found`);
  }
  const allKeys = new Set();
  for (const env of envs) Object.keys(env.flat).forEach(k => allKeys.add(k));

  for (const key of allKeys) {
    const present = envs.filter(e => Object.prototype.hasOwnProperty.call(e.flat, key));
    const missing = envs.filter(e => !Object.prototype.hasOwnProperty.call(e.flat, key));
    if (missing.length) add(findings, 'medium', 'missing-key', key, 'Environment key missing in one or more environments', `missing: ${missing.map(e => e.name).join(', ')}; present: ${present.map(e => e.name).join(', ')}`);

    const values = new Map();
    for (const env of present) values.set(safeString(env.flat[key]), (values.get(safeString(env.flat[key])) || []).concat(env.name));
    if (present.length > 1 && values.size === 1 && !SECRET_KEY_RE.test(key)) add(findings, 'low', 'same-value', key, 'Same non-secret value across environments', `${key}=${redactValue(key, present[0].flat[key])}`);

    if (SECRET_KEY_RE.test(key)) {
      for (const env of present) {
        const v = safeString(env.flat[key]);
        if (!v) add(findings, 'medium', 'empty-secret', `${env.name}.${key}`, 'Secret-like key is empty', env.name);
        else if (v.length < 12) add(findings, 'low', 'short-secret', `${env.name}.${key}`, 'Secret-like key value is short', `${env.name}: ${redact(v)}`);
      }
    }

    if (URL_KEY_RE.test(key)) {
      for (const env of present) {
        const value = safeString(env.flat[key]);
        const host = hostOf(value);
        if (value && !host && /^https?:/i.test(value) === false && value.includes('.')) add(findings, 'low', 'non-url-host', `${env.name}.${key}`, 'Host-like value is not a full URL', redactValue(key, value));
        if (DEV_RE.test(env.name) && host && PROD_RE.test(host)) add(findings, 'high', 'dev-points-to-prod', `${env.name}.${key}`, 'Development/staging environment points at production-like host', `${env.name}: ${host}`);
        if (PROD_RE.test(env.name) && host && DEV_RE.test(host)) add(findings, 'high', 'prod-points-to-dev', `${env.name}.${key}`, 'Production environment points at development-like host', `${env.name}: ${host}`);
        if (envs.length === 1 && host && PROD_RE.test(host)) add(findings, 'medium', 'single-env-prod-url', `${env.name}.${key}`, 'Current/single environment points at production-like host', `${env.name}: ${host}`);
      }
    }
  }

  const envNames = new Map();
  for (const env of envs) envNames.set(env.name.toLowerCase(), (envNames.get(env.name.toLowerCase()) || 0) + 1);
  for (const [name, count] of envNames) if (count > 1) add(findings, 'low', 'duplicate-environment-name', 'workspace.environments', 'Duplicate environment name', `${name} (${count})`);
  return findings.slice(0, 500);
}

function summarize(findings) {
  return findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, { high: 0, medium: 0, low: 0 });
}

function makeKeyMatrix(rawExport) {
  const envs = collectEnvironments(parseExport(rawExport));
  const keys = Array.from(new Set(envs.flatMap(e => Object.keys(e.flat)))).sort();
  if (!envs.length || !keys.length) return '';
  const header = `| Key | ${envs.map(e => e.name).join(' | ')} |`;
  const sep = `|---|${envs.map(() => '---').join('|')}|`;
  const rows = keys.map(key => `| ${key.replace(/\|/g, '\\|')} | ${envs.map(e => Object.prototype.hasOwnProperty.call(e.flat, key) ? 'yes' : 'missing').join(' | ')} |`);
  return [header, sep].concat(rows).join('\n');
}

function makeMarkdown(findings, rawExport) {
  const counts = summarize(findings);
  const rows = findings.map(f => `| ${f.severity} | ${f.type} | ${f.location} | ${f.message} | ${String(f.preview).replace(/\|/g, '\\|')} |`).join('\n');
  const matrix = rawExport ? makeKeyMatrix(rawExport) : '';
  return `# Insomnia Env Diff Report\n\nGenerated: ${new Date().toISOString()}\n\nLocal-only report. Secret-like values are redacted.\n\n## Summary\n\n- Compared keys: ${matrix ? matrix.split('\n').length - 2 : 0}\n- High: ${counts.high}\n- Medium: ${counts.medium}\n- Low: ${counts.low}\n\n## Key Matrix\n\n${matrix || 'No environment keys found.'}\n\n## Findings\n\n| Severity | Type | Location | Message | Preview |\n|---|---|---|---|---|\n${rows || '| low | none | workspace.environments | No environment drift detected. |  |'}\n`;
}

async function getWritableExportPath(context, fileName) {
  const path = require('path');
  const candidates = [];
  if (context.app && typeof context.app.getPath === 'function') {
    for (const key of ['documents', 'desktop', 'downloads', 'userData', 'home']) {
      try { const value = await context.app.getPath(key); if (value) candidates.push(value); } catch {}
    }
  }
  candidates.push(process.env.HOME || process.env.USERPROFILE || process.cwd());
  return path.join(candidates.find(Boolean) || '.', fileName);
}

const action = {
  label: 'Env Diff: Export Report',
  icon: 'fa-code-compare',
  action: async (context, models) => {
    const raw = await context.data.export.insomnia({ includePrivate: false, format: 'json' });
    const built = buildActionExport(raw, context, models);
    const report = makeMarkdown(diffEnvironments(built.raw, { diagnostics: built.diagnostics }), built.raw);
    const fs = require('fs');
    let output = null;
    if (context.app && typeof context.app.showSaveDialog === 'function') output = await context.app.showSaveDialog({ defaultPath: 'insomnia-env-diff.md' });
    if (!output) output = await getWritableExportPath(context, 'insomnia-env-diff.md');
    fs.writeFileSync(output, report, 'utf8');
    if (context.app && typeof context.app.alert === 'function') await context.app.alert('Env Diff report exported', output);
  }
};

module.exports.workspaceActions = [action];
module.exports.requestGroupActions = [action];
module.exports.requestActions = [action];
module.exports.__test = { buildActionExport, collectEnvironments, collectEnvironmentLikesFromModels, currentEnvironmentFromContext, diffEnvironments, exportDiagnostics, flatten, getWritableExportPath, hostOf, makeKeyMatrix, makeMarkdown, parseExport, redactValue, summarize };
