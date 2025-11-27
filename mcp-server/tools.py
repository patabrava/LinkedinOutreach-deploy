"""Supabase helpers used by the MCP server and agent."""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()


def supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(url, key)


def get_enriched_leads(client: Client, limit: int = 20) -> List[Dict[str, Any]]:
    resp = (
        client.table("leads")
        .select("*")
        .eq("status", "ENRICHED")
        .limit(limit)
        .execute()
    )
    return resp.data or []


def classify_lead(client: Client, lead_id: str, industry: str, company_type: str) -> Dict[str, Any]:
    existing = (
        client.table("leads")
        .select("ai_tags")
        .eq("id", lead_id)
        .single()
        .execute()
        .data
        or {}
    )
    ai_tags = existing.get("ai_tags") or {}
    ai_tags.update({"industry": industry, "company_type": company_type})
    client.table("leads").update({"ai_tags": ai_tags}).eq("id", lead_id).execute()
    return ai_tags


def select_case_study(client: Client, lead_id: str, case_study_name: str) -> Dict[str, Any]:
    existing = (
        client.table("leads")
        .select("ai_tags")
        .eq("id", lead_id)
        .single()
        .execute()
        .data
        or {}
    )
    ai_tags = existing.get("ai_tags") or {}
    ai_tags.update({"case_study": case_study_name})
    client.table("leads").update({"ai_tags": ai_tags}).eq("id", lead_id).execute()
    return ai_tags


def get_rotation_state(client: Client) -> Optional[int]:
    """Get the last used category index from settings."""
    resp = client.table("settings").select("value").eq("key", "example_rotation").execute()
    if resp.data and len(resp.data) > 0:
        return resp.data[0].get("value", {}).get("last_category_index")
    return None


def update_rotation_state(client: Client, category_index: int) -> None:
    """Update the last used category index in settings."""
    from datetime import datetime, timezone
    value = {
        "last_category_index": category_index,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
    client.table("settings").upsert(
        {"key": "example_rotation", "value": value}
    ).execute()


def save_draft(
    client: Client,
    lead_id: str,
    opener: str,
    body: str,
    cta: str,
    full_message: str,
    body_type: str = "",
    cta_type: str = "",
) -> Dict[str, Any]:
    # Delete any existing drafts for this lead to ensure only one draft exists
    client.table("drafts").delete().eq("lead_id", lead_id).execute()
    
    draft = {
        "lead_id": lead_id,
        "opener": opener,
        "body_text": body,
        "cta_text": cta,
        "final_message": full_message,
        "body_type": body_type,
        "cta_type": cta_type,
    }
    client.table("drafts").insert(draft).execute()
    client.table("leads").update({"status": "DRAFT_READY"}).eq("id", lead_id).execute()
    return draft

