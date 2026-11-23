// JSON Schema validation for every MergeWright file type and role output.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import path from "node:path";
import { SCHEMA_DIR } from "./paths.ts";
import { MwError, readText } from "./util.ts";

export type SchemaName =
  | "config" | "spec" | "card" | "role" | "flow" | "mcp" | "change"
  | "output.brief" | "output.handoff" | "output.findings" | "output.adjudication" | "output.reflection";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const compiled = new Map<SchemaName, ValidateFunction>();

export function schemaPath(name: SchemaName): string {
  return path.join(SCHEMA_DIR, `${name}.schema.json`);
}

export function loadSchema(name: SchemaName): object {
  return JSON.parse(readText(schemaPath(name))) as object;
}

function validator(name: SchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    try {
      v = ajv.compile(loadSchema(name));
    } catch (e) {
      throw new MwError("schema", `cannot load schema ${name}: ${(e as Error).message}`);
    }
    compiled.set(name, v);
  }
  return v;
}

/** One readable sentence per schema violation; empty when the value conforms. */
export function validate(name: SchemaName, value: unknown): string[] {
  return validateIssues(name, value).map((i) => i.message);
}

/**
 * A schema violation with where it is: `key` is the dotted key path of the offending field (for a
 * missing or unknown field, the path of that field; "" for the value as a whole), `detail` says what
 * is wrong without the place, and `message` is the sentence `validate` gives.
 */
export interface SchemaIssue {
  key: string;
  detail: string;
  message: string;
}

/** `validate`, with each violation's key path kept apart from its text (one per distinct message). */
export function validateIssues(name: SchemaName, value: unknown): SchemaIssue[] {
  const v = validator(name);
  if (v(value)) return [];
  const seen = new Set<string>();
  return (v.errors ?? []).map(issue).filter((i) => !seen.has(i.message) && !!seen.add(i.message));
}

const adHoc = new WeakMap<object, ValidateFunction>();

/** Like `validate`, for a schema given as an object (tool inputs of the MCP server). */
export function validateWith(schema: object, value: unknown): string[] {
  let v = adHoc.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    adHoc.set(schema, v);
  }
  if (v(value)) return [];
  return dedupe((v.errors ?? []).map(describe));
}

function describe(e: ErrorObject): string {
  return issue(e).message;
}

function issue(e: ErrorObject): SchemaIssue {
  const where = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "";
  const at = where ? `'${where}'` : "the file";
  const it = where ? `'${where}'` : "it";
  const under = (field: string) => (where ? `${where}.${field}` : field);
  const p = e.params as Record<string, unknown>;
  const make = (key: string, detail: string, message: string): SchemaIssue => ({ key, detail, message });
  switch (e.keyword) {
    case "required":
      return make(under(String(p.missingProperty)), "missing required field", `${it} is missing required field '${String(p.missingProperty)}'`);
    case "additionalProperties":
      return make(under(String(p.additionalProperty)), "unknown field", `${it} has unknown field '${String(p.additionalProperty)}'`);
    case "enum": {
      const detail = `must be one of: ${(p.allowedValues as unknown[]).join(", ")}`;
      return make(where, detail, `${at} ${detail}`);
    }
    case "type": {
      const detail = `must be ${Array.isArray(p.type) ? (p.type as string[]).join(" or ") : String(p.type)}`;
      return make(where, detail, `${at} ${detail}`);
    }
    case "pattern": {
      const detail = `has the wrong form (must match ${String(p.pattern)})`;
      return make(where, detail, `${at} ${detail}`);
    }
    case "propertyNames": {
      const detail = `has an invalid key '${String(p.propertyName)}'`;
      return make(where, detail, `${at} ${detail}`);
    }
    default: {
      const detail = e.message ?? "is invalid";
      return make(where, detail, `${at} ${detail}`);
    }
  }
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}
