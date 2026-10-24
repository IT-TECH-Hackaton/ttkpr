import type {
  Connector,
  Fixture,
  Level,
  MapDocument,
  Opening,
  PathLine,
  Poi,
  Tour,
  Underlay,
  Unit,
} from "@ttkpr/api-client";
import { CONNECTOR_LABELS, categoryLabel, sortedLevels } from "@ttkpr/map-core";
import { temporal } from "zundo";
import { create } from "zustand";
import { FURNITURE, furnitureAt } from "./lib/furniture";
import { scaleDocument } from "./lib/scalePlan";

export type Tool =
  | "select"
  | "rect"
  | "room"
  | "door"
  | "stairs"
  | "poi"
  | "furniture"
  | "move"
  | "path"
  | "pano";
export type DoorType = "door" | "double" | "passage" | "entrance" | "window";
export type ConnectorKind = Connector["kind"];
export type LayerGroup =
  | "underlay"
  | "rooms"
  | "labels"
  | "doors"
  | "connectors"
  | "points"
  | "panos";
export type SaveState = "saved" | "dirty" | "saving" | "offline" | "conflict" | "error";

type Position = [number, number];

interface DraftState {
  mapId: string | null;
  doc: MapDocument;
  /** Server draft version the current document is based on (optimistic locking). */
  version: number;
  saveState: SaveState;
  saveError: string | null;
  levelId: string;
  tool: Tool;
  selectedId: string | null;
  /** Point picked on the plan for a new panorama (phone capture or 360° upload). */
  panoSpot: Position | null;
  /** Pano being moved: the next click on the plan sets its position. */
  movingPanoId: string | null;
  /** Tour whose stops are being picked: clicks on points add them in order. */
  editingTourId: string | null;
  /** Tool options (toolbar dropdowns) and view settings. */
  doorType: DoorType;
  connectorKind: ConnectorKind;
  poiCategory: string;
  /** FURNITURE preset the "Мебель" tool puts. */
  furniture: string;
  snapping: boolean;
  hiddenLayers: LayerGroup[];
  /** Short message near the toolbar (e.g. "Кликните по стене"). */
  hint: string | null;

  /** Bumped on every load, so autosave re-reads its baseline. */
  loadedAt: number;
  /** restored: the document is a local backup that still has to reach the server. */
  load: (mapId: string, doc: MapDocument, version: number, restored?: boolean) => void;
  markSaved: (version: number) => void;
  setSaveState: (state: SaveState, error?: string) => void;
  setLevel: (levelId: string) => void;
  setTool: (tool: Tool) => void;
  select: (id: string | null) => void;
  setPanoSpot: (spot: Position | null) => void;
  setMovingPano: (id: string | null) => void;
  setOptions: (
    patch: Partial<
      Pick<DraftState, "doorType" | "connectorKind" | "poiCategory" | "furniture" | "snapping">
    >,
  ) => void;
  toggleLayer: (group: LayerGroup) => void;
  setHint: (hint: string | null) => void;

  addUnit: (ring: Position[]) => void;
  /** Many rooms at once (plan recognition): one undo step. */
  addUnits: (rings: Position[][]) => void;
  /** A whole new document at once (plan import): one undo step, then show `levelId`. */
  replaceDoc: (doc: MapDocument, levelId: string) => void;
  addPoi: (position: Position) => void;
  addOpening: (a: Position, b: Position) => void;
  addConnector: (position: Position) => void;
  addFurniture: (position: Position, rotationDeg: number) => void;
  /** Everything on the map scaled about a point (fixing a plan drawn at the wrong size). */
  scalePlan: (factor: number, center: Position) => void;
  addPath: (coordinates: Position[]) => void;
  addTour: () => void;
  updateTour: (id: string, patch: Partial<Tour>) => void;
  addTourStop: (poiId: string) => void;
  moveTourStop: (id: string, index: number, delta: -1 | 1) => void;
  removeTourStop: (id: string, index: number) => void;
  setEditingTour: (id: string | null) => void;
  updateUnit: (id: string, patch: Partial<Unit>) => void;
  /** Slide one wall, and the doors that sit on it, as a single undo step. */
  resizeUnit: (id: string, ring: Position[], openings: { id: string; line: Position[] }[]) => void;
  updatePoi: (id: string, patch: Partial<Poi>) => void;
  updateFixture: (id: string, patch: Partial<Fixture>) => void;
  remove: (id: string) => void;
  addLevel: () => void;
  updateLevel: (id: string, patch: Partial<Level>) => void;
  addUnderlay: (underlay: Omit<Underlay, "id" | "levelId">) => void;
  updateUnderlay: (id: string, patch: Partial<Underlay>) => void;
}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export const EMPTY_DOC: MapDocument = {
  venue: { id: "draft", name: "", anchor: [37.6176, 55.7558] },
  levels: [],
};

