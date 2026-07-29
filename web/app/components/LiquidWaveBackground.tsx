"use client";

import { useEffect, useRef } from "react";

type LiquidWaveBackgroundProps = {
  theme: "dark" | "light";
  animated: boolean;
};

type NormalizedPoint = {
  x: number;
  y: number;
};

type WaveFamily = {
  start: NormalizedPoint;
  controlA: NormalizedPoint;
  controlB: NormalizedPoint;
  end: NormalizedPoint;
  spread: number;
  strands: number;
  phase: number;
  weight: number;
  crossT: number;
};

const TARGET_FRAME_INTERVAL = 1000 / 30;
const WAVE_ROTATION = -15 * Math.PI / 180;
const WAVE_PIVOT_X = 0.64;
const WAVE_PIVOT_Y = 0.695;
const WAVE_VERTICAL_SHIFT = -0.055;

const WAVE_FAMILIES: WaveFamily[] = [
  {
    start: { x: -0.08, y: 0.52 },
    controlA: { x: 0.24, y: 0.56 },
    controlB: { x: 0.59, y: 0.75 },
    end: { x: 1.08, y: 0.6 },
    spread: 0.06,
    strands: 9,
    phase: 0.2,
    weight: 1,
    crossT: 0.65,
  },
  {
    start: { x: -0.08, y: 0.7 },
    controlA: { x: 0.24, y: 0.71 },
    controlB: { x: 0.6, y: 0.62 },
    end: { x: 1.08, y: 0.72 },
    spread: 0.058,
    strands: 9,
    phase: 1.75,
    weight: 0.92,
    crossT: 0.61,
  },
  {
    start: { x: -0.08, y: 0.8 },
    controlA: { x: 0.28, y: 0.74 },
    controlB: { x: 0.62, y: 0.67 },
    end: { x: 1.08, y: 0.78 },
    spread: 0.042,
    strands: 7,
    phase: 3.15,
    weight: 0.72,
    crossT: 0.59,
  },
  {
    start: { x: -0.08, y: 0.59 },
    controlA: { x: 0.23, y: 0.6 },
    controlB: { x: 0.69, y: 0.71 },
    end: { x: 1.08, y: 0.56 },
    spread: 0.034,
    strands: 7,
    phase: 4.55,
    weight: 0.64,
    crossT: 0.68,
  },
];

function cubicPoint(
  start: NormalizedPoint,
  controlA: NormalizedPoint,
  controlB: NormalizedPoint,
  end: NormalizedPoint,
  progress: number,
) {
  const inverse = 1 - progress;
  const inverseSquared = inverse * inverse;
  const progressSquared = progress * progress;
  return {
    x: inverseSquared * inverse * start.x
      + 3 * inverseSquared * progress * controlA.x
      + 3 * inverse * progressSquared * controlB.x
      + progressSquared * progress * end.x,
    y: inverseSquared * inverse * start.y
      + 3 * inverseSquared * progress * controlA.y
      + 3 * inverse * progressSquared * controlB.y
      + progressSquared * progress * end.y,
  };
}

function applyWaveTransform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  context.translate(0, height * WAVE_VERTICAL_SHIFT);
  context.translate(width * WAVE_PIVOT_X, height * WAVE_PIVOT_Y);
  context.rotate(WAVE_ROTATION);
  context.translate(-width * WAVE_PIVOT_X, -height * WAVE_PIVOT_Y);
}

