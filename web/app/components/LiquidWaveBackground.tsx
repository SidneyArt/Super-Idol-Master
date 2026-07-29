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
  leftBend: number;
  rightBend: number;
};

type CurveGeometrySample = {
  progress: number;
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  normalizedDistance: number;
  flareDistance: number;
  spreadScale: number;
  centerEnvelope: number;
  sideEnvelope: number;
  sideArcStrength: number;
  signedFocusDistance: number;
  focusWeaveEnvelope: number;
  sharedFlow: number;
};

type StrandPoint = {
  progress: number;
  x: number;
  y: number;
};

const TARGET_FRAME_INTERVAL = 1000 / 30;
const CURVE_STEPS = 40;
const FLARE_NORMALIZER = 1 - Math.exp(-8);
const WAVE_ROTATION = -15 * Math.PI / 180;
const WAVE_PIVOT_X = 0.64;
const WAVE_PIVOT_Y = 0.695;
const WAVE_VERTICAL_SHIFT = -0.055;
const WAVE_SCALE = 1.06;

const WAVE_FAMILIES: WaveFamily[] = [
  {
    start: { x: -0.08, y: 0.65 },
    controlA: { x: 0.24, y: 0.65 },
    controlB: { x: 0.62, y: 0.69 },
    end: { x: 1.08, y: 0.665 },
    spread: 0.132,
    strands: 32,
    phase: 0.2,
    weight: 1,
    crossT: 0.62,
    leftBend: 0,
    rightBend: 0,
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
  context.scale(WAVE_SCALE, WAVE_SCALE);
  context.translate(-width * WAVE_PIVOT_X, -height * WAVE_PIVOT_Y);
}

function buildFamilyGeometry(
  width: number,
  height: number,
  familyIndex: number,
  time: number,
  animated: boolean,
): CurveGeometrySample[] {
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
  const focusY = 0.695;
  const focusedPoint = (progress: number) => {
    const point = cubicPoint(family.start, controlA, controlB, family.end, progress);
    const focusEnvelope = Math.exp(-Math.pow((progress - family.crossT) / 0.14, 2));
    const archEnvelope = Math.sin(Math.PI * progress);
    const upwardArch = archEnvelope * archEnvelope * 0.075;
    const leftSag = archEnvelope
      * archEnvelope
      * Math.pow(1 - progress, 1.6)
      * 0.24;
    const rightProgress = Math.max(0, Math.min(1, (progress - 0.62) / 0.38));
    const rightLiftEase = rightProgress * rightProgress * (3 - 2 * rightProgress);
    const rightLift = rightLiftEase * 0.15;
    const distanceFromFocus = progress <= family.crossT
      ? (family.crossT - progress) / family.crossT
      : (progress - family.crossT) / (1 - family.crossT);
    const familyArcEnvelope = Math.sin(Math.PI * distanceFromFocus);
    const familyArc = familyArcEnvelope * (
      progress <= family.crossT ? family.leftBend : family.rightBend
    );
    return {
      x: point.x,
      y: point.y
        + (focusY - point.y) * focusEnvelope * 0.93
        - upwardArch
        + leftSag
        - rightLift
        + familyArc,
    };
  };

  const basePoints = Array.from({ length: CURVE_STEPS + 1 }, (_, step) => {
    const progress = step / CURVE_STEPS;
    const point = focusedPoint(progress);
    return {
      progress,
      x: point.x * width,
      y: point.y * height,
    };
  });

  return basePoints.map((point, step) => {
    const previousPoint = basePoints[Math.max(0, step - 1)];
    const nextPoint = basePoints[Math.min(CURVE_STEPS, step + 1)];
    const tangentX = nextPoint.x - previousPoint.x;
    const tangentY = nextPoint.y - previousPoint.y;
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
    const distanceToFocus = Math.abs(point.progress - family.crossT);
    const distanceToEdge = point.progress <= family.crossT
      ? family.crossT
      : 1 - family.crossT;
    const normalizedDistance = Math.min(1, distanceToFocus / distanceToEdge);
    const flareDistance = (1 - Math.exp(-8 * normalizedDistance * normalizedDistance))
      / FLARE_NORMALIZER;
    const endFlare = Math.pow(normalizedDistance, 1.6);
    const centerEnvelope = Math.exp(-Math.pow((point.progress - family.crossT) / 0.29, 2));
    const signedFocusDistance = (point.progress - family.crossT) / 0.13;
    return {
      progress: point.progress,
      x: point.x,
      y: point.y,
      normalX: -tangentY / tangentLength,
      normalY: tangentX / tangentLength,
      normalizedDistance,
      flareDistance,
      spreadScale: 0.085 + flareDistance * 0.775 + endFlare * 0.965,
      centerEnvelope,
      sideEnvelope: Math.sin(Math.PI * normalizedDistance),
      sideArcStrength: point.progress <= family.crossT ? 0.55 : -0.42,
      signedFocusDistance,
      focusWeaveEnvelope: Math.exp(-signedFocusDistance * signedFocusDistance),
      sharedFlow: animated
        ? Math.sin(time * 0.42 + family.phase + point.progress * 3.6)
          * height
          * 0.0056
          * family.weight
          * centerEnvelope
        : 0,
    };
  });
}

function buildFamilyStrandPoints(
  height: number,
  familyIndex: number,
  geometry: CurveGeometrySample[],
  strandPosition: number,
  strandIndex: number,
  time: number,
  animated: boolean,
) {
  const family = WAVE_FAMILIES[familyIndex];
  const hasStrandIdentity = strandIndex >= 0;
  const curveSeedA = hasStrandIdentity ? strandVariation(familyIndex + 3, strandIndex + 7) : 0;
  const curveSeedB = hasStrandIdentity ? strandVariation(familyIndex + 7, strandIndex + 13) : 0;
  const curveSeedC = hasStrandIdentity ? strandVariation(familyIndex + 13, strandIndex + 19) : 0;
  const curveSeedD = hasStrandIdentity ? strandVariation(familyIndex + 19, strandIndex + 23) : 0;
  const curveSeedE = hasStrandIdentity ? strandVariation(familyIndex + 23, strandIndex + 29) : 0;
  const leftCurvePhase = curveSeedA * Math.PI * 2;
  const rightCurvePhase = curveSeedB * Math.PI * 2;
  const leftCurveFrequency = 0.72 + curveSeedC * 0.86;
  const rightCurveFrequency = 0.68 + curveSeedD * 0.94;
  const organicCurveAmplitude = hasStrandIdentity
    ? height * (0.011 + curveSeedE * 0.014)
    : 0;
  const organicMotionAmplitude = hasStrandIdentity
    ? height * (0.0035 + curveSeedC * 0.0045)
    : 0;
  const focusWeaveBias = Math.sin(strandPosition * 8.6 + family.phase) * 0.0035;

  const points: StrandPoint[] = [];
  for (let step = 0; step < geometry.length; step += 1) {
    const sample = geometry[step];
    const strandSideArc = strandPosition
      * family.spread
      * height
      * sample.sideEnvelope
      * sample.sideArcStrength;
    const curvePhase = sample.progress <= family.crossT ? leftCurvePhase : rightCurvePhase;
    const curveFrequency = sample.progress <= family.crossT
      ? leftCurveFrequency
      : rightCurveFrequency;
    const primaryCurve = Math.sin(
      curvePhase + sample.normalizedDistance * Math.PI * curveFrequency,
    );
    const secondaryCurve = Math.sin(
      curvePhase * 0.63
        + sample.normalizedDistance * Math.PI * (curveFrequency * 2.15 + curveSeedE * 0.7),
    );
    const strandContour = (primaryCurve + secondaryCurve * 0.34)
      / 1.34
      * organicCurveAmplitude
      * sample.sideEnvelope;
    const focusWeave = (
      strandPosition * family.spread * 0.11
      + focusWeaveBias
    ) * height * sample.signedFocusDistance * sample.focusWeaveEnvelope;
    const strandRipple = animated
      ? Math.sin(time * 0.54 + family.phase + sample.progress * 4.8 + strandPosition * 6.4)
        * height * 0.0028 * sample.centerEnvelope
      : 0;
    const organicRipple = animated
      ? Math.sin(
        time * 0.54
          + curvePhase
          + sample.normalizedDistance * Math.PI * (1.35 + curveSeedD * 0.85),
      ) * organicMotionAmplitude * sample.sideEnvelope
      : 0;
    const offset = strandPosition * family.spread * height * sample.spreadScale
      + strandSideArc
      + strandContour
      + focusWeave
      + sample.sharedFlow
      + strandRipple
      + organicRipple;
    const x = sample.x + sample.normalX * offset;
    const y = sample.y + sample.normalY * offset;
    points.push({ progress: sample.progress, x, y });
  }
  return points;
}

function traceStrandCenterline(
  context: CanvasRenderingContext2D,
  points: StrandPoint[],
) {
  context.beginPath();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
}

function traceVariableWidthStrand(
  context: CanvasRenderingContext2D,
  points: StrandPoint[],
  familyIndex: number,
  strandIndex: number,
  baseWidth: number,
  time: number,
  animated: boolean,
) {
  const widthPhaseA = strandVariation(familyIndex + 31, strandIndex + 37) * Math.PI * 2;
  const widthPhaseB = strandVariation(familyIndex + 43, strandIndex + 53) * Math.PI * 2;
  const motionOffset = animated ? time * 0.12 : 0;
  const edges = points.map((point, index) => {
    const previousPoint = points[Math.max(0, index - 1)];
    const nextPoint = points[Math.min(points.length - 1, index + 1)];
    const tangentX = nextPoint.x - previousPoint.x;
    const tangentY = nextPoint.y - previousPoint.y;
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
    const widthScale = Math.max(
      0.52,
      0.92
        + Math.sin(point.progress * Math.PI * 2.1 + widthPhaseA + motionOffset) * 0.28
        + Math.sin(point.progress * Math.PI * 4.6 + widthPhaseB - motionOffset * 0.6) * 0.11,
    );
    const halfWidth = baseWidth * widthScale * 0.5;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    return {
      upperX: point.x + normalX * halfWidth,
      upperY: point.y + normalY * halfWidth,
      lowerX: point.x - normalX * halfWidth,
      lowerY: point.y - normalY * halfWidth,
    };
  });

  context.beginPath();
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (index === 0) context.moveTo(edge.upperX, edge.upperY);
    else context.lineTo(edge.upperX, edge.upperY);
  }
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index];
    context.lineTo(edge.lowerX, edge.lowerY);
  }
  context.closePath();
}

