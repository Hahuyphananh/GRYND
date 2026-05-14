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
) {
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.44)";
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

export function drawBalls(ctx: CanvasRenderingContext2D, balls: Ball[]) {
  for (const b of balls) {
    if (b.pocketed) continue;
    ctx.save();
    ctx.globalAlpha = b.opacity ?? 1;
    const s = b.scale ?? 1;
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
    ctx.restore();
  }
}
