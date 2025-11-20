#!/bin/bash
# Run the MCP agent

cd "$(dirname "$0")/mcp-server"
source venv/bin/activate
python run_agent.py
