"""Send-time campaign controls. Database failures always hold outbound work."""

from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit


class CampaignControlHeld(RuntimeError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(f"outbound_held:{reason}")


def parse_control_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    # Persisted timestamps are timestamptz; ambiguous naive values fail closed.
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def followup_hold_reason(row: Dict[str, Any], account_id: str, now: datetime,
                         *, allow_processing: bool = False) -> Optional[str]:
    if not account_id or row.get("linkedin_account_id") != account_id:
        return "followup_account_mismatch"
    allowed = {"APPROVED", "PROCESSING"} if allow_processing else {"APPROVED"}
    if str(row.get("status") or "").upper() not in allowed:
        return "followup_status"
    if row.get("requires_human"):
        return "requires_human"
    value = row.get("next_send_at")
    due = parse_control_time(value)
    if value is not None and not due:
        return "invalid_followup_due_time"
    if due and due > now:
        return "followup_not_due"
    return None


def outbound_hold_reason(lead: Dict[str, Any], account_id: str, *,
                         sequence: Optional[Dict[str, Any]] = None,
                         variant: Optional[Dict[str, Any]] = None,
                         followup: Optional[Dict[str, Any]] = None,
                         suppressed: bool = False, now: Optional[datetime] = None,
                         allow_processing: bool = False) -> Optional[str]:
    """Pure policy: None permits processing; a stable reason holds it unchanged."""
    now = now or datetime.now(timezone.utc)
    if not account_id or lead.get("linkedin_account_id") != account_id:
        return "account_mismatch"
    if lead.get("campaign_paused"):
        return "campaign_paused"
    pause = parse_control_time(lead.get("paused_until"))
    if lead.get("paused_until") is not None and not pause:
        return "invalid_paused_until"
    if pause and pause > now:
        return "paused_until"
    if lead.get("stop_reason") == "operator_stopped":
        return "operator_stopped"
    if lead.get("human_handoff_required"):
        return "human_handoff_required"
    if lead.get("sequence_id") and (not sequence or sequence.get("is_active") is not True):
        return "sequence_inactive"
    if sequence and sequence.get("is_managed_campaign") and not lead.get("sequence_variant_id"):
        return "variant_missing"
    if lead.get("sequence_variant_id"):
        if not variant or variant.get("is_active") is not True:
            return "variant_inactive"
        if str(variant.get("sequence_id")) != str(lead.get("sequence_id")):
            return "variant_sequence_mismatch"
    is_reply = bool(followup and str(followup.get("followup_type") or "").upper() == "REPLY")
    if followup is not None:
        reason = followup_hold_reason(followup, account_id, now, allow_processing=allow_processing)
        if reason:
            return reason
        if str(followup.get("lead_id")) != str(lead.get("id")):
            return "followup_lead_mismatch"
    clear_no_reply = bool(is_reply and followup.get("reply_route") == "clear_no")
    stop_reason = str(lead.get("stop_reason") or "")
    ordinary_reply = is_reply and stop_reason == "reply_received"
    closure_reply = clear_no_reply and stop_reason in {"clear_no", "suppressed", "reply_received"}
    if stop_reason and not ordinary_reply and not closure_reply:
        return stop_reason
    if followup is not None and str(followup.get("followup_type") or "").upper() == "NUDGE" and lead.get("last_reply_at"):
        return "reply_received"
    if suppressed and not clear_no_reply:
        return "outbound_suppressed"
    return None


def _rows(response: Any) -> list[Dict[str, Any]]:
    if getattr(response, "error", None) or not isinstance(response.data, list):
        raise RuntimeError("control query failed")
    if any(not isinstance(row, dict) for row in response.data):
        raise RuntimeError("invalid control response")
    return response.data


def _canonical_url(value: str) -> str:
    parts = urlsplit(value.strip().lower())
    host = "www.linkedin.com" if parts.hostname in {"linkedin.com", "www.linkedin.com"} else parts.netloc
    return urlunsplit(("https", host, parts.path.rstrip("/"), "", ""))


def read_outbound_controls(client: Any, lead_id: str, account_id: str, *,
                           followup_id: Optional[str] = None,
                           processing_started_at: Optional[str] = None,
                           now: Optional[datetime] = None) -> Tuple[Optional[str], Dict[str, Any], Optional[Dict[str, Any]]]:
    """Read current persisted resources; never fall back to a cached queue snapshot."""
    now = now or datetime.now(timezone.utc)
    lead, followup = {}, None
    try:
        rows = _rows(client.table("leads").select("*").eq("id", lead_id).limit(1).execute())
        if not rows:
            return "lead_missing", lead, followup
        lead = rows[0]
        sequence, variant = None, None
        if lead.get("sequence_id"):
            rows = _rows(client.table("outreach_sequences").select("id,is_active,is_managed_campaign")
                         .eq("id", lead["sequence_id"]).limit(1).execute())
            sequence = rows[0] if rows else None
        if lead.get("sequence_variant_id"):
            rows = _rows(client.table("outreach_sequence_variants").select("id,sequence_id,is_active")
                         .eq("id", lead["sequence_variant_id"]).limit(1).execute())
            variant = rows[0] if rows else None
        if followup_id:
            rows = _rows(client.table("followups").select("*").eq("id", followup_id).limit(1).execute())
            if not rows:
                return "followup_missing", lead, None
            followup = rows[0]
            if followup.get("status") != "PROCESSING":
                return "followup_status", lead, followup
            if not processing_started_at or followup.get("processing_started_at") != processing_started_at:
                return "followup_claim_mismatch", lead, followup
        url = str(lead.get("linkedin_url") or "")
        if not url:
            return "lead_url_missing", lead, followup
        rows = _rows(client.table("outbound_suppressions").select("expires_at")
                     .eq("linkedin_url", _canonical_url(url)).limit(1).execute())
        suppressed = any(row.get("expires_at") is None or not parse_control_time(row.get("expires_at"))
                         or parse_control_time(row["expires_at"]) > now for row in rows)
        reason = outbound_hold_reason(lead, account_id, sequence=sequence, variant=variant,
                                      followup=followup, suppressed=suppressed, now=now,
                                      allow_processing=bool(processing_started_at))
        return reason, lead, followup
    except Exception:
        return "controls_unavailable", lead, followup


def claim_followup(client: Any, row: Dict[str, Any], account_id: str, *,
                   now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Claim only the still-approved, still-due schedule; require returned ownership."""
    now = now or datetime.now(timezone.utc)
    if followup_hold_reason(row, account_id, now):
        return None
    started = now.isoformat()
    try:
        query = (client.table("followups").update({"status": "PROCESSING", "processing_started_at": started})
                 .eq("id", row["id"]).eq("linkedin_account_id", account_id).eq("status", "APPROVED")
                 .eq("requires_human", False)
                 .or_(f"next_send_at.is.null,next_send_at.lte.{started}"))
        due = row.get("next_send_at")
        query = query.is_("next_send_at", "null") if due is None else query.eq("next_send_at", due)
        claimed = _rows(query.execute())
        if len(claimed) != 1 or claimed[0].get("processing_started_at") != started:
            return None
        return {**row, **claimed[0]}
    except Exception:
        return None
