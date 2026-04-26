"""Lightweight agent loop that turns ENRICHED leads into drafts."""

from __future__ import annotations

import argparse
import json
import os
import sys
import re
from pathlib import Path
from typing import Any, Dict, Tuple

from dotenv import load_dotenv
from openai import OpenAI

from tools import (
    classify_lead,
    get_leads_for_generation,
    get_rotation_state,
    save_draft,
    select_case_study,
    supabase_client,
    update_rotation_state,
)
from example_pool import get_example_pool

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent / "workers"))
from shared_logger import get_logger

load_dotenv()

# Initialize logger
logger = get_logger("mcp-agent")

# Prompt files mapping: 1=standard, 2=vernetzung (thank-you), 3=process optimization
PROMPT_FILES = {
    1: "prompt.txt",
    2: "prompt_vernetzung.txt",
    3: "prompt_process.txt",
}

PROMPT_NAMES = {
    1: "Standard Outreach",
    2: "Vernetzung Thank-You",
    3: "Process Optimization",
}

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def load_prompt(prompt_type: int = 1) -> str:
    """Load the appropriate prompt file based on prompt_type."""
    prompt_file = PROMPT_FILES.get(prompt_type, "prompt.txt")
    prompt_path = Path(__file__).parent.joinpath(prompt_file)
    if not prompt_path.exists():
        logger.warn(f"Prompt file not found, falling back to default", data={"requested": prompt_file})
        prompt_path = Path(__file__).parent.joinpath("prompt.txt")
    return prompt_path.read_text()


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


def build_prompt(
    lead: Dict[str, Any],
    case_study: str,
    company_type: str,
    example: str,
    category: str,
    prompt_text: str,
) -> str:
    """Build the prompt with a specific example injected."""
    profile_json = json.dumps(lead.get("profile_data", {}), indent=2)
    activity_json = json.dumps(lead.get("recent_activity", []), indent=2)

    first_name = (lead.get("first_name") or "").strip()
    last_name = (lead.get("last_name") or "").strip()
    full_name = " ".join([p for p in [first_name, last_name] if p]).strip()

    # Inject the selected example into the prompt (if placeholders exist)
    personalized_prompt = prompt_text.replace("{SELECTED_EXAMPLE}", example).replace("{EXAMPLE_CATEGORY}", category)

    return (
        f"{personalized_prompt}\n\n"
        "You must respond in JSON with keys: opener, body, cta, full_message, body_type, cta_type, "
        "industry, company_type, case_study.\n"
        f"Lead first_name: {first_name or '(unknown)'}\n"
        f"Lead last_name: {last_name or '(unknown)'}\n"
        f"Lead full_name: {full_name or '(unknown)'}\n\n"
        f"Lead profile (JSON):\n{profile_json}\n\n"
        f"Recent activity (JSON):\n{activity_json}\n\n"
        f"Selected case study: {case_study}\n"
        f"Company type: {company_type}\n"
        "CRITICAL RULES: The opener must address the person by their first name if available (e.g., 'Hey Sven,'). "
        "Never output placeholder tokens like [Name] or {Name}. If no name is available, start with 'Hey,'.\n"
        "Follow the logic chain: classify company type, select case study, decide opener (post if "
        "recent <30 days else profile), choose body type, choose CTA (low friction default), "
        "and ensure word-count limits. Hard cap: opener + body + CTA combined must be <= 300 characters."
        "\nHard rule: Do not use hyphens or dashes '-', '–', or '—' and do not use apostrophes (') in opener, body, cta, or full_message. "
        "Respond as one cohesive text block without bullet formatting or line breaks in the final message."
    )


def _truncate_text(text: str, limit: int) -> str:
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit == 1:
        return text[:1]

    candidate = text[: limit - 1].rstrip()
    space_idx = candidate.rfind(" ")
    if space_idx > 0 and space_idx >= limit // 2:
        candidate = candidate[:space_idx]
    candidate = candidate.rstrip(" ,.;:-")
    if not candidate:
        candidate = text[: limit - 1]
    return f"{candidate}…"


