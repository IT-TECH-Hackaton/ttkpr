/** Room badges: a white glyph from a cached SVG, same idea as the stair and lift marks. */

const ICON_ID = /^[a-z0-9-]{1,40}:[a-z0-9-]{1,80}$/;

interface IconHost {
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
}

const pending = new Set<string>();

export function isRoomIconId(icon: string): boolean {
  return ICON_ID.test(icon);
}

/** MapLibre image name for an Iconify id (`mdi:toilet` → `room-mdi-toilet`). */
export function roomIconImageId(icon: string): string {
  return `room-${icon.replace(":", "-")}`;
}

/** The SVG we are willing to draw. Anything else is ignored, even if it is in the document. */
export function safeIconSvg(svg: string | null | undefined): string | null {
  if (!svg) return null;
  const text = svg.trim();
  if (text.length < 20 || text.length > 12000) return null;
  if (!text.startsWith("<svg") || !text.endsWith("</svg>")) return null;
  if (/<script|javascript:|foreignObject|on[a-z]+\s*=/i.test(text)) return null;
  return text;
}

function rasterize(svg: string): Promise<ImageData> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  return image.decode().then(
    () => {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        throw new Error("canvas");
      }
      const pad = size * 0.16;
      ctx.drawImage(image, pad, pad, size - pad * 2, size - pad * 2);
      const pixels = ctx.getImageData(0, 0, size, size);
      // Iconify SVGs are black. Paint every opaque pixel white so the badge stays readable
      // on a dark plan.
      const data = pixels.data;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) === 0) continue;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
      URL.revokeObjectURL(url);
      return pixels;
    },
    (error: unknown) => {
      URL.revokeObjectURL(url);
      throw error;
    },
  );
}

/** Registers each room icon once. Missing or unsafe SVGs are skipped. */
export function syncRoomIcons(
  map: IconHost,
  units: { icon?: string | null; iconSvg?: string | null }[],
): void {
  for (const unit of units) {
    const icon = unit.icon ?? "";
    const svg = safeIconSvg(unit.iconSvg);
    if (!isRoomIconId(icon) || !svg) continue;
    const id = roomIconImageId(icon);
    if (map.hasImage(id) || pending.has(id)) continue;
    pending.add(id);
    void rasterize(svg)
      .then((pixels) => {
        if (!map.hasImage(id)) map.addImage(id, pixels, { pixelRatio: 2 });
      })
      .catch(() => undefined)
      .finally(() => pending.delete(id));
  }
}
