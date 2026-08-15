import { describe, expect, it } from "vitest";
import {
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
