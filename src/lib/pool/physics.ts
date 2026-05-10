import { BALL_R, FRICTION, POCKET_R, POCKETS, RAIL, RAIL_DAMPING, STOP_EPSILON, TABLE_H, TABLE_W } from "./constants";
import { Ball, ShotMeta } from "./types";

export const isMoving = (balls: Ball[]) => balls.some((b) => !b.pocketed && (Math.abs(b.vx) + Math.abs(b.vy) > STOP_EPSILON));

export function applyShotPower(pull: number) {
  const t = Math.min(1, Math.max(0.08, pull / 110));
  return 2 + Math.pow(t, 1.45) * 12;
}

export function tickPhysics(balls: Ball[], shotMeta: ShotMeta) {
  for (const b of balls) {
    if (b.pocketed) continue;

    if (b.animatingPocket) {
      b.opacity = Math.max(0, (b.opacity ?? 1) - 0.12);
      b.scale = Math.max(0.2, (b.scale ?? 1) - 0.09);
      if ((b.opacity ?? 0) <= 0.02) b.pocketed = true;
      continue;
    }

    b.x += b.vx;
    b.y += b.vy;
    b.vx *= FRICTION;
    b.vy *= FRICTION;
    if (Math.hypot(b.vx, b.vy) < STOP_EPSILON) { b.vx = 0; b.vy = 0; }

    for (const [px, py] of POCKETS) {
      const dist = Math.hypot(b.x - px, b.y - py);
      if (b.number === 0 && dist < POCKET_R - 2) {
        b.pocketed = true;
        b.x = px;
        b.y = py;
        shotMeta.cueScratch = true;
      } else if (b.number !== 0 && dist < POCKET_R + BALL_R * 0.35) {
        b.animatingPocket = true;
        b.vx = 0; b.vy = 0;
        const nx = (b.x - px) / (dist || 1), ny = (b.y - py) / (dist || 1);
        b.x = px + nx * (POCKET_R - BALL_R * 0.5);
        b.y = py + ny * (POCKET_R - BALL_R * 0.5);
        shotMeta.pocketedNumbers.push(b.number);
      }
    }

    if (b.pocketed || b.animatingPocket) continue;

    if (b.x < RAIL + BALL_R || b.x > TABLE_W - RAIL - BALL_R) {
      b.x = Math.max(RAIL + BALL_R, Math.min(TABLE_W - RAIL - BALL_R, b.x));
      b.vx *= -RAIL_DAMPING;
      shotMeta.railAfterContact = true;
    }
    if (b.y < RAIL + BALL_R || b.y > TABLE_H - RAIL - BALL_R) {
      b.y = Math.max(RAIL + BALL_R, Math.min(TABLE_H - RAIL - BALL_R, b.y));
      b.vy *= -RAIL_DAMPING;
      shotMeta.railAfterContact = true;
    }
  }

  for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
    const a = balls[i], b = balls[j];
    if (a.pocketed || b.pocketed || a.animatingPocket || b.animatingPocket) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = BALL_R * 2;
    if (dist > 0 && dist < minDist) {
      const nx = dx / dist, ny = dy / dist;
      const overlap = minDist - dist + 0.01;
      a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const rel = rvx * nx + rvy * ny;
      if (rel < 0) {
        const impulse = -(1) * rel / 2;
        a.vx -= impulse * nx; a.vy -= impulse * ny;
        b.vx += impulse * nx; b.vy += impulse * ny;
      }
      if (shotMeta.firstContactNumber === null && (a.number === 0 || b.number === 0)) {
        shotMeta.firstContactNumber = a.number === 0 ? b.number : a.number;
      }
    }
  }
}
