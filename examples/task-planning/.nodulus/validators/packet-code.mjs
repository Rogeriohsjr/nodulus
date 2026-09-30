import { runPhase } from '../task-tools/runtime.mjs';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
try { process.stdout.write(JSON.stringify(runPhase(process.cwd(), 'code', JSON.parse(raw)))); }
catch (error) { process.stdout.write(JSON.stringify({valid:false,errors:[error.message]})); }
