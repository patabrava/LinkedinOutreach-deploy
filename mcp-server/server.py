"""FastMCP server exposing outreach tools."""

from __future__ import annotations

import sys
from typing import Any, Dict, List

from dotenv import load_dotenv

from tools import (
    classify_lead,
    get_enriched_leads,
    save_draft,
    select_case_study,
    supabase_client,
)

load_dotenv()

client = supabase_client()


def build_server():
    try:
        from fastmcp import FastMCP
    except ImportError:
        print("fastmcp is not installed. Install it to run the MCP server.", file=sys.stderr)
        return None

    server = FastMCP("linkedin-mcp")

    @server.tool()
    async def get_enriched_leads_tool() -> List[Dict[str, Any]]:
        return get_enriched_leads(client)

    @server.tool()
    async def classify_lead_tool(lead_id: str, industry: str, company_type: str) -> Dict[str, Any]:
        return classify_lead(client, lead_id, industry, company_type)

    @server.tool()
    async def select_case_study_tool(lead_id: str, case_study_name: str) -> Dict[str, Any]:
        return select_case_study(client, lead_id, case_study_name)

    @server.tool()
    async def save_draft_tool(
        lead_id: str,
        opener: str,
        body: str,
        cta: str,
        full_message: str,
        body_type: str = "",
        cta_type: str = "",
    ) -> Dict[str, Any]:
        return save_draft(client, lead_id, opener, body, cta, full_message, body_type, cta_type)

    return server


if __name__ == "__main__":
    server = build_server()
    if server:
        server.run()

