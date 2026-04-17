import type { ChildProcess } from "child_process";
import fs from "fs";

type ScraperLockResult =
  | { ok: true }
  | { ok: false; activePid: number };

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code !== "ESRCH";
  }
};

const readPidFile = (pidFile: string): number | null => {
  if (!fs.existsSync(pidFile)) return null;

  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const removeStalePidFile = (pidFile: string): void => {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Best-effort cleanup only.
  }
};

export const assertScraperLockFree = (pidFile: string): ScraperLockResult => {
  const activePid = readPidFile(pidFile);
  if (!activePid) return { ok: true };

  if (isPidAlive(activePid)) {
    return { ok: false, activePid };
  }

  removeStalePidFile(pidFile);
  return { ok: true };
};

export const persistScraperPid = (child: ChildProcess, pidFile: string): void => {
  if (!child.pid) return;

  try {
    fs.writeFileSync(pidFile, String(child.pid), "utf8");
  } catch {
    // Best-effort PID persistence only.
  }

  child.on("exit", () => {
    const currentPid = readPidFile(pidFile);
    if (currentPid === child.pid) {
      removeStalePidFile(pidFile);
    }
  });
};
