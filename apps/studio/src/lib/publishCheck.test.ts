import { readFileSync } from "node:fs";
import type { MapDocument } from "@ttkpr/api-client";
import { describe, expect, it } from "vitest";
import { publishIssues } from "./publishCheck";

const demo = JSON.parse(
  readFileSync(new URL("../../../../fixtures/demo-map.json", import.meta.url), "utf-8"),
) as MapDocument;

describe("publishIssues", () => {
  it("blocks an empty plan", () => {
    const issues = publishIssues({ ...demo, units: [] });
    expect(issues).toEqual([expect.objectContaining({ blocking: true })]);
  });

  it("finds nothing to fix in the demo venue", () => {
    expect(publishIssues(demo)).toEqual([]);
  });

  it("names what is missing", () => {
    const pois = demo.pois ?? [];
    const first = pois[0];
    if (!first) throw new Error("the demo has places");
    const issues = publishIssues({
      ...demo,
      openings: (demo.openings ?? []).filter((o) => o.category !== "entrance"),
      connectors: [],
      pois: [...pois, { ...first, id: "p-new", name: " " }],
    });
    const texts = issues.map((i) => i.text);
    expect(texts).toContain("Нет входа в здание — гости не поймут, откуда идти");
    expect(texts.some((t) => t.includes("не связан лестницей или лифтом"))).toBe(true);
    expect(issues).toContainEqual(
      expect.objectContaining({ text: "Место без названия", id: "p-new" }),
    );
    expect(issues.some((i) => i.blocking)).toBe(false);
  });
});
