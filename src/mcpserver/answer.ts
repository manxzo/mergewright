// A tool handler's answer with structured data beside its text (ToolDef.handler, results.ts). Its own
// module, without imports, so the repository transaction (repo.ts) can recognise one.
import type { ResultName, ResultTypes } from "./results.ts";

/** A handler's answer with structured data beside the text (`text` as a handler would return it alone). */
export class WithData {
  text: unknown;
  data: object;
  constructor(text: unknown, data: object) {
    this.text = text;
    this.data = data;
  }
}

/** Answer with `text` (a string, or a value sent as JSON text, exactly as before) and `data` of the declared shape. */
export function withData<N extends ResultName>(_type: N, text: unknown, data: ResultTypes[N]): WithData {
  return new WithData(text, data as object);
}
