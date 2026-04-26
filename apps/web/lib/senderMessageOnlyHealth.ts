export type IterationOutcome = "ok" | "error" | "unknown";

export type SenderMessageOnlyHealthParse = {
  lastIterationOutcome: IterationOutcome;
  lastIterationAt: string | null;
  lastError: string | null;
};

const TIMESTAMP_RE = /^\[([^\]]+)\]/;
const COMPLETE_RE = /Operation Complete: sender-message[-_]only/;
const ERROR_MARKER_RE = /Operation Error: sender-message[-_]only/;
const ERROR_LEVEL_RE = /^\[[^\]]+\]\s+ERROR:\s/;
const ERROR_TRUNCATE = 240;

const isMarkerLine = (line: string): boolean => line.startsWith("[");

export function parseSenderMessageOnlyTail(tail: string): SenderMessageOnlyHealthParse {
  const result: SenderMessageOnlyHealthParse = {
    lastIterationOutcome: "unknown",
    lastIterationAt: null,
    lastError: null,
  };

  if (!tail) return result;

  const lines = tail.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!isMarkerLine(line)) continue;

    if (COMPLETE_RE.test(line)) {
      const tsMatch = TIMESTAMP_RE.exec(line);
      result.lastIterationOutcome = "ok";
      result.lastIterationAt = tsMatch ? tsMatch[1] : null;
      break;
    }

    if (ERROR_MARKER_RE.test(line)) {
      const tsMatch = TIMESTAMP_RE.exec(line);
      result.lastIterationOutcome = "error";
      result.lastIterationAt = tsMatch ? tsMatch[1] : null;
      result.lastError = line.length > ERROR_TRUNCATE ? line.slice(0, ERROR_TRUNCATE) : line;
      break;
    }
  }

  if (result.lastError === null) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!isMarkerLine(line)) continue;
      if (ERROR_LEVEL_RE.test(line)) {
        result.lastError = line.length > ERROR_TRUNCATE ? line.slice(0, ERROR_TRUNCATE) : line;
        break;
      }
    }
  }

  return result;
}
