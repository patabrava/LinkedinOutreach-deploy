"""Followup agent that generates personalized follow-up messages for LinkedIn leads."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
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
PROMPT_FILE = "prompt_followup.txt"


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
    
    # Determine scenario
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
    
    if has_reply:
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
            f"VORHERIGE FOLLOW-UPS:",
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
        f"Generiere jetzt eine passende Follow-up Nachricht basierend auf dem Szenario und Kontext."
    )


def generate_followup(context: Dict[str, Any]) -> Dict[str, Any]:
    """Generate a followup message using OpenAI.
    
    Args:
        context: Dictionary with lead info, reply_snippet, attempt, etc.
        
    Returns:
        Dictionary with message, message_type, tone
    """
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
        })
        
        # Output as JSON for the calling process
        print(json.dumps(result))
        
    except Exception as e:
        logger.error("Followup generation failed", error=e)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
