import { existsSync, readFileSync, appendFileSync, mkdirSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('opencode 1.18.32\n');
  process.exit(0);
}

if (args[0] === 'models' && args[1] === 'ollama') {
  process.stdout.write('ollama/qwen3.5:9b\n');
  process.exit(0);
}

if (args[0] !== 'run') {
  process.stderr.write('expected run\n');
  process.exit(1);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

const logPath = join(process.cwd(), '.nodulus', 'fixtures', 'provider-invocations.jsonl');
let index = 0;
if (existsSync(logPath)) {
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  index = lines.length;
}

if (index >= 5) {
  process.stderr.write('too many calls\n');
  process.exit(1);
}

if (index === 2 || index === 3) {
  const agentVal = flag('--agent');
  const sessionVal = flag('--session');
  const dirVal = flag('--dir');
  if (agentVal !== 'nodulus-response') {
    process.stderr.write('expected --agent nodulus-response\n');
    process.exit(1);
  }
  if (sessionVal !== 'obs-session') {
    process.stderr.write('expected --session obs-session\n');
    process.exit(1);
  }
  if (!dirVal || realpathSync(resolve(dirVal)) !== realpathSync(process.cwd())) {
    process.stderr.write('expected --dir resolving to cwd\n');
    process.exit(1);
  }
} else {
  if (flag('--agent') !== 'build') {
    process.stderr.write('expected --agent build\n');
    process.exit(1);
  }
}

let stdin = '';
for await (const chunk of process.stdin) {
  stdin += chunk;
}

let outcome;
if (index === 0) {
  outcome = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'first' } }] });
} else if (index === 1) {
  outcome = '{"first-invalid":';
} else if (index === 2) {
  outcome = '{"second-invalid":';
} else if (index === 3) {
  outcome = JSON.stringify({ status: 'needs_input', request: { id: 'confirm', questions: [{ id: 'confirmed', message: 'Confirm?' }], answerContract: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'], additionalProperties: false } } });
} else {
  outcome = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'resumed' } }] });
}

const stepStart = { type: 'step_start', sessionID: 'obs-session', part: { id: 'start-' + index, sessionID: 'obs-session', messageID: 'm-' + index } };
const textEvent = { type: 'text', sessionID: 'obs-session', part: { messageID: 'm-' + index, text: outcome } };
const stepFinish = { type: 'step_finish', sessionID: 'obs-session', part: { id: 'finish-' + index, sessionID: 'obs-session', messageID: 'm-' + index, reason: 'stop', tokens: { input: index === 4 ? 20 : 10, output: index === 4 ? 4 : 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } };

process.stdout.write(JSON.stringify(stepStart) + '\n');
process.stdout.write(JSON.stringify(textEvent) + '\n');
process.stdout.write(JSON.stringify(stepFinish) + '\n');

mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, JSON.stringify({ argv: args, stdin, index }) + '\n');