def enforce_char_limit(opener: str, body: str, cta: str, limit: int = 300, lead_id: str = "unknown") -> Tuple[str, str, str, str]:
    sections = [
        ("opener", (opener or "").strip()),
        ("body", (body or "").strip()),
        ("cta", (cta or "").strip()),
    ]
    separator = "\n\n"
    current = ""
    results: Dict[str, str] = {"opener": "", "body": "", "cta": ""}
    had_truncation = False

    for name, text in sections:
        if not text:
            results[name] = ""
            continue

        addition = separator if current else ""
        available = limit - len(current) - len(addition)
        if available <= 0:
            logger.warn(f"Section '{name}' dropped - no space remaining", {"leadId": lead_id}, {"currentLength": len(current)})
            results[name] = ""
            had_truncation = True
            continue

        if len(text) <= available:
            truncated = text
        else:
            logger.warn(f"Section '{name}' truncated", {"leadId": lead_id}, {"original": len(text), "available": available})
            truncated = _truncate_text(text, available)
            had_truncation = True

        current = f"{current}{addition}{truncated}" if current else truncated
        results[name] = truncated

    # Log if complete message fits or needed truncation
    final_length = len(current)
    if had_truncation:
        logger.warn(f"Message required truncation", {"leadId": lead_id}, {"finalLength": final_length, "limit": limit})
    else:
        logger.debug(f"Message within limit", {"leadId": lead_id}, {"length": final_length, "limit": limit})

    return results["opener"], results["body"], results["cta"], current


def sanitize_no_dashes(text: str) -> str:
    if not text:
        return ""
    # Replace prohibited characters (dashes, apostrophes) with spaces and collapse whitespace
    text = re.sub(r"[\-\u2010-\u2015\u2212]+", " ", text)
    text = re.sub(r"['`\u2018\u2019]+", " ", text)
    text = text.replace("\n", " ").replace("\r", " ")
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


GENERIC_FILLER_PATTERNS = [
    r"\b(das )?spart zeit( und)? senkt den verwaltungsaufwand\.?",
]


def strip_generic_filler(text: str) -> str:
    """Remove verbose filler phrases that bloat the message without adding value."""
    if not text:
        return ""
    cleaned = text
    for pattern in GENERIC_FILLER_PATTERNS:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip()


def ensure_sentence_punctuation(text: str) -> str:
    """Ensure each sentence-like fragment ends with terminal punctuation."""
    if not text:
        return ""

    fragments = re.split(r"[\n\r]+", text)
    normalized_fragments = []
    for fragment in fragments:
        cleaned = re.sub(r"\s{2,}", " ", fragment.strip())
        if not cleaned:
            continue
        if cleaned[-1] not in ".?!":
            cleaned = f"{cleaned}."
        normalized_fragments.append(cleaned)

    if not normalized_fragments:
        return ""

    return " ".join(normalized_fragments)


def build_text_block(*sections: str) -> str:
    parts = []
    for section in sections:
        normalized = ensure_sentence_punctuation(section)
        if normalized:
            parts.append(normalized)
    if not parts:
        return ""
    text_block = " ".join(parts)
    return re.sub(r" {2,}", " ", text_block).strip()


