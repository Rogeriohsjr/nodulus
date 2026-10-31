const errors = [];
let raw = "";

for await (const chunk of process.stdin) raw += chunk;

try {
  const data = JSON.parse(raw);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    errors.push("Report data must be an object.");
  } else if (typeof data.text !== "string" || data.text.trim().length === 0) {
    errors.push("Report text must be nonempty.");
  }
} catch {
  errors.push("Report data must be valid JSON.");
}

process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors }));
