import { BALL_R, POCKET_R, RAIL, TABLE_H, TABLE_W } from "./constants";
import { Ball } from "./types";

export function drawTable(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, TABLE_W, TABLE_H);
  const grad = ctx.createLinearGradient(0, 0, 0, TABLE_H);
  grad.addColorStop(0, "#0bc089"); grad.addColorStop(1, "#03523f");
  ctx.fillStyle = grad; ctx.fillRect(RAIL, RAIL, TABLE_W - RAIL * 2, TABLE_H - RAIL * 2);
  ctx.strokeStyle = "#5f2d90"; ctx.shadowColor = "#06b6d4"; ctx.shadowBlur = 12;
  ctx.lineWidth = 30; ctx.strokeRect(RAIL - 14, RAIL - 14, TABLE_W - (RAIL - 14) * 2, TABLE_H - (RAIL - 14) * 2);
  ctx.shadowBlur = 0;
  [[34,34],[TABLE_W/2,28],[TABLE_W-34,34],[34,TABLE_H-34],[TABLE_W/2,TABLE_H-28],[TABLE_W-34,TABLE_H-34]].forEach(([px,py])=>{ctx.fillStyle="#020202";ctx.beginPath();ctx.arc(px,py,POCKET_R,0,Math.PI*2);ctx.fill();});
}

export function drawBalls(ctx: CanvasRenderingContext2D, balls: Ball[]) {
  for (const b of balls) {
    if (b.pocketed) continue;
    ctx.save();
    ctx.globalAlpha = b.opacity ?? 1;
    const s = b.scale ?? 1;
    ctx.translate(b.x, b.y);
    ctx.scale(s, s);
    const g = ctx.createRadialGradient(-4, -4, 1, 0, 0, BALL_R);
    g.addColorStop(0, "#ffffff"); g.addColorStop(0.24, b.color); g.addColorStop(1, "#090909");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, BALL_R, 0, Math.PI * 2); ctx.fill();
    if (b.striped) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.ellipse(0, 0, BALL_R * 0.95, BALL_R * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.ellipse(0, 0, BALL_R * 0.9, BALL_R * 0.26, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (b.number) { ctx.fillStyle = "#fff"; ctx.font = "bold 9px sans-serif"; ctx.fillText(String(b.number), -3, 3); }
    ctx.restore();
  }
}
