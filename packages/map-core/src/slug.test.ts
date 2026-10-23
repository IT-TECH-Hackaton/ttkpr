import { describe, expect, it } from "vitest";
import { SLUG_RE, slugify } from "./slug";

describe("slugify", () => {
  it("transliterates Russian titles into valid short links", () => {
    expect(slugify("Отель «Сокол» — 2 этаж")).toBe("otel-sokol-2-etazh");
    expect(slugify("Хакатон IT-TECH 2026")).toBe("hakaton-it-tech-2026");
    expect(SLUG_RE.test(slugify("Щёлково, ДК «Юность»"))).toBe(true);
  });
});

describe("plural", async () => {
  const { plural } = await import("./plural");
  it("picks the Russian form", () => {
    const forms: [string, string, string] = ["панорама", "панорамы", "панорам"];
    expect([1, 2, 5, 11, 21, 22, 112].map((n) => plural(n, forms))).toEqual([
      "1 панорама",
      "2 панорамы",
      "5 панорам",
      "11 панорам",
      "21 панорама",
      "22 панорамы",
      "112 панорам",
    ]);
  });
});
