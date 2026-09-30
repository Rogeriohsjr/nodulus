import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { cleanupProviderProject, readProviderCalls, runDefaultProviderCli } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

// Supervisor-authored process-safety coverage; local Qwen owns the implementation packet.
test('OBS-006E readiness failure explicitly reports inference not launched', async () => {
  const {project,logPath}=await createUsageScenario('codex',jsonLines([{type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}]));
  try {
    const config=path.join(project,'.nodulus'); const controlFile=path.join(config,'fixtures/usage-control.json');
    writeFileSync(controlFile,JSON.stringify({...JSON.parse(readFileSync(controlFile,'utf8')),failAuthAfterInference:true}));
    const node=JSON.parse(readFileSync(path.join(config,'nodes/example.json'),'utf8'));
    writeFileSync(path.join(config,'nodes/second.json'),JSON.stringify({...node,id:'second'}));
    writeFileSync(path.join(config,'workflows/example.json'),JSON.stringify({schemaVersion:1,id:'example',nodes:['example','second']}));
    const result=await runDefaultProviderCli(project,'readiness evidence');
    expect(result.code).toBe(1); expect(readProviderCalls(logPath)).toHaveLength(1);
    const status=await getRunStatus(project,result.envelope.runId);
    expect(status.metrics!.calls[0]).toMatchObject({launched:true});
    expect(status.metrics!.calls[1]).toMatchObject({launched:false,usage:null});
    expect(status.callEvidence).toEqual(expect.arrayContaining([expect.objectContaining({nodeId:'second',status:'not_launched',launched:false,requestAvailable:false})]));
  }finally{cleanupProviderProject(project);}
},20000);

test('OBS-006F killed workflow leaves inspectable request without inference replay in fresh status process', async () => {
  const {project,logPath}=await createUsageScenario('opencode','');
  appendFileSync(path.join(project,'.nodulus/fixtures/opencode-fixture.mjs'),'\nsetInterval(()=>{},1000);\n');
  const child=spawn(process.execPath,[path.resolve('dist/bin.js'),'run','--project',project,'--request','interruption evidence','--json'],{stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'});
  const closed=once(child,'close');
  let stopped=false;
  const stop=async()=>{if(stopped)return;stopped=true;if(child.pid){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else process.kill(-child.pid,'SIGKILL');}await closed;};
  try {
    const deadline=Date.now()+10000;
    while(readProviderCalls(logPath).length===0){if(Date.now()>deadline)throw Error('fixture did not launch');await new Promise<void>(resolve=>setTimeout(resolve,20));}
    const runs=path.join(project,'.nodulus/runs');const [runId]=readdirSync(runs);expect(runId).toBeDefined();
    const root=path.join(runs,runId!);const [callId]=readdirSync(path.join(root,'calls'));expect(callId).toBeDefined();
    const requestFile=path.join(root,'calls',callId!,'request.json');const request=readFileSync(requestFile,'utf8');
    await stop();
    const checkpoint=readFileSync(path.join(root,'run.json'),'utf8');
    const result=spawnSync(process.execPath,[path.resolve('dist/bin.js'),'status',runId!,'--project',project,'--json'],{encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.status,result.stderr).toBe(0);
    const status=JSON.parse(result.stdout).result;
    expect(status.status).toBe('running');
    expect(status.callEvidence).toEqual([expect.objectContaining({callId,status:'incomplete',launched:null,requestAvailable:true,transportAvailable:false})]);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    expect(readFileSync(requestFile,'utf8')).toBe(request);expect(readFileSync(path.join(root,'run.json'),'utf8')).toBe(checkpoint);
  }finally{await stop();cleanupProviderProject(project);}
},20000);
