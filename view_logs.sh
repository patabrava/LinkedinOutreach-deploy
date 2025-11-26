#!/bin/bash

# Log Viewer Utility
# View logs from all services in real-time or historically

LOGS_DIR=".logs"

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -s, --service SERVICE    View logs for specific service (web-app, scraper, sender, mcp-agent)"
    echo "  -f, --follow             Follow log output in real-time (like tail -f)"
    echo "  -l, --level LEVEL        Filter by log level (debug, info, warn, error)"
    echo "  -n, --lines NUM          Show last N lines (default: 50)"
    echo "  -c, --correlationId ID   Filter by correlation ID"
    echo "  --all                    View all logs merged"
    echo "  --clear                  Clear all logs"
    echo "  --stats                  Show log statistics"
    echo "  -h, --help               Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --service scraper --follow"
    echo "  $0 --level error --lines 100"
    echo "  $0 --all --follow"
    echo "  $0 --correlationId req_123456789"
}

# Function to colorize JSON logs
colorize_log() {
    jq -C '.' 2>/dev/null || cat
}

# Function to format logs for readability
format_log() {
    jq -r '"\(.timestamp) [\(.level)] [\(.service // .context.service // "unknown")] \(.message) | \(.context | to_entries | map("\(.key)=\(.value)") | join(" "))"' 2>/dev/null || cat
}

# Function to filter logs by level
filter_level() {
    local level=$1
    if [ -n "$level" ]; then
        jq -c "select(.level == \"${level^^}\")" 2>/dev/null
    else
        cat
    fi
}

# Function to filter by correlation ID
filter_correlation() {
    local cid=$1
    if [ -n "$cid" ]; then
        jq -c "select(.correlationId == \"$cid\" or .context.correlationId == \"$cid\")" 2>/dev/null
    else
        cat
    fi
}

# Function to show statistics
show_stats() {
    echo -e "${CYAN}=== Log Statistics ===${NC}"
    echo ""
    
    for log_file in "$LOGS_DIR"/*.log; do
        if [ -f "$log_file" ]; then
            service=$(basename "$log_file" .log)
            total=$(wc -l < "$log_file" | tr -d ' ')
            errors=$(grep -c '"level":"ERROR"' "$log_file" 2>/dev/null || echo 0)
            warns=$(grep -c '"level":"WARN"' "$log_file" 2>/dev/null || echo 0)
            infos=$(grep -c '"level":"INFO"' "$log_file" 2>/dev/null || echo 0)
            
            echo -e "${GREEN}$service${NC}"
            echo "  Total entries: $total"
            echo "  Errors: ${RED}$errors${NC}"
            echo "  Warnings: ${YELLOW}$warns${NC}"
            echo "  Info: ${BLUE}$infos${NC}"
            echo ""
        fi
    done
}

# Function to clear logs
clear_logs() {
    echo -e "${YELLOW}Clearing all logs...${NC}"
    rm -f "$LOGS_DIR"/*.log
    echo -e "${GREEN}All logs cleared.${NC}"
}

# Parse arguments
SERVICE=""
FOLLOW=false
LEVEL=""
LINES=50
CORRELATION_ID=""
VIEW_ALL=false
SHOW_STATS=false
CLEAR=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -s|--service)
            SERVICE="$2"
            shift 2
            ;;
        -f|--follow)
            FOLLOW=true
            shift
            ;;
        -l|--level)
            LEVEL="$2"
            shift 2
            ;;
        -n|--lines)
            LINES="$2"
            shift 2
            ;;
        -c|--correlationId)
            CORRELATION_ID="$2"
            shift 2
            ;;
        --all)
            VIEW_ALL=true
            shift
            ;;
        --stats)
            SHOW_STATS=true
            shift
            ;;
        --clear)
            CLEAR=true
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Execute actions
if [ "$CLEAR" = true ]; then
    clear_logs
    exit 0
fi

if [ "$SHOW_STATS" = true ]; then
    show_stats
    exit 0
fi

# Check if logs directory exists
if [ ! -d "$LOGS_DIR" ]; then
    echo -e "${RED}Logs directory not found: $LOGS_DIR${NC}"
    exit 1
fi

# View logs
if [ "$VIEW_ALL" = true ]; then
    # Merge all logs and sort by timestamp
    if [ "$FOLLOW" = true ]; then
        tail -f "$LOGS_DIR"/*.log 2>/dev/null | \
            filter_level "$LEVEL" | \
            filter_correlation "$CORRELATION_ID" | \
            format_log
    else
        cat "$LOGS_DIR"/*.log 2>/dev/null | \
            jq -s 'sort_by(.timestamp) | .[]' 2>/dev/null | \
            filter_level "$LEVEL" | \
            filter_correlation "$CORRELATION_ID" | \
            tail -n "$LINES" | \
            format_log
    fi
elif [ -n "$SERVICE" ]; then
    LOG_FILE="$LOGS_DIR/${SERVICE}.log"
    
    if [ ! -f "$LOG_FILE" ]; then
        echo -e "${RED}Log file not found: $LOG_FILE${NC}"
        echo "Available services:"
        ls -1 "$LOGS_DIR"/*.log 2>/dev/null | xargs -n1 basename | sed 's/.log$//' | sed 's/^/  - /'
        exit 1
    fi
    
    if [ "$FOLLOW" = true ]; then
        tail -f "$LOG_FILE" | \
            filter_level "$LEVEL" | \
            filter_correlation "$CORRELATION_ID" | \
            format_log
    else
        cat "$LOG_FILE" | \
            filter_level "$LEVEL" | \
            filter_correlation "$CORRELATION_ID" | \
            tail -n "$LINES" | \
            format_log
    fi
else
    echo -e "${YELLOW}Please specify --service or --all${NC}"
    echo ""
    show_usage
    exit 1
fi