function strandVariation(familyIndex: number, strandIndex: number) {
  const value = Math.sin((familyIndex + 1) * 97.13 + (strandIndex + 1) * 41.73) * 43758.5453;
  return value - Math.floor(value);
}

function clusteredStrandPosition(familyIndex: number, strandIndex: number, strandCount: number) {
  if (strandCount <= 1) return 0;
  const linearPosition = strandIndex / (strandCount - 1) * 2 - 1;
  const clusteredPosition = Math.sign(linearPosition) * Math.pow(Math.abs(linearPosition), 1.14);
  const strandSpacing = 2 / (strandCount - 1);
  const irregularity = Math.sin((strandIndex + 1) * 2.17 + familyIndex * 0.93)
    * strandSpacing
    * 0.28
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
      pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        width < 900 ? 1 : animated ? 1.1 : 1.25,
      );
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

      const familyGeometries = WAVE_FAMILIES.map((_, familyIndex) => (
        buildFamilyGeometry(width, height, familyIndex, time, animated)
      ));

      context.save();
      applyWaveTransform(context, width, height);

      context.globalCompositeOperation = theme === "dark" ? "screen" : "source-over";
      context.strokeStyle = glowPaint;
      context.lineCap = "round";
      context.lineJoin = "round";

      for (let familyIndex = 0; familyIndex < WAVE_FAMILIES.length; familyIndex += 1) {
        const family = WAVE_FAMILIES[familyIndex];
        const centerline = buildFamilyStrandPoints(
          height,
          familyIndex,
          familyGeometries[familyIndex],
          0,
          -1,
          time,
          animated,
        );
        traceStrandCenterline(context, centerline);
        context.globalAlpha = family.weight * (theme === "dark" ? 0.045 : 0.035);
        context.lineWidth = (theme === "dark" ? 72 : 52) * (0.72 + family.weight * 0.28);
        context.shadowColor = theme === "dark" ? "rgba(132, 184, 247, 0.34)" : "rgba(48, 96, 184, 0.14)";
        context.shadowBlur = theme === "dark" ? 28 : 18;
        context.stroke();
        context.globalAlpha = family.weight * (theme === "dark" ? 0.075 : 0.055);
        context.lineWidth = (theme === "dark" ? 34 : 25) * (0.74 + family.weight * 0.26);
        context.shadowColor = theme === "dark" ? "rgba(153, 198, 255, 0.3)" : "rgba(60, 107, 188, 0.14)";
        context.shadowBlur = theme === "dark" ? 18 : 12;
        context.stroke();
      }

      context.shadowBlur = 0;
      context.fillStyle = wavePaint;
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

          const strandPoints = buildFamilyStrandPoints(
            height,
            familyIndex,
            familyGeometries[familyIndex],
            strandPosition,
            strandIndex,
            time,
            animated,
          );
          traceVariableWidthStrand(
            context,
            strandPoints,
            familyIndex,
            strandIndex,
            strandWidth * 1.85,
            time,
            animated,
          );
          context.fillStyle = wavePaint;
          context.globalAlpha = strandAlpha * 0.44;
          context.fill();
          traceVariableWidthStrand(
            context,
            strandPoints,
            familyIndex,
            strandIndex,
            strandWidth * 0.72,
            time,
            animated,
          );
          context.fillStyle = flowPaint;
          context.globalAlpha = strandAlpha * 0.9;
          context.fill();

          if (animated) {
            const pulseOffset = strandVariation(familyIndex + 61, strandIndex + 67);
            const pulseSpeedSeed = strandVariation(familyIndex + 71, strandIndex + 73);
            const pulseSpeed = 0.0375 + pulseSpeedSeed * 0.0175;
            const pulseProgress = ((time * pulseSpeed + pulseOffset * 1.24) % 1.3) - 0.15;
            const pulseX = pulseProgress * width;
            const pulseRadius = width * (0.3 + pulseSpeedSeed * 0.14);
            const pulsePaint = context.createLinearGradient(
              pulseX - pulseRadius,
              0,
              pulseX + pulseRadius,
              0,
            );
            pulsePaint.addColorStop(0, "rgba(255, 255, 255, 0)");
            pulsePaint.addColorStop(
              0.28,
              theme === "dark" ? "rgba(145, 199, 248, 0.08)" : "rgba(54, 94, 180, 0.06)",
            );
            pulsePaint.addColorStop(
              0.46,
              theme === "dark" ? "rgba(202, 233, 255, 0.58)" : "rgba(43, 84, 177, 0.4)",
            );
            pulsePaint.addColorStop(
              0.5,
              theme === "dark" ? "rgba(239, 249, 255, 0.98)" : "rgba(31, 72, 166, 0.78)",
            );
            pulsePaint.addColorStop(
              0.54,
              theme === "dark" ? "rgba(194, 229, 255, 0.54)" : "rgba(48, 89, 181, 0.36)",
            );
            pulsePaint.addColorStop(
              0.72,
              theme === "dark" ? "rgba(132, 190, 242, 0.07)" : "rgba(60, 100, 184, 0.05)",
            );
            pulsePaint.addColorStop(1, "rgba(255, 255, 255, 0)");
            const pulseStrength = 0.82
              + Math.sin(time * 0.62 + pulseOffset * Math.PI * 2) * 0.18;

            traceVariableWidthStrand(
              context,
              strandPoints,
              familyIndex,
              strandIndex,
              strandWidth * 2.15,
              time,
              animated,
            );
            context.fillStyle = pulsePaint;
            context.globalAlpha = strandAlpha * pulseStrength * 0.2;
            context.fill();
            traceVariableWidthStrand(
              context,
              strandPoints,
              familyIndex,
              strandIndex,
              strandWidth * 0.95,
              time,
              animated,
            );
            context.fillStyle = pulsePaint;
            context.globalAlpha = strandAlpha * pulseStrength * 0.82;
            context.fill();
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

  return animated ? (
    <canvas
      ref={canvasRef}
      className="liquid-wave-background"
      data-animated="true"
      aria-hidden="true"
    />
  ) : null;
}
