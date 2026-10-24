/** White glyphs for the purple stair and lift markers. Registered once per map style. */

interface IconHost {
  hasImage(id: string): boolean;
  addImage(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
}

const SIZE = 64;
const PIXEL_RATIO = 2;

type Kind = "stairs" | "elevator" | "escalator" | "ramp";

function canvas(): { ctx: CanvasRenderingContext2D; image: () => ImageData } {
  const el = document.createElement("canvas");
  el.width = SIZE;
  el.height = SIZE;
  const ctx = el.getContext("2d");
  if (!ctx) throw new Error("canvas 2d is unavailable");
  return { ctx, image: () => ctx.getImageData(0, 0, SIZE, SIZE) };
}

/** A thick staircase zigzag, the usual wayfinding mark. */
function drawStairs(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = SIZE * 0.11;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const x0 = SIZE * 0.18;
  const y0 = SIZE * 0.82;
  const x1 = SIZE * 0.82;
  const y1 = SIZE * 0.18;
  const n = 3;
  const dx = (x1 - x0) / n;
  const dy = (y0 - y1) / n;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 0; i < n; i++) {
    ctx.lineTo(x0 + i * dx, y0 - (i + 1) * dy);
    ctx.lineTo(x0 + (i + 1) * dx, y0 - (i + 1) * dy);
  }
  ctx.stroke();
}

/** Up and down arrows: a lift. */
function drawElevator(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#ffffff";
  const arrow = (cx: number, tipY: number, dir: 1 | -1) => {
    const w = SIZE * 0.36;
    const h = SIZE * 0.3;
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx - w, tipY + dir * h);
    ctx.lineTo(cx + w, tipY + dir * h);
    ctx.closePath();
    ctx.fill();
  };
  arrow(SIZE / 2, SIZE * 0.1, 1);
  arrow(SIZE / 2, SIZE * 0.9, -1);
}

/** Stairs plus an arrow at the top: an escalator. */
function drawEscalator(ctx: CanvasRenderingContext2D) {
  drawStairs(ctx);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(SIZE * 0.72, SIZE * 0.1);
  ctx.lineTo(SIZE * 0.9, SIZE * 0.28);
  ctx.lineTo(SIZE * 0.62, SIZE * 0.28);
  ctx.closePath();
  ctx.fill();
}

/** A slope: a ramp. */
function drawRamp(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(SIZE * 0.18, SIZE * 0.78);
  ctx.lineTo(SIZE * 0.82, SIZE * 0.28);
  ctx.lineTo(SIZE * 0.82, SIZE * 0.78);
  ctx.closePath();
  ctx.fill();
}

const DRAW: Record<Kind, (ctx: CanvasRenderingContext2D) => void> = {
  stairs: drawStairs,
  elevator: drawElevator,
  escalator: drawEscalator,
  ramp: drawRamp,
};

export function addConnectorIcons(map: IconHost) {
  if (map.hasImage("connector-stairs")) return;
  for (const kind of Object.keys(DRAW) as Kind[]) {
    const { ctx, image } = canvas();
    DRAW[kind](ctx);
    map.addImage(`connector-${kind}`, image(), { pixelRatio: PIXEL_RATIO });
  }
}
