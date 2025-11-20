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

