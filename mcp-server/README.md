# MCP Server

FastMCP server that exposes tools for the outreach agent.

## Setup
- `pip install -e .`
- Copy `../workers/.env.example` to `.env` and set Supabase + OpenAI keys.
- Run the server: `python server.py`
- Trigger the agent loop: `python run_agent.py`

## Tools exposed
- `get_enriched_leads()` → fetch leads with `status = 'ENRICHED'`
- `classify_lead(lead_id, industry, company_type)` → stores tags in `ai_tags`
- `select_case_study(lead_id, case_study_name)` → stores selected case study in `ai_tags`
- `save_draft(lead_id, opener, body, cta, full_message)` → writes to `drafts` and moves lead to `DRAFT_READY`

The baked system prompt lives in `prompt.txt`.
