'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('insomnia-plugin-env-diff');
const workspace = JSON.stringify({ resources: [
  { _type: 'environment', name: 'Dev', data: { base_url: 'https://prod.example.com', token: 'short' } },
  { _type: 'environment', name: 'Prod', data: { base_url: 'https://dev.example.com' } }
] });
function ctx(out) { const alerts=[]; return { alerts, data:{export:{insomnia:async()=>workspace}}, app:{showSaveDialog:async()=>out,getPath:async k=>k==='documents'?os.tmpdir():'',alert:async(t,m)=>alerts.push({t,m})} }; }
async function main(){
  assert(Array.isArray(plugin.workspaceActions));
  assert(Array.isArray(plugin.requestGroupActions));
  assert(Array.isArray(plugin.requestActions));
  assert(plugin.__test.diffEnvironments);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'env-diff-packaged-'));
  try{ for(const action of [plugin.workspaceActions[0],plugin.requestGroupActions[0],plugin.requestActions[0]]){ const out=path.join(tmp,Math.random().toString(36).slice(2)+'.md'); await action.action(ctx(out)); const report=fs.readFileSync(out,'utf8'); assert(report.includes('Insomnia Env Diff Report')); assert(report.includes('dev-points-to-prod')); assert(report.includes('prod-points-to-dev')); }} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
  console.log('PASS: packaged plugin integration harness');
}
main().catch(e=>{console.error(e.stack||e);process.exit(1);});
