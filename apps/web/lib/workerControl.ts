import type { ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

export type WorkerKind =
  | "scraper_outreach"
  | "scraper_inbox"
  | "draft_agent"
  | "sender_outreach"
  | "sender_followup";

export type WorkerRecord = {
  id: string;
  kind: WorkerKind;
  pid: number;
  label: string;
  startedAt: string;
  args: string[];
};

type RegistryShape = {
  workers: WorkerRecord[];
};

type RegisterWorkerInput = {
  registryPath?: string;
  kind: WorkerKind;
  pid: number;
  label: string;
  args?: string[];
};

type TrackWorkerChildInput = Omit<RegisterWorkerInput, "pid"> & {
  child: ChildProcess;
};

type ListWorkersInput = {
  registryPath?: string;
  kinds?: WorkerKind[];
};

type StopWorkersResult = {
  stopped: WorkerRecord[];
  notRunning: WorkerRecord[];
};

const REGISTRY_FILENAME = "worker-control.json";

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code !== "ESRCH";
  }
};

export function getDefaultWorkerRegistryPath() {
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  return path.join(repoRoot, ".logs", REGISTRY_FILENAME);
}

const resolveRegistryPath = (registryPath?: string) => {
  return registryPath || getDefaultWorkerRegistryPath();
};

const ensureRegistryDir = (registryPath: string) => {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
};

const readRegistry = (registryPath: string): RegistryShape => {
  if (!fs.existsSync(registryPath)) {
    return { workers: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Partial<RegistryShape>;
    const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
    return { workers: workers.filter((worker) => Number.isInteger(worker?.pid) && worker.pid > 0) };
  } catch {
    return { workers: [] };
  }
};

const writeRegistry = (registryPath: string, registry: RegistryShape) => {
  ensureRegistryDir(registryPath);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
};

const dedupeWorkers = (workers: WorkerRecord[]) => {
  const byPid = new Map<number, WorkerRecord>();
  workers.forEach((worker) => {
    byPid.set(worker.pid, worker);
  });
  return Array.from(byPid.values());
};

const cleanupRegistry = (registryPath: string): WorkerRecord[] => {
  const registry = readRegistry(registryPath);
  const activeWorkers = dedupeWorkers(registry.workers).filter((worker) => isPidAlive(worker.pid));
  if (activeWorkers.length !== registry.workers.length) {
    writeRegistry(registryPath, { workers: activeWorkers });
  }
  return activeWorkers;
};

export function listActiveWorkers({ registryPath, kinds }: ListWorkersInput = {}): WorkerRecord[] {
  const resolvedPath = resolveRegistryPath(registryPath);
  const activeWorkers = cleanupRegistry(resolvedPath);
  if (!kinds?.length) {
    return activeWorkers;
  }
  const kindSet = new Set(kinds);
  return activeWorkers.filter((worker) => kindSet.has(worker.kind));
}

export function registerWorkerPid(input: RegisterWorkerInput): WorkerRecord | null {
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    return null;
  }

  const registryPath = resolveRegistryPath(input.registryPath);
  const activeWorkers = cleanupRegistry(registryPath);
  const worker: WorkerRecord = {
    id: `${input.kind}:${input.pid}`,
    kind: input.kind,
    pid: input.pid,
    label: input.label,
    startedAt: new Date().toISOString(),
    args: input.args || [],
  };

  const nextWorkers = activeWorkers.filter((entry) => entry.pid !== input.pid);
  nextWorkers.push(worker);
  writeRegistry(registryPath, { workers: nextWorkers });
  return worker;
}

export function unregisterWorkerPid(pid: number, registryPath?: string) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const resolvedPath = resolveRegistryPath(registryPath);
  const activeWorkers = cleanupRegistry(resolvedPath);
  const nextWorkers = activeWorkers.filter((worker) => worker.pid !== pid);
  if (nextWorkers.length !== activeWorkers.length) {
    writeRegistry(resolvedPath, { workers: nextWorkers });
  }
}

export function trackWorkerChild({ child, registryPath, kind, label, args }: TrackWorkerChildInput) {
  if (!child.pid) {
    return null;
  }

  const record = registerWorkerPid({
    registryPath,
    kind,
    pid: child.pid,
    label,
    args,
  });

  child.on("exit", () => {
    unregisterWorkerPid(child.pid || 0, registryPath);
  });

  return record;
}

export function stopWorkers({ registryPath, kinds }: ListWorkersInput = {}): StopWorkersResult {
  const matchingWorkers = listActiveWorkers({ registryPath, kinds });
  const stopped: WorkerRecord[] = [];
  const notRunning: WorkerRecord[] = [];

  matchingWorkers.forEach((worker) => {
    try {
      process.kill(worker.pid, "SIGTERM");
      stopped.push(worker);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        notRunning.push(worker);
        return;
      }
      throw error;
    }
  });

  const stoppedPidSet = new Set([...stopped, ...notRunning].map((worker) => worker.pid));
  if (stoppedPidSet.size > 0) {
    const resolvedPath = resolveRegistryPath(registryPath);
    const remainingWorkers = listActiveWorkers({ registryPath: resolvedPath }).filter(
      (worker) => !stoppedPidSet.has(worker.pid)
    );
    writeRegistry(resolvedPath, { workers: remainingWorkers });
  }

  return { stopped, notRunning };
}
