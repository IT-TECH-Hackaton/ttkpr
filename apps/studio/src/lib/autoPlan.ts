// Rooms from a plan image, in the browser: dark lines are walls, door gaps are closed by a small
// dilation, enclosed light areas become rooms. Outlines are traced, simplified, squared to the
// image axes and placed with the underlay's corners. A draft to check, not a finished plan.

export type Position = [number, number];

export interface DetectedRoom {
  /** Ring in image fractions (0..1), closed. */
  ring: Position[];
  /** Share of the image area. */
  area: number;
}

const MAX_SIDE = 900;
const N8: Position[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

async function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas недоступен");
  ctx.fillStyle = "#ffffff"; // transparent PNGs: background is not a wall
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

/** Otsu's threshold on luminance: the split between ink (walls) and paper. */
function otsu(lum: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of lum) hist[v] = (hist[v] ?? 0) + 1;
  const total = lum.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * (hist[i] ?? 0);
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i] ?? 0;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * (hist[i] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/** Square dilation via two separable passes (fast for any radius). */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    // Forward and backward sweeps: within r of the nearest set pixel in the row.
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Moore-neighbour boundary of the component containing the raster-first pixel (sx, sy). */
function trace(inside: (x: number, y: number) => boolean, sx: number, sy: number): Position[] {
  const out: Position[] = [[sx, sy]];
  let x = sx;
  let y = sy;
  let dir = 0;
  for (let guard = 0; guard < 400_000; guard++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const [dx, dy] = N8[d] as Position;
      if (inside(x + dx, y + dy)) {
        x += dx;
        y += dy;
        dir = d;
        moved = true;
        break;
      }
    }
    if (!moved || (x === sx && y === sy)) break;
    out.push([x, y]);
  }
  return out;
}

function simplify(points: Position[], epsilon: number): Position[] {
  if (points.length < 3) return points;
  const [a, b] = [points[0] as Position, points.at(-1) as Position];
  let index = 0;
  let max = 0;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i] as Position;
    const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [a, b];
  return [
    ...simplify(points.slice(0, index + 1), epsilon).slice(0, -1),
    ...simplify(points.slice(index), epsilon),
  ];
}

/** Closed outline: split at the point farthest from the start, simplify both halves. */
function simplifyRing(ring: Position[], epsilon: number): Position[] {
  const first = ring[0] as Position;
  let far = 0;
  let best = -1;
  ring.forEach((p, i) => {
    const d = Math.hypot(p[0] - first[0], p[1] - first[1]);
    if (d > best) {
      best = d;
      far = i;
    }
  });
  const a = simplify(ring.slice(0, far + 1), epsilon);
  const b = simplify([...ring.slice(far), first], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Edges within 15° of the image axes become exactly horizontal / vertical. */
function square(ring: Position[]): Position[] {
  const pts = ring.map((p) => [...p] as Position);
  const tan = Math.tan((15 * Math.PI) / 180);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Position;
    const q = pts[(i + 1) % pts.length] as Position;
    const dx = Math.abs(q[0] - p[0]);
    const dy = Math.abs(q[1] - p[1]);
    if (dy <= dx * tan) p[1] = q[1] = (p[1] + q[1]) / 2;
    else if (dx <= dy * tan) p[0] = q[0] = (p[0] + q[0]) / 2;
  }
  // Drop vertices that ended up collinear.
  return pts.filter((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length] as Position;
    const b = pts[(i + 1) % pts.length] as Position;
    return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) > 0.5;
  });
}

/** Push a ring outwards by r (the dilation shrank every room by about that much). */
function grow(ring: Position[], r: number): Position[] {
  let signed = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Position;
    const b = ring[(i + 1) % ring.length] as Position;
    signed += a[0] * b[1] - b[0] * a[1];
  }
  const out = signed > 0 ? 1 : -1; // image y points down
  return ring.map((p, i) => {
    const prev = ring[(i - 1 + ring.length) % ring.length] as Position;
    const next = ring[(i + 1) % ring.length] as Position;
    const n1 = normal(prev, p, out);
    const n2 = normal(p, next, out);
    const nx = n1[0] + n2[0];
    const ny = n1[1] + n2[1];
    const k = n1[0] * nx + n1[1] * ny || 1;
    return [p[0] + (nx / k) * r, p[1] + (ny / k) * r] as Position;
  });
}

function normal(a: Position, b: Position, out: number): Position {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(-(b[1] - a[1]) / len) * -out, ((b[0] - a[0]) / len) * -out];
}

export async function detectRooms(url: string): Promise<DetectedRoom[]> {
  const { data, w, h } = await loadPixels(url);
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0];
    lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return roomsFromLuminance(lum, w, h);
}

/** The pure part (testable without a canvas): luminance image -> room rings. */
export function roomsFromLuminance(lum: Uint8Array, w: number, h: number): DetectedRoom[] {
  const threshold = otsu(lum);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = (lum[i] ?? 255) <= threshold ? 1 : 0;
  // Door gaps are ~1 m; on a typical plan image that is ~1–2 % of its width.
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.012));
  const walls = dilate(ink, w, h, r);

  const label = new Int32Array(w * h).fill(-1);
  const rooms: DetectedRoom[] = [];
  const queue = new Int32Array(w * h);
  let next = 0;
  for (let start = 0; start < w * h; start++) {
    if (walls[start] || label[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = next;
    let size = 0;
    let border = false;
    while (head < tail) {
      const i = queue[head++] as number;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || walls[j] || label[j] !== -1) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        label[j] = next;
        queue[tail++] = j;
      }
    }
    const area = size / (w * h);
    const id = next++;
    // The outside touches the border; specks are furniture or text; huge areas are background.
    if (border || area < 0.002 || area > 0.85) continue;
    const sx = start % w;
    const sy = (start - sx) / w;
    const inside = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === id;
    const outline = trace(inside, sx, sy);
    if (outline.length < 8) continue;
    const ring = grow(square(simplifyRing(outline, Math.max(1.5, r * 0.4))), r);
    if (ring.length < 3) continue;
    rooms.push({ ring: [...ring, ring[0] as Position].map(([x, y]) => [x / w, y / h]), area });
  }
  return rooms;
}

/** Image fractions -> lon/lat through the underlay corners (top-left, top-right, bottom-right, bottom-left). */
export function placeRing(ring: Position[], corners: Position[]): Position[] {
  const [tl, tr, br, bl] = corners as [Position, Position, Position, Position];
  return ring.map(([u, v]) => [
    tl[0] * (1 - u) * (1 - v) + tr[0] * u * (1 - v) + br[0] * u * v + bl[0] * (1 - u) * v,
    tl[1] * (1 - u) * (1 - v) + tr[1] * u * (1 - v) + br[1] * u * v + bl[1] * (1 - u) * v,
  ]);
}
