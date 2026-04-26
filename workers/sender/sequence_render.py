"""Pure render helper used by sender for sequence-driven outreach.

Token classes accepted: {{name}}, {name}, [name].
Canonical names: first_name, last_name, full_name, company_name.
Legacy sender-runtime aliases: VORNAME -> first_name, NACHNAME -> last_name.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional

_TOKEN_RE = re.compile(
    r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}"
    r"|\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}"
    r"|\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]"
)

_CANONICAL = {"first_name", "last_name", "full_name", "company_name"}
_ALIASES = {"VORNAME": "first_name", "NACHNAME": "last_name"}


def _resolve(name: str, lead: Dict[str, Any]) -> Optional[str]:
    canonical = _ALIASES.get(name, name)
    if canonical not in _CANONICAL:
        return None
    if canonical == "full_name":
        explicit = (lead.get("full_name") or "").strip()
        if explicit:
            return explicit
        first = (lead.get("first_name") or "").strip()
        last = (lead.get("last_name") or "").strip()
        return " ".join(p for p in (first, last) if p)
    return str(lead.get(canonical) or "")


def render(template: str, lead: Dict[str, Any]) -> str:
    def _sub(match: "re.Match[str]") -> str:
        name = match.group(1) or match.group(2) or match.group(3)
        resolved = _resolve(name, lead)
        return match.group(0) if resolved is None else resolved
    return _TOKEN_RE.sub(_sub, template)
