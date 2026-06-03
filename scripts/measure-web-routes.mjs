#!/usr/bin/env node

const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
const routes = ["/", "/leads", "/followups", "/analytics", "/custom-outreach", "/settings", "/upload"];
const iterations = Number(process.env.ROUTE_TIMING_ITERATIONS || "3");
const cookie = process.env.ROUTE_TIMING_COOKIE || "";

async function timeRoute(path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "follow",
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  const headerAt = performance.now();
  await response.arrayBuffer();
  const ended = performance.now();
  return {
    path,
    status: response.status,
    ttfbMs: Math.round(headerAt - started),
    totalMs: Math.round(ended - started),
  };
}

async function main() {
  console.log(`Measuring ${baseUrl} for ${iterations} warm iteration(s)`);
  if (cookie) {
    console.log("Using ROUTE_TIMING_COOKIE for authenticated routes");
  }
  for (let i = 0; i < iterations; i += 1) {
    console.log(`\nIteration ${i + 1}`);
    for (const route of routes) {
      const result = await timeRoute(route);
      console.log(`${result.path.padEnd(16)} ${String(result.status).padEnd(3)} ttfb=${String(result.ttfbMs).padStart(4)}ms total=${String(result.totalMs).padStart(4)}ms`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
