"""Lightweight agent loop that turns ENRICHED leads into drafts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from openai import OpenAI

from tools import classify_lead, get_enriched_leads, save_draft, select_case_study, supabase_client

load_dotenv()

PROMPT = Path(__file__).parent.joinpath("prompt.txt").read_text()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def guess_company_type(profile: Dict[str, Any]) -> str:
    text = " ".join(filter(None, [profile.get("headline", ""), profile.get("about", "")])).lower()
    if "agency" in text:
        return "Agency"
    if "law" in text or "attorney" in text or "legal" in text:
        return "Legal"
    return "Other"


def choose_case_study(ai_tags: Dict[str, Any]) -> str:
    industry = (ai_tags.get("industry") or "").lower()
    if "education" in industry:
        return "BibliU"
    if "operations" in industry or "logistics" in industry:
        return "RoOut"
    return "General"


def build_prompt(lead: Dict[str, Any], case_study: str, company_type: str) -> str:
    profile_json = json.dumps(lead.get("profile_data", {}), indent=2)
    activity_json = json.dumps(lead.get("recent_activity", []), indent=2)

    return (
        f"{PROMPT}\n\n"
        "You must respond in JSON with keys: opener, body, cta, full_message, body_type, cta_type, "
        "industry, company_type, case_study.\n"
        f"Lead profile:\n{profile_json}\n\n"
        f"Recent activity:\n{activity_json}\n\n"
        f"Selected case study: {case_study}\n"
        f"Company type: {company_type}\n"
        "Follow the logic chain: classify company type, select case study, decide opener (post if "
        "recent <30 days else profile), choose body type, choose CTA (low friction default), "
        "and ensure word-count limits."
    )


def main() -> None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY.")

    client = supabase_client()
    openai = OpenAI(api_key=api_key)

    leads = get_enriched_leads(client)
    if not leads:
        print("No ENRICHED leads found.")
        return

    for lead in leads:
        profile = lead.get("profile_data") or {}
        company_type = guess_company_type(profile)
        ai_tags = classify_lead(client, lead["id"], profile.get("industry", "Unknown"), company_type)
        case_study = choose_case_study(ai_tags)
        select_case_study(client, lead["id"], case_study)

        prompt = build_prompt(lead, case_study, company_type)
        completion = openai.chat.completions.create(
            model=OPENAI_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Du bist eine deutschsprachige LinkedIn-Textexpertin mit Schwerpunkt Immobilien. "
                        "Schreibe prägnante, warme und branchenspezifische Outreach-Nachrichten auf Deutsch."
                    ),
                },
                {"role": "system", "content": PROMPT},
                {"role": "user", "content": prompt},
            ],
        )
        content = completion.choices[0].message.content or "{}"
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            print(f"Bad model output for lead {lead['id']}: {content}")
            continue

        opener = data.get("opener", "")
        body = data.get("body", "")
        cta = data.get("cta", "")
        full_message = data.get("full_message") or "\n\n".join(
            [part for part in [opener, body, cta] if part]
        )
        body_type = data.get("body_type", "")
        cta_type = data.get("cta_type", "")

        save_draft(client, lead["id"], opener, body, cta, full_message, body_type, cta_type)
        print(f"Saved draft for lead {lead['id']}")


if __name__ == "__main__":
    main()

