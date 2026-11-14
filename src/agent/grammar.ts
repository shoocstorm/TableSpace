// PURE: a JSON-Schema subset for tool arguments. The same schema constrains
// what the model can write (as a GBNF grammar: this wllama build can't
// convert a JSON Schema itself) and then checks the result, because a
// grammar is an aid and not a guarantee. Adapted from Andai's
// agent/tools/validate.ts; here most arguments are enums built from the
// active database (table names, domains, presets), so a small model can't
// name a table that doesn't exist.

export type PropSchema =
  | { type: 'string'; description?: string; enum: string[] }
  | { type: 'array'; description?: string; items: { type: 'string'; enum: string[] }; minItems?: number; maxItems?: number };

export type ObjectSchema = { type: 'object'; properties: Record<string, PropSchema>; required: string[] };

export type Validation = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };

/** Checks `value` against `schema`. Unknown keys are errors; array items are de-duplicated. */
export function validate(schema: ObjectSchema, value: unknown): Validation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, errors: ['arguments must be a JSON object'] };
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(obj)) if (!(key in schema.properties)) errors.push(`unknown argument ${key}`);
  for (const key of schema.required) if (!(key in obj)) errors.push(`missing ${key}`);
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (p.type === 'string') {
      if (typeof v !== 'string' || !p.enum.includes(v)) errors.push(`${key} must be one of ${p.enum.join(', ')}`);
      else out[key] = v;
    } else {
      if (!Array.isArray(v)) {
        errors.push(`${key} must be a list`);
        continue;
      }
      const items = [...new Set(v)];
      if (items.some((x) => typeof x !== 'string' || !p.items.enum.includes(x))) errors.push(`${key} has an item that isn't allowed`);
      if (p.minItems !== undefined && items.length < p.minItems) errors.push(`${key} needs at least ${p.minItems} item(s)`);
      if (p.maxItems !== undefined && items.length > p.maxItems) errors.push(`${key} allows at most ${p.maxItems} items`);
      out[key] = items;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

const lit = (s: string) => JSON.stringify(s);
/** A GBNF literal that matches the JSON text of `s`, e.g. "\"orders\"". */
const jsonLit = (s: string) => lit(JSON.stringify(s));
const oneOf = (values: string[]) => values.map(jsonLit).join(' | ');

/**
 * GBNF for one JSON object with every property of `schema`, in order. Each
 * property's allowed values are a rule of their own (`v0`, `v1`, …), so a
 * list of table names is written once however many items the list allows.
 */
export function schemaGrammar(schema: ObjectSchema): string {
  const rules: string[] = [];
  const fields = Object.entries(schema.properties).map(([k, p], i) => {
    const rule = `v${i}`;
    rules.push(`${rule} ::= ${oneOf(p.type === 'string' ? p.enum : p.items.enum)}`);
    if (p.type === 'string') return `${jsonLit(k)} ws ":" ws ${rule}`;
    const extra = Math.max(0, (p.maxItems ?? 6) - 1);
    const items = `${rule} (ws "," ws ${rule}){0,${extra}}`;
    return `${jsonLit(k)} ws ":" ws "[" ws ${(p.minItems ?? 0) > 0 ? items : `(${items})?`} ws "]"`;
  });
  return [`root ::= "{" ws ${fields.join(' ws "," ws ')} ws "}"`, ...rules, 'ws ::= [ \\t\\n]{0,2}'].join('\n');
}

/** GBNF for exactly one of `choices`, as bare text: how the model names a tool. */
export function choiceGrammar(choices: string[]): string {
  return `root ::= ${choices.map(lit).join(' | ')}`;
}