function traceFamilyStrand(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  familyIndex: number,
  strandPosition: number,
  time: number,
  animated: boolean,
) {
  const family = WAVE_FAMILIES[familyIndex];
  const motionStrength = animated ? 1 : 0;
  const controlA = {
    x: family.controlA.x + Math.sin(time * 0.16 + family.phase) * 0.008 * motionStrength,
    y: family.controlA.y + Math.sin(time * 0.21 + family.phase) * 0.03 * family.weight * motionStrength,
  };
  const controlB = {
    x: family.controlB.x + Math.cos(time * 0.14 + family.phase) * 0.009 * motionStrength,
    y: family.controlB.y + Math.cos(time * 0.19 + family.phase * 0.78) * 0.033 * family.weight * motionStrength,
  };
  const focusY = 0.695 + (familyIndex - 1.5) * 0.006;
  const focusedPoint = (progress: number) => {
    const point = cubicPoint(family.start, controlA, controlB, family.end, progress);
    const focusEnvelope = Math.exp(-Math.pow((progress - family.crossT) / 0.18, 2));
    const archEnvelope = Math.sin(Math.PI * progress);
    const upwardArch = archEnvelope * archEnvelope * 0.045;
    return {
      x: point.x,
      y: point.y + (focusY - point.y) * focusEnvelope * 0.85 - upwardArch,
    };
  };

  context.beginPath();
  for (let step = 0; step <= 64; step += 1) {
    const progress = step / 64;
    const point = focusedPoint(progress);
    const previousPoint = focusedPoint(Math.max(0, progress - 0.003));
    const nextPoint = focusedPoint(Math.min(1, progress + 0.003));
    const tangentX = (nextPoint.x - previousPoint.x) * width;
    const tangentY = (nextPoint.y - previousPoint.y) * height;
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    const normalizedDistance = Math.min(
      1,
      Math.abs(progress - family.crossT) / Math.max(family.crossT, 1 - family.crossT),
    );
    const smoothDistance = normalizedDistance * normalizedDistance * (3 - 2 * normalizedDistance);
    const endFlare = Math.pow(smoothDistance, 1.45);
    const spreadScale = 0.11 + smoothDistance * 0.77 + endFlare * 0.58;
    const centerEnvelope = Math.exp(-Math.pow((progress - family.crossT) / 0.29, 2));
    const contourEnvelope = Math.sin(Math.PI * progress) * (1 - centerEnvelope * 0.42);
    const strandContour = Math.sin(
      family.phase * 1.7 + strandPosition * 7.2 + progress * 5.4,
    ) * height * 0.0019 * contourEnvelope;
    const sharedFlow = animated
      ? Math.sin(time * 0.42 + family.phase + progress * 3.6) * height * 0.0056 * family.weight * centerEnvelope
      : 0;
    const strandRipple = animated
      ? Math.sin(time * 0.54 + family.phase + progress * 4.8 + strandPosition * 6.4)
        * height * 0.0028 * centerEnvelope
      : 0;
    const offset = strandPosition * family.spread * height * spreadScale
      + strandContour
      + sharedFlow
      + strandRipple;
    const x = point.x * width + normalX * offset;
    const y = point.y * height + normalY * offset;
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
}

function strandVariation(familyIndex: number, strandIndex: number) {
  const value = Math.sin((familyIndex + 1) * 97.13 + (strandIndex + 1) * 41.73) * 43758.5453;
  return value - Math.floor(value);
}

function clusteredStrandPosition(familyIndex: number, strandIndex: number, strandCount: number) {
  if (strandCount <= 1) return 0;
  const linearPosition = strandIndex / (strandCount - 1) * 2 - 1;
  const clusteredPosition = Math.sign(linearPosition) * Math.pow(Math.abs(linearPosition), 1.24);
  const irregularity = Math.sin((strandIndex + 1) * 2.17 + familyIndex * 0.93)
    * 0.052
    * (1 - Math.abs(clusteredPosition) * 0.35);
  return Math.max(-1, Math.min(1, clusteredPosition + irregularity));
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
      context.save();
      applyWaveTransform(context, width, height);
      wavePaint = context.createLinearGradient(0, height * 0.8, width, height * 0.56);
      glowPaint = context.createLinearGradient(0, height * 0.82, width, height * 0.54);
      flowPaint = context.createLinearGradient(0, height * 0.8, width, height * 0.58);
      context.restore();
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
        wavePaint.addColorStop(0.58, "rgba(190, 218, 248, 0.9)");
        wavePaint.addColorStop(0.7, "rgba(207, 231, 255, 0.96)");
        wavePaint.addColorStop(0.84, "rgba(139, 188, 248, 0.78)");
        wavePaint.addColorStop(1, "rgba(76, 123, 198, 0)");
        glowPaint.addColorStop(0, "rgba(86, 139, 221, 0)");
        glowPaint.addColorStop(0.42, "rgba(147, 187, 239, 0.2)");
        glowPaint.addColorStop(0.69, "rgba(176, 213, 250, 0.39)");
        glowPaint.addColorStop(1, "rgba(98, 151, 228, 0)");
        flowPaint.addColorStop(0, "rgba(158, 201, 255, 0)");
        flowPaint.addColorStop(0.3, "rgba(184, 216, 255, 0.44)");
        flowPaint.addColorStop(0.68, "rgba(190, 224, 255, 0.92)");
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
      applyWaveTransform(context, width, height);

      const pulsePaints: CanvasGradient[] = [];
      const pulseStrengths: number[] = [];
      if (animated) {
        for (let familyIndex = 0; familyIndex < WAVE_FAMILIES.length; familyIndex += 1) {
          const family = WAVE_FAMILIES[familyIndex];
          const pulseProgress = ((time * 0.085 + familyIndex * 0.047) % 1.34) - 0.17;
          const pulseX = pulseProgress * width;
          const pulseRadius = width * (0.13 + familyIndex * 0.004);
          const pulsePaint = context.createLinearGradient(
            pulseX - pulseRadius,
            0,
            pulseX + pulseRadius,
            0,
          );
          pulsePaint.addColorStop(0, "rgba(255, 255, 255, 0)");
          pulsePaint.addColorStop(
            0.28,
            theme === "dark" ? "rgba(178, 215, 255, 0.13)" : "rgba(45, 91, 177, 0.08)",
          );
          pulsePaint.addColorStop(
            0.5,
            theme === "dark" ? "rgba(207, 233, 255, 0.84)" : "rgba(31, 76, 164, 0.68)",
          );
          pulsePaint.addColorStop(
            0.72,
            theme === "dark" ? "rgba(169, 209, 255, 0.11)" : "rgba(48, 95, 181, 0.07)",
          );
          pulsePaint.addColorStop(1, "rgba(255, 255, 255, 0)");
          pulsePaints.push(pulsePaint);
          pulseStrengths.push(0.92 + Math.sin(time * 0.46 + family.phase) * 0.08);
        }
      }

      context.globalCompositeOperation = theme === "dark" ? "screen" : "source-over";
      context.strokeStyle = glowPaint;
      context.lineCap = "round";
      context.lineJoin = "round";

      for (let familyIndex = 0; familyIndex < WAVE_FAMILIES.length; familyIndex += 1) {
        const family = WAVE_FAMILIES[familyIndex];
        traceFamilyStrand(context, width, height, familyIndex, 0, time, animated);
        context.globalAlpha = family.weight * (theme === "dark" ? 0.095 : 0.06);
        context.lineWidth = (theme === "dark" ? 54 : 40) * (0.72 + family.weight * 0.28);
        context.shadowColor = theme === "dark" ? "rgba(132, 184, 247, 0.42)" : "rgba(48, 96, 184, 0.18)";
        context.shadowBlur = theme === "dark" ? 26 : 17;
        context.stroke();
      }

      for (let familyIndex = 0; familyIndex < WAVE_FAMILIES.length; familyIndex += 1) {
        const family = WAVE_FAMILIES[familyIndex];
        traceFamilyStrand(context, width, height, familyIndex, 0, time, animated);
        context.globalAlpha = family.weight * (theme === "dark" ? 0.18 : 0.11);
        context.lineWidth = (theme === "dark" ? 20 : 15) * (0.74 + family.weight * 0.26);
        context.shadowColor = theme === "dark" ? "rgba(153, 198, 255, 0.42)" : "rgba(60, 107, 188, 0.2)";
        context.shadowBlur = theme === "dark" ? 16 : 10;
        context.stroke();
      }

      context.shadowBlur = 0;
      context.strokeStyle = wavePaint;
      for (let familyIndex = 0; familyIndex < WAVE_FAMILIES.length; familyIndex += 1) {
        const family = WAVE_FAMILIES[familyIndex];
        for (let strandIndex = 0; strandIndex < family.strands; strandIndex += 1) {
          const strandPosition = clusteredStrandPosition(
            familyIndex,
            strandIndex,
            family.strands,
          );
          const thicknessVariation = strandVariation(familyIndex, strandIndex);
          const brightnessVariation = strandVariation(familyIndex + 11, strandIndex + 17);
          const thicknessScale = 0.86 + thicknessVariation * 0.28;
          const brightnessScale = 0.85 + brightnessVariation * 0.3;
          const familyScale = 0.9 + family.weight * 0.1;
          const strandWidth = (theme === "dark" ? 2 : 1.75) * thicknessScale;
          const strandAlpha = (theme === "dark" ? 0.42 : 0.3) * brightnessScale * familyScale;

          traceFamilyStrand(context, width, height, familyIndex, strandPosition, time, animated);
          context.strokeStyle = glowPaint;
          context.globalAlpha = strandAlpha * 0.13;
          context.lineWidth = strandWidth * 3.6;
          context.stroke();
          context.strokeStyle = wavePaint;
          context.globalAlpha = strandAlpha * 0.44;
          context.lineWidth = strandWidth * 1.85;
          context.stroke();
          context.strokeStyle = flowPaint;
          context.globalAlpha = strandAlpha * 0.9;
          context.lineWidth = strandWidth * 0.72;
          context.stroke();

          if (animated) {
            context.strokeStyle = pulsePaints[familyIndex];
            context.globalAlpha = strandAlpha * pulseStrengths[familyIndex] * 0.08;
            context.lineWidth = strandWidth * 2.8;
            context.stroke();
            context.globalAlpha = strandAlpha * pulseStrengths[familyIndex] * 0.3;
            context.lineWidth = strandWidth * 0.64;
            context.stroke();
          }
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
