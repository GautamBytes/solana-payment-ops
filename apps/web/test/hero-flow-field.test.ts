import { describe, expect, it } from "vitest";
import {
  FLOW_FOCUS_PROGRESS,
  createFlowStrands,
  flowPoint,
  shouldAnimateFlow,
} from "../components/hero-flow-model";

describe("PayOps hero flow field", () => {
  it("creates the same 24-strand desktop field for the same seed", () => {
    const first = createFlowStrands(24, 2025);
    const second = createFlowStrands(24, 2025);

    expect(first).toHaveLength(24);
    expect(second).toEqual(first);
    expect(new Set(first.map((strand) => strand.phase)).size).toBeGreaterThan(
      20,
    );
  });

  it("morphs a strand slowly without moving its anchored start", () => {
    const [strand] = createFlowStrands(1, 2025);
    expect(strand).toBeDefined();
    if (!strand) throw new Error("Expected one flow strand");

    const startA = flowPoint(strand, 0, 0, 1440, 900);
    const startB = flowPoint(strand, 0, 6_000, 1440, 900);
    const middleA = flowPoint(strand, 0.56, 0, 1440, 900);
    const middleB = flowPoint(strand, 0.56, 6_000, 1440, 900);

    expect(startB).toEqual(startA);
    expect(middleB).not.toEqual(middleA);
    const distance = Math.hypot(middleB.x - middleA.x, middleB.y - middleA.y);
    expect(distance).toBeGreaterThan(20);
    expect(distance).toBeLessThan(80);
  });

  it("fans behind and ahead of a shared payment-truth focal point", () => {
    const strands = createFlowStrands(24, 2025);
    const width = 1440;
    const height = 900;
    const starts = strands.map((strand) =>
      flowPoint(strand, 0, 0, width, height),
    );
    const focus = strands.map((strand) =>
      flowPoint(strand, FLOW_FOCUS_PROGRESS, 0, width, height),
    );
    const ends = strands.map((strand) =>
      flowPoint(strand, 1, 0, width, height),
    );

    expect(Math.max(...starts.map((point) => point.x))).toBeLessThan(
      -width * 0.1,
    );
    expect(Math.min(...ends.map((point) => point.x))).toBeGreaterThan(
      width * 1.1,
    );
    expect(Math.max(...focus.map((point) => point.x))).toBeLessThan(
      width * 0.48,
    );
    expect(Math.min(...focus.map((point) => point.x))).toBeGreaterThan(
      width * 0.38,
    );

    const focusSpread =
      Math.max(...focus.map((point) => point.y)) -
      Math.min(...focus.map((point) => point.y));
    const startSpread =
      Math.max(...starts.map((point) => point.y)) -
      Math.min(...starts.map((point) => point.y));
    const endSpread =
      Math.max(...ends.map((point) => point.y)) -
      Math.min(...ends.map((point) => point.y));

    expect(focusSpread).toBeLessThan(height * 0.08);
    expect(startSpread).toBeGreaterThan(height * 0.28);
    expect(endSpread).toBeGreaterThan(height * 0.72);
  });

  it("animates only while visible and motion is allowed", () => {
    expect(
      shouldAnimateFlow({
        isIntersecting: true,
        isPageVisible: true,
        prefersReducedMotion: false,
      }),
    ).toBe(true);
    expect(
      shouldAnimateFlow({
        isIntersecting: true,
        isPageVisible: true,
        prefersReducedMotion: true,
      }),
    ).toBe(false);
    expect(
      shouldAnimateFlow({
        isIntersecting: false,
        isPageVisible: true,
        prefersReducedMotion: false,
      }),
    ).toBe(false);
    expect(
      shouldAnimateFlow({
        isIntersecting: true,
        isPageVisible: false,
        prefersReducedMotion: false,
      }),
    ).toBe(false);
  });
});
