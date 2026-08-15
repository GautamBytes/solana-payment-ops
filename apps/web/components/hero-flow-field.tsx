"use client";

import { useEffect, useRef } from "react";
import {
  createFlowStrands,
  flowGeometryHeight,
  flowPoint,
  shouldAnimateFlow,
} from "./hero-flow-model";

const DESKTOP_STRAND_COUNT = 40;
const MOBILE_STRAND_COUNT = 24;
const FIELD_RESOLUTION = 80;
const PARTICLE_STRAND_INDEX = 14;
const DESKTOP_STRANDS = createFlowStrands(DESKTOP_STRAND_COUNT, 2025);
const MOBILE_STRANDS = createFlowStrands(MOBILE_STRAND_COUNT, 2025);

function drawFlowField(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  elapsedMs: number,
) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const stageHeight = Math.max(1, bounds.height);
  const heroHeight =
    canvas.parentElement
      ?.querySelector<HTMLElement>(".hero")
      ?.getBoundingClientRect().height ?? stageHeight;
  const railHeight = Math.max(0, stageHeight - heroHeight);
  const flowHeight = flowGeometryHeight(stageHeight, railHeight);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const renderWidth = Math.round(width * pixelRatio);
  const renderHeight = Math.round(stageHeight * pixelRatio);

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, stageHeight);
  context.globalCompositeOperation = "lighter";

  const strands = width < 720 ? MOBILE_STRANDS : DESKTOP_STRANDS;
  const gradient = context.createLinearGradient(
    width * 0.08,
    flowHeight * 0.82,
    width,
    flowHeight * 0.12,
  );
  gradient.addColorStop(0, "#0b7f61");
  gradient.addColorStop(0.42, "#18e299");
  gradient.addColorStop(0.72, "#baff24");
  gradient.addColorStop(1, "#18e299");

  for (const strand of strands) {
    context.beginPath();

    for (let step = 0; step <= FIELD_RESOLUTION; step += 1) {
      const progress = step / FIELD_RESOLUTION;
      const point = flowPoint(strand, progress, elapsedMs, width, flowHeight);

      if (step === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }

    context.globalAlpha = strand.alpha;
    context.lineWidth = strand.thickness;
    context.strokeStyle = gradient;
    context.stroke();
  }

  const particleStrand = strands[PARTICLE_STRAND_INDEX % strands.length];
  if (!particleStrand) return;
  const particleHead = (elapsedMs * 0.000075 + 0.11) % 1;
  const particleTail = Math.max(0, particleHead - 0.075);
  const particleGradient = context.createLinearGradient(
    width * particleTail,
    flowHeight,
    width * particleHead,
    0,
  );
  particleGradient.addColorStop(0, "rgba(186, 255, 36, 0)");
  particleGradient.addColorStop(0.72, "rgba(186, 255, 36, 0.78)");
  particleGradient.addColorStop(1, "rgba(255, 255, 255, 0.95)");

  context.beginPath();
  for (let step = 0; step <= 18; step += 1) {
    const progress = particleTail + (particleHead - particleTail) * (step / 18);
    const point = flowPoint(
      particleStrand,
      progress,
      elapsedMs,
      width,
      flowHeight,
    );

    if (step === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }

  context.globalAlpha = 0.92;
  context.lineWidth = 2;
  context.strokeStyle = particleGradient;
  context.shadowColor = "rgba(186, 255, 36, 0.7)";
  context.shadowBlur = 9;
  context.stroke();
  context.shadowBlur = 0;
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
}

export function HeroFlowField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let isIntersecting = true;
    let isPageVisible = document.visibilityState === "visible";

    const canAnimate = () =>
      shouldAnimateFlow({
        isIntersecting,
        isPageVisible,
        prefersReducedMotion: motionQuery.matches,
      });

    const frame = (elapsedMs: number) => {
      drawFlowField(canvas, context, elapsedMs);
      if (canAnimate()) animationFrame = window.requestAnimationFrame(frame);
    };

    const restart = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      drawFlowField(
        canvas,
        context,
        motionQuery.matches ? 0 : performance.now(),
      );
      if (canAnimate()) animationFrame = window.requestAnimationFrame(frame);
    };

    const handleVisibilityChange = () => {
      isPageVisible = document.visibilityState === "visible";
      restart();
    };

    const resizeObserver = new ResizeObserver(restart);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isIntersecting = entry?.isIntersecting ?? false;
      restart();
    });

    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionQuery.addEventListener("change", restart);
    restart();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionQuery.removeEventListener("change", restart);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="hero-flow-canvas"
      data-hero-flow-field="true"
      aria-hidden="true"
    />
  );
}
