"use client";

import { useEffect, useRef } from "react";

type LiquidWaveBackgroundProps = {
  theme: "dark" | "light";
  animated: boolean;
};

type WaveSeed = {
  phase: number;
  drift: number;
  alpha: number;
  width: number;
};

const TARGET_FRAME_INTERVAL = 1000 / 30;
const WAVE_COUNT = 27;
const GLOW_LINE_INDEXES = [6, 7, 8, 18, 19, 20];
const CORE_LINE_INDEXES = [12, 13, 14];

const WAVE_SEEDS: WaveSeed[] = Array.from({ length: WAVE_COUNT }, (_, index) => {
  const pseudoRandom = Math.sin((index + 1) * 91.731) * 43758.5453;
  const fraction = pseudoRandom - Math.floor(pseudoRandom);
  return {
    phase: index * 0.71 + fraction * Math.PI,
    drift: 0.74 + fraction * 0.54,
    alpha: 0.34 + fraction * 0.56,
    width: index % 9 === 0 ? 2.2 : index % 4 === 0 ? 1.45 : 0.9,
  };
});

function traceWave(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  index: number,
  time: number,
  animated: boolean,
) {
  const seed = WAVE_SEEDS[index];
  const group = index % 3;
  const lineInGroup = Math.floor(index / 3);
  const linesPerGroup = WAVE_COUNT / 3;
  const normalized = lineInGroup / (linesPerGroup - 1) * 2 - 1;
  const spread = Math.sign(normalized) * Math.pow(Math.abs(normalized), 0.82);
  const motion = animated ? Math.sin(time * 0.52 * seed.drift + seed.phase) : Math.sin(seed.phase) * 0.12;
  const counterMotion = animated ? Math.cos(time * 0.39 + seed.phase * 0.67) : 0;
  const groupMotion = animated ? Math.sin(time * 0.32 + group * 2.1) : 0;
  const leftCenters = [0.47, 0.75, 0.62];
  const leftSpreads = [0.13, 0.16, 0.07];
  const rightCenters = [0.58, 0.76, 0.67];
  const rightSpreads = [0.09, 0.14, 0.06];
  const pinchCenters = [0.69, 0.72, 0.705];
  const arches = [0.055, -0.07, 0.018];
  const pinchX = width * (0.665 + group * 0.008 + counterMotion * 0.012);
  const pinchY = height * (pinchCenters[group] + groupMotion * 0.016);
  const leftY = height * (leftCenters[group] + spread * leftSpreads[group])
    + motion * height * 0.018;
  const rightY = height * (rightCenters[group] + spread * rightSpreads[group])
    - motion * height * 0.016;
  const pinchOffset = spread * height * 0.017 + counterMotion * height * 0.006;
  const archMotion = animated ? Math.sin(time * 0.28 + group * 1.7) * height * 0.022 : 0;
  const arch = height * arches[group] + archMotion;
  const pinchPointY = pinchY + pinchOffset;
  const sharedHandle = width * 0.17;
  const tangentSlope = ((rightY - leftY) / (width * 1.16)) * 0.32
    + (arch / width) * 0.08
    + groupMotion * 0.01;
  const incomingControlY = pinchPointY - tangentSlope * sharedHandle;
  const outgoingControlY = pinchPointY + tangentSlope * sharedHandle;

  context.beginPath();
  context.moveTo(-width * 0.08, leftY);
  context.bezierCurveTo(
    width * 0.16,
    leftY + arch + motion * height * 0.012,
    pinchX - sharedHandle,
    incomingControlY,
    pinchX,
    pinchPointY,
  );
  context.bezierCurveTo(
    pinchX + sharedHandle,
    outgoingControlY,
    width * 0.96,
    rightY - arch * 0.62 - counterMotion * height * 0.012,
    width * 1.08,
    rightY,
  );
}

