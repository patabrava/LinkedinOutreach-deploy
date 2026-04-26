export const CONNECT_NOTE_MAX = 300;

const CANONICAL_TOKENS = new Set([
  "first_name",
  "last_name",
  "full_name",
  "company_name",
]);

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}|\[\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\]/g;

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateConnectNote(text: string): ValidationResult {
  if (text.length > CONNECT_NOTE_MAX) {
    return { ok: false, error: `Connect note exceeds ${CONNECT_NOTE_MAX} chars (got ${text.length}).` };
  }
  for (const match of text.matchAll(TOKEN_RE)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (!name) continue;
    if (!CANONICAL_TOKENS.has(name)) {
      return { ok: false, error: `Unknown token "${name}". Allowed: first_name, last_name, full_name, company_name.` };
    }
  }
  return { ok: true };
}
