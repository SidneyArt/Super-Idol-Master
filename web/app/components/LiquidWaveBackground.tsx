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

type RibbonGeometrySample = {
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  halfWidth: number;
};

type FlowLine = {
  offset: number;
  width: number;
  opacity: number;
  phase: number;
  primary?: boolean;
};

const TARGET_FRAME_INTERVAL = 1000 / 30;
const CURVE_STEPS = 48;

const BASE_CURVE = {
  start: { x: -0.12, y: 0.69 },
  controlA: { x: 0.24, y: 0.76 },
  controlB: { x: 0.68, y: 0.49 },
  end: { x: 1.12, y: 0.52 },
} satisfies Record<string, NormalizedPoint>;

const FLOW_LINES: FlowLine[] = [
  { offset: -1.12, width: 0.9, opacity: 0.34, phase: 0.3 },
  { offset: -0.86, width: 1.35, opacity: 0.58, phase: 1.1 },
  { offset: -0.52, width: 2.4, opacity: 0.9, phase: 1.9, primary: true },
  { offset: -0.24, width: 1.05, opacity: 0.45, phase: 2.6 },
  { offset: 0.08, width: 2.8, opacity: 1, phase: 3.4, primary: true },
  { offset: 0.36, width: 1.1, opacity: 0.48, phase: 4.2 },
  { offset: 0.66, width: 2.1, opacity: 0.78, phase: 5, primary: true },
  { offset: 0.92, width: 1.25, opacity: 0.5, phase: 5.8 },
  { offset: 1.14, width: 0.85, opacity: 0.3, phase: 6.5 },
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

function buildRibbonGeometry(
  width: number,
  height: number,
  time: number,
  motionEnabled: boolean,
): RibbonGeometrySample[] {
  const motionStrength = motionEnabled ? 1 : 0;
  const visualScale = Math.min(height, width * 0.9);
  const start = {
    x: BASE_CURVE.start.x,
    y: BASE_CURVE.start.y + Math.sin(time * 0.21 + 0.3) * 0.004 * motionStrength,
  };
  const controlA = {
    x: BASE_CURVE.controlA.x
      + Math.cos(time * 0.15 + 0.8) * 0.0035 * motionStrength,
    y: BASE_CURVE.controlA.y
      + Math.sin(time * 0.24 + 1.2) * 0.009 * motionStrength,
  };
  const controlB = {
    x: BASE_CURVE.controlB.x
      + Math.sin(time * 0.13 + 2.1) * 0.004 * motionStrength,
    y: BASE_CURVE.controlB.y
      + Math.cos(time * 0.19 + 0.4) * 0.009 * motionStrength,
  };
  const end = {
    x: BASE_CURVE.end.x,
    y: BASE_CURVE.end.y + Math.sin(time * 0.17 + 2.7) * 0.005 * motionStrength,
  };

  const basePoints = Array.from({ length: CURVE_STEPS + 1 }, (_, step) => {
    const progress = step / CURVE_STEPS;
    const point = cubicPoint(start, controlA, controlB, end, progress);
    const centerEnvelope = Math.sin(Math.PI * progress);
    const longWave = Math.sin(progress * Math.PI * 1.65 - time * 0.18 + 0.45)
      * visualScale
      * 0.006
      * centerEnvelope
      * motionStrength;
    const widthEnvelope = Math.pow(centerEnvelope, 1.25);
    const widthBreath = 1
      + Math.sin(time * 0.2 + progress * 2.15) * 0.035 * motionStrength;

    return {
      x: point.x * width,
      y: point.y * height + longWave,
      halfWidth: visualScale * (0.028 + widthEnvelope * 0.01) * widthBreath,
    };
  });

  return basePoints.map((point, index) => {
    const previousPoint = basePoints[Math.max(0, index - 1)];
    const nextPoint = basePoints[Math.min(CURVE_STEPS, index + 1)];
    const tangentX = nextPoint.x - previousPoint.x;
    const tangentY = nextPoint.y - previousPoint.y;
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));

    return {
      ...point,
      normalX: -tangentY / tangentLength,
      normalY: tangentX / tangentLength,
    };
  });
}

function ribbonPoint(
  sample: RibbonGeometrySample,
  widthRatio: number,
) {
  const offset = sample.halfWidth * widthRatio;
  return {
    x: sample.x + sample.normalX * offset,
    y: sample.y + sample.normalY * offset,
  };
}

