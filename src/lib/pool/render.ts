import { BALL_R, POCKET_R, RAIL, TABLE_H, TABLE_W } from "./constants";
import { Ball } from "./types";

const POCKETS: [number, number][] = [
  [34, 34],
  [TABLE_W / 2, 28],
  [TABLE_W - 34, 34],
  [34, TABLE_H - 34],
  [TABLE_W / 2, TABLE_H - 28],
  [TABLE_W - 34, TABLE_H - 34],
];

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawTable(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, TABLE_W, TABLE_H);

  const outer = ctx.createLinearGradient(0, 0, 0, TABLE_H);
  outer.addColorStop(0, "#f2f2ee");
  outer.addColorStop(0.16, "#666");
  outer.addColorStop(0.5, "#171717");
  outer.addColorStop(0.84, "#696969");
  outer.addColorStop(1, "#f8f8f2");
  ctx.fillStyle = outer;
  roundedRect(ctx, 24, 24, TABLE_W - 48, TABLE_H - 48, 30);
  ctx.fill();

  const rail = ctx.createLinearGradient(0, RAIL - 18, 0, RAIL + 46);
  rail.addColorStop(0, "#3d1b09");
  rail.addColorStop(0.5, "#9b5827");
  rail.addColorStop(1, "#321406");
  ctx.fillStyle = rail;
  ctx.fillRect(RAIL + 22, 28, TABLE_W / 2 - 78, 54);
  ctx.fillRect(TABLE_W / 2 + 36, 28, TABLE_W / 2 - 100, 54);
  ctx.fillRect(RAIL + 22, TABLE_H - 82, TABLE_W / 2 - 78, 54);
  ctx.fillRect(TABLE_W / 2 + 36, TABLE_H - 82, TABLE_W / 2 - 100, 54);
  ctx.fillRect(28, RAIL + 22, 54, TABLE_H - RAIL * 2 - 44);
  ctx.fillRect(TABLE_W - 82, RAIL + 22, 54, TABLE_H - RAIL * 2 - 44);

  const felt = ctx.createRadialGradient(
    TABLE_W / 2,
    TABLE_H / 2,
    60,
    TABLE_W / 2,
    TABLE_H / 2,
    TABLE_W * 0.58,
  );
  felt.addColorStop(0, "#12b95d");
  felt.addColorStop(0.62, "#008b45");
  felt.addColorStop(1, "#005d34");
  ctx.fillStyle = felt;
  roundedRect(ctx, RAIL, RAIL, TABLE_W - RAIL * 2, TABLE_H - RAIL * 2, 10);
  ctx.fill();

  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.beginPath();
  ctx.moveTo(RAIL, RAIL);
  ctx.lineTo(RAIL + 26, RAIL + 26);
  ctx.lineTo(RAIL + 26, TABLE_H - RAIL - 26);
  ctx.lineTo(RAIL, TABLE_H - RAIL);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(TABLE_W - RAIL, RAIL);
  ctx.lineTo(TABLE_W - RAIL - 26, RAIL + 26);
  ctx.lineTo(TABLE_W - RAIL - 26, TABLE_H - RAIL - 26);
  ctx.lineTo(TABLE_W - RAIL, TABLE_H - RAIL);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,.22)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(TABLE_W * 0.31, RAIL + 2);
  ctx.lineTo(TABLE_W * 0.31, TABLE_H - RAIL - 2);
  ctx.stroke();

  ctx.fillStyle = "#f7f7f2";
  const diamonds = [155, 265, 375, 525, 635, 745];
  for (const x of diamonds) {
    ctx.save();
    ctx.translate(x, 56);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
    ctx.save();
    ctx.translate(x, TABLE_H - 56);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
  }
  for (const y of [170, 250, 330]) {
    ctx.save();
    ctx.translate(56, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
    ctx.save();
    ctx.translate(TABLE_W - 56, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
  }

  for (const [px, py] of POCKETS) {
    const pocket = ctx.createRadialGradient(
      px - 7,
      py - 7,
      3,
      px,
      py,
      POCKET_R,
    );
    pocket.addColorStop(0, "#2b2b2b");
    pocket.addColorStop(1, "#000");
    ctx.fillStyle = pocket;
    ctx.beginPath();
    ctx.arc(px, py, POCKET_R, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawAimGuide(
  ctx: CanvasRenderingContext2D,
  cue: Ball,
  aim: number,
  pull: number,
  locked = false,
) {
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  ctx.save();
  // Locked angle → green aim line so the player can see the angle is pinned.
  ctx.strokeStyle = locked ? "rgba(74,222,128,.85)" : "rgba(255,255,255,.44)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cue.x + dx * BALL_R, cue.y + dy * BALL_R);
  ctx.lineTo(cue.x + dx * 340, cue.y + dy * 340);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,.28)";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(cue.x + dx * 24, cue.y + dy * 24);
  ctx.lineTo(cue.x + dx * 64, cue.y + dy * 64);
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cue.x + dx * 78, cue.y + dy * 78, 14, 0, Math.PI * 2);
  ctx.stroke();

  const cueGrad = ctx.createLinearGradient(
    cue.x - dx * (165 + pull),
    cue.y - dy * (165 + pull),
    cue.x - dx * 18,
    cue.y - dy * 18,
  );
  cueGrad.addColorStop(0, "#540000");
  cueGrad.addColorStop(0.42, "#d7a348");
  cueGrad.addColorStop(0.86, "#ffe283");
  cueGrad.addColorStop(1, "#f9fafb");
  ctx.strokeStyle = cueGrad;
  ctx.lineCap = "round";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(cue.x - dx * (170 + pull), cue.y - dy * (170 + pull));
  ctx.lineTo(cue.x - dx * 16, cue.y - dy * 16);
  ctx.stroke();
  ctx.restore();
}

// ── Bank shot preview: show aim line bouncing off rails ──
interface BankSegment { fromX: number; fromY: number; toX: number; toY: number }

function traceBanks(
  startX: number,
  startY: number,
  dirX: number,
  dirY: number,
  maxBounces: number,
): BankSegment[] {
  const segments: BankSegment[] = [];
  let sx = startX;
  let sy = startY;
  let dx = dirX;
  let dy = dirY;
  const maxDist = 600;

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    // Find nearest rail intersection
    let t = maxDist;

    if (dx > 0.0001) t = Math.min(t, (TABLE_W - RAIL - BALL_R - sx) / dx);
    else if (dx < -0.0001) t = Math.min(t, (RAIL + BALL_R - sx) / dx);

    if (dy > 0.0001) t = Math.min(t, (TABLE_H - RAIL - BALL_R - sy) / dy);
    else if (dy < -0.0001) t = Math.min(t, (RAIL + BALL_R - sy) / dy);

    if (t <= 0 || t > maxDist) break;

    const ex = sx + dx * t;
    const ey = sy + dy * t;
    segments.push({ fromX: sx, fromY: sy, toX: ex, toY: ey });

    // Reflect off the rail
    const margin = 1;
    if (Math.abs(ex - (RAIL + BALL_R)) < margin || Math.abs(ex - (TABLE_W - RAIL - BALL_R)) < margin) {
      dx = -dx;
    }
    if (Math.abs(ey - (RAIL + BALL_R)) < margin || Math.abs(ey - (TABLE_H - RAIL - BALL_R)) < margin) {
      dy = -dy;
    }

    sx = ex;
    sy = ey;
  }

  return segments;
}

export function drawBankPreview(
  ctx: CanvasRenderingContext2D,
  cue: Ball,
  aim: number,
  balls: Ball[],
  isMyAim: boolean,
) {
  // Skip bank preview if the aim line hits an object ball first
  if (findGhostBall(cue, aim, balls)) return;

  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  const segments = traceBanks(cue.x + dx * BALL_R, cue.y + dy * BALL_R, dx, dy, 2);
  if (segments.length <= 1) return; // only show if there's at least one bounce

  ctx.save();
  ctx.globalAlpha = isMyAim ? 0.2 : 0.12;
  ctx.strokeStyle = "#a78bfa";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.lineCap = "round";

  for (const seg of segments) {
    ctx.beginPath();
    ctx.moveTo(seg.fromX, seg.fromY);
    ctx.lineTo(seg.toX, seg.toY);
    ctx.stroke();
  }

  // Small bounce indicators at rail contact points
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(167,139,250,0.45)";
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i - 1];
    ctx.beginPath();
    ctx.arc(seg.toX, seg.toY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/** Cast a ray from the cue ball in aim direction; find the first object ball hit.
 *  Returns { ghostX, ghostY, objBall } or null if nothing is in the path. */
export function findGhostBall(
  cue: Ball,
  aim: number,
  balls: Ball[],
): { ghostX: number; ghostY: number; objBall: Ball } | null {
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);

  let best: { ghostX: number; ghostY: number; objBall: Ball; dist: number } | null = null;

  for (const b of balls) {
    if (b.number === 0 || b.pocketed || b.animatingPocket) continue;
    // Vector from cue to object ball
    const ox = b.x - cue.x;
    const oy = b.y - cue.y;
    // Project onto aim direction
    const t = ox * dx + oy * dy;
    if (t <= 0) continue; // behind the cue ball
    // Closest point on the ray to the object ball center
    const cx = cue.x + dx * t;
    const cy = cue.y + dy * t;
    const d = Math.hypot(b.x - cx, b.y - cy);
    if (d > BALL_R * 2) continue; // aim line misses the ball
    // Ghost ball centre = contact point backed up by 2*BALL_R along aim
    const offset = Math.sqrt((BALL_R * 2) ** 2 - d * d);
    const ghostX = cx - dx * offset;
    const ghostY = cy - dy * offset;
    const dist = t - offset;
    if (dist <= 0) continue;
    if (!best || dist < best.dist) {
      best = { ghostX, ghostY, objBall: b, dist };
    }
  }

  return best ? { ghostX: best.ghostX, ghostY: best.ghostY, objBall: best.objBall } : null;
}

/** Draw ghost ball + predicted object-ball and cue-ball trajectories. */
export function drawShotPreview(
  ctx: CanvasRenderingContext2D,
  cue: Ball,
  aim: number,
  balls: Ball[],
) {
  const hit = findGhostBall(cue, aim, balls);
  if (!hit) return;

  const { ghostX, ghostY, objBall } = hit;
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);

  ctx.save();

  // ── Ghost cue ball ──
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#f5f5f5";
  ctx.beginPath();
  ctx.arc(ghostX, ghostY, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Object ball trajectory ──
  const objAngle = Math.atan2(objBall.y - ghostY, objBall.x - ghostX);
  const objDx = Math.cos(objAngle);
  const objDy = Math.sin(objAngle);

  // Clamp trajectory length so it stays within the table
  const maxDist = Math.min(
    300,
    objDx > 0 ? (TABLE_W - RAIL - objBall.x) / objDx : (objBall.x - RAIL) / -objDx,
    objDy > 0 ? (TABLE_H - RAIL - objBall.y) / objDy : (objBall.y - RAIL) / -objDy,
  );
  const trajLen = Math.max(20, maxDist);

  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = objBall.color;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(objBall.x, objBall.y);
  ctx.lineTo(objBall.x + objDx * trajLen, objBall.y + objDy * trajLen);
  ctx.stroke();

  // small arrowhead
  const tipX = objBall.x + objDx * Math.max(10, trajLen - 10);
  const tipY = objBall.y + objDy * Math.max(10, trajLen - 10);
  ctx.fillStyle = objBall.color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - objDx * 10 + objDy * 6, tipY - objDy * 10 - objDx * 6);
  ctx.lineTo(tipX - objDx * 10 - objDy * 6, tipY - objDy * 10 + objDx * 6);
  ctx.closePath();
  ctx.fill();

  // ── Cue ball post-contact trajectory (tangent / 90° from object path) ──
  const cueDx = -objDy;
  const cueDy = objDx;
  ctx.strokeStyle = "#f5f5f5";
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.moveTo(ghostX, ghostY);
  ctx.lineTo(ghostX + cueDx * 160, ghostY + cueDy * 160);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ghostX, ghostY);
  ctx.lineTo(ghostX - cueDx * 160, ghostY - cueDy * 160);
  ctx.stroke();

  ctx.restore();
}

