# P04: strict graph fields and resource declarations

Assign after P03 acceptance. Luna owns only `tests/scenarios/par-004-graph-strict-definition.test.ts`; preserve production and earlier fixture/test files. Reuse the working parallel helper, real JSON mutations, public inspection and byte/sentinel side-effect checks.

Cover valid omitted resources (configuration is not silently rewritten), valid empty per-node resource arrays and valid typed caller inputs. Independently reject unknown workflow, execution, output-alias, caller-input declaration and graph input-mapping properties; zero/negative/fractional/unsafe/nonnumeric concurrency; graph plus feedbackRouting; unknown resource node; non-array resource declaration; duplicate resource keys; unsafe resource key; malformed caller declaration; empty output aliases. Values must be actual JSON values, not NaN/Infinity that stringify into a different case.

The nested caller-declaration and graph-mapping unknown-property cases are expected to expose gaps. Record their meaningful assertion failures before a production correction. Version-1 legality and behavior remain unchanged; stricter graph-only mapping fields must not silently rewrite the version-1 contract.

Run `npm run build`, then `npx --no-install vitest run tests/scenarios/par-004-graph-strict-definition.test.ts` with the verified fixture-process permissions. Return exact results and hash for Sol and coordinator review; no production edits, installation, providers, commit or push. A later scoped implementation assignment names the graph validator/inspection ownership. Already-passing cases are coverage, not fabricated RED.
