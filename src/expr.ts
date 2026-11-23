// The condition language used by flows (`when:` and `stop.when:`).
//
//   expr   := or
//   or     := and ("or" and)*
//   and    := unary ("and" unary)*
//   unary  := "not" unary | "(" expr ")" | cmp
//   cmp    := VARIABLE [ ("==" | "!=" | ">=" | "<=" | ">" | "<") LITERAL ]
//
// Variables are a fixed set (see VARIABLES). Risk levels compare by rank: low < medium < high < critical.
// A list of names (`gate.skipped_names`) compares only with == (it contains the word) and != (it does not).

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type Risk = (typeof RISK_LEVELS)[number];

/** Every variable a flow condition may read, with its type. */
export const VARIABLES: Record<string, "risk" | "string" | "boolean" | "number" | "names"> = {
  always: "boolean",
  never: "boolean",
  risk: "risk",
  kind: "string",
  deep_review: "boolean",
  round: "number",
  "findings.total": "number",
  "findings.blocking": "number",
  "gate.ok": "boolean",
  "gate.skipped": "number",
  "gate.skipped_names": "names",
  "adjudication.conditions": "number",
  "adjudication.follow_ups": "number",
};

export type Vars = Record<string, string | number | boolean | string[]>;

type Node =
  | { t: "or" | "and"; l: Node; r: Node }
  | { t: "not"; e: Node }
  | { t: "var"; name: string }
  | { t: "cmp"; name: string; op: string; lit: string | number | boolean };

const TOKEN = /\s*(==|!=|>=|<=|>|<|\(|\)|[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`unexpected character at position ${pos + 1}: '${src.slice(pos).trim().slice(0, 10)}'`);
    out.push(m[1]!);
    pos = TOKEN.lastIndex;
  }
  return out;
}

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const OPS = ["==", "!=", ">=", "<=", ">", "<"];

  function or(): Node {
    let l = and();
    while (peek() === "or") { next(); l = { t: "or", l, r: and() }; }
    return l;
  }
  function and(): Node {
    let l = unary();
    while (peek() === "and") { next(); l = { t: "and", l, r: unary() }; }
    return l;
  }
  function unary(): Node {
    const tok = next();
    if (tok === undefined) throw new Error("expression ends early");
    if (tok === "not") return { t: "not", e: unary() };
    if (tok === "(") {
      const e = or();
      if (next() !== ")") throw new Error("missing ')'");
      return e;
    }
    const type = VARIABLES[tok];
    if (!type) throw new Error(`unknown variable '${tok}' (known: ${Object.keys(VARIABLES).join(", ")})`);
    const op = peek();
    if (op === undefined || !OPS.includes(op)) {
      if (type !== "boolean") throw new Error(`'${tok}' is not a yes/no value; compare it, e.g. '${tok} == ...'`);
      return { t: "var", name: tok };
    }
    next();
    const raw = next();
    if (raw === undefined) throw new Error(`missing value after '${tok} ${op}'`);
    let lit: string | number | boolean = raw;
    if (type === "number") {
      if (!/^[0-9]+$/.test(raw)) throw new Error(`'${tok}' is a number; '${raw}' is not`);
      lit = Number(raw);
    } else if (type === "risk") {
      if (!(RISK_LEVELS as readonly string[]).includes(raw)) throw new Error(`'${raw}' is not a risk level (${RISK_LEVELS.join(", ")})`);
    } else if (type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new Error(`'${tok}' is yes/no; compare it with true or false`);
      if (op !== "==" && op !== "!=") throw new Error(`'${tok}' can only be compared with == or !=`);
      lit = raw === "true";
    } else if (type === "names") {
      if (op !== "==" && op !== "!=") throw new Error(`'${tok}' is a list of names; compare it with == (it contains the name) or != (it does not)`);
    } else if (op !== "==" && op !== "!=") {
      throw new Error(`'${tok}' is text; it can only be compared with == or !=`);
    }
    return { t: "cmp", name: tok, op, lit };
  }

  const tree = or();
  if (i < toks.length) throw new Error(`unexpected '${toks[i]}'`);
  return tree;
}

/** Returns a description of what is wrong with the expression, or undefined when it is valid. */
export function checkExpr(src: string): string | undefined {
  try {
    parseExpr(src);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export function evalExpr(src: string, vars: Vars): boolean {
  const v: Vars = { always: true, never: false, ...vars };
  const rank = (x: unknown) => (RISK_LEVELS as readonly string[]).indexOf(String(x));
  function ev(n: Node): boolean {
    switch (n.t) {
      case "or": return ev(n.l) || ev(n.r);
      case "and": return ev(n.l) && ev(n.r);
      case "not": return !ev(n.e);
      case "var": return v[n.name] === true;
      case "cmp": {
        const type = VARIABLES[n.name];
        const left = v[n.name];
        if (left === undefined) return false; // a value that is not known yet makes the comparison false
        if (Array.isArray(left)) return n.op === "==" ? left.includes(String(n.lit)) : !left.includes(String(n.lit));
        const [a, b] = type === "risk" ? [rank(left), rank(n.lit)] : [left, n.lit];
        switch (n.op) {
          case "==": return a === b;
          case "!=": return a !== b;
          case ">=": return a >= b;
          case "<=": return a <= b;
          case ">": return a > b;
          default: return a < b;
        }
      }
    }
  }
  return ev(parseExpr(src));
}
