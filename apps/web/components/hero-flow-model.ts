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

    return {
      amplitude: 0.52 + random() * 0.48,
      alpha: 0.19 + random() * 0.42,
      frequency: 0.72 + random() * 0.7,
      offset: orderedOffset + (random() - 0.5) * 0.035,
      phase: random() * Math.PI * 2,
      thickness: 0.55 + random() * 0.9,
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
  const baseX = cubicBezier(
    -width * 0.08,
    width * 0.3,
    width * 0.42,
    width * 1.08,
    progress,
  );
  const baseY = cubicBezier(
    height * (0.78 + offset * 0.32),
    height * (0.82 + offset * 0.12),
    height * (0.58 - offset * 0.08),
    height * (0.31 + offset * 1.02),
    progress,
  );
  const motionEnvelope = Math.sin(Math.PI * progress);
  const sweep =
    Math.sin(
      elapsedMs * 0.00022 + strand.phase * 0.24 + progress * Math.PI * 1.35,
    ) *
    width *
    0.012 *
    strand.amplitude *
    motionEnvelope;
  const morph =
    Math.sin(
      elapsedMs * 0.00034 +
        strand.phase +
        progress * Math.PI * 2 * strand.frequency,
    ) *
    height *
    0.052 *
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
