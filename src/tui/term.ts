// The only file that touches process.stdin/stdout for the TUI: raw mode, the alternate screen,
// resize, key decoding, and restoring the terminal however the process ends.

const SEQ: Record<string, string> = {
  "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
  "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
  "\x1b[Z": "btab", "\x1b[H": "home", "\x1b[F": "end", "\x1bOH": "home", "\x1bOF": "end",
  "\x1b[1~": "home", "\x1b[4~": "end", "\x1b[3~": "delete", "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
};

/** Split a chunk of terminal input into key names: "up", "enter", "esc", "tab", "backspace", "ctrl-c", or the typed character. */
export function decodeKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const c = chunk[i]!;
    if (c === "\x1b") {
      // A CSI or SS3 sequence: ESC [ params final, or ESC O letter. A lone ESC is the Esc key.
      const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(chunk.slice(i));
      if (m) {
        const k = SEQ[m[0]];
        if (k) keys.push(k);
        i += m[0].length;
        continue;
      }
      keys.push("esc");
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") keys.push("enter");
    else if (c === "\t") keys.push("tab");
    else if (c === "\x7f" || c === "\b") keys.push("backspace");
    else if (c === "\x03") keys.push("ctrl-c");
    else if (c === "\x04") keys.push("ctrl-d");
    else if (c >= " ") {
      const cp = chunk.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      keys.push(ch);
      i += ch.length;
      continue;
    }
    i++;
  }
  return keys;
}

export interface Term {
  columns(): number;
  rows(): number;
  draw(lines: string[]): void;
  onKey(f: (key: string) => void): void;
  onResize(f: () => void): void;
  /** Leave raw mode and the alternate screen. Safe to call more than once. */
  restore(): void;
}

/** Take over the terminal. The terminal is restored on restore(), on exit, on SIGINT/SIGTERM/SIGHUP and on an uncaught error. */
export function openTerm(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Term {
  let restored = false;
  const listeners: [string | symbol, (...a: never[]) => void][] = [];
  const on = (event: string, f: (...a: never[]) => void) => {
    process.on(event as "exit", f as () => void);
    listeners.push([event, f]);
  };
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    } catch {
      // the terminal may already be gone
    }
    for (const [event, f] of listeners) process.off(event as "exit", f as () => void);
  };
  on("exit", () => restore());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) on(sig, () => { restore(); process.exit(sig === "SIGINT" ? 130 : 143); });
  on("uncaughtException", (e: Error) => { restore(); process.stderr.write(`mw: ${e?.stack ?? e}\n`); process.exit(1); });
  on("unhandledRejection", (e: unknown) => { restore(); process.stderr.write(`mw: ${(e as Error)?.stack ?? String(e)}\n`); process.exit(1); });

  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  output.write("\x1b[?1049h\x1b[?25l\x1b[2J");

  return {
    columns: () => output.columns || 80,
    rows: () => output.rows || 24,
    draw(lines) {
      if (restored) return;
      output.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J`);
    },
    onKey(f) {
      input.on("data", (chunk: string) => { for (const k of decodeKeys(chunk)) f(k); });
    },
    onResize(f) {
      output.on("resize", f);
    },
    restore,
  };
}
