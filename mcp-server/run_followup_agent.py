"""Followup agent that generates personalized follow-up messages for LinkedIn leads."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from openai import OpenAI

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent / "workers"))
from shared_logger import get_logger

load_dotenv()

# Initialize logger
logger = get_logger("followup-agent")

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_ENDPOINT_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
PROMPT_FILE = "prompt_followup.txt"
POSITIVE_REPLY_LINK = "https://api.degura.de/2.0/consultants/my-scheduling-link"
NEGATIVE_REPLY_LINK = "https://www.degura.de/arbeitnehmer"
POSITIVE_REPLY_ANCHOR = (
    "Freut mich zu hoeren, kannst dir gerne hier einen Termin mit einem unserer "
    f"bAV Experten buchen {POSITIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_ANCHOR = (
    "Wenn es spaeter interessant wird, findest du hier einen Ueberblick: "
    f"{NEGATIVE_REPLY_LINK}"
)


def load_followup_prompt() -> str:
    """Load the followup prompt file."""
    prompt_path = Path(__file__).parent.joinpath(PROMPT_FILE)
    if not prompt_path.exists():
        raise FileNotFoundError(f"Followup prompt not found: {prompt_path}")
    return prompt_path.read_text()


def sanitize_message(text: str) -> str:
    """Apply safety filters: remove dashes/apostrophes, enforce char limit."""
    if not text:
        return ""
    # Remove dashes and apostrophes
    sanitized = re.sub(r"[\-\u2010-\u2015\u2212]+", " ", text)
    sanitized = re.sub(r"['`\u2018\u2019]+", " ", sanitized)
    sanitized = sanitized.replace("\n", " ").replace("\r", " ")
    sanitized = re.sub(r" {2,}", " ", sanitized).strip()
    
    # Hard cap at 300 characters
    if len(sanitized) > 300:
        candidate = sanitized[:297].rstrip()
        space_idx = candidate.rfind(" ")
        if space_idx >= 150:
            candidate = candidate[:space_idx]
        candidate = candidate.rstrip(" ,.;:-")
        sanitized = f"{candidate}..."
    
    return sanitized


def _sanitize_reply_message(text: str) -> str:
    """Normalize reply drafts without damaging approved URLs."""
    if not text:
        return ""
    sanitized = text.replace("\n", " ").replace("\r", " ")
    sanitized = re.sub(r" {2,}", " ", sanitized).strip()
    if len(sanitized) <= 300:
        return sanitized

    urls = [POSITIVE_REPLY_LINK, NEGATIVE_REPLY_LINK]
    preserved_url = next((url for url in urls if url in sanitized), "")
    if preserved_url and len(preserved_url) < 290:
        prefix_limit = max(0, 296 - len(preserved_url))
        prefix = sanitized.split(preserved_url, 1)[0][:prefix_limit].rstrip()
        prefix = prefix.rstrip(" ,.;:-")
        return f"{prefix}... {preserved_url}".strip()

    candidate = sanitized[:297].rstrip()
    space_idx = candidate.rfind(" ")
    if space_idx >= 150:
        candidate = candidate[:space_idx]
    candidate = candidate.rstrip(" ,.;:-")
    return f"{candidate}..."


def _is_reply_context(context: Dict[str, Any]) -> bool:
    followup_type = str(context.get("followup_type") or "").upper()
    last_message_from = str(context.get("last_message_from") or "").lower()
    return followup_type == "REPLY" or last_message_from == "lead" or bool(context.get("reply_snippet"))


def _clamp_confidence(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, numeric))


def _extract_json_object(raw_content: str) -> Dict[str, Any]:
    raw = (raw_content or "").strip()
    if not raw:
        raise ValueError("Gemini returned empty content instead of valid JSON")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            raise ValueError("Gemini did not return valid JSON")
        try:
            return json.loads(match.group())
        except json.JSONDecodeError as exc:
            raise ValueError("Gemini did not return valid JSON") from exc


def parse_reply_generation_response(raw_content: str) -> Dict[str, Any]:
    payload = _extract_json_object(raw_content)
    intent = str(payload.get("intent") or "").strip().lower()
    if intent not in {"positive", "negative"}:
        intent = "negative"

    draft_text = _sanitize_reply_message(str(payload.get("draft_text") or payload.get("message") or ""))
    if not draft_text:
        raise ValueError("Gemini reply draft is empty")

    required_link = POSITIVE_REPLY_LINK if intent == "positive" else NEGATIVE_REPLY_LINK
    if required_link not in draft_text:
        raise ValueError(f"Gemini reply draft did not preserve approved link: {required_link}")

    return {
        "message": draft_text,
        "intent": intent,
        "confidence": _clamp_confidence(payload.get("confidence")),
        "message_type": f"reply_{intent}",
        "tone": "friendly",
    }


def build_reply_generation_prompt(context: Dict[str, Any]) -> str:
    reply_text = context.get("last_message_text") or context.get("reply_snippet") or ""
    first_name = context.get("first_name") or ""
    company_name = context.get("company_name") or ""
    original_message = context.get("original_message") or ""

    return "\n".join([
        "Du klassifizierst eine LinkedIn Antwort und formulierst eine sehr kurze Antwort.",
        "Erlaubte intents: positive, negative.",
        "Wenn die Antwort unklar, ablehnend, vertroestend oder ohne klares Interesse ist, waehle negative.",
        "Wenn die Person Interesse zeigt, ein Gespraech will oder mehr wissen moechte, waehle positive.",
        "Wenn die Person stattdessen ihre eigene Leistung anbietet, eine Gegenfrage zu Degura als Kunde stellt oder ein Verkaufsgespraech fuer ihr Produkt startet, waehle negative.",
        "Nutze nur eine leichte Umformulierung der passenden genehmigten Vorlage.",
        "Keine neuen Links, keine neuen Angebote, kein langer Chatbot-Text.",
        "",
        f"Positive Vorlage: {POSITIVE_REPLY_ANCHOR}",
        f"Negative Vorlage: {NEGATIVE_REPLY_ANCHOR}",
        "",
        "Antworte ausschliesslich als JSON:",
        '{"intent":"positive|negative","draft_text":"string","confidence":0.0}',
        "",
        f"Kontakt Vorname: {first_name}",
        f"Firma: {company_name}",
        f"Unsere vorherige Nachricht: {original_message[:500]}",
        f"Antwort des Kontakts: {reply_text[:1000]}",
    ])


def call_gemini_reply_model(context: Dict[str, Any]) -> str:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY not set")

    endpoint = GEMINI_ENDPOINT_TEMPLATE.format(model=GEMINI_MODEL, api_key=api_key)
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_reply_generation_prompt(context)}],
            }
        ],
        "generationConfig": {
            "temperature": 0.25,
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini HTTP {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Gemini request failed: {exc}") from exc

    try:
        return payload["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"Gemini response missing text content: {json.dumps(payload)[:500]}") from exc


def build_followup_prompt(context: Dict[str, Any], prompt_text: str) -> str:
    """Build the prompt for followup generation.
    
    Args:
        context: Dictionary containing lead info, reply_snippet, attempt, etc.
        prompt_text: The base prompt template
    """
    first_name = context.get("first_name", "").strip()
    last_name = context.get("last_name", "").strip()
    company_name = context.get("company_name", "").strip()
    reply_snippet = context.get("reply_snippet") or ""
    attempt = context.get("attempt", 1)
    original_message = context.get("original_message", "")
    previous_messages = context.get("previous_messages", [])
    profile_data = context.get("profile_data", {})
    
    # New: last message tracking for proper sender attribution
    last_message_text = context.get("last_message_text") or ""
    last_message_from = context.get("last_message_from") or ""
    
    # Determine scenario based on last_message_from (preferred) or fallback to reply_snippet
    # If last_message_from == 'lead', they replied to us -> REPLY scenario
    # If last_message_from == 'us', we sent last -> NUDGE scenario
    if last_message_from == "lead":
        scenario = "REPLY"
        has_reply = True
    elif last_message_from == "us":
        scenario = "NO_REPLY"
        has_reply = False
    else:
        # Fallback to legacy behavior using reply_snippet
        has_reply = bool(reply_snippet and reply_snippet.strip())
        scenario = "REPLY" if has_reply else "NO_REPLY"
    
    # Build context section
    context_parts = [
        f"KONTAKT INFORMATIONEN:",
        f"- Vorname: {first_name or 'Unbekannt'}",
        f"- Nachname: {last_name or 'Unbekannt'}",
        f"- Firma: {company_name or 'Unbekannt'}",
        f"- Followup Versuch: {attempt}",
        f"",
        f"SZENARIO: {scenario}",
    ]
    
    # Add last message with explicit sender attribution
    if last_message_text:
        sender_label = "Kontakt" if last_message_from == "lead" else "Du (wir)"
        context_parts.extend([
            f"",
            f"LETZTE NACHRICHT IM THREAD (Absender: {sender_label}):",
            f'"{last_message_text[:400]}..."' if len(last_message_text) > 400 else f'"{last_message_text}"',
        ])
        
        # Clarify who should write the response
        if last_message_from == "us":
            context_parts.extend([
                f"",
                f"⚠️ WICHTIG: Die letzte Nachricht war von UNS. Der Kontakt hat noch nicht geantwortet.",
                f"Du schreibst jetzt eine Follow-up Nachricht UM den Kontakt erneut zu erreichen.",
            ])
        else:
            context_parts.extend([
                f"",
                f"⚠️ WICHTIG: Die letzte Nachricht war vom KONTAKT. Sie haben auf unsere Nachricht geantwortet.",
                f"Du schreibst jetzt eine Antwort AUF ihre Nachricht.",
            ])
    elif has_reply and reply_snippet:
        # Fallback: show reply_snippet if no last_message_text
        context_parts.extend([
            f"",
            f"ANTWORT DES KONTAKTS:",
            f'"{reply_snippet}"',
        ])
    
    if original_message:
        context_parts.extend([
            f"",
            f"URSPRÜNGLICHE NACHRICHT (die wir gesendet haben):",
            f'"{original_message[:300]}..."' if len(original_message) > 300 else f'"{original_message}"',
        ])
    
    if previous_messages:
        context_parts.extend([
            f"",
            f"VORHERIGE FOLLOW-UPS (von uns gesendet):",
        ])
        for i, msg in enumerate(previous_messages[:3], 1):
            context_parts.append(f"{i}. {msg[:150]}...")
    
    # Add profile context if available
    if profile_data:
        headline = profile_data.get("headline", "")
        if headline:
            context_parts.extend([
                f"",
                f"PROFIL HEADLINE: {headline}",
            ])
    
    context_section = "\n".join(context_parts)
    
    return (
        f"{prompt_text}\n\n"
        f"===== KONTEXT FÜR DIESE NACHRICHT =====\n"
        f"{context_section}\n"
        f"===== ENDE KONTEXT =====\n\n"
        f"Generiere jetzt eine passende Follow-up Nachricht basierend auf dem Szenario und Kontext. "
        f"Du schreibst IMMER als wir/uns (der Absender), niemals als der Kontakt."
    )


def generate_followup(context: Dict[str, Any]) -> Dict[str, Any]:
    """Generate a followup message using Gemini for replies and OpenAI for legacy nudges.
    
    Args:
        context: Dictionary with lead info, reply_snippet, attempt, etc.
        
    Returns:
        Dictionary with message, message_type, tone
    """
    if _is_reply_context(context):
        logger.debug("Generating Gemini reply draft", data={
            "followup_id": context.get("followup_id"),
            "has_reply": bool(context.get("reply_snippet") or context.get("last_message_text")),
        })
        raw_content = call_gemini_reply_model(context)
        return parse_reply_generation_response(raw_content)

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    
    client = OpenAI(api_key=api_key)
    
    # Load prompt and build full prompt
    prompt_text = load_followup_prompt()
    full_prompt = build_followup_prompt(context, prompt_text)
    
    logger.debug("Generating followup draft", data={
        "followup_id": context.get("followup_id"),
        "first_name": context.get("first_name"),
        "has_reply": bool(context.get("reply_snippet")),
        "attempt": context.get("attempt", 1),
    })
    
    try:
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "Du bist ein LinkedIn Follow-up Agent. Antworte NUR mit validen JSON. Keine Erklärungen."
                },
                {"role": "user", "content": full_prompt},
            ],
            temperature=0.7,
            max_tokens=500,
        )
        
        raw_content = response.choices[0].message.content or ""
        logger.debug("OpenAI response received", data={"length": len(raw_content)})
        
        # Parse JSON response
        # Try to extract JSON from the response
        json_match = re.search(r'\{[^{}]*\}', raw_content, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
        else:
            # If no JSON found, try parsing the whole response
            result = json.loads(raw_content.strip())
        
        # Sanitize the message
        message = sanitize_message(result.get("message", ""))
        
        if not message:
            raise ValueError("Generated message is empty")
        
        return {
            "message": message,
            "message_type": result.get("message_type", "unknown"),
            "tone": result.get("tone", "friendly"),
        }
        
    except json.JSONDecodeError as e:
        logger.error("Failed to parse OpenAI response as JSON", error=e)
        # Fallback: try to extract any reasonable text
        lines = raw_content.strip().split("\n")
        for line in lines:
            if len(line) > 20 and len(line) < 350:
                return {
                    "message": sanitize_message(line),
                    "message_type": "fallback",
                    "tone": "friendly",
                }
        raise ValueError(f"Could not parse response: {raw_content[:200]}")
    except Exception as e:
        logger.error("OpenAI API call failed", error=e)
        raise


def main():
    parser = argparse.ArgumentParser(description="Generate followup draft using AI")
    parser.add_argument("--context", required=True, help="Path to JSON file with context")
    args = parser.parse_args()
    
    # Load context from file
    context_path = Path(args.context)
    if not context_path.exists():
        print(json.dumps({"error": f"Context file not found: {args.context}"}))
        sys.exit(1)
    
    try:
        context = json.loads(context_path.read_text())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON in context file: {e}"}))
        sys.exit(1)
    
    logger.operation_start("followup-generation", input_data={
        "followup_id": context.get("followup_id"),
        "lead_id": context.get("lead_id"),
    })
    
    try:
        result = generate_followup(context)
        logger.operation_complete("followup-generation", result={
            "message_length": len(result.get("message", "")),
            "message_type": result.get("message_type"),
            "intent": result.get("intent"),
            "confidence": result.get("confidence"),
        })
        
        # Output as JSON for the calling process
        print(json.dumps(result))
        
    except Exception as e:
        logger.error("Followup generation failed", error=e)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
