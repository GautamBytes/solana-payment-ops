export interface FlowStrand {
  amplitude: number;
  alpha: number;
  frequency: number;
  offset: number;
  phase: number;
  thickness: number;
}

interface FlowAnimationState {
  isIntersecting: boolean;
  isPageVisible: boolean;
  prefersReducedMotion: boolean;
}

export const FLOW_FOCUS_PROGRESS = 0.46;

export function flowGeometryHeight(stageHeight: number, railHeight: number) {
  const safeStageHeight = Number.isFinite(stageHeight)
    ? Math.max(1, stageHeight)
    : 1;
  const safeRailHeight = Number.isFinite(railHeight)
    ? Math.max(0, railHeight)
    : 0;

  return Math.max(1, safeStageHeight - safeRailHeight);
}

function createRandom(seed: number) {
  let value = seed >>> 0;

  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createFlowStrands(count = 24, seed = 2025): FlowStrand[] {
  const random = createRandom(seed);

  return Array.from({ length: count }, (_, index) => {
    const orderedOffset = count === 1 ? 0 : index / (count - 1) - 0.5;
    const isPrimary = index % 5 === 0;

    return {
      amplitude: 0.52 + random() * 0.48,
      alpha: (isPrimary ? 0.3 : 0.18) + random() * 0.4,
      frequency: 0.72 + random() * 0.7,
      offset: orderedOffset + (random() - 0.5) * 0.035,
      phase: random() * Math.PI * 2,
      thickness: isPrimary ? 1.35 + random() * 0.85 : 0.72 + random() * 0.88,
    };
  });
}

function cubicBezier(
  start: number,
  controlA: number,
  controlB: number,
  end: number,
  progress: number,
) {
  const inverse = 1 - progress;
  return (
    inverse ** 3 * start +
    3 * inverse ** 2 * progress * controlA +
    3 * inverse * progress ** 2 * controlB +
    progress ** 3 * end
  );
}

export function flowPoint(
  strand: FlowStrand,
  progress: number,
  elapsedMs: number,
  width: number,
  height: number,
) {
  const offset = strand.offset;
  const isBack = progress <= FLOW_FOCUS_PROGRESS;
  const segmentProgress = isBack
    ? progress / FLOW_FOCUS_PROGRESS
    : (progress - FLOW_FOCUS_PROGRESS) / (1 - FLOW_FOCUS_PROGRESS);
  const baseX = isBack
    ? cubicBezier(
        -width * 0.18,
        width * 0.04,
        width * 0.32,
        width * 0.43,
        segmentProgress,
      )
    : cubicBezier(
        width * 0.43,
        width * 0.58,
        width * 0.82,
        width * 1.18,
        segmentProgress,
      );
  const baseY = isBack
    ? cubicBezier(
        height * (0.9 + offset * 0.48),
        height * (0.86 + offset * 0.32),
        height * (0.76 + offset * 0.08),
        height * 0.78,
        segmentProgress,
      )
    : cubicBezier(
        height * 0.78,
        height * (0.7 - offset * 0.04),
        height * (0.45 + offset * 0.5),
        height * (0.28 + offset * 1.34),
        segmentProgress,
      );
  const motionEnvelope = Math.sin(Math.PI * segmentProgress);
  const sweep =
    Math.sin(
      elapsedMs * 0.00022 +
        strand.phase * 0.24 +
        segmentProgress * Math.PI * 1.35,
    ) *
    width *
    0.011 *
    strand.amplitude *
    motionEnvelope;
  const morph =
    Math.sin(
      elapsedMs * 0.00034 +
        strand.phase +
        segmentProgress * Math.PI * 2 * strand.frequency,
    ) *
    height *
    0.047 *
    strand.amplitude *
    motionEnvelope;
  const breathing =
    Math.sin(elapsedMs * 0.00018 + strand.phase * 0.45) *
    height *
    0.012 *
    offset *
    motionEnvelope;

  return { x: baseX + sweep, y: baseY + morph + breathing };
}

export function shouldAnimateFlow({
  isIntersecting,
  isPageVisible,
  prefersReducedMotion,
}: FlowAnimationState) {
  return isIntersecting && isPageVisible && !prefersReducedMotion;
}