export default function LiquidWaveBackground({ theme, animated }: LiquidWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let animationFrame = 0;
    let resizeFrame = 0;
    let lastFrameTime = 0;
    let currentTime = 0;
    let backgroundPaint: CanvasGradient;
    let ambientPaint: CanvasGradient;
    let wavePaint: CanvasGradient;
    let glowPaint: CanvasGradient;
    let flowPaint: CanvasGradient;
    let vignettePaint: CanvasGradient;

    const createPaints = () => {
      backgroundPaint = context.createLinearGradient(0, 0, width, height);
      ambientPaint = context.createRadialGradient(
        width * 0.68,
        height * 0.72,
        0,
        width * 0.68,
        height * 0.72,
        Math.max(width, height) * 0.7,
      );
      wavePaint = context.createLinearGradient(0, height * 0.8, width, height * 0.56);
      glowPaint = context.createLinearGradient(0, height * 0.82, width, height * 0.54);
      flowPaint = context.createLinearGradient(0, height * 0.8, width, height * 0.58);
      vignettePaint = context.createRadialGradient(
        width * 0.63,
        height * 0.65,
        Math.min(width, height) * 0.1,
        width * 0.63,
        height * 0.65,
        Math.max(width, height) * 0.78,
      );

      if (theme === "dark") {
        backgroundPaint.addColorStop(0, "#000101");
        backgroundPaint.addColorStop(0.54, "#020407");
        backgroundPaint.addColorStop(1, "#000207");
        ambientPaint.addColorStop(0, "rgba(75, 127, 205, 0.11)");
        ambientPaint.addColorStop(0.42, "rgba(29, 76, 148, 0.045)");
        ambientPaint.addColorStop(1, "rgba(0, 0, 0, 0)");
        wavePaint.addColorStop(0, "rgba(111, 157, 224, 0)");
        wavePaint.addColorStop(0.18, "rgba(130, 176, 236, 0.68)");
        wavePaint.addColorStop(0.58, "rgba(230, 240, 252, 0.94)");
        wavePaint.addColorStop(0.7, "rgba(250, 253, 255, 1)");
        wavePaint.addColorStop(0.84, "rgba(139, 188, 248, 0.78)");
        wavePaint.addColorStop(1, "rgba(76, 123, 198, 0)");
        glowPaint.addColorStop(0, "rgba(86, 139, 221, 0)");
        glowPaint.addColorStop(0.42, "rgba(147, 187, 239, 0.2)");
        glowPaint.addColorStop(0.69, "rgba(229, 242, 255, 0.42)");
        glowPaint.addColorStop(1, "rgba(98, 151, 228, 0)");
        flowPaint.addColorStop(0, "rgba(158, 201, 255, 0)");
        flowPaint.addColorStop(0.3, "rgba(184, 216, 255, 0.44)");
        flowPaint.addColorStop(0.68, "rgba(255, 255, 255, 0.98)");
        flowPaint.addColorStop(1, "rgba(162, 204, 255, 0)");
        vignettePaint.addColorStop(0, "rgba(0, 0, 0, 0)");
        vignettePaint.addColorStop(1, "rgba(0, 0, 0, 0.54)");
      } else {
        backgroundPaint.addColorStop(0, "#fbfcff");
        backgroundPaint.addColorStop(0.54, "#f4f7ff");
        backgroundPaint.addColorStop(1, "#edf3ff");
        ambientPaint.addColorStop(0, "rgba(57, 109, 193, 0.13)");
        ambientPaint.addColorStop(0.46, "rgba(87, 135, 209, 0.055)");
        ambientPaint.addColorStop(1, "rgba(255, 255, 255, 0)");
        wavePaint.addColorStop(0, "rgba(38, 86, 168, 0)");
        wavePaint.addColorStop(0.16, "rgba(42, 94, 184, 0.58)");
        wavePaint.addColorStop(0.58, "rgba(39, 88, 171, 0.82)");
        wavePaint.addColorStop(0.7, "rgba(29, 76, 159, 0.92)");
        wavePaint.addColorStop(0.86, "rgba(64, 112, 194, 0.66)");
        wavePaint.addColorStop(1, "rgba(49, 96, 177, 0)");
        glowPaint.addColorStop(0, "rgba(62, 112, 195, 0)");
        glowPaint.addColorStop(0.42, "rgba(68, 117, 199, 0.1)");
        glowPaint.addColorStop(0.69, "rgba(43, 91, 176, 0.2)");
        glowPaint.addColorStop(1, "rgba(80, 127, 205, 0)");
        flowPaint.addColorStop(0, "rgba(43, 91, 174, 0)");
        flowPaint.addColorStop(0.3, "rgba(55, 105, 190, 0.36)");
        flowPaint.addColorStop(0.68, "rgba(27, 72, 156, 0.76)");
        flowPaint.addColorStop(1, "rgba(57, 106, 190, 0)");
        vignettePaint.addColorStop(0, "rgba(255, 255, 255, 0)");
        vignettePaint.addColorStop(1, "rgba(65, 91, 151, 0.055)");
      }
    };

    const resize = () => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      pixelRatio = Math.min(window.devicePixelRatio || 1, width < 900 ? 1 : 1.25);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      createPaints();
    };

    const draw = (time: number) => {
      currentTime = time;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.shadowBlur = 0;
      context.setLineDash([]);
      context.fillStyle = backgroundPaint;
      context.fillRect(0, 0, width, height);
      context.fillStyle = ambientPaint;
      context.fillRect(0, 0, width, height);

      context.save();
      context.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";
      context.strokeStyle = glowPaint;
      context.lineCap = "round";
      context.lineJoin = "round";

      for (const index of CORE_LINE_INDEXES) {
        traceWave(context, width, height, index, time, animated);
        context.globalAlpha = theme === "dark" ? 0.085 : 0.055;
        context.lineWidth = theme === "dark" ? 68 : 52;
        context.shadowColor = theme === "dark" ? "rgba(132, 184, 247, 0.42)" : "rgba(48, 96, 184, 0.18)";
        context.shadowBlur = theme === "dark" ? 30 : 20;
        context.stroke();
      }

      for (const index of GLOW_LINE_INDEXES) {
        traceWave(context, width, height, index, time, animated);
        context.globalAlpha = theme === "dark" ? 0.15 : 0.095;
        context.lineWidth = theme === "dark" ? 28 : 21;
        context.shadowColor = theme === "dark" ? "rgba(153, 198, 255, 0.42)" : "rgba(60, 107, 188, 0.2)";
        context.shadowBlur = theme === "dark" ? 20 : 13;
        context.stroke();
      }

      context.shadowBlur = 0;
      context.strokeStyle = wavePaint;
      for (let index = 0; index < WAVE_COUNT; index += 1) {
        const seed = WAVE_SEEDS[index];
        traceWave(context, width, height, index, time, animated);
        context.globalAlpha = seed.alpha * (theme === "dark" ? 0.5 : 0.39);
        context.lineWidth = seed.width;
        context.stroke();
      }

      context.strokeStyle = flowPaint;
      context.setLineDash([]);
      for (const index of CORE_LINE_INDEXES) {
        traceWave(context, width, height, index, time, animated);
        context.globalAlpha = theme === "dark" ? 0.76 : 0.52;
        context.lineWidth = theme === "dark" ? 3.4 : 2.6;
        context.shadowColor = theme === "dark" ? "rgba(195, 224, 255, 0.48)" : "rgba(47, 94, 179, 0.2)";
        context.shadowBlur = theme === "dark" ? 10 : 6;
        context.stroke();
      }

      if (animated) {
        const sweepX = ((time * 0.085) % 1.45 - 0.22) * width;
        const sweepPaint = context.createLinearGradient(
          sweepX - width * 0.2,
          0,
          sweepX + width * 0.2,
          0,
        );
        sweepPaint.addColorStop(0, "rgba(255, 255, 255, 0)");
        sweepPaint.addColorStop(
          0.5,
          theme === "dark" ? "rgba(246, 251, 255, 0.88)" : "rgba(35, 82, 168, 0.58)",
        );
        sweepPaint.addColorStop(1, "rgba(255, 255, 255, 0)");
        context.strokeStyle = sweepPaint;
        context.lineWidth = theme === "dark" ? 11 : 8;
        context.shadowColor = theme === "dark" ? "rgba(166, 210, 255, 0.56)" : "rgba(47, 94, 179, 0.22)";
        context.shadowBlur = theme === "dark" ? 16 : 9;
        for (const index of CORE_LINE_INDEXES) {
          traceWave(context, width, height, index, time, animated);
          context.globalAlpha = theme === "dark" ? 0.48 : 0.34;
          context.stroke();
        }
      }
      context.restore();

      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.setLineDash([]);
      context.fillStyle = vignettePaint;
      context.fillRect(0, 0, width, height);
    };

    const shouldAnimate = () => animated && !reducedMotion.matches && !document.hidden;

    const tick = (now: number) => {
      animationFrame = 0;
      if (!shouldAnimate()) return;
      if (!lastFrameTime || now - lastFrameTime >= TARGET_FRAME_INTERVAL) {
        lastFrameTime = now;
        draw(now * 0.001);
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastFrameTime = 0;
      if (shouldAnimate()) animationFrame = window.requestAnimationFrame(tick);
      else draw(currentTime);
    };

    const onResize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        resize();
        draw(currentTime);
      });
    };

    const onVisibilityChange = () => {
      start();
    };

    const onMotionChange = () => {
      start();
    };

    resize();
    draw(0);
    start();
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onMotionChange);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
