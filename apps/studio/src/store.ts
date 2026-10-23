import type { MapDocument, Poi, Unit } from "@ttkpr/api-client";
import { sortedLevels } from "@ttkpr/map-core";
import { temporal } from "zundo";
import { create } from "zustand";
import demoMap from "../../../fixtures/demo-map.json";

export type Tool = "select" | "room" | "rect" | "poi";

type Position = [number, number];

interface DraftState {
  doc: MapDocument;
  levelId: string;
  tool: Tool;
  selectedId: string | null;
  setLevel: (levelId: string) => void;
  setTool: (tool: Tool) => void;
  select: (id: string | null) => void;
  addUnit: (ring: Position[]) => void;
  addPoi: (position: Position) => void;
  updateUnit: (id: string, patch: Partial<Unit>) => void;
  updatePoi: (id: string, patch: Partial<Poi>) => void;
  remove: (id: string) => void;
  load: (doc: MapDocument) => void;
}

const AUTOSAVE_KEY = "ttk-studio-draft";

function initialDoc(): MapDocument {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved) return JSON.parse(saved) as MapDocument;
  } catch {
    // Storage may be unavailable (private mode); fall back to the demo.
  }
  // JSON imports widen [lon, lat] tuples to number[]; the file is generated from the schema.
  return demoMap as unknown as MapDocument;
}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const doc = initialDoc();

export const useDraft = create<DraftState>()(
  temporal(
    (set) => ({
      doc,
      levelId: sortedLevels(doc)[0]?.id ?? "",
      tool: "select",
      selectedId: null,
      setLevel: (levelId) => set({ levelId, selectedId: null }),
      setTool: (tool) => set({ tool, selectedId: null }),
      select: (selectedId) => set({ selectedId }),
      addUnit: (ring) =>
        set((s) => {
          const unit: Unit = {
            id: newId("u"),
            levelId: s.levelId,
            name: "Новое помещение",
            category: "room",
            walkable: true,
            geometry: { type: "Polygon", coordinates: [ring] },
          };
          return {
            doc: { ...s.doc, units: [...(s.doc.units ?? []), unit] },
            selectedId: unit.id,
            tool: "select",
          };
        }),
      addPoi: (position) =>
        set((s) => {
          const poi: Poi = {
            id: newId("p"),
            levelId: s.levelId,
            name: "Новая точка",
            category: "other",
            position,
          };
          return {
            doc: { ...s.doc, pois: [...(s.doc.pois ?? []), poi] },
            selectedId: poi.id,
            tool: "select",
          };
        }),
      updateUnit: (id, patch) =>
        set((s) => ({
          doc: { ...s.doc, units: s.doc.units?.map((u) => (u.id === id ? { ...u, ...patch } : u)) },
        })),
      updatePoi: (id, patch) =>
        set((s) => ({
          doc: { ...s.doc, pois: s.doc.pois?.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
        })),
      remove: (id) =>
        set((s) => ({
          doc: {
            ...s.doc,
            units: s.doc.units?.filter((u) => u.id !== id),
            pois: s.doc.pois?.filter((p) => p.id !== id),
          },
          selectedId: null,
        })),
      load: (next) =>
        set({ doc: next, levelId: sortedLevels(next)[0]?.id ?? "", selectedId: null }),
    }),
    // Only document edits are undoable; tool/selection/level are UI state.
    {
      partialize: (state) => ({ doc: state.doc }),
      // Record history only when the document itself changed, so undo never "does nothing".
      equality: (past, current) => past.doc === current.doc,
      limit: 100,
    },
  ),
);

useDraft.subscribe((state, prev) => {
  if (state.doc === prev.doc) return;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state.doc));
  } catch {
    // Autosave is a convenience; ignore quota/private-mode errors.
  }
});

if (import.meta.env.DEV) (window as unknown as { draft?: typeof useDraft }).draft = useDraft;
