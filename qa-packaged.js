'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = __dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diff-packaged-qa-'));
const installDir = path.join(tmp, 'plugins');
fs.mkdirSync(installDir, { recursive: true });
function run(command, args, options = {}) { const r=spawnSync(command,args,{cwd:options.cwd||root,env:options.env||process.env,encoding:'utf8',stdio:options.stdio||'pipe'}); if(r.status!==0){process.stderr.write(r.stdout||'');process.stderr.write(r.stderr||'');throw new Error(`${command} ${args.join(' ')} failed`);} return typeof r.stdout==='string'?r.stdout.trim():''; }
try { const name=run('npm',['pack','--pack-destination',tmp]); const tarball=path.join(tmp,name.split('\n').pop().trim()); run('npm',['init','-y'],{cwd:installDir}); run('npm',['install',tarball,'--ignore-scripts'],{cwd:installDir}); run(process.execPath,[path.join(root,'real-insomnia-packaged-test.js')],{cwd:root,env:Object.assign({},process.env,{NODE_PATH:path.join(installDir,'node_modules')}),stdio:'inherit'}); console.log('PASS: npm tarball install + packaged plugin integration'); } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
