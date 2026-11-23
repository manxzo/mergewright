// A finding from `mw check`: where, what, how bad.
export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** Stable identifier such as `card/unknown-requirement`. */
  code: string;
  /** Project-relative path. */
  file: string;
  line?: number;
  message: string;
  /** For a schema violation: the dotted key path of the offending field ("" for the file as a whole). */
  key?: string;
  /** For a schema violation: what is wrong, without the place (the message names both). */
  detail?: string;
}

export class Diagnostics {
  items: Diagnostic[] = [];
  /** `at`: where in the file a schema violation is (see `Diagnostic.key` and `detail`). */
  error(code: string, file: string, message: string, line?: number, at?: { key: string; detail: string }): void {
    this.items.push({ severity: "error", code, file, message, line, ...(at ? { key: at.key, detail: at.detail } : {}) });
  }
  warn(code: string, file: string, message: string, line?: number): void {
    this.items.push({ severity: "warning", code, file, message, line });
  }
  get errors(): Diagnostic[] {
    return this.items.filter((d) => d.severity === "error");
  }
  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === "warning");
  }
  sorted(): Diagnostic[] {
    return [...this.items].sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code));
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}${d.line ? `:${d.line}` : ""}: ${d.severity}: ${d.message} [${d.code}]`;
}