function traceRibbon(
  context: CanvasRenderingContext2D,
  geometry: RibbonGeometrySample[],
  widthScale: number,
  centerOffset = 0,
) {
  context.beginPath();

  for (let index = 0; index < geometry.length; index += 1) {
    const point = ribbonPoint(geometry[index], centerOffset + widthScale);
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }

  for (let index = geometry.length - 1; index >= 0; index -= 1) {
    const point = ribbonPoint(geometry[index], centerOffset - widthScale);
    context.lineTo(point.x, point.y);
  }

  context.closePath();
}

function traceRibbonSeam(
  context: CanvasRenderingContext2D,
  geometry: RibbonGeometrySample[],
  offsetRatio: number,
  phase: number,
  time: number,
  motionEnabled: boolean,
) {
  context.beginPath();
  for (let index = 0; index < geometry.length; index += 1) {
    const progress = index / Math.max(1, geometry.length - 1);
    const driftEnvelope = Math.sin(Math.PI * progress);
    const lineDrift = motionEnabled
      ? Math.sin(progress * Math.PI * 1.8 + phase + time * 0.16)
        * 0.055
        * driftEnvelope
      : 0;
    const point = ribbonPoint(geometry[index], offsetRatio + lineDrift);
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
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
    let auraPaint: CanvasGradient;
    let bodyPaint: CanvasGradient;
    let innerPaint: CanvasGradient;
    let seamPaint: CanvasGradient;
    let safetyVeilPaint: CanvasGradient;
    let vignettePaint: CanvasGradient;

    const createPaints = () => {
      backgroundPaint = context.createLinearGradient(0, 0, width, height);
      ambientPaint = context.createRadialGradient(
        width * 0.62,
        height * 0.62,
        0,
        width * 0.62,
        height * 0.62,
        Math.max(width, height) * 0.68,
      );
      auraPaint = context.createLinearGradient(0, height * 0.72, width, height * 0.48);
      bodyPaint = context.createLinearGradient(0, height * 0.73, width, height * 0.48);
      innerPaint = context.createLinearGradient(0, height * 0.73, width, height * 0.48);
      seamPaint = context.createLinearGradient(0, height * 0.72, width, height * 0.49);
      safetyVeilPaint = context.createLinearGradient(0, 0, 0, height);
      vignettePaint = context.createRadialGradient(
        width * 0.56,
        height * 0.61,
        Math.min(width, height) * 0.12,
        width * 0.56,
        height * 0.61,
        Math.max(width, height) * 0.78,
      );

      if (theme === "dark") {
        backgroundPaint.addColorStop(0, "#000101");
        backgroundPaint.addColorStop(0.52, "#02050a");
        backgroundPaint.addColorStop(1, "#000309");

        ambientPaint.addColorStop(0, "rgba(46, 101, 176, 0.105)");
        ambientPaint.addColorStop(0.48, "rgba(20, 59, 116, 0.04)");
        ambientPaint.addColorStop(1, "rgba(0, 0, 0, 0)");

        auraPaint.addColorStop(0, "rgba(48, 105, 188, 0)");
        auraPaint.addColorStop(0.14, "rgba(55, 115, 198, 0.045)");
        auraPaint.addColorStop(0.46, "rgba(76, 139, 218, 0.12)");
        auraPaint.addColorStop(0.7, "rgba(104, 172, 235, 0.17)");
        auraPaint.addColorStop(0.9, "rgba(55, 113, 190, 0.065)");
        auraPaint.addColorStop(1, "rgba(40, 86, 158, 0)");

        bodyPaint.addColorStop(0, "rgba(67, 126, 205, 0)");
        bodyPaint.addColorStop(0.14, "rgba(70, 132, 210, 0.07)");
        bodyPaint.addColorStop(0.45, "rgba(91, 154, 225, 0.17)");
        bodyPaint.addColorStop(0.7, "rgba(128, 189, 239, 0.235)");
        bodyPaint.addColorStop(0.89, "rgba(70, 130, 205, 0.1)");
        bodyPaint.addColorStop(1, "rgba(54, 104, 182, 0)");

        innerPaint.addColorStop(0, "rgba(92, 151, 224, 0)");
        innerPaint.addColorStop(0.16, "rgba(94, 158, 229, 0.055)");
        innerPaint.addColorStop(0.48, "rgba(123, 182, 238, 0.15)");
        innerPaint.addColorStop(0.7, "rgba(157, 209, 248, 0.22)");
        innerPaint.addColorStop(0.88, "rgba(96, 155, 222, 0.08)");
        innerPaint.addColorStop(1, "rgba(70, 126, 201, 0)");

        seamPaint.addColorStop(0, "rgba(126, 180, 235, 0)");
        seamPaint.addColorStop(0.18, "rgba(128, 184, 239, 0.2)");
        seamPaint.addColorStop(0.52, "rgba(158, 207, 249, 0.48)");
        seamPaint.addColorStop(0.74, "rgba(183, 221, 251, 0.62)");
        seamPaint.addColorStop(0.92, "rgba(113, 169, 226, 0.14)");
        seamPaint.addColorStop(1, "rgba(89, 143, 208, 0)");

        safetyVeilPaint.addColorStop(0, "rgba(0, 1, 2, 0.24)");
        safetyVeilPaint.addColorStop(0.28, "rgba(0, 1, 2, 0)");
        safetyVeilPaint.addColorStop(0.76, "rgba(0, 1, 3, 0)");
        safetyVeilPaint.addColorStop(0.9, "rgba(0, 1, 3, 0.58)");
        safetyVeilPaint.addColorStop(1, "rgba(0, 1, 3, 0.9)");

        vignettePaint.addColorStop(0, "rgba(0, 0, 0, 0)");
        vignettePaint.addColorStop(1, "rgba(0, 0, 0, 0.5)");
      } else {
        backgroundPaint.addColorStop(0, "#fbfcff");
        backgroundPaint.addColorStop(0.52, "#f4f7ff");
        backgroundPaint.addColorStop(1, "#edf3ff");

        ambientPaint.addColorStop(0, "rgba(78, 122, 199, 0.12)");
        ambientPaint.addColorStop(0.5, "rgba(91, 132, 205, 0.045)");
        ambientPaint.addColorStop(1, "rgba(255, 255, 255, 0)");

        auraPaint.addColorStop(0, "rgba(65, 103, 183, 0)");
        auraPaint.addColorStop(0.14, "rgba(71, 111, 193, 0.035)");
        auraPaint.addColorStop(0.46, "rgba(86, 126, 204, 0.09)");
        auraPaint.addColorStop(0.7, "rgba(105, 139, 211, 0.13)");
        auraPaint.addColorStop(0.9, "rgba(76, 111, 188, 0.05)");
        auraPaint.addColorStop(1, "rgba(63, 97, 174, 0)");

        bodyPaint.addColorStop(0, "rgba(52, 88, 169, 0)");
        bodyPaint.addColorStop(0.14, "rgba(54, 92, 176, 0.055)");
        bodyPaint.addColorStop(0.45, "rgba(64, 102, 187, 0.13)");
        bodyPaint.addColorStop(0.7, "rgba(75, 110, 196, 0.18)");
        bodyPaint.addColorStop(0.89, "rgba(60, 96, 178, 0.08)");
        bodyPaint.addColorStop(1, "rgba(47, 82, 161, 0)");

        innerPaint.addColorStop(0, "rgba(54, 91, 171, 0)");
        innerPaint.addColorStop(0.16, "rgba(57, 95, 179, 0.045)");
        innerPaint.addColorStop(0.48, "rgba(67, 105, 190, 0.12)");
        innerPaint.addColorStop(0.7, "rgba(79, 115, 202, 0.17)");
        innerPaint.addColorStop(0.88, "rgba(59, 96, 179, 0.065)");
        innerPaint.addColorStop(1, "rgba(48, 83, 162, 0)");

        seamPaint.addColorStop(0, "rgba(47, 83, 163, 0)");
        seamPaint.addColorStop(0.18, "rgba(49, 86, 169, 0.16)");
        seamPaint.addColorStop(0.52, "rgba(55, 91, 180, 0.36)");
        seamPaint.addColorStop(0.74, "rgba(61, 96, 188, 0.48)");
        seamPaint.addColorStop(0.92, "rgba(54, 89, 171, 0.11)");
        seamPaint.addColorStop(1, "rgba(46, 79, 157, 0)");

        safetyVeilPaint.addColorStop(0, "rgba(250, 252, 255, 0.28)");
        safetyVeilPaint.addColorStop(0.28, "rgba(250, 252, 255, 0)");
        safetyVeilPaint.addColorStop(0.76, "rgba(242, 247, 255, 0)");
        safetyVeilPaint.addColorStop(0.9, "rgba(239, 245, 255, 0.58)");
        safetyVeilPaint.addColorStop(1, "rgba(237, 243, 255, 0.9)");

        vignettePaint.addColorStop(0, "rgba(255, 255, 255, 0)");
        vignettePaint.addColorStop(1, "rgba(67, 91, 151, 0.05)");
      }
    };

    const resize = () => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      pixelRatio = Math.min(window.devicePixelRatio || 1, animated ? 1 : 1.2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      createPaints();
    };

    const draw = (time: number) => {
      currentTime = time;
      const motionEnabled = animated && !reducedMotion.matches;
      const compactOpacity = width < 720 ? 0.68 : 1;
      const staticOpacity = motionEnabled ? 1 : 0.76;
      const geometry = buildRibbonGeometry(width, height, time, motionEnabled);

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.shadowBlur = 0;
      context.fillStyle = backgroundPaint;
      context.fillRect(0, 0, width, height);
      context.fillStyle = ambientPaint;
      context.fillRect(0, 0, width, height);

      context.save();
      context.globalCompositeOperation = theme === "dark" ? "screen" : "source-over";
      context.lineCap = "round";
      context.lineJoin = "round";

      traceRibbon(context, geometry, 1.62);
      context.fillStyle = auraPaint;
      context.globalAlpha = compactOpacity * staticOpacity * (theme === "dark" ? 0.34 : 0.22);
      context.shadowColor = theme === "dark"
        ? "rgba(65, 133, 220, 0.24)"
        : "rgba(66, 103, 184, 0.12)";
      context.shadowBlur = theme === "dark" ? 30 : 20;
      context.fill();

      traceRibbon(context, geometry, 1);
      context.fillStyle = bodyPaint;
      context.globalAlpha = compactOpacity * staticOpacity * (theme === "dark" ? 0.46 : 0.32);
      context.shadowColor = theme === "dark"
        ? "rgba(91, 157, 229, 0.18)"
        : "rgba(68, 103, 182, 0.09)";
      context.shadowBlur = theme === "dark" ? 16 : 10;
      context.fill();

      traceRibbon(context, geometry, 0.43, -0.06);
      context.fillStyle = innerPaint;
      context.globalAlpha = compactOpacity * staticOpacity * (theme === "dark" ? 0.5 : 0.36);
      context.shadowBlur = 0;
      context.fill();

      if (motionEnabled) {
        const pulseProgress = ((time * 0.07) % 1.36) - 0.18;
        const pulseX = pulseProgress * width;
        const pulseRadius = width * 0.12;
        const pulsePaint = context.createLinearGradient(
          pulseX - pulseRadius,
          0,
          pulseX + pulseRadius,
          0,
        );
        pulsePaint.addColorStop(0, "rgba(255, 255, 255, 0)");
        pulsePaint.addColorStop(
          0.36,
          theme === "dark" ? "rgba(135, 193, 244, 0.08)" : "rgba(58, 93, 173, 0.055)",
        );
        pulsePaint.addColorStop(
          0.5,
          theme === "dark" ? "rgba(181, 221, 252, 0.28)" : "rgba(52, 88, 169, 0.2)",
        );
        pulsePaint.addColorStop(
          0.64,
          theme === "dark" ? "rgba(124, 184, 239, 0.07)" : "rgba(61, 97, 177, 0.045)",
        );
        pulsePaint.addColorStop(1, "rgba(255, 255, 255, 0)");

        traceRibbon(context, geometry, 0.82);
        context.fillStyle = pulsePaint;
        context.globalAlpha = compactOpacity * (theme === "dark" ? 0.7 : 0.56);
        context.fill();
      }

      context.strokeStyle = seamPaint;
      context.shadowColor = theme === "dark"
        ? "rgba(128, 190, 244, 0.32)"
        : "rgba(49, 81, 166, 0.16)";
      const visibleLines = width < 720
        ? FLOW_LINES.filter((line, index) => line.primary || index % 2 === 1)
        : FLOW_LINES;
      for (const line of visibleLines) {
        traceRibbonSeam(
          context,
          geometry,
          line.offset,
          line.phase,
          time,
          motionEnabled,
        );
        context.globalAlpha = compactOpacity
          * staticOpacity
          * line.opacity
          * (theme === "dark" ? 0.72 : 0.82);
        context.lineWidth = line.width * (theme === "dark" ? 1 : 1.08);
        context.shadowBlur = line.primary ? (theme === "dark" ? 9 : 5) : 0;
        context.stroke();
      }

      context.restore();
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.shadowBlur = 0;
      context.fillStyle = safetyVeilPaint;
      context.fillRect(0, 0, width, height);
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
