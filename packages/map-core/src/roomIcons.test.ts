import { describe, expect, it } from "vitest";
import { isRoomIconId, roomIconImageId, safeIconSvg } from "./roomIcons";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

describe("room icons", () => {
  it("accepts an Iconify id and turns it into an image name", () => {
    expect(isRoomIconId("mdi:toilet")).toBe(true);
    expect(isRoomIconId("not an icon")).toBe(false);
    expect(roomIconImageId("mdi:toilet")).toBe("room-mdi-toilet");
  });

  it("keeps a plain svg and drops anything that can run code", () => {
    expect(safeIconSvg(SVG)).toBe(SVG);
    expect(safeIconSvg("<svg><script>alert(1)</script></svg>")).toBeNull();
    expect(safeIconSvg('<svg onload="alert(1)"></svg>')).toBeNull();
    expect(safeIconSvg("not svg")).toBeNull();
  });
});
