// Crop geometry: the largest crop of a ratio, a corner drag, an arrow nudge,
// and the pixel rectangle Go writes. PixelRect matches internal/crop.
import type { Crop, Ratio } from "./state";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The largest crop of ratio r that fits an image, centered. */
export function maxCrop(w: number, h: number, r: Ratio): Crop {
  const value = r.w / r.h;
  let cw: number;
  let ch: number;
  if (w / h > value) {
    ch = h;
    cw = Math.round(h * value);
  } else {
    cw = w;
    ch = Math.round(w / value);
  }
  return {
    x: (w - cw) / 2 / w,
    y: (h - ch) / 2 / h,
    w: cw / w,
    h: ch / h,
  };
}

/** Whether c differs from the centered default; it then shows as 手动. */
export function isCustom(c: Crop, m: Crop): boolean {
  return (
    Math.abs(c.x - m.x) > 0.0005 ||
    Math.abs(c.y - m.y) > 0.0005 ||
    Math.abs(c.w - m.w) > 0.0005 ||
    Math.abs(c.h - m.h) > 0.0005
  );
}

/** The pixel rectangle of c, as Go computes it. */
export function pixelRect(
  imgW: number,
  imgH: number,
  c: Crop,
): { x: number; y: number; w: number; h: number } {
  if (imgW <= 0 || imgH <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const w = clamp(Math.round(c.w * imgW), 1, imgW);
  const h = clamp(Math.round(c.h * imgH), 1, imgH);
  const x = clamp(Math.round(c.x * imgW), 0, imgW - w);
  const y = clamp(Math.round(c.y * imgH), 0, imgH - h);
  return { x, y, w, h };
}

/**
 * Resizes c by dragging a corner to (px, py), keeping the ratio: the dominant
 * axis decides the new width, and the box stays inside the image.
 */
export function resize(
  c: Crop,
  corner: string,
  px: number,
  py: number,
  rectW: number,
  rectH: number,
  r: Ratio,
): Crop {
  const value = r.w / r.h;
  const west = corner.includes("w");
  const north = corner.includes("n");
  const ax = (west ? c.x + c.w : c.x) * rectW;
  const ay = (north ? c.y + c.h : c.y) * rectH;
  const maxW = west ? ax : rectW - ax;
  const maxH = north ? ay : rectH - ay;
  const limit = Math.min(maxW, maxH * value);
  const minW = Math.min(40, limit);
  const w = clamp(Math.max(Math.abs(px - ax), Math.abs(py - ay) * value), minW, limit);
  const h = w / value;
  return {
    x: clamp((west ? ax - w : ax) / rectW, 0, 1 - w / rectW),
    y: clamp((north ? ay - h : ay) / rectH, 0, 1 - h / rectH),
    w: w / rectW,
    h: h / rectH,
  };
}

/** Moves c by (dx, dy) fractions of the image, inside the image. */
export function nudge(c: Crop, dx: number, dy: number, step: number): Crop {
  return {
    x: clamp(c.x + dx * step, 0, 1 - c.w),
    y: clamp(c.y + dy * step, 0, 1 - c.h),
    w: c.w,
    h: c.h,
  };
}
