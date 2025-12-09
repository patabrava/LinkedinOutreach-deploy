# Comprehensive Logging System

This document describes the logging architecture implemented across all services in the LinkedIn Outreach application.

## Overview

The application now features a **world-class structured logging system** that provides:

- ✅ **JSON-formatted logs** for easy parsing and analysis
- ✅ **Correlation IDs** to track requests across services
- ✅ **Timestamp tracking** in ISO 8601 format (UTC)
- ✅ **Context-aware logging** with service names, lead IDs, and operation details
- ✅ **Multiple output targets** (console and file)
- ✅ **Log level filtering** (DEBUG, INFO, WARN, ERROR)
- ✅ **Input/Output tracking** for all operations
- ✅ **Error stack traces** with full context
- ✅ **Performance metrics** (tokens used, operation duration)

## Architecture

### Log Storage

All logs are written to `.logs/` directory at the repository root:

```
.logs/
├── web-app.log       # Next.js application logs
├── scraper.log       # LinkedIn scraper worker logs
├── sender.log        # Message sender worker logs
└── mcp-agent.log     # Draft generation agent logs
```

### Log Format

All logs follow a consistent JSON structure:

```json
{
  "timestamp": "2025-01-26T13:50:52.123Z",
  "level": "INFO",
  "service": "scraper",
  "message": "Lead enriched successfully",
  "context": {
    "leadId": "abc123",
    "correlationId": "req_1706281852123_x4d8k",
    "operation": "enrichment"
  },
  "data": {
    "url": "https://linkedin.com/in/example",
    "hasName": true,
    "hasHeadline": true
  }
}
```

## Services

### 1. Web Application (Next.js)

**Logger:** `apps/web/lib/logger.ts`

**Capabilities:**
- API request/response logging
- Server action tracking
- Database query logging
- Worker process spawn tracking
- Correlation ID generation and propagation

**Example Usage:**
```typescript
import { logger } from "../lib/logger";

// API endpoint
const correlationId = logger.apiRequest("POST", "/api/enrich", {}, body);
logger.apiResponse("POST", "/api/enrich", 200, { correlationId });

// Server action
const correlationId = logger.actionStart("approveDraft", { leadId }, input);
logger.actionComplete("approveDraft", { correlationId, leadId }, result);

// Database operation
logger.dbQuery("update", "leads", { correlationId, leadId }, query);
logger.dbResult("update", "leads", { correlationId, leadId }, rowCount);
```

### 2. Python Workers (Scraper & Sender)

**Logger:** `workers/shared_logger.py`

**Capabilities:**
- Operation lifecycle tracking (start/complete/error)
- Database query logging
- Scraping progress tracking
- Message sending tracking
- AI API request/response logging
- **Headless Scraping Visibility** (NEW):
  - Page navigation tracking
  - Element search/click/type logging
  - Selector fallback tracking
  - Dialog detection
  - Connection flow path logging

**Example Usage:**
```python
from shared_logger import get_logger

logger = get_logger("scraper")

# Operation tracking
logger.operation_start("enrichment", input_data={"limit": 10})
logger.operation_complete("enrichment", result={"processed": 5})

# Scraping
logger.scrape_start(lead_id, url)
logger.scrape_complete(lead_id, profile_data=profile)

# Database
logger.db_query("select", "leads", {"status": "NEW"}, {"limit": 10})
logger.db_result("select", "leads", {"status": "NEW"}, count=5)

# Messaging
logger.message_send_start(lead_id, message_preview=message[:100])
logger.message_send_complete(lead_id)

# NEW: Headless scraping visibility
logger.page_navigation("https://linkedin.com/in/john-doe", from_url="https://linkedin.com/feed")
logger.element_search("main h1.text-heading-xlarge", found_count=1, extracted="John Doe")
logger.element_click("Connect button", success=True)
logger.element_type("note textbox", char_count=150, text_preview="Hi John...")
logger.path_attempt("Message button (connected user)", path_number=1, success=True)
logger.dialog_detected("connection_invite", buttons_found=["Send", "Add note"])
logger.connection_flow("send_button", "CLICKED", data={"url": "..."})
```

### Headless Scraping Visibility (SCRAPE_VERBOSE)

For detailed debugging during headless deployment, enable verbose scraping logs:

```bash
SCRAPE_VERBOSE=true python scraper.py --run --limit 1
```

This will output every element search, click, and type action to the console, replacing the need to watch the browser live.

