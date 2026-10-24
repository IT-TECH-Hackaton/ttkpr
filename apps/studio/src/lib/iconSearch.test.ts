import { describe, expect, it } from "vitest";
import { iconIdFromUrl } from "./iconSearch";

describe("iconIdFromUrl", () => {
  it("keeps an Iconify id and rejects a non-https link", () => {
    expect(iconIdFromUrl("https://api.iconify.design/mdi/security.svg")).toBe("mdi:security");
    expect(iconIdFromUrl("http://api.iconify.design/mdi/security.svg")).toBeNull();
    expect(iconIdFromUrl("не ссылка")).toBeNull();
  });

  it("assigns a stable id to an svg that is not an Iconify path", () => {
    const id = iconIdFromUrl("https://example.com/guard.svg");
    expect(id).toMatch(/^svg:[0-9a-f]{8}$/);
    expect(iconIdFromUrl("https://example.com/guard.svg")).toBe(id);
  });
});
