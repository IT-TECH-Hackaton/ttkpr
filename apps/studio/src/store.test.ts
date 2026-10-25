import { readFileSync } from "node:fs";
import type { MapDocument } from "@ttkpr/api-client";
import { toLocal } from "@ttkpr/map-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store saves drafts to localStorage; tests run without a browser.
const memory = new Map<string, string>();
vi.stubGlobal("window", globalThis);
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => memory.set(k, v),
  removeItem: (k: string) => memory.delete(k),
});
const { useDraft } = await import("./store");

const demo = JSON.parse(
  readFileSync(new URL("../../../fixtures/demo-map.json", import.meta.url), "utf-8"),
) as MapDocument;

describe("duplicate and copy floor", () => {
  beforeEach(() => useDraft.getState().load("m1", structuredClone(demo), 1));

  it("puts a copy of a room right next to it and selects it", () => {
    const room = demo.units?.find((u) => u.levelId === "l1");
    if (!room) throw new Error("the demo has rooms");
    useDraft.getState().duplicate(room.id);
    const s = useDraft.getState();
    const copy = s.doc.units?.at(-1);
    expect(copy?.id).not.toBe(room.id);
    expect(s.selectedId).toBe(copy?.id);
    const xs = (ring: number[][]) =>
      ring.map((p) => toLocal(demo.venue.anchor, p as [number, number])[0]);
    const a = xs(room.geometry.coordinates[0] ?? []);
    const b = xs(copy?.geometry.coordinates[0] ?? []);
    // The copy starts where the original ends.
    expect(Math.min(...b)).toBeCloseTo(Math.max(...a), 3);
  });

  it("copies the current floor's rooms and doors to a new floor above", () => {
    const s0 = useDraft.getState();
    s0.setLevel("l1");
    const rooms = (s0.doc.units ?? []).filter((u) => u.levelId === "l1").length;
    const doors = (s0.doc.openings ?? []).filter((o) => o.levelId === "l1").length;
    useDraft.getState().copyLevel();
    const s = useDraft.getState();
    const level = s.levelId;
    expect(s.doc.levels?.length).toBe((demo.levels?.length ?? 0) + 1);
    expect((s.doc.units ?? []).filter((u) => u.levelId === level)).toHaveLength(rooms);
    expect((s.doc.openings ?? []).filter((o) => o.levelId === level)).toHaveLength(doors);
    const ids = new Set((s.doc.units ?? []).map((u) => u.id));
    expect(ids.size).toBe(s.doc.units?.length);
  });
});