**Example verbose output:**
```
[2025-01-26T14:30:00.123Z] INFO: Navigation ✓: https://linkedin.com/in/john-doe...
[2025-01-26T14:30:01.456Z] DEBUG: Element search ✓: main h1.text-heading-xlarge... [1 found]
[2025-01-26T14:30:01.789Z] DEBUG: Scroll down: 6 steps
[2025-01-26T14:30:02.123Z] DEBUG: Element search ✓: section#about button:has-text('more')... [1 found]
[2025-01-26T14:30:02.456Z] DEBUG: Element click ✓: section#about button:has-text('more')...
[2025-01-26T14:30:03.789Z] INFO: Profile scrape complete [hasName=true, hasHeadline=true, experienceCount=3]
```


### 3. MCP Agent

**Logger:** Uses `shared_logger.py`

**Capabilities:**
- Draft generation tracking
- AI model request/response logging
- Token usage tracking
- Classification and case study selection

**Example Usage:**
```python
logger.operation_start("draft-generation")
logger.ai_request(model, {"leadId": lead_id}, prompt_preview)
logger.ai_response(model, {"leadId": lead_id}, tokens=1234)
logger.operation_complete("draft-generation", result={"processed": 10})
```

## Viewing Logs

### Using the Log Viewer

A comprehensive log viewer script is provided: `view_logs.sh`

**Basic Usage:**
```bash
# View logs for a specific service
./view_logs.sh --service scraper

# Follow logs in real-time
./view_logs.sh --service web-app --follow

# View all logs merged and sorted
./view_logs.sh --all --lines 100

# Filter by log level
./view_logs.sh --service sender --level error

# Filter by correlation ID
./view_logs.sh --correlationId req_1706281852123_x4d8k

# Show statistics
./view_logs.sh --stats

# Clear all logs
./view_logs.sh --clear
```

### Using jq Directly

Since logs are in JSON format, you can use `jq` for advanced queries:

```bash
# Find all errors
cat .logs/scraper.log | jq 'select(.level == "ERROR")'

# Count by log level
cat .logs/web-app.log | jq -r '.level' | sort | uniq -c

# Find logs for specific lead
cat .logs/*.log | jq 'select(.context.leadId == "abc123")'

# Extract error messages
cat .logs/*.log | jq 'select(.level == "ERROR") | .message'

# Track a correlation ID across services
cat .logs/*.log | jq 'select(.context.correlationId == "req_123")' | jq -s 'sort_by(.timestamp)'
```

### Using grep

For quick searches:

```bash
# Find all errors
grep '"level":"ERROR"' .logs/scraper.log

# Search by lead ID
grep 'leadId.*abc123' .logs/*.log

# Find specific operations
grep 'Operation Start: enrichment' .logs/scraper.log
```

## Correlation IDs

Correlation IDs allow you to track a single request through multiple services:

1. **Generated in Next.js API/Action** → `req_<timestamp>_<random>`
2. **Passed to worker via environment** → `CORRELATION_ID`
3. **Included in all subsequent logs** → `context.correlationId`

Example flow:
```
User clicks "Enrich" button
↓
POST /api/enrich [correlationId: req_1706281852123_x4d8k]
↓
Spawns scraper process [CORRELATION_ID=req_1706281852123_x4d8k]
↓
Scraper logs all operations with same correlationId
```

Track it:
```bash
./view_logs.sh --correlationId req_1706281852123_x4d8k --all
```

## Log Levels

### DEBUG
- Database queries and results
- Detailed operation steps
- Data structure information
- Internal state changes

### INFO
- Operation start/complete
- Successful API calls
- Worker spawns
- Message sends
- Key milestones

### WARN
- Non-fatal errors
- Fallback behaviors
- Daily limits reached
- Connection request failures

### ERROR
- Failed operations
- Database errors
- Authentication failures
- Invalid data
- Unexpected exceptions

## Configuration

### Environment Variables

Control logging behavior with these variables:

```bash
# Disable console logging (file only)
LOG_TO_CONSOLE=false

# Disable file logging (console only)
LOG_TO_FILE=false

# Both enabled by default
```

Add to your `.env` files:
```env
# .env.local (web app)
LOG_TO_CONSOLE=true
LOG_TO_FILE=true

# workers/.env (Python workers)
LOG_TO_CONSOLE=true
LOG_TO_FILE=true
```

## Best Practices

### 1. Use Appropriate Log Levels

```typescript
// ❌ Wrong
logger.error("User clicked button", { userId });

// ✅ Right
logger.info("User clicked button", { userId });
```

### 2. Include Relevant Context

```typescript
// ❌ Wrong
logger.info("Lead updated");

// ✅ Right
logger.info("Lead updated", { leadId, status: "ENRICHED" });
```

### 3. Log Input and Output

