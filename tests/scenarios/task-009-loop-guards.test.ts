import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { fileHash } from '../../scripts/task-workflow/io.mjs';
import { runTaskLoop } from '../../scripts/task-workflow/rework.mjs';

const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true }); });
function setup() {
  const project = mkdtempSync(path.join(tmpdir(), 'loop guards ')); projects.push(project);
  mkdirSync(path.join(project, '.nodulus'));
  const files = { 'source.mjs': 'export const value=0;', 'test.mjs': "import {value} from './source.mjs'; import assert from 'node:assert/strict'; assert.ok(value > 0);", 'docs.md': 'old' };
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(project, file), content);
  const state = { executionId:'guard', contextHash:'context', completed:[], hashes:Object.fromEntries(Object.keys(files).map(f => [f,fileHash(path.join(project,f))])), task:{id:'T1',kind:'runtime',files:[{path:'source.mjs'}],documentation:['docs.md'],testing:{mode:'tdd',testFile:'test.mjs',checkIds:['fixed']}},repo:{id:'repo',root:project,files:Object.keys(files).map(f=>({path:f})),checks:[{id:'fixed',executable:process.execPath,args:['test.mjs']}]}};
  writeFileSync(path.join(project,'.nodulus/task-execution.json'),JSON.stringify(state));
  return project;
}
const completion = (project: string) => path.join(project,'.nodulus/task-completed/context/T1.json');
const response = (phase: string) => ({runId:'fixture',artifact:phase==='review'?{decision:'accept',summary:'ok'}:{summary:'ok',files:[{path:phase==='code'?'source.mjs':'docs.md',content:phase==='code'?'export const value=1;':'new'}]}});

test('existing completion is preserved before any inference', async () => {
  const project=setup(); mkdirSync(path.dirname(completion(project)),{recursive:true}); writeFileSync(completion(project),'prior accepted evidence');
  let calls=0;
  await expect(runTaskLoop(project,{maxCorrections:1,invoke:async({phase}:{phase:string})=>{calls++;return response(phase);}})).rejects.toThrow(/completion/i);
  expect(calls).toBe(0); expect(readFileSync(completion(project),'utf8')).toBe('prior accepted evidence');
});

test('failed real check stops before docs and rerun never replays inference', async () => {
  const project=setup(); let calls=0;
  const invoke=async()=>{calls++;return {runId:'failed',artifact:{summary:'bad',files:[{path:'source.mjs',content:'export const value=0;'}]}};};
  const result=await runTaskLoop(project,{maxCorrections:2,invoke});
  expect(result).toMatchObject({status:'error',iterations:1}); expect(result.error).toContain('fixed failed');
  expect(await runTaskLoop(project,{maxCorrections:2,invoke})).toEqual(result);
  expect(calls).toBe(1); expect(existsSync(completion(project))).toBe(false);
});

test('completion appearing during review cannot be overwritten or mark the phase complete', async () => {
  const project=setup();
  const result=await runTaskLoop(project,{maxCorrections:1,invoke:async({phase}:{phase:string})=>{
    if(phase==='review'){mkdirSync(path.dirname(completion(project)),{recursive:true});writeFileSync(completion(project),'concurrent accepted evidence');}
    return response(phase);
  }});
  expect(result).toMatchObject({status:'error'}); expect(result.error).toContain('completion already exists');
  expect(readFileSync(completion(project),'utf8')).toBe('concurrent accepted evidence');
  expect(JSON.parse(readFileSync(path.join(project,'.nodulus/task-execution.json'),'utf8')).completed).toEqual(['code','docs']);
});

test('provider mutation of frozen test stops without applying its proposal', async () => {
  const project=setup(); let calls=0;
  const result=await runTaskLoop(project,{maxCorrections:1,invoke:async()=>{calls++;writeFileSync(path.join(project,'test.mjs'),'changed');return response('code');}});
  expect(result).toMatchObject({status:'error'}); expect(result.error).toContain('Hash mismatch at test.mjs'); expect(calls).toBe(1);
  expect(readFileSync(path.join(project,'source.mjs'),'utf8')).toBe('export const value=0;'); expect(existsSync(completion(project))).toBe(false);
});

test('abrupt process exit remains inspectable and cannot replay inference', () => {
  const project=setup(); const script=path.join(project,'crash.mjs');
  writeFileSync(script,`import {runTaskLoop} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/task-workflow/rework.mjs')).href)}; await runTaskLoop(${JSON.stringify(project)},{maxCorrections:1,invoke:async()=>{process.exit(23);}});`);
  expect(spawnSync(process.execPath,[script],{windowsHide:true}).status).toBe(23);
  const stateFile=path.join(project,'.nodulus/task-loops/guard/state.json'); const before=readFileSync(stateFile,'utf8');
  const inspected=spawnSync(process.execPath,['scripts/task-workflow/cli.mjs','loop-status',project],{encoding:'utf8',windowsHide:true});
  expect(inspected.status,inspected.stderr).toBe(0);
  expect(JSON.parse(inspected.stdout)).toMatchObject({lockPresent:true,journal:{status:'running',phase:'code'}});
  expect(readFileSync(stateFile,'utf8')).toBe(before);
  expect(spawnSync(process.execPath,[script],{encoding:'utf8',windowsHide:true}).stderr).toContain('loop-status');
  expect(existsSync(completion(project))).toBe(false);
});
