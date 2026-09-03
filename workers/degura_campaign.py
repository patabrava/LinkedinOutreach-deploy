"""Deterministic DEGURA scheduling, asset and reply safety contracts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
import calendar
import re
from typing import Optional
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")
MAX_GUIDE_BYTES = 10 * 1024 * 1024

HUMAN_ONLY_ROUTES = {
    "price",
    "competitor",
    "legal",
    "privacy",
    "angry",
    "unclear",
    "unsupported_language",
    "asset_reply",
    "second_factual_question",
}


@dataclass(frozen=True)
class ReplyDecision:
    route: str
    requires_human: bool
    reason: str
    action_order: tuple[str, ...]
    auto_template_key: Optional[str] = None


def ensure_berlin(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=BERLIN)
    return value.astimezone(BERLIN)


def add_business_days(value: datetime, days: int) -> datetime:
    if days < 0:
        raise ValueError("Business-day offset must be non-negative.")
    current = ensure_berlin(value)
    remaining = days
    while remaining:
        current += timedelta(days=1)
        if current.weekday() < 5:
            remaining -= 1
    return current


def add_calendar_months(value: datetime, months: int) -> datetime:
    if months < 0:
        raise ValueError("Month offset must be non-negative.")
    source = ensure_berlin(value)
    month_index = source.month - 1 + months
    year = source.year + month_index // 12
    month = month_index % 12 + 1
    day = min(source.day, calendar.monthrange(year, month)[1])
    return source.replace(year=year, month=month, day=day)


def next_touch_at(touch_number: int, reference_at: datetime) -> Optional[datetime]:
    if touch_number == 2:
        return ensure_berlin(reference_at) + timedelta(hours=24)
    if touch_number == 3:
        return add_business_days(reference_at, 4)
    if touch_number == 4:
        return add_business_days(reference_at, 6)
    if touch_number > 4:
        return None
    raise ValueError("Touch number must be 2, 3, 4, or a completed touch above 4.")


def invite_withdraw_at(invite_sent_at: datetime) -> datetime:
    return ensure_berlin(invite_sent_at) + timedelta(days=14)


def nurture_until(sequence_ended_at: datetime) -> datetime:
    return add_calendar_months(sequence_ended_at, 6)


def asset_followup_at(asset_sent_at: datetime, followup_number: int) -> datetime:
    if followup_number == 1:
        return add_business_days(asset_sent_at, 5)
    if followup_number == 2:
        return add_business_days(asset_sent_at, 7)
    raise ValueError("Asset follow-up number must be 1 or 2.")


def out_of_office_resume(return_at: datetime) -> datetime:
    return add_business_days(return_at, 1)


def validate_guide_pdf(path_value: object, max_bytes: int = MAX_GUIDE_BYTES) -> Path:
    path = Path(str(path_value or "")).expanduser()
    if not path.is_file():
        raise ValueError("GUIDE_ASSET_INVALID: Guide PDF is missing or unreadable.")
    size = path.stat().st_size
    if size < 5 or size > max_bytes:
        raise ValueError("GUIDE_ASSET_INVALID: Guide PDF size is invalid.")
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            raise ValueError("GUIDE_ASSET_INVALID: Guide asset is not a PDF.")
    return path.resolve()


def route_degura_reply(
    text: object,
    *,
    confidence: float = 1.0,
    language: str = "de",
    source_touch: Optional[str] = None,
    factual_questions_answered: int = 0,
) -> ReplyDecision:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    if confidence < 0.85 or not normalized:
        return ReplyDecision("unclear", True, "low_confidence", ("handoff",))
    if language.lower() not in {"de", "en"}:
        return ReplyDecision("unsupported_language", True, "unsupported_language", ("handoff",))
    if source_touch in {"asset_followup_1", "asset_followup_2"}:
        return ReplyDecision("asset_reply", True, "asset_followup_reply", ("handoff",))

    checks = (
        ("privacy", r"datenschutz|dsgvo|auskunft|daten löschen"),
        ("angry", r"belästig|unverschämt|frech|anwalt|beschwerde"),
        ("price", r"preis|kosten|kostet|angebot"),
        ("competitor", r"wettbewerb|konkurrent|versus|vs\.?|vergleich"),
        ("legal", r"rechtssicher|betravg|gesetz|haftung|paragraph|§"),
    )
    for route, pattern in checks:
        if re.search(pattern, normalized):
            action = ("suppress", "handoff") if route in {"privacy", "angry"} else ("handoff",)
            return ReplyDecision(route, True, f"{route}_question", action)

    if re.search(r"nicht mehr|keine nachrichten|abmeld|unsubscribe|bitte löschen", normalized):
        return ReplyDecision("clear_no", False, "explicit_opt_out", ("suppress", "send_close"), "clear_no")
    if re.search(r"\bnein\b|kein interesse|passt nicht", normalized):
        return ReplyDecision("clear_no", False, "clear_no", ("suppress", "send_close"), "clear_no")
    if re.search(r"urlaub|abwesen|out of office|zurück am", normalized):
        return ReplyDecision("out_of_office", False, "temporary_absence", ("pause",), None)
    if re.search(r"per e-?mail|per mail|mailadresse|e-mail-adresse", normalized):
        return ReplyDecision("email_request", False, "email_delivery_requested", ("ask_email",), "email_request")
    if re.search(r"bereits (?:eine |die )?bav|schon (?:eine |die )?bav|makler|bestehende bav", normalized):
        return ReplyDecision("existing_bav", False, "existing_bav_or_broker", ("send_reply",), "existing_bav")
    if re.search(r"intern (?:klären|abstimmen|besprechen)|geschäftsführung (?:klären|fragen|abstimmen)", normalized):
        return ReplyDecision("internal_clarification", False, "internal_clarification", ("send_reply",), "internal_clarification")
    if re.search(r"keine zeit|keinen zeit|zu wenig zeit", normalized):
        return ReplyDecision("no_time", False, "no_time", ("send_reply",), "no_time")
    if re.search(r"interessiert (?:unsere|die) mitarbeit|mitarbeitende.*(?:kein|nicht).*interess", normalized):
        return ReplyDecision("employee_disinterest", False, "employee_disinterest", ("send_reply",), "employee_disinterest")
    if re.search(r"(?:im moment|aktuell|derzeit) nicht|nicht jetzt|später|vielleicht im|nächstes (?:jahr|quartal)", normalized):
        return ReplyDecision("not_now", False, "not_now", ("pause", "send_reply"), "not_now")
    if re.search(r"termin|kalender|sprechen|call|telefon", normalized):
        return ReplyDecision("appointment", False, "appointment_request", ("send_booking_link", "handoff"), "booking_link")
    if re.search(r"leitfaden|pdf|material|schicken|senden", normalized):
        return ReplyDecision("guide", False, "guide_consent", ("validate_delivery", "send_guide", "schedule_asset_followup"), "guide")
    if re.search(r"nicht zuständig|falsche person|weiterleiten|zuständig ist", normalized):
        return ReplyDecision("wrong_person", False, "wrong_person", ("ask_referral",), "ask_referral")
    if "?" in normalized:
        if factual_questions_answered >= 1:
            return ReplyDecision("second_factual_question", True, "second_factual_question", ("handoff",))
        return ReplyDecision("factual_question", True, "fact_requires_approved_basis", ("handoff",))
    return ReplyDecision("unclear", True, "unclassified_reply", ("handoff",))


def event_payload(
    *,
    account_id: str,
    lead_id: str,
    event_type: str,
    sequence_id: Optional[int] = None,
    variant_id: Optional[int] = None,
    touch_number: Optional[int] = None,
    correlation_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> dict:
    return {
        "linkedin_account_id": account_id,
        "lead_id": lead_id,
        "sequence_id": sequence_id,
        "sequence_variant_id": variant_id,
        "event_type": event_type,
        "touch_number": touch_number,
        "correlation_id": correlation_id,
        "metadata": metadata or {},
    }
