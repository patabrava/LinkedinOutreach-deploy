import { logger } from "./logger";

export const mirrorWorkerOutput = (
  stream: NodeJS.ReadableStream | null,
  logLevel: "info" | "warn",
  correlationId: string,
  label: string,
) => {
  if (!stream) return;

  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logger[logLevel](`Scraper ${label}`, { correlationId }, { line: trimmed });
    }
  });

  stream.on("end", () => {
    const trimmed = buffer.trim();
    if (!trimmed) return;
    logger[logLevel](`Scraper ${label}`, { correlationId }, { line: trimmed });
  });
};
