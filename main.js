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



function promptedEnvironmentsFromText(text) {
  const trimmed = safeString(text).trim();
  if (!trimmed) return [];
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  const envs = [];
  const pushEnv = (name, data) => {
    if (data && typeof data === 'object' && !Array.isArray(data)) envs.push({ _type: 'environment', name: safeString(name || `Pasted Environment ${envs.length + 1}`), data });
  };
  if (Array.isArray(parsed)) {
    parsed.forEach((item, i) => {
      if (isEnvironment(item)) pushEnv(item.name || item._id || `Pasted Environment ${i + 1}`, item.data || {});
      else if (item && typeof item === 'object' && !Array.isArray(item)) pushEnv(item.name || `Pasted Environment ${i + 1}`, item.data && typeof item.data === 'object' ? item.data : item);
    });
    return envs;
  }
  if (isEnvironment(parsed)) return [{ _type: 'environment', name: safeString(parsed.name || 'Pasted Environment'), data: parsed.data || {} }];
  const values = Object.values(parsed);
  if (values.length && values.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    for (const [name, data] of Object.entries(parsed)) pushEnv(name, data);
    return envs;
  }
  pushEnv('Pasted Environment', parsed);
  return envs;
}

function mergeSyntheticEnvironments(rawExport, envs) {
  if (!envs || !envs.length) return rawExport;
  const parsed = parseExport(rawExport);
  const merged = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.assign({}, parsed) : { originalExport: parsed };
  const existing = Array.isArray(merged.resources) ? merged.resources : [];
  merged.resources = existing.concat(envs);
  return JSON.stringify(merged);
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

function valueShape(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
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

    const shapes = new Map();
    for (const env of present) {
      const shape = valueShape(env.flat[key]);
      shapes.set(shape, (shapes.get(shape) || []).concat(env.name));
    }
    if (present.length > 1 && shapes.size > 1) {
      add(findings, 'medium', 'type-drift', key, 'Same key has different value types across environments', Array.from(shapes.entries()).map(([shape, names]) => `${shape}: ${names.join(', ')}`).join('; '));
    }

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

function markdownCell(value) {
  return safeString(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim();
}

function makeKeyMatrix(rawExport) {
  const envs = collectEnvironments(parseExport(rawExport));
  const keys = Array.from(new Set(envs.flatMap(e => Object.keys(e.flat)))).sort();
  if (!envs.length || !keys.length) return '';
  const header = `| Key | ${envs.map(e => markdownCell(e.name)).join(' | ')} |`;
  const sep = `|---|${envs.map(() => '---').join('|')}|`;
  const rows = keys.map(key => `| ${markdownCell(key)} | ${envs.map(e => Object.prototype.hasOwnProperty.call(e.flat, key) ? 'yes' : 'missing').map(markdownCell).join(' | ')} |`);
  return [header, sep].concat(rows).join('\n');
}

function priorityFindings(findings) {
  const rank = { high: 0, medium: 1, low: 2 };
  return findings
    .filter(f => f.severity === 'high' || f.severity === 'medium')
    .slice()
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || safeString(a.type).localeCompare(safeString(b.type)))
    .slice(0, 5);
}

function makePrioritySection(findings) {
  const priority = priorityFindings(findings);
  if (!priority.length) return 'No high or medium priority findings.';
  return priority.map((f, i) => `${i + 1}. **${markdownCell(f.severity)} ${markdownCell(f.type)}** at \`${markdownCell(f.location)}\` — ${markdownCell(f.message)}`).join('\n');
}

function makeMarkdown(findings, rawExport) {
  const counts = summarize(findings);
  const rows = findings.map(f => `| ${markdownCell(f.severity)} | ${markdownCell(f.type)} | ${markdownCell(f.location)} | ${markdownCell(f.message)} | ${markdownCell(f.preview)} |`).join('\n');
  const matrix = rawExport ? makeKeyMatrix(rawExport) : '';
  return `# Insomnia Env Diff Report\n\nGenerated: ${new Date().toISOString()}\n\nLocal-only report. Secret-like values are redacted.\n\n## Summary\n\n- Compared keys: ${matrix ? matrix.split('\n').length - 2 : 0}\n- High: ${counts.high}\n- Medium: ${counts.medium}\n- Low: ${counts.low}\n\n## Priority Fixes\n\n${makePrioritySection(findings)}\n\n## Key Matrix\n\n${matrix || 'No environment keys found.'}\n\n## Findings\n\n| Severity | Type | Location | Message | Preview |\n|---|---|---|---|---|\n${rows || '| low | none | workspace.environments | No environment drift detected. |  |'}\n`;
}

function makeJsonSidecar(findings, rawExport, options = {}) {
  const envs = collectEnvironments(parseExport(rawExport));
  const keys = Array.from(new Set(envs.flatMap(e => Object.keys(e.flat)))).sort();
  const severity = summarize(findings);
  const typeCounts = findings.reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {});
  const matrix = keys.map(key => ({
    key,
    environments: Object.fromEntries(envs.map(env => [env.name, Object.prototype.hasOwnProperty.call(env.flat, key) ? 'present' : 'missing']))
  }));
  return {
    schema: 'insomnia-env-diff/v1',
    generatedAt: new Date().toISOString(),
    sourceDiagnostics: options.sourceDiagnostics || null,
    usedFallback: Boolean(options.usedFallback),
    summary: {
      environmentsCompared: envs.length,
      keysCompared: keys.length,
      totalFindings: findings.length,
      high: severity.high || 0,
      medium: severity.medium || 0,
      low: severity.low || 0,
      typeCounts,
    },
    priority: priorityFindings(findings).map(f => ({
      severity: f.severity,
      type: f.type,
      location: f.location,
      message: f.message,
      preview: f.preview,
    })),
    matrix,
    findings: findings.map(f => ({
      severity: f.severity,
      type: f.type,
      location: f.location,
      message: f.message,
      preview: f.preview,
    })),
  };
}

function jsonSidecarPath(markdownPath) {
  const p = safeString(markdownPath);
  return /\.md$/i.test(p) ? p.replace(/\.md$/i, '.json') : `${p}.json`;
}


function normalizeSaveDialogResult(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (result.canceled) return null;
    if (typeof result.filePath === 'string' && result.filePath) return result.filePath;
    if (typeof result.path === 'string' && result.path) return result.path;
  }
  return null;
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
    let reportRaw = built.raw;
    let usedPromptFallback = false;
    if (!collectEnvironments(parseExport(reportRaw)).length && context.app && typeof context.app.prompt === 'function') {
      const pasted = await context.app.prompt('Env Diff: paste environment JSON', {
        label: 'Insomnia did not expose environments. Paste environment JSON or {"Dev":{...},"Prod":{...}} to diff. Leave blank to export diagnostics only.',
        defaultValue: '{"Dev":{"base_url":"https://api.production.example.com","api_key":"short","shared":"same"},"Prod":{"base_url":"https://api.dev.example.com","shared":"same","client_secret":""}}',
        submitName: 'Use JSON',
        cancelable: true,
      });
      const prompted = promptedEnvironmentsFromText(pasted);
      usedPromptFallback = prompted.length > 0;
      reportRaw = mergeSyntheticEnvironments(reportRaw, prompted);
    }
    const findings = diffEnvironments(reportRaw, { diagnostics: built.diagnostics });
    const report = makeMarkdown(findings, reportRaw);
    const jsonReport = makeJsonSidecar(findings, reportRaw, { sourceDiagnostics: built.diagnostics, usedFallback: built.usedFallback || usedPromptFallback });
    const fs = require('fs');
    let output = null;
    if (context.app && typeof context.app.showSaveDialog === 'function') output = normalizeSaveDialogResult(await context.app.showSaveDialog({ defaultPath: 'insomnia-env-diff.md' }));
    if (!output) output = await getWritableExportPath(context, 'insomnia-env-diff.md');
    const jsonOutput = jsonSidecarPath(output);
    fs.writeFileSync(output, report, 'utf8');
    fs.writeFileSync(jsonOutput, JSON.stringify(jsonReport, null, 2), 'utf8');
    if (context.app && typeof context.app.alert === 'function') await context.app.alert('Env Diff report exported', `${output}\n${jsonOutput}`);
  }
};

module.exports.workspaceActions = [action];
module.exports.requestGroupActions = [action];
module.exports.requestActions = [action];
module.exports.__test = { buildActionExport, collectEnvironments, collectEnvironmentLikesFromModels, currentEnvironmentFromContext, diffEnvironments, exportDiagnostics, flatten, getWritableExportPath, hostOf, jsonSidecarPath, normalizeSaveDialogResult, makeJsonSidecar, makeKeyMatrix, makeMarkdown, makePrioritySection, markdownCell, mergeSyntheticEnvironments, parseExport, priorityFindings, promptedEnvironmentsFromText, redactValue, summarize, valueShape };
