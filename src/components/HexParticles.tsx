"use client";

import React, { useEffect, useRef } from "react";

// ── Types ───────────────────────────────────────────────────────────────

interface Particle {
  x: number;       // 0-100 %
  y: number;       // 0-100 %
  vx: number;      // velocity
  vy: number;
  size: number;    // px
  opacity: number; // 0-1
  life: number;    // ms remaining
  maxLife: number;
  color: string;   // CSS color
  glow: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 28;
const COLORS = [
  "rgba(34,211,238,__OPACITY__)",   // cyan
  "rgba(168,85,247,__OPACITY__)",    // purple
  "rgba(96,165,250,__OPACITY__)",    // blue
  "rgba(250,204,21,__OPACITY__)",    // yellow
  "rgba(192,132,252,__OPACITY__)",   // violet
];

// ── Component ────────────────────────────────────────────────────────────

interface HexParticlesProps {
  /** Whether the board is in victory mode (more particles, brighter) */
  victory?: boolean;
  /** Whether the board is in game-over state */
  gameOver?: boolean;
  /** Color to tint particles toward (hex color) */
  accentColor?: string;
}

export default function HexParticles({ victory, gameOver, accentColor }: HexParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap at 2x for perf
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    // Initialize particles
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const count = victory ? PARTICLE_COUNT * 2 : gameOver ? PARTICLE_COUNT : PARTICLE_COUNT;

    particlesRef.current = Array.from({ length: count }, () => createParticle(w, h, victory));

    function createParticle(w: number, h: number, victoryMode?: boolean): Particle {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * (victoryMode ? 1.2 : 0.6),
        vy: (Math.random() - 0.5) * (victoryMode ? 1.2 : 0.6),
        size: Math.random() * (victoryMode ? 3.5 : 2.5) + 1,
        opacity: Math.random() * 0.5 + 0.15,
        life: Math.random() * 4000 + 1000,
        maxLife: 5000,
        color,
        glow: Math.random() < 0.3,
      };
    }

    // Animation loop
    let lastTime = performance.now();

    function animate(now: number) {
      const dt = Math.min(now - lastTime, 33); // cap at ~30fps equivalent
      lastTime = now;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        // Update position
        p.x += p.vx * (dt / 16); // normalize to ~60fps
        p.y += p.vy * (dt / 16);
        p.life -= dt;

        // Wrap around edges
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;

        // Replace dead particles
        if (p.life <= 0) {
          particles[i] = createParticle(w, h, victory);
          continue;
        }

        // Fade out near end of life
        const lifeRatio = p.life / p.maxLife;
        const fade = lifeRatio < 0.2 ? lifeRatio / 0.2 : 1;
        const alpha = p.opacity * fade;

        // Draw
        const colorWithAlpha = p.color.replace("__OPACITY__", String(alpha));

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = colorWithAlpha;
        ctx.fill();

        // Glow ring
        if (p.glow) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = colorWithAlpha.replace(String(alpha), String(alpha * 0.15));
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(animate);
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [victory, gameOver, accentColor]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-10"
      aria-hidden="true"
    />
  );
}