def main() -> None:
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Generate drafts for LinkedIn outreach leads")
    parser.add_argument(
        "--prompt-type",
        type=int,
        default=1,
        choices=[1, 2, 3],
        help="Prompt type: 1=Standard Outreach, 2=Vernetzung Thank-You, 3=Process Optimization",
    )
    parser.add_argument(
        "--mode",
        type=str,
        default="connect_message",
        choices=["connect_message", "connect_only", "message"],
        help="Which outreach pipeline to process: connect_message (connection + DM) or connect_only (message-only mode)",
    )
    parser.add_argument(
        "--batch-id",
        type=int,
        help="Process only leads from this batch id.",
    )
    args = parser.parse_args()
    prompt_type = args.prompt_type
    mode = "connect_only" if args.mode == "connect_only" else "message"
    
    # Load the appropriate prompt
    prompt_text = load_prompt(prompt_type)
    prompt_name = PROMPT_NAMES.get(prompt_type, "Standard Outreach")
    
    logger.operation_start("draft-generation", {"promptType": prompt_type, "mode": args.mode})
    logger.info(
        f"Using prompt type: {prompt_name}",
        data={"promptType": prompt_type, "promptName": prompt_name, "mode": args.mode},
    )
    
    try:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            logger.error("Missing OPENAI_API_KEY")
            raise RuntimeError("Missing OPENAI_API_KEY.")

        client = supabase_client()
        openai = OpenAI(api_key=api_key)

        leads = get_leads_for_generation(client, mode=mode, batch_id=args.batch_id)
        if not leads:
            logger.info("No leads found for requested mode", data={"mode": args.mode, "batchId": args.batch_id})
            return
        
        logger.info(
            f"Processing {len(leads)} leads",
            data={"count": len(leads), "promptType": prompt_type, "mode": args.mode},
        )

        # Initialize example pool
        example_pool = get_example_pool()
        
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

            # Get the next example using rotation
            last_category_index = get_rotation_state(client)
            category_name, example_text, new_category_index = example_pool.get_next_example(last_category_index)
            
            logger.info(f"Selected example from category", {"leadId": lead_id}, {
                "category": category_name,
                "categoryIndex": new_category_index,
                "example": example_text[:50] + "..."
            })
            
            # Update rotation state for next lead
            update_rotation_state(client, new_category_index)

            prompt = build_prompt(lead, case_study, company_type, example_text, category_name, prompt_text)
            
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
                    {
                        "role": "system",
                        "content": (
                            "Harte Regel: Verwende keine Bindestriche oder Gedankenstriche ('-', '–', '—') "
                            "und keine Apostrophe (') in irgendeinem Ausgabefeld (opener, body, cta, full_message). "
                            "Formuliere deine Ausgabe als geschlossenen Textblock ohne Zeilenumbrüche."
                        ),
                    },
                    {"role": "system", "content": prompt_text},
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
            full_message = build_text_block(opener, body, cta)
            body_type = data.get("body_type", "")
            cta_type = data.get("cta_type", "")

            logger.debug("Draft generated", {"leadId": lead_id}, {
                "messageLength": len(full_message),
                "bodyType": body_type,
                "ctaType": cta_type,
            })
            
            # Safety net: ensure the opener greets with the lead's first name when available
            def sanitize_opener(op: str, l: Dict[str, Any]) -> str:
                safe = (op or "").strip()
                # Replace common placeholder patterns
                for ph in ["[Name]", "[name]", "{Name}", "{name}", "<Name>", "<name>"]:
                    if ph in safe:
                        safe = safe.replace(ph, (l.get("first_name") or "").strip())
                first = (l.get("first_name") or "").strip()
                if first:
                    # If opener doesn't already mention the first name in the first few words, prefix it
                    lowered = safe.lower()
                    if first.lower() not in lowered[:40]:
                        # Normalize to German "Hey" greeting
                        safe = f"Hey {first}, " + safe
                else:
                    # No first name available: ensure we don't leave any placeholders
                    safe = safe.replace("[", "").replace("]", "").replace("{", "").replace("}", "").replace("<", "").replace(">", "")
                    if not safe.lower().startswith("hey"):
                        safe = f"Hey, {safe}" if safe else "Hey,"
                return safe.strip()

            opener = sanitize_opener(opener, lead)
            # If we rebuilt opener, recompute full_message to reflect sanitized opener
            if not data.get("full_message"):
                full_message = build_text_block(opener, body, cta)

            # Enforce no-dash rule on fields and rebuild full_message for consistency
            opener = sanitize_no_dashes(opener)
            body = sanitize_no_dashes(body)
            cta = sanitize_no_dashes(cta)
            opener = strip_generic_filler(opener)
            body = strip_generic_filler(body)
            cta = strip_generic_filler(cta)
            opener = ensure_sentence_punctuation(opener)
            body = ensure_sentence_punctuation(body)
            cta = ensure_sentence_punctuation(cta)
            full_message = build_text_block(opener, body, cta)

            # Check length before enforcement
            pre_check = build_text_block(opener, body, cta)
            if len(pre_check) > 300:
                logger.warn(f"AI generated message exceeds 300 chars", {"leadId": lead_id}, {"length": len(pre_check)})
            
            opener, body, cta, _ = enforce_char_limit(opener, body, cta, lead_id=lead_id)

            # Final safety: ensure no dashes or filler remain after truncation
            opener = sanitize_no_dashes(opener)
            body = sanitize_no_dashes(body)
            cta = sanitize_no_dashes(cta)
            opener = strip_generic_filler(opener)
            body = strip_generic_filler(body)
            cta = strip_generic_filler(cta)
            opener = ensure_sentence_punctuation(opener)
            body = ensure_sentence_punctuation(body)
            cta = ensure_sentence_punctuation(cta)
            full_message = build_text_block(opener, body, cta)

            next_status = "MESSAGE_ONLY_READY" if mode == "connect_only" else "DRAFT_READY"
            save_draft(
                client,
                lead_id,
                opener,
                body,
                cta,
                full_message,
                body_type,
                cta_type,
                next_status=next_status,
            )
            logger.info(f"Draft saved for lead", {"leadId": lead_id})
        
        logger.operation_complete("draft-generation", result={"processed": len(leads), "mode": args.mode})
    except Exception as exc:
        logger.operation_error("draft-generation", error=exc)
        raise


if __name__ == "__main__":
    main()
