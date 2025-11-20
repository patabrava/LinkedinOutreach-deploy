#!/bin/bash
# Setup script for Python 3.11 and virtual environments

set -e  # Exit on error

echo "🐍 Setting up Python 3.11 for LinkedIn Outreach..."
echo ""

# Install Python 3.11 via Homebrew
echo "📦 Installing Python 3.11 via Homebrew..."
brew install python@3.11

# Get the Python 3.11 path
PYTHON311=$(brew --prefix python@3.11)/bin/python3.11

echo "✅ Python 3.11 installed at: $PYTHON311"
$PYTHON311 --version
echo ""

# Create virtual environment for scraper
echo "🔧 Creating virtual environment for scraper..."
cd workers/scraper
$PYTHON311 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -e .
deactivate
echo "✅ Scraper venv created"
echo ""

# Create virtual environment for sender
echo "🔧 Creating virtual environment for sender..."
cd ../sender
$PYTHON311 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -e .
deactivate
echo "✅ Sender venv created"
echo ""

# Create virtual environment for MCP server
echo "🔧 Creating virtual environment for MCP server..."
cd ../../mcp-server
$PYTHON311 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -e .
deactivate
echo "✅ MCP server venv created"
echo ""

# Install Playwright browsers (only need to do once)
echo "🎭 Installing Playwright Chromium browser..."
cd ../workers/scraper
source venv/bin/activate
python -m playwright install chromium
deactivate
echo "✅ Playwright installed"
echo ""

echo "🎉 Setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Configure your .env files with API keys"
echo "2. Create LinkedIn auth: cd workers/scraper && source venv/bin/activate && playwright codegen --save-storage=auth.json https://www.linkedin.com/login"
echo ""
echo "🚀 To run each component:"
echo "   Scraper:  cd workers/scraper && source venv/bin/activate && python scraper.py"
echo "   Agent:    cd mcp-server && source venv/bin/activate && python run_agent.py"
echo "   Sender:   cd workers/sender && source venv/bin/activate && python sender.py"
echo "   Web:      npm run dev:web"
