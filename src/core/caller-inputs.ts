import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";

export type CallerInputDeclaration = Record<string, { contract: string }>;
export type MissingCallerInput = { name: string; contract: string };

/** Return declared caller inputs that are absent or invalid under their captured contracts. */
export function missingCallerInputs(
  declared: CallerInputDeclaration,
  values: Record<string, unknown>,
  contracts: Record<string, unknown>,
): MissingCallerInput[] {
  const missing: MissingCallerInput[] = [];
  for (const [name, declaration] of Object.entries(declared)) {
    const schema = contracts[declaration.contract];
    let valid = Object.hasOwn(values, name) && schema !== undefined;
    if (valid) {
      try {
        valid = Boolean(new Ajv2020({ strict: false }).compile(schema as AnySchema)(values[name]));
      } catch {
        valid = false;
      }
    }
    if (!valid) missing.push({ name, contract: declaration.contract });
  }
  return missing;
}

/** Build the same answer schema used by ordered-workflow caller-input pauses. */
export function callerAnswerContract(
  missing: MissingCallerInput[],
  contracts: Record<string, unknown>,
): unknown {
  return {
    type: "object",
    required: missing.map(({ name }) => name),
    properties: Object.fromEntries(missing.map(({ name, contract }) => [name, { $ref: `#/$defs/${contract}` }])),
    additionalProperties: false,
    $defs: contracts,
  };
}