```typescript
// ✅ Good
const correlationId = logger.actionStart("fetchLeads", {}, { page, filters });
const result = await fetchLeadsFromDB(page, filters);
logger.actionComplete("fetchLeads", { correlationId }, { count: result.length });
```

### 4. Use Correlation IDs

```typescript
// Pass correlation ID through operations
const correlationId = logger.apiRequest("POST", "/api/action");
await someAsyncOperation(correlationId);
logger.apiResponse("POST", "/api/action", 200, { correlationId });
```

### 5. Sanitize Sensitive Data

```python
# ❌ Wrong - logs password
logger.info("Credentials", data={"email": email, "password": password})

# ✅ Right - only logs presence
logger.info("Credentials", data={"hasEmail": bool(email), "hasPassword": bool(password)})
```

## Monitoring and Alerting

### Quick Stats

```bash
# Show statistics for all services
./view_logs.sh --stats
```

### Find Recent Errors

```bash
# Last 10 errors across all services
cat .logs/*.log | jq 'select(.level == "ERROR")' | tail -10 | jq -r '"\(.timestamp) [\(.service)] \(.message)"'
```

### Monitor Error Rate

```bash
# Count errors in last hour
date -u -v-1H +%Y-%m-%dT%H:%M:%S > /tmp/hour_ago
cat .logs/*.log | jq -r 'select(.level == "ERROR") | select(.timestamp > "'$(cat /tmp/hour_ago)'") | .timestamp' | wc -l
```

### Track Operation Performance

```bash
# Find slow operations (with custom timing if added)
cat .logs/*.log | jq 'select(.data.duration > 5000)' # > 5 seconds
```

## Troubleshooting

### No Logs Appearing

1. Check `.logs/` directory exists
2. Verify `LOG_TO_FILE` is not set to `false`
3. Check file permissions on `.logs/` directory
4. Ensure services are actually running

### Logs Too Verbose

Set `LOG_TO_CONSOLE=false` in production or filter by level:

```bash
./view_logs.sh --service scraper --level error
```

### Can't Find Specific Request

Use correlation ID:

```bash
# Search all logs for the correlation ID
grep -r "correlationId.*req_123" .logs/
```

### Disk Space Issues

Clear old logs periodically:

```bash
# Clear all logs
./view_logs.sh --clear

# Or manually delete old logs
find .logs -name "*.log" -mtime +7 -delete  # Delete logs older than 7 days
```

## Examples

### Example 1: Track a Full Enrichment Flow

```bash
# Start enrichment
curl -X POST http://localhost:3000/api/enrich -d '{"limit": 1}'

# Find the correlation ID in web-app logs
./view_logs.sh --service web-app --lines 5

# Track it through scraper
./view_logs.sh --correlationId <ID> --all
```

### Example 2: Debug Failed Message Send

```bash
# Find the error
./view_logs.sh --service sender --level error

# Get full context for that lead
cat .logs/sender.log | jq 'select(.context.leadId == "abc123")'

# Check if draft exists
cat .logs/web-app.log | jq 'select(.context.leadId == "abc123") | select(.message | contains("draft"))'
```

### Example 3: Monitor Draft Generation

```bash
# Follow MCP agent in real-time
./view_logs.sh --service mcp-agent --follow

# Count successful drafts
cat .logs/mcp-agent.log | grep -c '"message":"Draft saved for lead"'

# Check AI token usage
cat .logs/mcp-agent.log | jq 'select(.context.tokens) | .context.tokens' | awk '{s+=$1} END {print s}'
```

## Performance Impact

The logging system is designed to be lightweight:

- **File I/O:** Append-only writes (fast)
- **JSON serialization:** Only when logging (not on hot path)
- **Console output:** Can be disabled in production
- **Memory:** No buffering, direct writes

Typical overhead: **< 1ms per log entry**

## Future Enhancements

Consider implementing:

1. **Log rotation** - Automatically archive old logs
2. **Log shipping** - Send to external service (Datadog, Splunk, etc.)
3. **Structured search** - Build index for faster queries
4. **Alerting** - Trigger notifications on error patterns
5. **Dashboards** - Visualize metrics in real-time
6. **Sampling** - Reduce volume in high-traffic scenarios

## Summary

You now have **comprehensive, production-grade logging** across your entire application:

✅ **Every API call logged** with input/output  
✅ **Every database query logged** with results  
✅ **Every worker operation logged** with context  
✅ **Every error logged** with full stack traces  
✅ **Correlation IDs** for request tracking  
✅ **Easy viewing and filtering** with provided tools  

Your logs will now tell you **exactly what happened**, **when it happened**, and **why it happened**.
