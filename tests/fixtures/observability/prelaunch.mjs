import * as obsFs from 'node:fs';
import obsPath from 'node:path';

if (process.argv[2] === 'exec' || process.argv[2] === '-p' || process.argv[2] === 'run') {
  const runFolder = obsFs.readdirSync(obsPath.join(process.cwd(), '.nodulus', 'runs'))[0];
  if (runFolder) {
    let obsCalls = [];
    const callsDir = obsPath.join(process.cwd(), '.nodulus', 'runs', runFolder, 'calls');
    if (obsFs.existsSync(callsDir)) {
      const callIds = obsFs.readdirSync(callsDir);
      obsCalls = callIds.map(child => {
        const requestPath = obsPath.join(callsDir, child, 'request.json');
        const stdinPath = obsPath.join(callsDir, child, 'stdin.txt');
        return {
          callId: child,
          request: JSON.parse(obsFs.readFileSync(requestPath, 'utf8')),
          stdin: obsFs.readFileSync(stdinPath, 'utf8')
        };
      });
    }
    obsFs.writeFileSync(obsPath.join(process.cwd(), '.nodulus', 'fixtures', 'observed.json'), JSON.stringify(obsCalls));
  } else {
    obsFs.writeFileSync(obsPath.join(process.cwd(), '.nodulus', 'fixtures', 'observed.json'), '[]');
  }
}