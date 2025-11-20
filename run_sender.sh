#!/bin/bash
# Run the LinkedIn sender

cd "$(dirname "$0")/workers/sender"
source venv/bin/activate
python sender.py
