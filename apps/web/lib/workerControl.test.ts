import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

import {
  listActiveWorkers,
  registerWorkerPid,
  stopWorkers,
} from "./workerControl";

test("listActiveWorkers removes stale pids and keeps live ones", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-control-"));
  const registryPath = path.join(tmpDir, "worker-control.json");

  registerWorkerPid({
    registryPath,
    kind: "sender_outreach",
    pid: process.pid,
    label: "Live sender",
    args: ["sender.py"],
  });
  registerWorkerPid({
    registryPath,
    kind: "draft_agent",
    pid: 999_999_999,
    label: "Stale draft agent",
    args: ["run_agent.py"],
  });

  const active = listActiveWorkers({ registryPath });

  assert.equal(active.length, 1);
  assert.equal(active[0]?.pid, process.pid);
  assert.equal(active[0]?.kind, "sender_outreach");
});

test("stopWorkers sends SIGTERM to tracked workers", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-control-stop-"));
  const registryPath = path.join(tmpDir, "worker-control.json");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });

  assert.ok(child.pid);

  registerWorkerPid({
    registryPath,
    kind: "sender_followup",
    pid: child.pid!,
    label: "Follow-up sender",
    args: ["sender.py", "--followup"],
  });

  const result = stopWorkers({ registryPath, kinds: ["sender_followup"] });
  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0]?.pid, child.pid);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not exit after SIGTERM")), 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
});
