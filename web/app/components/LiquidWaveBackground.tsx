"use client";

import { useEffect, useRef } from "react";

type LiquidWaveBackgroundProps = {
  theme: "dark" | "light";
  animated: boolean;
};

type Point = {
  x: number;
  y: number;
};

type Ribbon = {
  points: [Point, Point, Point, Point];
  lines: number;
  spacing: number;
  phase: number;
  strength: number;
};

type Particle = {
  progress: number;
  offset: number;
  size: number;
  speed: number;
  phase: number;
};

function cubicBezier(points: Ribbon["points"], progress: number) {
  const inverse = 1 - progress;
  const inverseSquared = inverse * inverse;
  const progressSquared = progress * progress;
  return {
    x: inverseSquared * inverse * points[0].x
      + 3 * inverseSquared * progress * points[1].x
      + 3 * inverse * progressSquared * points[2].x
      + progressSquared * progress * points[3].x,
    y: inverseSquared * inverse * points[0].y
      + 3 * inverseSquared * progress * points[1].y
      + 3 * inverse * progressSquared * points[2].y
      + progressSquared * progress * points[3].y,
  };
}

function cubicTangent(points: Ribbon["points"], progress: number) {
  const inverse = 1 - progress;
  return {
    x: 3 * inverse * inverse * (points[1].x - points[0].x)
      + 6 * inverse * progress * (points[2].x - points[1].x)
      + 3 * progress * progress * (points[3].x - points[2].x),
    y: 3 * inverse * inverse * (points[1].y - points[0].y)
      + 6 * inverse * progress * (points[2].y - points[1].y)
      + 3 * progress * progress * (points[3].y - points[2].y),
  };
}

