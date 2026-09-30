import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { createProviderScenario, cleanupProviderProject, readProviderCalls } from './provider-adapter-scenarios.js';
import { fileHash } from '../../scripts/task-workflow/io.mjs';

export async function exerciseTaskLoop(cli: string) {
  const { project, logPath } = await createProviderScenario('opencode');
  try {
    const settings = JSON.parse(readFileSync(path.join(project, '.nodulus/settings.json'), 'utf8'));
    cpSync('examples/task-planning/.nodulus', path.join(project, '.nodulus'), { recursive: true });
    writeFileSync(path.join(project, '.nodulus/settings.json'), JSON.stringify(settings));
    for (const phase of ['code', 'docs', 'review']) {
      const file = path.join(project, `.nodulus/nodes/packet-${phase}.json`);
      const node = JSON.parse(readFileSync(file, 'utf8')); node.providerProfile = 'fixture';
      writeFileSync(file, JSON.stringify(node));
    }
    writeFileSync(path.join(project, 'source.mjs'), 'export const value = 0;');
    writeFileSync(path.join(project, 'test.mjs'), "import {value} from './source.mjs'; import assert from 'node:assert/strict'; assert.ok(value > 0);");
    writeFileSync(path.join(project, 'docs.md'), 'old');
    const files = ['source.mjs', 'test.mjs', 'docs.md'].map(file => ({ path: file, sha256: fileHash(path.join(project, file)), content: readFileSync(path.join(project, file), 'utf8') }));
    const frozen = fileHash(path.join(project, 'test.mjs'));
    writeFileSync(path.join(project, '.nodulus/task-execution.json'), JSON.stringify({ executionId: 'cli-loop', contextHash: 'cli-context', completed: [], hashes: Object.fromEntries(files.map(f => [f.path, f.sha256])), task: { id: 'T1', kind: 'runtime', goal: 'Use value 2 after review', files: [{path:'source.mjs'}], documentation:['docs.md'], testing:{mode:'tdd',testFile:'test.mjs',checkIds:['fixed']} }, repo:{id:'repo',root:project,files,checks:[{id:'fixed',executable:process.execPath,args:['test.mjs']}] } }));
    const fixture = `import fs from 'node:fs';
const args=process.argv.slice(2); if(args.includes('--version')){console.log('1.18.32');process.exit();} if(args[0]==='models'){console.log('ollama/qwen3.5:9b');process.exit();}
let stdin='';for await(const chunk of process.stdin)stdin+=chunk;
const log=${JSON.stringify(logPath)};const count=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length:0;
const phase=['code','docs','review'][count%3];if(count>=6||!stdin.includes('Loop phase: '+phase))throw Error('unexpected inference');
if(count===3&&!stdin.includes('Use value 2'))throw Error('missing review feedback');
fs.appendFileSync(log,JSON.stringify({phase,stdin})+'\\n');
const data=phase==='review'?{decision:count===2?'changes_required':'accept',summary:count===2?'Use value 2':'accepted'}:{files:[{path:phase==='code'?'source.mjs':'docs.md',content:phase==='code'?'export const value = '+(count<3?1:2)+';':'Iteration '+Math.floor(count/3)}],summary:'fixture'};
const outcome=JSON.stringify({status:'success',artifacts:[{name:phase==='review'?'review':'changes',contract:phase==='review'?'task-review.v1':'task-change.v1',data}]});
console.log(JSON.stringify({type:'text',sessionID:'session',part:{type:'text',text:outcome,messageID:'message'}}));
console.log(JSON.stringify({type:'step_finish',sessionID:'session',part:{type:'step-finish',reason:'stop',messageID:'message'}}));`;
    writeFileSync(path.join(project, '.nodulus/fixtures/opencode-fixture.mjs'), fixture);
    const execute = () => spawnSync(process.execPath, [cli, 'loop', project, '1'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const result = execute();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'accepted', iterations: 2 });
    expect(readProviderCalls(logPath).map(call => call.phase)).toEqual(['code','docs','review','code','docs','review']);
    expect(readFileSync(path.join(project, 'source.mjs'), 'utf8')).toBe('export const value = 2;');
    expect(readFileSync(path.join(project, 'docs.md'), 'utf8')).toBe('Iteration 1');
    expect(fileHash(path.join(project, 'test.mjs'))).toBe(frozen);
    expect(existsSync(path.join(project, '.nodulus/task-completed/cli-context/T1.json'))).toBe(true);
    const runs = readdirSync(path.join(project, '.nodulus/runs'));
    expect(runs).toHaveLength(6);
    for (const run of runs) expect(JSON.parse(readFileSync(path.join(project, '.nodulus/runs', run, 'run.json'), 'utf8')).status).toBe('success');
    expect(execute().status).toBe(0);
    expect(readProviderCalls(logPath)).toHaveLength(6);
  } finally { cleanupProviderProject(project); }
}
