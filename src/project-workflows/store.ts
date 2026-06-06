import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { ProjectWorkflowRecord, ProjectWorkflowStore } from "./types.js";

const STORE_VERSION = 1 as const;

export function resolveProjectWorkflowStorePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "project-workflows", "workflows.json");
}

function emptyStore(): ProjectWorkflowStore {
  return { version: STORE_VERSION, workflows: [] };
}

function normalizeStore(value: unknown): ProjectWorkflowStore {
  if (!value || typeof value !== "object") {
    return emptyStore();
  }
  const workflows = Array.isArray((value as { workflows?: unknown }).workflows)
    ? ((value as { workflows: ProjectWorkflowRecord[] }).workflows ?? [])
    : [];
  return { version: STORE_VERSION, workflows };
}

export async function readProjectWorkflowStore(
  storePath = resolveProjectWorkflowStorePath(),
): Promise<ProjectWorkflowStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore();
    }
    throw err;
  }
}

export async function writeProjectWorkflowStore(
  store: ProjectWorkflowStore,
  storePath = resolveProjectWorkflowStorePath(),
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function updateProjectWorkflowStore<T>(
  update: (store: ProjectWorkflowStore) => T | Promise<T>,
  storePath = resolveProjectWorkflowStorePath(),
): Promise<T> {
  const store = await readProjectWorkflowStore(storePath);
  const result = await update(store);
  await writeProjectWorkflowStore(store, storePath);
  return result;
}
