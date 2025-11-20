#!/bin/bash
# Run the LinkedIn scraper

cd "$(dirname "$0")/workers/scraper"
source venv/bin/activate
python scraper.py
