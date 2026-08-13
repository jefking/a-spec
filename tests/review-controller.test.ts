// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ReviewController } from "../src/main/review-controller";

describe("review cadence", () => {
  it("clamps and snaps cadence changes to the supported slider steps", () => {
    const controller = new ReviewController();
    expect(controller.setCadence(0)).toBe(500);
    expect(controller.setCadence(749)).toBe(500);
    expect(controller.setCadence(750)).toBe(1_000);
    expect(controller.setCadence(15_000)).toBe(10_000);
    expect(controller.getState().cadenceMs).toBe(10_000);
  });
});
