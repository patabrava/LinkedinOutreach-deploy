type LeadFields = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  company_name?: string | null;
};

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}|\[\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\]/g;

const CANONICAL = new Set(["first_name", "last_name", "full_name", "company_name"]);

function resolve(name: string, lead: LeadFields): string | null {
  if (!CANONICAL.has(name)) return null;
  if (name === "full_name") {
    const explicit = (lead.full_name ?? "").trim();
    if (explicit) return explicit;
    const first = (lead.first_name ?? "").trim();
    const last = (lead.last_name ?? "").trim();
    return [first, last].filter(Boolean).join(" ");
  }
  const value = (lead as Record<string, string | null | undefined>)[name];
  return (value ?? "").toString();
}

export function renderSequence(template: string, lead: LeadFields): string {
  return template.replace(TOKEN_RE, (match, dbl, sgl, brk) => {
    const name = dbl ?? sgl ?? brk;
    const resolved = resolve(name, lead);
    return resolved === null ? match : resolved;
  });
}