export default function LiquidWaveBackground({ theme, animated }: LiquidWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = { x: 0.64, y: 0.62, targetX: 0.64, targetY: 0.62 };
    const particles: Particle[] = Array.from({ length: 42 }, (_, index) => ({
      progress: (index * 0.61803398875) % 1,
      offset: ((index % 13) - 6) * 3.1,
      size: 0.45 + (index % 4) * 0.24,
      speed: 0.018 + (index % 7) * 0.003,
      phase: index * 1.41,
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
    };

    const onPointerLeave = () => {
      pointer.targetX = 0.64;
      pointer.targetY = 0.62;
    };

    const addRadialGlow = (x: number, y: number, radius: number, inner: string) => {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, inner);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };

    const ribbons = (): Ribbon[] => {
      const scaleY = Math.max(0.72, Math.min(1.08, height / Math.max(width * 0.75, 1)));
      return [
        {
          points: [
            { x: -0.13 * width, y: 1.06 * height },
            { x: 0.22 * width, y: (0.73 + 0.03 * scaleY) * height },
            { x: 0.60 * width, y: 0.62 * height },
            { x: 1.12 * width, y: 0.42 * height },
          ],
          lines: 54,
          spacing: Math.max(3.2, height * 0.0052),
          phase: 0,
          strength: 1,
        },
        {
          points: [
            { x: -0.11 * width, y: 0.43 * height },
            { x: 0.25 * width, y: 0.43 * height },
            { x: 0.61 * width, y: 0.69 * height },
            { x: 1.13 * width, y: 0.88 * height },
          ],
          lines: 42,
          spacing: Math.max(3, height * 0.0047),
          phase: 2.2,
          strength: 0.76,
        },
        {
          points: [
            { x: 0.05 * width, y: 1.1 * height },
            { x: 0.34 * width, y: 0.74 * height },
            { x: 0.62 * width, y: 0.63 * height },
            { x: 1.1 * width, y: 0.56 * height },
          ],
          lines: 28,
          spacing: Math.max(3.4, height * 0.0054),
          phase: 4.1,
          strength: 0.62,
        },
      ];
    };

    function draw(now: number) {
      const time = now * 0.00024;
      const delta = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0;
      lastTime = now;

      pointer.x += (pointer.targetX - pointer.x) * 0.04;
      pointer.y += (pointer.targetY - pointer.y) * 0.04;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const background = context.createLinearGradient(0, 0, width, height);
      if (theme === "dark") {
        background.addColorStop(0, "#010203");
        background.addColorStop(0.52, "#030405");
        background.addColorStop(1, "#010207");
      } else {
        background.addColorStop(0, "#f9fbff");
        background.addColorStop(0.54, "#eef3fa");
        background.addColorStop(1, "#f4f6fb");
      }
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);

      if (theme === "dark") {
        addRadialGlow(width * 0.08, height * 0.94, width * 0.46, "rgba(26, 93, 183, .15)");
        addRadialGlow(width * 0.78, height * 0.7, width * 0.36, "rgba(116, 145, 198, .055)");
        if (animated) addRadialGlow(pointer.x * width, pointer.y * height, width * 0.22, "rgba(121, 164, 240, .045)");
      } else {
        addRadialGlow(width * 0.08, height * 0.94, width * 0.46, "rgba(66, 124, 201, .11)");
        addRadialGlow(width * 0.78, height * 0.7, width * 0.36, "rgba(94, 119, 159, .07)");
      }

      context.save();
      context.globalCompositeOperation = theme === "dark" ? "screen" : "multiply";
      const ribbonSet = ribbons();

      for (const ribbon of ribbonSet) {
        const centerGradient = context.createLinearGradient(0, height, width, height * 0.42);
        if (theme === "dark") {
          centerGradient.addColorStop(0, "rgba(40, 100, 190, 0)");
          centerGradient.addColorStop(0.32, `rgba(91, 143, 222, ${0.028 * ribbon.strength})`);
          centerGradient.addColorStop(0.64, `rgba(232, 239, 249, ${0.09 * ribbon.strength})`);
          centerGradient.addColorStop(0.9, `rgba(129, 154, 196, ${0.026 * ribbon.strength})`);
          centerGradient.addColorStop(1, "rgba(75, 98, 141, 0)");
        } else {
          centerGradient.addColorStop(0, "rgba(57, 105, 176, 0)");
          centerGradient.addColorStop(0.32, `rgba(57, 105, 176, ${0.035 * ribbon.strength})`);
          centerGradient.addColorStop(0.64, `rgba(81, 98, 127, ${0.07 * ribbon.strength})`);
          centerGradient.addColorStop(1, "rgba(75, 91, 119, 0)");
        }

        context.beginPath();
        for (let step = 0; step <= 120; step += 1) {
          const progress = step / 120;
          const point = cubicBezier(ribbon.points, progress);
          if (step === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        }
        context.strokeStyle = centerGradient;
        context.lineWidth = Math.max(34, height * 0.075);
        context.shadowColor = theme === "dark" ? "rgba(149, 183, 235, .11)" : "rgba(70, 98, 143, .08)";
        context.shadowBlur = Math.max(18, height * 0.038);
        context.stroke();

        for (let line = 0; line < ribbon.lines; line += 1) {
          const centeredLine = line - (ribbon.lines - 1) / 2;
          const lineGradient = context.createLinearGradient(0, height, width, height * 0.4);
          const lineAlpha = (0.10 + (line % 7) * 0.014) * ribbon.strength;
          if (theme === "dark") {
            lineGradient.addColorStop(0, "rgba(37, 102, 197, 0)");
            lineGradient.addColorStop(0.2, `rgba(48, 111, 209, ${lineAlpha * 0.66})`);
            lineGradient.addColorStop(0.55, `rgba(198, 214, 239, ${lineAlpha})`);
            lineGradient.addColorStop(0.72, `rgba(235, 240, 247, ${lineAlpha * 1.22})`);
            lineGradient.addColorStop(0.92, `rgba(113, 137, 181, ${lineAlpha * 0.58})`);
            lineGradient.addColorStop(1, "rgba(86, 105, 146, 0)");
          } else {
            lineGradient.addColorStop(0, "rgba(54, 102, 174, 0)");
            lineGradient.addColorStop(0.2, `rgba(54, 102, 174, ${lineAlpha * 0.72})`);
            lineGradient.addColorStop(0.6, `rgba(72, 92, 126, ${lineAlpha * 0.82})`);
            lineGradient.addColorStop(0.82, `rgba(93, 106, 132, ${lineAlpha * 0.58})`);
            lineGradient.addColorStop(1, "rgba(93, 106, 132, 0)");
          }

          context.beginPath();
          context.strokeStyle = lineGradient;
          context.lineWidth = line % 9 === 0 ? 1.15 : 0.48;
          context.shadowColor = theme === "dark" ? "rgba(179, 205, 244, .18)" : "rgba(61, 88, 132, .08)";
          context.shadowBlur = line % 9 === 0 ? 9 : 2;

          for (let step = 0; step <= 150; step += 1) {
            const progress = step / 150;
            const point = cubicBezier(ribbon.points, progress);
            const tangent = cubicTangent(ribbon.points, progress);
            const tangentLength = Math.max(1, Math.hypot(tangent.x, tangent.y));
            const normalX = -tangent.y / tangentLength;
            const normalY = tangent.x / tangentLength;
            const pinch = 0.16 + Math.pow(Math.abs(progress - 0.61), 1.15) * 1.9;
            const movement = Math.sin(progress * 13 + ribbon.phase + centeredLine * 0.17 + time * 1.1)
              * (1.2 + Math.abs(centeredLine) * 0.025);
            const pointerDistance = Math.hypot(point.x - pointer.x * width, point.y - pointer.y * height);
            const pointerFalloff = animated ? Math.max(0, 1 - pointerDistance / Math.max(190, width * 0.18)) : 0;
            const pointerLift = (pointer.y - 0.5) * -24 * pointerFalloff;
            const offset = centeredLine * ribbon.spacing * pinch + movement;
            const x = point.x + normalX * offset;
            const y = point.y + normalY * offset + pointerLift;
            if (step === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
          context.stroke();
        }
      }

      if (animated && !reducedMotion.matches) {
        const particleRibbon = ribbonSet[0];
        for (const particle of particles) {
          particle.progress = (particle.progress + particle.speed * delta) % 1;
          const point = cubicBezier(particleRibbon.points, particle.progress);
          const tangent = cubicTangent(particleRibbon.points, particle.progress);
          const tangentLength = Math.max(1, Math.hypot(tangent.x, tangent.y));
          const normalX = -tangent.y / tangentLength;
          const normalY = tangent.x / tangentLength;
          const shimmer = Math.sin(time * 3 + particle.phase) * 2.4;
          const x = point.x + normalX * (particle.offset + shimmer);
          const y = point.y + normalY * (particle.offset + shimmer);
          context.beginPath();
          context.fillStyle = theme === "dark" ? "rgba(185, 211, 250, .34)" : "rgba(62, 94, 145, .2)";
          context.arc(x, y, particle.size, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.restore();

      if (animated && !reducedMotion.matches) animationFrame = window.requestAnimationFrame(draw);
    }

    const onResize = () => {
      resize();
      if (!animated || reducedMotion.matches) {
        lastTime = 0;
        draw(animated ? performance.now() : 0);
      }
    };

    const onMotionChange = () => {
      window.cancelAnimationFrame(animationFrame);
      lastTime = 0;
      draw(animated ? performance.now() : 0);
    };

    resize();
    draw(animated ? performance.now() : 0);
    window.addEventListener("resize", onResize);
    if (animated) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
    }
    reducedMotion.addEventListener("change", onMotionChange);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      reducedMotion.removeEventListener("change", onMotionChange);
    };
  }, [animated, theme]);

  return (
    <canvas
      ref={canvasRef}
      className="liquid-wave-background"
      data-animated={animated ? "true" : "false"}
      aria-hidden="true"
    />
  );
}
