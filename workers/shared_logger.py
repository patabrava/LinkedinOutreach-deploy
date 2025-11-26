"""
Structured logging utility for Python workers
Provides JSON-formatted logs with correlation IDs, timestamps, and context
"""

import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional


class StructuredLogger:
    """JSON-structured logger for Python services"""

    def __init__(self, service_name: str, log_dir: Optional[Path] = None):
        self.service_name = service_name
        
        # Determine log directory (default to repo root .logs)
        if log_dir is None:
            repo_root = Path(__file__).parent.parent
            log_dir = repo_root / ".logs"
        
        self.log_dir = log_dir
        self.log_file = self.log_dir / f"{service_name}.log"
        
        # Create log directory if it doesn't exist
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        # Get correlation ID from environment if available
        self.correlation_id = os.getenv("CORRELATION_ID")
        
        # Console and file logging flags
        self.log_to_console = os.getenv("LOG_TO_CONSOLE", "true").lower() != "false"
        self.log_to_file = os.getenv("LOG_TO_FILE", "true").lower() != "false"
    
    def _format_entry(self, level: str, message: str, context: Dict[str, Any], data: Any = None, error: Optional[Exception] = None) -> Dict[str, Any]:
        """Format a log entry as a structured dictionary"""
        entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": level.upper(),
            "service": self.service_name,
            "message": message,
            "context": context or {},
        }
        
        # Add correlation ID if available
        if self.correlation_id:
            entry["context"]["correlationId"] = self.correlation_id
        
        # Add data payload if provided
        if data is not None:
            entry["data"] = data
        
        # Add error details if provided
        if error:
            entry["error"] = {
                "type": type(error).__name__,
                "message": str(error),
                "traceback": self._get_traceback(error),
            }
        
        return entry
    
    def _get_traceback(self, error: Exception) -> Optional[str]:
        """Extract traceback from exception"""
        import traceback
        return "".join(traceback.format_exception(type(error), error, error.__traceback__))
    
    def _write_to_file(self, entry: Dict[str, Any]) -> None:
        """Write log entry to file"""
        if not self.log_to_file:
            return
        
        try:
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            print(f"Failed to write log to file: {e}", file=sys.stderr)
    
    def _write_to_console(self, entry: Dict[str, Any]) -> None:
        """Write log entry to console"""
        if not self.log_to_console:
            return
        
        level = entry["level"]
        timestamp = entry["timestamp"]
        message = entry["message"]
        
        # Format context as key=value pairs
        context_items = entry.get("context", {})
        context_str = " ".join([f"{k}={v}" for k, v in context_items.items()])
        context_part = f" [{context_str}]" if context_str else ""
        
        # Build log line
        log_line = f"[{timestamp}] {level}: {message}{context_part}"
        
        # Print to appropriate stream
        if level == "ERROR":
            print(log_line, file=sys.stderr)
            if "error" in entry:
                print(f"  Error: {entry['error'].get('message', '')}", file=sys.stderr)
                if "traceback" in entry["error"]:
                    print(f"  Traceback:\n{entry['error']['traceback']}", file=sys.stderr)
        else:
            print(log_line)
        
        # Print data if present and not too large
        if "data" in entry:
            data_str = json.dumps(entry["data"], indent=2, default=str)
            if len(data_str) < 500:
                print(f"  Data: {data_str}")
    
    def _log(self, level: str, message: str, context: Optional[Dict[str, Any]] = None, data: Any = None, error: Optional[Exception] = None) -> None:
        """Internal log method"""
        entry = self._format_entry(level, message, context or {}, data, error)
        self._write_to_file(entry)
        self._write_to_console(entry)
    
    def debug(self, message: str, context: Optional[Dict[str, Any]] = None, data: Any = None) -> None:
        """Log debug message"""
        self._log("DEBUG", message, context, data)
    
    def info(self, message: str, context: Optional[Dict[str, Any]] = None, data: Any = None) -> None:
        """Log info message"""
        self._log("INFO", message, context, data)
    
    def warn(self, message: str, context: Optional[Dict[str, Any]] = None, data: Any = None, error: Optional[Exception] = None) -> None:
        """Log warning message"""
        self._log("WARN", message, context, data, error)
    
    def error(self, message: str, context: Optional[Dict[str, Any]] = None, error: Optional[Exception] = None, data: Any = None) -> None:
        """Log error message"""
        self._log("ERROR", message, context, data, error)
    
    # Specialized logging methods
    
    def operation_start(self, operation: str, context: Optional[Dict[str, Any]] = None, input_data: Any = None) -> None:
        """Log the start of an operation"""
        ctx = context or {}
        ctx["operation"] = operation
        self.info(f"Operation Start: {operation}", ctx, input_data)
    
    def operation_complete(self, operation: str, context: Optional[Dict[str, Any]] = None, result: Any = None) -> None:
        """Log the completion of an operation"""
        ctx = context or {}
        ctx["operation"] = operation
        self.info(f"Operation Complete: {operation}", ctx, result)
    
    def operation_error(self, operation: str, context: Optional[Dict[str, Any]] = None, error: Optional[Exception] = None, input_data: Any = None) -> None:
        """Log an operation error"""
        ctx = context or {}
        ctx["operation"] = operation
        self.error(f"Operation Error: {operation}", ctx, error, input_data)
    
    def db_query(self, operation: str, table: str, context: Optional[Dict[str, Any]] = None, query: Any = None) -> None:
        """Log database query"""
        ctx = context or {}
        ctx.update({"operation": operation, "table": table})
        self.debug(f"DB Query: {operation} on {table}", ctx, query)
    
    def db_result(self, operation: str, table: str, context: Optional[Dict[str, Any]] = None, count: Optional[int] = None) -> None:
        """Log database result"""
        ctx = context or {}
        ctx.update({"operation": operation, "table": table})
        if count is not None:
            ctx["rowCount"] = count
        self.debug(f"DB Result: {operation} on {table}", ctx)
    
    def scrape_start(self, lead_id: str, url: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log scraping start"""
        ctx = context or {}
        ctx.update({"leadId": lead_id, "url": url})
        self.info(f"Scraping started for lead {lead_id}", ctx, {"url": url})
    
    def scrape_complete(self, lead_id: str, context: Optional[Dict[str, Any]] = None, profile_data: Any = None) -> None:
        """Log scraping completion"""
        ctx = context or {}
        ctx["leadId"] = lead_id
        
        # Log summary instead of full profile data
        summary = {}
        if isinstance(profile_data, dict):
            summary = {
                "hasName": bool(profile_data.get("name")),
                "hasHeadline": bool(profile_data.get("headline")),
                "hasAbout": bool(profile_data.get("about")),
                "experienceCount": len(profile_data.get("experience", [])),
            }
        
        self.info(f"Scraping completed for lead {lead_id}", ctx, summary)
    
    def scrape_error(self, lead_id: str, context: Optional[Dict[str, Any]] = None, error: Optional[Exception] = None) -> None:
        """Log scraping error"""
        ctx = context or {}
        ctx["leadId"] = lead_id
        self.error(f"Scraping failed for lead {lead_id}", ctx, error)
    
    def message_send_start(self, lead_id: str, context: Optional[Dict[str, Any]] = None, message_preview: Optional[str] = None) -> None:
        """Log message sending start"""
        ctx = context or {}
        ctx["leadId"] = lead_id
        
        # Include first 100 chars of message as preview
        data = {}
        if message_preview:
            data["messagePreview"] = message_preview[:100]
        
        self.info(f"Sending message for lead {lead_id}", ctx, data if data else None)
    
    def message_send_complete(self, lead_id: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log message sending completion"""
        ctx = context or {}
        ctx["leadId"] = lead_id
        self.info(f"Message sent successfully for lead {lead_id}", ctx)
    
    def message_send_error(self, lead_id: str, context: Optional[Dict[str, Any]] = None, error: Optional[Exception] = None) -> None:
        """Log message sending error"""
        ctx = context or {}
        ctx["leadId"] = lead_id
        self.error(f"Failed to send message for lead {lead_id}", ctx, error)
    
    def ai_request(self, model: str, context: Optional[Dict[str, Any]] = None, prompt_preview: Optional[str] = None) -> None:
        """Log AI API request"""
        ctx = context or {}
        ctx["model"] = model
        
        data = {}
        if prompt_preview:
            data["promptPreview"] = prompt_preview[:200]
        
        self.info(f"AI request to {model}", ctx, data if data else None)
    
    def ai_response(self, model: str, context: Optional[Dict[str, Any]] = None, tokens: Optional[int] = None) -> None:
        """Log AI API response"""
        ctx = context or {}
        ctx["model"] = model
        if tokens:
            ctx["tokens"] = tokens
        self.info(f"AI response from {model}", ctx)


def get_logger(service_name: str) -> StructuredLogger:
    """Factory function to create a logger instance"""
    return StructuredLogger(service_name)
