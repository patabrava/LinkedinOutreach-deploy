import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawn as nodeSpawn } from "child_process";

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

test("stopWorkers with processGroup=true kills the entire process group", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-control-pgroup-"));
  const registryPath = path.join(tmpDir, "worker-control.json");

  // bash spawns a sleep child, prints its PID, then waits — so we can verify
  // that killing the process group also kills the inner sleep, not only bash.
  const child = nodeSpawn(
    "bash",
    ["-c", "sleep 60 & echo $! ; wait"],
    { stdio: ["ignore", "pipe", "ignore"], detached: true },
  );
  assert.ok(child.pid);

  const innerPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("never read inner pid")), 5000);
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const pid = Number(buffer.slice(0, newline).trim());
        clearTimeout(timeout);
        resolve(pid);
      }
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  registerWorkerPid({
    registryPath,
    kind: "sender_message_only",
    pid: child.pid!,
    label: "Message-only daemon",
    args: ["bash", "-c", "loop"],
    processGroup: true,
  });

  const result = stopWorkers({ registryPath, kinds: ["sender_message_only"] });
  assert.equal(result.stopped.length, 1);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bash did not exit after group SIGTERM")), 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // The inner sleep should be dead too. Poll briefly to allow signal delivery.
  const innerDead = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + 3000;
    const tick = () => {
      try {
        process.kill(innerPid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return resolve(true);
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  assert.equal(innerDead, true, "inner sleep child must be killed by group SIGTERM");
});