export function drawBalls(ctx: CanvasRenderingContext2D, balls: Ball[]) {
  for (const b of balls) {
    if (b.pocketed) continue;
    ctx.save();
    ctx.globalAlpha = b.opacity ?? 1;
    const s = b.scale ?? 1;

    // ── Drop shadow on the felt ──
    if (!b.animatingPocket) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(b.x + 3, b.y + 4, BALL_R * 0.85, BALL_R * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.translate(b.x, b.y);
    ctx.scale(s, s);
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;

    ctx.fillStyle = b.striped ? "#f8fafc" : b.color;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    if (b.striped) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, BALL_R - 0.4, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = b.color;
      ctx.fillRect(-BALL_R, -BALL_R * 0.44, BALL_R * 2, BALL_R * 0.88);
      ctx.restore();
    }

    const gloss = ctx.createRadialGradient(-5, -6, 1, -2, -3, BALL_R * 1.35);
    gloss.addColorStop(0, "rgba(255,255,255,.96)");
    gloss.addColorStop(0.22, "rgba(255,255,255,.30)");
    gloss.addColorStop(0.68, "rgba(0,0,0,0)");
    gloss.addColorStop(1, "rgba(0,0,0,.35)");
    ctx.fillStyle = gloss;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    if (b.number) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(0, 0, BALL_R * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111827";
      ctx.font = "bold 8px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(b.number), 0, 0.5);
    }

    // ── Spin indicator on cue ball ──
    if (b.number === 0 && (b.spinX || b.spinY)) {
      const sx = (b.spinX ?? 0) * BALL_R * 0.55;
      const sy = (b.spinY ?? 0) * BALL_R * 0.55;
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    ctx.restore();
  }
}

/**
 * Aim-guide pot line — the object ball's path to the best pocket, drawn from
 * the same readout `analyzeShot` produces. A null pot (nothing is lined up)
 * and a pot whose ball has left the table both draw nothing.
 */
export function drawPotPreview(
  ctx: CanvasRenderingContext2D,
  balls: Ball[],
  pot: { ball: number; pocket: number; chance: number; blocked: boolean } | null,
) {
  if (!pot) return;

  // The ball may have been pocketed since the readout was taken.
  const ball = balls.find((b) => b.number === pot.ball && !b.pocketed);
  const pocket = POCKETS[pot.pocket];
  if (!ball || !pocket) return;

  const [px, py] = pocket;

  ctx.save();
  // A blocked line stays faint; an open one reads as strongly as its chance.
  ctx.globalAlpha = pot.blocked ? 0.18 : 0.3 + pot.chance * 0.45;
  ctx.strokeStyle = ball.color;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(ball.x, ball.y);
  ctx.lineTo(px, py);
  ctx.stroke();

  // Ring the pocket the line runs into, so the target reads at a glance.
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(px, py, POCKET_R * 0.8, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}