function withDefaultLevel(doc: MapDocument): MapDocument {
  if (doc.levels?.length) return doc;
  return { ...doc, levels: [{ id: "l1", name: "1 этаж", ordinal: 0 }] };
}

export const useDraft = create<DraftState>()(
  temporal(
    (set) => ({
      mapId: null,
      doc: EMPTY_DOC,
      version: 0,
      saveState: "saved",
      saveError: null,
      levelId: "",
      tool: "select",
      selectedId: null,
      panoSpot: null,
      movingPanoId: null,
      editingTourId: null,
      doorType: "door",
      connectorKind: "stairs",
      poiCategory: "stand",
      furniture: "table",
      snapping: true,
      hiddenLayers: [],
      hint: null,
      loadedAt: 0,

      load: (mapId, doc, version, restored = false) => {
        const ready = withDefaultLevel(doc);
        set({
          mapId,
          doc: ready,
          version,
          saveState: ready === doc && !restored ? "saved" : "dirty",
          loadedAt: Date.now(),
          saveError: null,
          levelId: sortedLevels(ready)[0]?.id ?? "",
          tool: "select",
          selectedId: null,
          panoSpot: null,
          movingPanoId: null,
          editingTourId: null,
        });
        useDraft.temporal.getState().clear();
      },
      markSaved: (version) => set({ version, saveState: "saved", saveError: null }),
      setSaveState: (saveState, error) => set({ saveState, saveError: error ?? null }),
      setLevel: (levelId) => set({ levelId, selectedId: null, panoSpot: null }),
      setTool: (tool) =>
        set({
          tool,
          selectedId: null,
          panoSpot: null,
          movingPanoId: null,
          editingTourId: null,
          hint: null,
        }),
      select: (selectedId) =>
        set((s) => ({
          selectedId,
          panoSpot: null,
          editingTourId: selectedId === s.editingTourId ? s.editingTourId : null,
        })),
      setPanoSpot: (panoSpot) => set({ panoSpot, selectedId: null }),
      setMovingPano: (movingPanoId) => set({ movingPanoId }),
      setOptions: (patch) => set(patch),
      toggleLayer: (group) =>
        set((s) => ({
          hiddenLayers: s.hiddenLayers.includes(group)
            ? s.hiddenLayers.filter((g) => g !== group)
            : [...s.hiddenLayers, group],
        })),
      setHint: (hint) => set({ hint }),

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
          // The tool stays active: draw room after room, rename them in the panel.
          return { doc: { ...s.doc, units: [...(s.doc.units ?? []), unit] }, selectedId: unit.id };
        }),
      replaceDoc: (doc, levelId) => set({ doc, levelId, selectedId: null, tool: "select" }),
      addUnits: (rings) =>
        set((s) => {
          const start = (s.doc.units?.length ?? 0) + 1;
          const units: Unit[] = rings.map((ring, i) => ({
            id: newId("u"),
            levelId: s.levelId,
            name: `Помещение ${start + i}`,
            category: "room",
            walkable: true,
            geometry: { type: "Polygon", coordinates: [ring] },
          }));
          return { doc: { ...s.doc, units: [...(s.doc.units ?? []), ...units] } };
        }),
      addPoi: (position) =>
        set((s) => {
          const sameCategory = (s.doc.pois ?? []).filter(
            (p) => p.category === s.poiCategory,
          ).length;
          const poi: Poi = {
            id: newId("p"),
            levelId: s.levelId,
            name: `${categoryLabel(s.poiCategory)} ${sameCategory + 1}`,
            category: s.poiCategory,
            position,
          };
          return { doc: { ...s.doc, pois: [...(s.doc.pois ?? []), poi] }, selectedId: poi.id };
        }),
      addOpening: (a, b) =>
        set((s) => {
          const opening: Opening = {
            id: newId("o"),
            levelId: s.levelId,
            category: s.doorType === "double" ? "door" : s.doorType,
            geometry: { type: "LineString", coordinates: [a, b] },
          };
          return {
            doc: { ...s.doc, openings: [...(s.doc.openings ?? []), opening] },
            selectedId: opening.id,
          };
        }),
      addFurniture: (position, rotationDeg) =>
        set((s) => {
          const preset = FURNITURE.find((p) => p.id === s.furniture) ?? FURNITURE[0];
          if (!preset) return {};
          const fixture = furnitureAt(
            preset,
            s.doc.venue.anchor,
            position,
            s.levelId,
            newId("f"),
            rotationDeg,
          );
          // The tool stays: tables and chairs go in a row, click after click.
          return { doc: { ...s.doc, fixtures: [...(s.doc.fixtures ?? []), fixture] } };
        }),
      scalePlan: (factor, center) => set((s) => ({ doc: scaleDocument(s.doc, factor, center) })),
      addConnector: (position) =>
        set((s) => {
          // Stairs/lifts join this floor with the one above; a second floor appears if needed.
          const levels = sortedLevels(s.doc);
          const current = levels.find((l) => l.id === s.levelId);
          let above = levels.find((l) => current && l.ordinal === current.ordinal + 1);
          let docLevels = s.doc.levels ?? [];
          if (!above) {
            const ordinal = (current?.ordinal ?? 0) + 1;
            above = { id: newId("l"), name: `${ordinal + 1} этаж`, ordinal };
            docLevels = [...docLevels, above];
          }
          const connector: Connector = {
            id: newId("c"),
            kind: s.connectorKind,
            name: CONNECTOR_LABELS[s.connectorKind],
            points: [
              { levelId: s.levelId, position },
              { levelId: above.id, position },
            ],
          };
          return {
            doc: {
              ...s.doc,
              levels: docLevels,
              connectors: [...(s.doc.connectors ?? []), connector],
            },
            selectedId: connector.id,
          };
        }),
      addPath: (coordinates) =>
        set((s) => {
          const path: PathLine = {
            id: newId("w"),
            levelId: s.levelId,
            geometry: { type: "LineString", coordinates },
          };
          return { doc: { ...s.doc, paths: [...(s.doc.paths ?? []), path] }, selectedId: path.id };
        }),
      addTour: () =>
        set((s) => {
          const tour: Tour = {
            id: newId("t"),
            name: `Маршрут ${(s.doc.tours?.length ?? 0) + 1}`,
            stops: [],
          };
          return {
            doc: { ...s.doc, tours: [...(s.doc.tours ?? []), tour] },
            selectedId: tour.id,
            editingTourId: tour.id,
            tool: "select",
          };
        }),
      updateTour: (id, patch) =>
        set((s) => ({
          doc: { ...s.doc, tours: s.doc.tours?.map((t) => (t.id === id ? { ...t, ...patch } : t)) },
        })),
      addTourStop: (poiId) =>
        set((s) => ({
          doc: {
            ...s.doc,
            tours: s.doc.tours?.map((t) => {
              const stops = t.stops ?? [];
              if (t.id !== s.editingTourId || stops.at(-1) === poiId || stops.length >= 30)
                return t;
              return { ...t, stops: [...stops, poiId] };
            }),
          },
        })),
      moveTourStop: (id, index, delta) =>
        set((s) => ({
          doc: {
            ...s.doc,
            tours: s.doc.tours?.map((t) => {
              const stops = [...(t.stops ?? [])];
              const to = index + delta;
              if (t.id !== id || to < 0 || to >= stops.length) return t;
              [stops[index], stops[to]] = [stops[to] as string, stops[index] as string];
              return { ...t, stops };
            }),
          },
        })),
      removeTourStop: (id, index) =>
        set((s) => ({
          doc: {
            ...s.doc,
            tours: s.doc.tours?.map((t) =>
              t.id === id ? { ...t, stops: (t.stops ?? []).filter((_, i) => i !== index) } : t,
            ),
          },
        })),
      setEditingTour: (editingTourId) => set({ editingTourId, tool: "select" }),
      updateUnit: (id, patch) =>
        set((s) => ({
          doc: { ...s.doc, units: s.doc.units?.map((u) => (u.id === id ? { ...u, ...patch } : u)) },
        })),
      resizeUnit: (id, ring, moved) =>
        set((s) => ({
          doc: {
            ...s.doc,
            units: s.doc.units?.map((u) =>
              u.id === id
                ? {
                    ...u,
                    geometry: {
                      type: "Polygon" as const,
                      coordinates: [ring, ...u.geometry.coordinates.slice(1)],
                    },
                  }
                : u,
            ),
            openings: s.doc.openings?.map((o) => {
              const next = moved.find((m) => m.id === o.id);
              return next
                ? { ...o, geometry: { type: "LineString" as const, coordinates: next.line } }
                : o;
            }),
          },
        })),
      updatePoi: (id, patch) =>
        set((s) => ({
          doc: { ...s.doc, pois: s.doc.pois?.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
        })),
      updateFixture: (id, patch) =>
        set((s) => ({
          doc: {
            ...s.doc,
            fixtures: s.doc.fixtures?.map((f) => (f.id === id ? { ...f, ...patch } : f)),
          },
        })),
      remove: (id) =>
        set((s) => ({
          doc: {
            ...s.doc,
            units: s.doc.units?.filter((u) => u.id !== id),
            pois: s.doc.pois?.filter((p) => p.id !== id),
            openings: s.doc.openings?.filter((o) => o.id !== id),
            connectors: s.doc.connectors?.filter((c) => c.id !== id),
            fixtures: s.doc.fixtures?.filter((f) => f.id !== id),
            underlays: s.doc.underlays?.filter((u) => u.id !== id),
            paths: s.doc.paths?.filter((p) => p.id !== id),
            // A removed point leaves every tour; a removed tour is gone.
            tours: s.doc.tours
              ?.filter((t) => t.id !== id)
              .map((t) => ({ ...t, stops: (t.stops ?? []).filter((poiId) => poiId !== id) })),
          },
          selectedId: null,
          editingTourId: s.editingTourId === id ? null : s.editingTourId,
        })),
      addLevel: () =>
        set((s) => {
          const levels = sortedLevels(s.doc);
          const ordinal = (levels.at(-1)?.ordinal ?? -1) + 1;
          const level: Level = { id: newId("l"), name: `${ordinal + 1} этаж`, ordinal };
          return {
            doc: { ...s.doc, levels: [...(s.doc.levels ?? []), level] },
            levelId: level.id,
            selectedId: null,
          };
        }),
      updateLevel: (id, patch) =>
        set((s) => ({
          doc: {
            ...s.doc,
            levels: s.doc.levels?.map((l) => (l.id === id ? { ...l, ...patch } : l)),
          },
        })),
      addUnderlay: (underlay) =>
        set((s) => {
          const created: Underlay = { ...underlay, id: newId("ul"), levelId: s.levelId };
          return {
            doc: { ...s.doc, underlays: [...(s.doc.underlays ?? []), created] },
            selectedId: created.id,
            tool: "select",
          };
        }),
      updateUnderlay: (id, patch) =>
        set((s) => ({
          doc: {
            ...s.doc,
            underlays: s.doc.underlays?.map((u) => (u.id === id ? { ...u, ...patch } : u)),
          },
        })),
    }),
    {
      partialize: (state) => ({ doc: state.doc }),
      // Record history only when the document itself changed, so undo never "does nothing".
      equality: (past, current) => past.doc === current.doc,
      limit: 100,
    },
  ),
);

if (import.meta.env.DEV) (window as unknown as { draft?: typeof useDraft }).draft = useDraft;
