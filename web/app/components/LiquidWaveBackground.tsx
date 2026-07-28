"use client";

import { useEffect, useRef } from "react";

type LiquidWaveBackgroundProps = {
  theme: "dark" | "light";
};

type Particle = {
  x: number;
  lane: number;
  size: number;
  speed: number;
  phase: number;
  alpha: number;
};

export default function LiquidWaveBackground({ theme }: LiquidWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = { x: 0.68, y: 0.48, targetX: 0.68, targetY: 0.48 };
    const particles: Particle[] = Array.from({ length: 76 }, (_, index) => ({
      x: ((index * 0.61803398875) % 1),
      lane: ((index * 0.38196601125) % 1),
      size: 0.45 + (index % 5) * 0.28,
      speed: 0.035 + (index % 9) * 0.006,
      phase: index * 1.79,
      alpha: 0.16 + (index % 7) * 0.045,
    }));

    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let animationFrame = 0;
    let lastTime = 0;

    const resize = () => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.targetX = Math.min(1, Math.max(0, event.clientX / width));
      pointer.targetY = Math.min(1, Math.max(0, event.clientY / height));
      if (reducedMotion.matches) draw(performance.now());
    };

    const onPointerLeave = () => {
      pointer.targetX = 0.68;
      pointer.targetY = 0.48;
    };

    const addRadialGlow = (
      x: number,
      y: number,
      radius: number,
      inner: string,
      outer = "rgba(0,0,0,0)",
    ) => {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, inner);
      gradient.addColorStop(1, outer);
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };

    function draw(now: number) {
      const time = now * 0.00032;
      const delta = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0;
      lastTime = now;

      pointer.x += (pointer.targetX - pointer.x) * 0.045;
      pointer.y += (pointer.targetY - pointer.y) * 0.045;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const background = context.createLinearGradient(0, 0, width, height);
      if (theme === "dark") {
        background.addColorStop(0, "#020305");
        background.addColorStop(0.48, "#06070b");
        background.addColorStop(1, "#02030a");
      } else {
        background.addColorStop(0, "#f7f9fd");
        background.addColorStop(0.5, "#edf2fa");
        background.addColorStop(1, "#f7f4fb");
      }
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);

      if (theme === "dark") {
        addRadialGlow(width * 0.04, height * 0.92, width * 0.54, "rgba(12, 72, 160, .18)");
        addRadialGlow(width * 0.94, height * 0.13, width * 0.42, "rgba(73, 33, 142, .16)");
        addRadialGlow(pointer.x * width, pointer.y * height, width * 0.26, "rgba(79, 134, 255, .07)");
      } else {
        addRadialGlow(width * 0.02, height * 0.9, width * 0.5, "rgba(44, 112, 210, .12)");
        addRadialGlow(width * 0.96, height * 0.1, width * 0.4, "rgba(111, 74, 185, .11)");
        addRadialGlow(pointer.x * width, pointer.y * height, width * 0.24, "rgba(255, 255, 255, .44)");
      }

      context.save();
      context.globalCompositeOperation = theme === "dark" ? "screen" : "multiply";
      const waveTop = height * 0.42;
      const bandGap = Math.max(9, height * 0.016);
      const pointerRadius = Math.max(180, width * 0.2);

      for (let band = 0; band < 34; band += 1) {
        const lineGradient = context.createLinearGradient(0, 0, width, 0);
        if (theme === "dark") {
          lineGradient.addColorStop(0, "rgba(32, 112, 225, 0)");
          lineGradient.addColorStop(0.15, `rgba(48, 128, 238, ${0.12 + (band % 6) * 0.012})`);
          lineGradient.addColorStop(0.55, `rgba(225, 235, 255, ${0.11 + (band % 5) * 0.015})`);
          lineGradient.addColorStop(0.86, `rgba(118, 73, 210, ${0.1 + (band % 4) * 0.014})`);
          lineGradient.addColorStop(1, "rgba(74, 41, 174, 0)");
        } else {
          lineGradient.addColorStop(0, "rgba(46, 112, 192, 0)");
          lineGradient.addColorStop(0.16, `rgba(39, 103, 190, ${0.12 + (band % 5) * 0.014})`);
          lineGradient.addColorStop(0.57, `rgba(79, 100, 145, ${0.09 + (band % 4) * 0.012})`);
          lineGradient.addColorStop(0.86, `rgba(113, 76, 171, ${0.1 + (band % 4) * 0.013})`);
          lineGradient.addColorStop(1, "rgba(106, 65, 177, 0)");
        }

        context.beginPath();
        context.strokeStyle = lineGradient;
        context.lineWidth = band % 7 === 0 ? 1.15 : 0.48;
        context.shadowColor = theme === "dark" ? "rgba(105, 156, 255, .24)" : "rgba(68, 105, 164, .12)";
        context.shadowBlur = band % 7 === 0 ? 12 : 3;

        for (let x = -12; x <= width + 12; x += 9) {
          const distanceFromPointer = x - pointer.x * width;
          const pointerFalloff = Math.exp(-(distanceFromPointer * distanceFromPointer) / (pointerRadius * pointerRadius));
          const base = waveTop + band * bandGap;
          const primary = Math.sin(x * 0.006 + time * (1.25 + band * 0.008) + band * 0.29) * (17 + band * 0.42);
          const secondary = Math.sin(x * 0.0021 - time * 0.72 + band * 0.53) * (11 + band * 0.24);
          const direction = (pointer.x - 0.5) * (x / width - 0.5) * 55;
          const lift = (pointer.y - 0.5) * -110 * pointerFalloff;
          const ripple = Math.sin(distanceFromPointer * 0.014 - time * 3.2) * 15 * pointerFalloff;
          const y = base + primary + secondary + direction + lift + ripple;

          if (x === -12) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }

      for (const particle of particles) {
        if (!reducedMotion.matches) particle.x = (particle.x + particle.speed * delta) % 1;
        const x = particle.x * (width + 80) - 40;
        const baseY = height * (0.45 + particle.lane * 0.49);
        const y = baseY
          + Math.sin(x * 0.0052 + time * 1.4 + particle.phase) * (13 + particle.lane * 25)
          + (pointer.x - 0.5) * (particle.lane - 0.5) * 34;
        const pointerDistance = Math.hypot(x - pointer.x * width, y - pointer.y * height);
        const pointerBoost = Math.max(0, 1 - pointerDistance / 210);

        context.beginPath();
        context.fillStyle = theme === "dark"
          ? `rgba(${130 + Math.round(pointerBoost * 80)}, ${170 + Math.round(pointerBoost * 55)}, 255, ${particle.alpha + pointerBoost * 0.38})`
          : `rgba(50, 92, 160, ${particle.alpha * 0.7 + pointerBoost * 0.22})`;
        context.arc(x, y, particle.size + pointerBoost * 1.2, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      const vignette = context.createRadialGradient(
        width * 0.5,
        height * 0.47,
        Math.min(width, height) * 0.14,
        width * 0.5,
        height * 0.47,
        Math.max(width, height) * 0.78,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, theme === "dark" ? "rgba(0,0,0,.48)" : "rgba(62,76,105,.06)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);

      if (!reducedMotion.matches) animationFrame = window.requestAnimationFrame(draw);
    }

    const onMotionChange = () => {
      window.cancelAnimationFrame(animationFrame);
      lastTime = 0;
      draw(performance.now());
    };

    resize();
    draw(performance.now());
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    reducedMotion.addEventListener("change", onMotionChange);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      reducedMotion.removeEventListener("change", onMotionChange);
    };
  }, [theme]);

  return <canvas ref={canvasRef} className="liquid-wave-background" aria-hidden="true" />;
}
