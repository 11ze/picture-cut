import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clamp, isCustom, maxCrop, nudge, pixelRect, resize } from "../src/crop";
import { RATIOS, type Crop } from "../src/state";

const ratio = (key: string) => RATIOS.find((r) => r.key === key)!;

// The same table Go's internal/crop reads, so the page's px match the file.
describe("pixelRect", () => {
  const cases = JSON.parse(
    readFileSync(new URL("../testdata/crop-cases.json", import.meta.url), "utf8"),
  ) as Array<{
    name: string;
    imgW: number;
    imgH: number;
    x: number;
    y: number;
    w: number;
    h: number;
    want: { x: number; y: number; w: number; h: number };
  }>;

  for (const c of cases) {
    test(c.name, () => {
      expect(pixelRect(c.imgW, c.imgH, c)).toEqual(c.want);
    });
  }
});

describe("maxCrop", () => {
  test("16:9 of a wider image keeps the image height", () => {
    const c = maxCrop(2400, 1489, ratio("16:9"));
    expect(Math.round(c.w * 2400)).toBe(2400);
    expect(Math.round(c.h * 1489)).toBe(1350);
    expect(c.x).toBe(0);
    expect(c.y).toBeCloseTo((1489 - 1350) / 2 / 1489, 10);
  });

  test("1:1 of a portrait image keeps the image width", () => {
    const c = maxCrop(1200, 1600, ratio("1:1"));
    expect(Math.round(c.w * 1200)).toBe(1200);
    expect(Math.round(c.h * 1600)).toBe(1200);
    expect(c.y).toBeCloseTo((1600 - 1200) / 2 / 1600, 10);
  });

  test("a crop never exceeds the image", () => {
    for (const r of RATIOS) {
      for (const [w, h] of [
        [2400, 1489],
        [2400, 1617],
        [4032, 3024],
        [800, 1200],
      ] as const) {
        const c = maxCrop(w, h, r);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-12);
        expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

describe("resize", () => {
  test("a corner drag keeps the ratio in pixels", () => {
    const start: Crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const c = resize(start, "se", 600, 500, 1000, 800, ratio("1:1"));
    expect(c).toEqual({ x: 0.25, y: 0.25, w: 0.35, h: 0.4375 });
    expect(Math.round(c.w * 1000)).toBe(Math.round(c.h * 800));
  });

  test("the dominant axis decides the width and the image bounds the drag", () => {
    const start: Crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const c = resize(start, "se", 520, 600, 1000, 800, ratio("1:1"));
    expect(c.x).toBeCloseTo(0.25, 10);
    expect(c.y).toBeCloseTo(0.25, 10);
    expect(c.w).toBeCloseTo(0.4, 10);
    expect(c.h).toBeCloseTo(0.5, 10);
  });

  test("dragging past the edge stops at the image", () => {
    const start: Crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const c = resize(start, "nw", -500, -400, 1000, 800, ratio("4:3"));
    expect(c.x).toBe(0);
    // The 4:3 box keeps it 46.875px below the top edge; the anchor pins it.
    expect(c.y).toBeCloseTo(0.046875, 10);
    expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-12);
    expect(Math.round(c.w * 1000) / Math.round(c.h * 800)).toBeCloseTo(4 / 3, 2);
  });
});

describe("nudge", () => {
  test("moves by the step and stops at the edge", () => {
    const start: Crop = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(nudge(start, -1, 0, 0.002).x).toBe(0);
    expect(nudge(start, 1, 0, 0.002).x).toBeCloseTo(0.002, 10);
    const far = nudge(start, 1000, 0, 0.002);
    expect(far.x).toBeCloseTo(0.5, 10);
  });
});

describe("isCustom", () => {
  test("the centered default is not custom", () => {
    const m = maxCrop(2400, 1489, ratio("16:9"));
    expect(isCustom(m, m)).toBe(false);
    expect(isCustom({ ...m, x: m.x + 0.001 }, m)).toBe(true);
  });
});

describe("clamp", () => {
  test("bounds both ways", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
