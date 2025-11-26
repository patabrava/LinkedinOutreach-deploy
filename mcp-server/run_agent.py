"""Lightweight agent loop that turns ENRICHED leads into drafts."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from openai import OpenAI

from tools import classify_lead, get_enriched_leads, save_draft, select_case_study, supabase_client

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent / "workers"))
from shared_logger import get_logger

load_dotenv()

# Initialize logger
logger = get_logger("mcp-agent")

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
    logger.operation_start("draft-generation")
    
    try:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            logger.error("Missing OPENAI_API_KEY")
            raise RuntimeError("Missing OPENAI_API_KEY.")

        client = supabase_client()
        openai = OpenAI(api_key=api_key)

        leads = get_enriched_leads(client)
        if not leads:
            logger.info("No ENRICHED leads found")
            return
        
        logger.info(f"Processing {len(leads)} ENRICHED leads", data={"count": len(leads)})

        for lead in leads:
            lead_id = lead["id"]
            logger.info(f"Generating draft for lead", {"leadId": lead_id})
            profile = lead.get("profile_data") or {}
            company_type = guess_company_type(profile)
            
            logger.debug("Classifying lead", {"leadId": lead_id}, {"companyType": company_type})
            ai_tags = classify_lead(client, lead_id, profile.get("industry", "Unknown"), company_type)
            
            case_study = choose_case_study(ai_tags)
            logger.debug("Selected case study", {"leadId": lead_id}, {"caseStudy": case_study})
            select_case_study(client, lead_id, case_study)

            prompt = build_prompt(lead, case_study, company_type)
            
            logger.ai_request(OPENAI_MODEL, {"leadId": lead_id}, prompt[:200])
            
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
            
            tokens = completion.usage.total_tokens if completion.usage else None
            logger.ai_response(OPENAI_MODEL, {"leadId": lead_id}, tokens)
            
            content = completion.choices[0].message.content or "{}"
            try:
                data = json.loads(content)
            except json.JSONDecodeError:
                logger.error(f"Bad JSON from AI model", {"leadId": lead_id}, data={"content": content[:200]})
                continue

            opener = data.get("opener", "")
            body = data.get("body", "")
            cta = data.get("cta", "")
            full_message = data.get("full_message") or "\n\n".join(
                [part for part in [opener, body, cta] if part]
            )
            body_type = data.get("body_type", "")
            cta_type = data.get("cta_type", "")

            logger.debug("Draft generated", {"leadId": lead_id}, {
                "messageLength": len(full_message),
                "bodyType": body_type,
                "ctaType": cta_type,
            })
            
            save_draft(client, lead_id, opener, body, cta, full_message, body_type, cta_type)
            logger.info(f"Draft saved for lead", {"leadId": lead_id})
        
        logger.operation_complete("draft-generation", result={"processed": len(leads)})
    except Exception as exc:
        logger.operation_error("draft-generation", error=exc)
        raise


if __name__ == "__main__":
    main()

