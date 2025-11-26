/**
 * Structured logging utility for Next.js application
 * Provides JSON-formatted logs with correlation IDs, timestamps, and context
 */

import fs from "fs";
import path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  service?: string;
  action?: string;
  userId?: string;
  leadId?: string;
  draftId?: string;
  followupId?: string;
  correlationId?: string;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  data?: any;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

class Logger {
  private logDir: string;
  private logFile: string;
  private consoleEnabled: boolean;
  private fileEnabled: boolean;

  constructor() {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    this.logDir = path.join(repoRoot, ".logs");
    this.logFile = path.join(this.logDir, "web-app.log");
    this.consoleEnabled = process.env.LOG_TO_CONSOLE !== "false";
    this.fileEnabled = process.env.LOG_TO_FILE !== "false";
    
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (this.fileEnabled && !fs.existsSync(this.logDir)) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
      } catch (err) {
        console.error("Failed to create log directory:", err);
      }
    }
  }

  private formatEntry(entry: LogEntry): string {
    return JSON.stringify(entry) + "\n";
  }

  private writeToFile(entry: LogEntry): void {
    if (!this.fileEnabled) return;
    
    try {
      const formatted = this.formatEntry(entry);
      fs.appendFileSync(this.logFile, formatted, "utf8");
    } catch (err) {
      console.error("Failed to write log to file:", err);
    }
  }

  private writeToConsole(entry: LogEntry): void {
    if (!this.consoleEnabled) return;
    
    const timestamp = new Date(entry.timestamp).toISOString();
    const contextStr = Object.keys(entry.context).length > 0 
      ? ` [${Object.entries(entry.context).map(([k, v]) => `${k}=${v}`).join(" ")}]`
      : "";
    
    const message = `[${timestamp}] ${entry.level.toUpperCase()}: ${entry.message}${contextStr}`;
    
    switch (entry.level) {
      case "error":
        console.error(message, entry.error || entry.data || "");
        break;
      case "warn":
        console.warn(message, entry.data || "");
        break;
      case "debug":
        console.debug(message, entry.data || "");
        break;
      default:
        console.log(message, entry.data || "");
    }
  }

  private log(level: LogLevel, message: string, context: LogContext = {}, data?: any, error?: Error): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: {
        service: "web-app",
        ...context,
      },
      data,
    };

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      };
    }

    this.writeToFile(entry);
    this.writeToConsole(entry);
  }

  debug(message: string, context?: LogContext, data?: any): void {
    this.log("debug", message, context, data);
  }

  info(message: string, context?: LogContext, data?: any): void {
    this.log("info", message, context, data);
  }

  warn(message: string, context?: LogContext, data?: any): void {
    this.log("warn", message, context, data);
  }

  error(message: string, context?: LogContext, error?: Error, data?: any): void {
    this.log("error", message, context, data, error);
  }

  /**
   * Log API request start
   */
  apiRequest(method: string, path: string, context: LogContext = {}, body?: any): string {
    const correlationId = context.correlationId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.info(`API Request: ${method} ${path}`, {
      ...context,
      correlationId,
      method,
      path,
    }, body ? { body } : undefined);
    return correlationId;
  }

  /**
   * Log API response
   */
  apiResponse(method: string, path: string, statusCode: number, context: LogContext = {}, data?: any): void {
    this.info(`API Response: ${method} ${path} - ${statusCode}`, {
      ...context,
      method,
      path,
      statusCode,
    }, data);
  }

  /**
   * Log server action start
   */
  actionStart(actionName: string, context: LogContext = {}, input?: any): string {
    const correlationId = context.correlationId || `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.info(`Action Start: ${actionName}`, {
      ...context,
      correlationId,
      action: actionName,
    }, input ? { input } : undefined);
    return correlationId;
  }

  /**
   * Log server action completion
   */
  actionComplete(actionName: string, context: LogContext = {}, result?: any): void {
    this.info(`Action Complete: ${actionName}`, {
      ...context,
      action: actionName,
    }, result ? { result } : undefined);
  }

  /**
   * Log server action error
   */
  actionError(actionName: string, context: LogContext = {}, error?: Error, input?: any): void {
    this.error(`Action Error: ${actionName}`, {
      ...context,
      action: actionName,
    }, error, input ? { input } : undefined);
  }

  /**
   * Log database query
   */
  dbQuery(operation: string, table: string, context: LogContext = {}, query?: any): void {
    this.debug(`DB Query: ${operation} on ${table}`, {
      ...context,
      operation,
      table,
    }, query);
  }

  /**
   * Log database result
   */
  dbResult(operation: string, table: string, context: LogContext = {}, result?: any): void {
    const count = Array.isArray(result) ? result.length : (result ? 1 : 0);
    this.debug(`DB Result: ${operation} on ${table} (${count} rows)`, {
      ...context,
      operation,
      table,
      rowCount: count,
    });
  }

  /**
   * Log worker spawn
   */
  workerSpawn(workerName: string, args: string[], context: LogContext = {}): void {
    this.info(`Worker Spawn: ${workerName}`, {
      ...context,
      worker: workerName,
    }, { args });
  }

  /**
   * Log external process result
   */
  processResult(processName: string, exitCode: number, context: LogContext = {}, output?: string): void {
    const level = exitCode === 0 ? "info" : "error";
    this.log(level, `Process ${processName} exited with code ${exitCode}`, {
      ...context,
      process: processName,
      exitCode,
    }, output ? { output } : undefined);
  }
}

// Singleton instance
let loggerInstance: Logger | null = null;

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

export const logger = getLogger();
