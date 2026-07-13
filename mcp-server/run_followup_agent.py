"""Followup agent that generates personalized follow-up messages for LinkedIn leads."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv

from ai_client import create_json_client, get_gemini_model, load_ai_env

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent / "workers"))
from shared_logger import get_logger

load_ai_env()
load_dotenv()

# Initialize logger
logger = get_logger("followup-agent")

GEMINI_MODEL = get_gemini_model()
PROMPT_FILE = "prompt_followup.txt"
POSITIVE_REPLY_LINK = "https://api.degura.de/2.0/consultants/my-scheduling-link"
NEGATIVE_REPLY_LINK = "https://www.degura.de/arbeitnehmer"
POSITIVE_REPLY_ANCHOR = (
    "Freut mich zu hören, kannst dir gerne hier einen Termin mit einem unserer "
    f"bAV Experten buchen {POSITIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_ANCHOR = (
    "Passt, vollkommen verständlich. Falls bAV später nochmal interessant wird, "
    "schau gerne hier vorbei: "
    f"{NEGATIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_FALLBACK_GENERIC = (
    "Passt, vollkommen verständlich. Falls bAV später nochmal interessant wird, "
    f"schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_FALLBACK_GENERIC_EN = (
    "Totally understandable. If occupational pension becomes relevant later, "
    f"feel free to take a look here: {NEGATIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_FALLBACK_VENDOR = (
    "Danke dir, lieb von dir zu fragen. Beim IT-Ticketsystem sind wir bestens aufgestellt. "
    f"Falls bAV bei euch doch nochmal Thema wird, schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_FALLBACK_RELOCATION = (
    "Alles gut, dann macht das aktuell keinen Sinn. Falls bAV später nochmal interessant wird, "
    f"schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}"
)
NEGATIVE_REPLY_FALLBACK_ALREADY_COVERED = (
    "Danke dir, alles klar. Dann bist du ja erstmal versorgt. "
    f"Falls später doch mal etwas offen ist, schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}"
)

ASCII_UMLAUT_WORDS = {
    "aehnlich": "ähnlich",
    "aendern": "ändern",
    "fuer": "für",
    "haette": "hätte",
    "haetten": "hätten",
    "koennen": "können",
    "koennte": "könnte",
    "koennten": "könnten",
    "laeuft": "läuft",
    "loesung": "lösung",
    "loesungen": "lösungen",
    "moechte": "möchte",
    "moechten": "möchten",
    "muesste": "müsste",
    "muessten": "müssten",
    "pruefen": "prüfen",
    "schoen": "schön",
    "schoene": "schöne",
    "schoener": "schöner",
    "ueber": "über",
    "ueberhaupt": "überhaupt",
    "ueberlegen": "überlegen",
    "uebersehe": "übersehe",
    "uebersehen": "übersehen",
    "waere": "wäre",
    "waeren": "wären",
}


def load_followup_prompt() -> str:
    """Load the followup prompt file."""
    prompt_path = Path(__file__).parent.joinpath(PROMPT_FILE)
    if not prompt_path.exists():
        raise FileNotFoundError(f"Followup prompt not found: {prompt_path}")
    return prompt_path.read_text()


def _preserve_case(source: str, replacement: str) -> str:
    if source.isupper():
        return replacement.upper()
    if source[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def normalize_ascii_umlauts(text: str) -> str:
    """Convert common ASCII umlaut spellings to native German forms."""
    if not text:
        return ""

    def replace_match(match: re.Match[str]) -> str:
        source = match.group(0)
        replacement = ASCII_UMLAUT_WORDS.get(source.lower())
        return _preserve_case(source, replacement) if replacement else source

    pattern = r"\b(" + "|".join(re.escape(word) for word in ASCII_UMLAUT_WORDS) + r")\b"
    return re.sub(pattern, replace_match, text, flags=re.IGNORECASE)


def sanitize_message(text: str) -> str:
    """Apply safety filters: remove dashes/apostrophes, enforce char limit."""
    if not text:
        return ""
    # Remove dashes and apostrophes
    sanitized = re.sub(r"[\-\u2010-\u2015\u2212]+", " ", text)
    sanitized = re.sub(r"['`\u2018\u2019]+", " ", sanitized)
    sanitized = sanitized.replace("\n", " ").replace("\r", " ")
    sanitized = re.sub(r" {2,}", " ", sanitized).strip()
    sanitized = normalize_ascii_umlauts(sanitized)
    
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
    sanitized = normalize_ascii_umlauts(sanitized)
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


def _context_reply_text(context: Optional[Dict[str, Any]]) -> str:
    if not context:
        return ""
    return str(context.get("last_message_text") or context.get("reply_snippet") or "")


def _strip_contact_name_from_opening(text: str, context: Optional[Dict[str, Any]]) -> str:
    if not text or not context:
        return text
    first_name = str(context.get("first_name") or "").strip()
    if not first_name:
        return text
    name = re.escape(first_name)
    text = re.sub(rf"^\s*(?:hi|hallo|hey)?\s*,?\s*{name}\s*,\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(rf"^({name})\s*[,.:;-]\s*", "", text, flags=re.IGNORECASE)
    return re.sub(rf"(^[^.!?]{{0,100}}),\s*{name}([.!?])", r"\1\2", text, flags=re.IGNORECASE).strip()


def _negative_reply_fallback(context: Optional[Dict[str, Any]]) -> str:
    reply_text = _context_reply_text(context).lower()
    if re.search(r"\b(not interested|no longer|unemployed|current employer|doesn.t apply|don.t speak german|north america)\b", reply_text):
        return NEGATIVE_REPLY_FALLBACK_GENERIC_EN
    if re.search(r"\b(servicenow|ticket\s*system|ticketsystem|it\s*ticket|anders\s+herum|bei\s+degura)\b", reply_text):
        return NEGATIVE_REPLY_FALLBACK_VENDOR
    if re.search(r"\b(bulgarien|umzug|umgezogen|gezogen|ausland|nicht\s+zutreffen|trifft\s+nicht|passt\s+nicht)\b", reply_text):
        return NEGATIVE_REPLY_FALLBACK_RELOCATION
    if re.search(r"\b(bereits|schon|abgesichert|altersvorsorge|bav|bav\b|land\s+berlin|zuschuss)\b", reply_text):
        return NEGATIVE_REPLY_FALLBACK_ALREADY_COVERED
    return NEGATIVE_REPLY_FALLBACK_GENERIC


def _has_echo_style_violation(text: str, context: Optional[Dict[str, Any]]) -> bool:
    if not text:
        return False
    first_sentence = text.split(NEGATIVE_REPLY_LINK, 1)[0][:180].lower()
    first_name = str((context or {}).get("first_name") or "").strip()
    if first_name and re.search(rf"\b{re.escape(first_name.lower())}\b", first_sentence):
        return True

    bad_openers = [
        r"\bdanke\s+(?:dir\s+)?für\s+die\s+(?:info|rückmeldung|nachfrage)\s*,?\s*(?:dass|zu)\b",
        r"\bdanke\s+(?:dir\s+)?für\s+die\s+(?:info|rückmeldung|nachfrage)\s*,\s*[a-zäöüß]+\b",
        r"\bschade,\s*dass\b",
        r"\bdurch\s+deinen?\s+umzug\b",
        r"\bdass\s+du\s+(?:bereits|schon)\b",
    ]
    return any(re.search(pattern, first_sentence) for pattern in bad_openers)


def _repair_reply_style(draft_text: str, intent: str, context: Optional[Dict[str, Any]]) -> str:
    cleaned = _strip_contact_name_from_opening(draft_text, context)
    if intent == "negative" and context:
        reply_text = _context_reply_text(context).lower()
        needs_warmer_phrase = "findest du hier einen überblick" in cleaned.lower()
        is_vendor_pitch = bool(
            re.search(
                r"\b(servicenow|ticket\s*system|ticketsystem|it\s*ticket|anders\s+herum|bei\s+degura)\b",
                reply_text,
            )
        )
        is_english_negative = bool(
            re.search(
                r"\b(not interested|no longer|unemployed|current employer|doesn.t apply|don.t speak german|north america)\b",
                reply_text,
            )
        )
        if (
            NEGATIVE_REPLY_LINK not in cleaned
            or _has_echo_style_violation(cleaned, context)
            or is_vendor_pitch
            or is_english_negative
            or needs_warmer_phrase
        ):
            return _sanitize_reply_message(_negative_reply_fallback(context))
    return cleaned


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


def parse_reply_generation_response(raw_content: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = _extract_json_object(raw_content)
    intent = str(payload.get("intent") or "").strip().lower()
    if intent not in {"positive", "negative"}:
        intent = "negative"

    draft_text = _sanitize_reply_message(str(payload.get("draft_text") or payload.get("message") or ""))
    draft_text = _repair_reply_style(draft_text, intent, context)
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
    sequence_messages = context.get("sequence_messages") or {}
    sequence_lines = _reply_sequence_style_lines(sequence_messages)

    lines = [
        "Du klassifizierst eine LinkedIn Antwort und formulierst eine sehr kurze Antwort.",
        "Erlaubte intents: positive, negative.",
        "Wenn die Antwort unklar, ablehnend, vertröstend oder ohne klares Interesse ist, wähle negative.",
        "Wenn die Person Interesse zeigt, ein Gespräch will oder mehr wissen möchte, wähle positive.",
        "Wenn die Person stattdessen ihre eigene Leistung anbietet, eine Gegenfrage zu Degura als Kunde stellt oder ein Verkaufsgespräch für ihr Produkt startet, wähle negative.",
        "Schreibe wie Katharina in einer echten kurzen LinkedIn DM: freundlich, locker, knapp, nicht corporate.",
        "Wenn der Kontakt auf Englisch schreibt, antworte auf Englisch. Sonst Deutsch.",
        "Die Antwort darf warm klingen, aber nicht überschwänglich. Nutze natürliche Formulierungen wie 'Alles gut', 'Danke dir', 'macht Sinn', 'schicke ich dir'.",
        "Niemals mit dem Vornamen oder einer Anrede beginnen. Den Namen des Kontakts nicht wiederholen.",
        "Nicht paraphrasieren: keine Sätze wie 'Danke für die Info, dass ...' oder 'Schade, dass ...'.",
        "Reagiere nur auf die Absicht der letzten Nachricht: kurz bestätigen, direkt antworten, Link anhängen.",
        "Wenn der Kontakt uns etwas verkaufen will oder nach unserem Setup fragt: im gleichen ruhigen Stil antworten, dass wir bestens aufgestellt sind.",
        "Schreibe wie ein nativer deutscher Sprecher mit ä, ö, ü und ß. Niemals ae, oe oder ue als Umlaut-Ersatz.",
        "Keine neuen Links, keine neuen Angebote, kein langer Chatbot-Text. Maximal zwei kurze Sätze vor dem Link.",
        "Negative Antworten müssen den negativen Link vollständig enthalten.",
        "",
        "Beispiele für negative Antworten:",
        f"- Kein Interesse/kein Bedarf: Passt, vollkommen verständlich. Falls bAV später nochmal interessant wird, schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}",
        f"- English no interest/out of scope: Totally understandable. If occupational pension becomes relevant later, feel free to take a look here: {NEGATIVE_REPLY_LINK}",
        f"- Gegenfrage/Vendor Pitch: Danke dir, lieb von dir zu fragen. Beim IT-Ticketsystem sind wir bestens aufgestellt. Falls bAV bei euch doch nochmal Thema wird, schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}",
        f"- Umzug/nicht passend: Alles gut, dann macht das aktuell keinen Sinn. Falls bAV später nochmal interessant wird, schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}",
        f"- Bereits versorgt: Danke dir, alles klar. Dann bist du ja erstmal versorgt. Falls später doch mal etwas offen ist, schau gerne hier vorbei: {NEGATIVE_REPLY_LINK}",
        "",
        f"Positive Vorlage: {POSITIVE_REPLY_ANCHOR}",
        f"Negative Vorlage: {NEGATIVE_REPLY_ANCHOR}",
        "",
    ]
    if sequence_lines:
        lines.extend(sequence_lines)
        lines.append("")

    lines.extend([
        "Antworte ausschließlich als JSON:",
        '{"intent":"positive|negative","draft_text":"string","confidence":0.0}',
        "",
        f"Kontakt Vorname: {first_name}",
        f"Firma: {company_name}",
        f"Unsere vorherige Nachricht: {original_message[:500]}",
        f"Antwort des Kontakts: {reply_text[:1000]}",
    ])
    return "\n".join(lines)


def call_gemini_reply_model(context: Dict[str, Any]) -> str:
    client = create_json_client()
    prompt = build_reply_generation_prompt(context)
    logger.ai_request(GEMINI_MODEL, {"followupId": context.get("followup_id")}, prompt[:200])
    response = client.generate_json(
        [
            {
                "role": "user",
                "content": prompt,
            }
        ],
        temperature=0.45,
        max_output_tokens=2000,
        timeout=45,
    )
    logger.ai_response(GEMINI_MODEL, {"followupId": context.get("followup_id")}, response.total_tokens)
    return response.raw_text


def _reply_sequence_style_lines(sequence_messages: Dict[str, Any]) -> list[str]:
    if not sequence_messages:
        return []
    lines = _sequence_style_lines(sequence_messages)
    return [
        line
        for line in lines
        if "Beziehe dich konkret auf die letzte Nachricht" not in line
    ] + [
        "- Greife nur die Absicht der letzten Nachricht auf, ohne die Details nachzuerzählen",
    ]


def _sequence_style_lines(sequence_messages: Dict[str, Any]) -> list[str]:
    if not sequence_messages:
        return []

    labels = [
        ("name", "Name"),
        ("connect_note", "Kontaktanfrage"),
        ("first_message", "Nachricht 1"),
        ("second_message", "Nachricht 2 / positiver Follow-up-Inhalt"),
        ("third_message", "Nachricht 3 / negativer Abschluss-Inhalt"),
    ]
    lines = ["", "SEQUENZ-STIL ALS SCHREIBVORBILD:"]
    for key, label in labels:
        value = str(sequence_messages.get(key) or "").strip()
        if value:
            lines.append(f"- {label}: {value}")
    lines.extend(
        [
            "",
            "Nutze diese Sequenz nicht als Copy-Paste-Vorlage, sondern als Stilquelle:",
            "- gleiche Tonalität, Kürze, Direktheit und thematische Stoßrichtung",
            "- bei positiver Antwort: den positiven Follow-up-Inhalt als Zielrichtung nutzen",
            "- bei negativer oder skeptischer Antwort: den negativen Abschluss-Inhalt als Zielrichtung nutzen",
            "- Beziehe dich konkret auf die letzte Nachricht des Kontakts, damit die Antwort nicht standardisiert wirkt",
            "- Native deutsche Umlaute verwenden: ä, ö, ü, ß. Niemals ae, oe oder ue als Umlaut-Ersatz schreiben",
        ]
    )
    return lines


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
    sequence_messages = context.get("sequence_messages") or {}
    
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

    context_parts.extend(_sequence_style_lines(sequence_messages))
    
    context_section = "\n".join(context_parts)
    
    return (
        f"{prompt_text}\n\n"
        f"===== KONTEXT FÜR DIESE NACHRICHT =====\n"
        f"{context_section}\n"
        f"===== ENDE KONTEXT =====\n\n"
        f"Generiere jetzt eine passende Follow-up Nachricht basierend auf dem Szenario und Kontext. "
        f"Du schreibst IMMER als wir/uns (der Absender), niemals als der Kontakt. "
        f"Beziehe dich konkret auf die letzte Nachricht und halte die Sequenz als Stilanker ein."
    )


def generate_followup(context: Dict[str, Any]) -> Dict[str, Any]:
    """Generate a followup message using Gemini.
    
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
        return parse_reply_generation_response(raw_content, context)

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
        client = create_json_client()
        logger.ai_request(GEMINI_MODEL, {"followupId": context.get("followup_id")}, full_prompt[:200])
        response = client.generate_json(
            [
                {
                    "role": "system",
                    "content": "Du bist ein LinkedIn Follow-up Agent. Antworte NUR mit validen JSON. Keine Erklärungen."
                },
                {"role": "user", "content": full_prompt},
            ],
            temperature=0.7,
            max_output_tokens=2000,
        )
        logger.ai_response(GEMINI_MODEL, {"followupId": context.get("followup_id")}, response.total_tokens)
        raw_content = response.raw_text
        result = response.data
        logger.debug("Gemini response received", data={"length": len(raw_content)})
        
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
        logger.error("Failed to parse Gemini response as JSON", error=e)
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
        logger.error("Gemini API call failed", error=e)
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
