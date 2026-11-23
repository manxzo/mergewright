// Getting a JSON object out of whatever an agent replied with.

/**
 * Find the JSON value in an agent's reply. Tries, in order: the whole text; the last fenced
 * ```json block; the last fenced block of any kind; the outermost {...} span. Returns undefined
 * when nothing parses.
 */
export function extractJson(text: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const t = text.trim();
  if (!t) return undefined;
  const whole = tryParse(t);
  if (whole !== undefined && typeof whole === "object") return whole;
  const fences = [...t.matchAll(/```([a-zA-Z]*)[ \t]*\r?\n([\s\S]*?)```/g)];
  for (const pick of [fences.filter((f) => f[1]!.toLowerCase() === "json"), fences]) {
    for (let i = pick.length - 1; i >= 0; i--) {
      const v = tryParse(pick[i]![2]!.trim());
      if (v !== undefined && typeof v === "object") return v;
    }
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const v = tryParse(t.slice(first, last + 1));
    if (v !== undefined && typeof v === "object") return v;
  }
  return undefined;
}
