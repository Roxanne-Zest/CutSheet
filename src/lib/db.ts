import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import type { Asset, Project } from "../types";

/**
 * Everything lives in the browser. No backend for v1 — projects and photo
 * blobs go in IndexedDB.
 */

type StoredAsset = Omit<Asset, "blob"> & { blob: Blob };

interface CutSheetDB extends DBSchema {
  projects: { key: string; value: Project };
  assets: { key: string; value: StoredAsset };
}

let dbPromise: Promise<IDBPDatabase<CutSheetDB>> | null = null;

const db = (): Promise<IDBPDatabase<CutSheetDB>> => {
  dbPromise ??= openDB<CutSheetDB>("cutsheet", 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("projects")) {
        database.createObjectStore("projects", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("assets")) {
        database.createObjectStore("assets", { keyPath: "id" });
      }
    },
  });
  return dbPromise;
};

export const saveProject = async (project: Project): Promise<void> => {
  await (await db()).put("projects", { ...project, updatedAt: Date.now() });
};

export const loadProjects = async (): Promise<Project[]> => {
  const all = await (await db()).getAll("projects");
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
};

export const loadProject = async (id: string): Promise<Project | undefined> =>
  (await db()).get("projects", id);

export const deleteProject = async (id: string): Promise<void> => {
  await (await db()).delete("projects", id);
};

export const saveAsset = async (asset: Asset): Promise<void> => {
  await (await db()).put("assets", asset);
};

export const loadAssets = async (): Promise<Asset[]> =>
  (await db()).getAll("assets");

export const deleteAsset = async (id: string): Promise<void> => {
  await (await db()).delete("assets", id);
};

/** Drop photos nothing references any more. */
export const pruneAssets = async (keep: Set<string>): Promise<void> => {
  const database = await db();
  const tx = database.transaction("assets", "readwrite");
  for (const asset of await tx.store.getAll()) {
    if (!keep.has(asset.id)) await tx.store.delete(asset.id);
  }
  await tx.done;
};
