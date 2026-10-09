let input = "";
for await (const chunk of process.stdin) input += chunk;
const artifact = JSON.parse(input);
const valid = artifact?.message === "pong";
process.stdout.write(JSON.stringify({ valid, errors: valid ? [] : ["Expected message to equal pong."] }));
