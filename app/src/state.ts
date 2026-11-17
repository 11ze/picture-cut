// The list, the per-image crop, and the shared output settings of the window.
import type { Image } from "./mygo";

export type Ratio = {
  key: string;
  w: number;
  h: number;
  use: string;
  gw: number;
  gh: number;
};

/** The design's nine ratios, in the inspector's order. */
export const RATIOS: Ratio[] = [
  { key: "16:9", w: 16, h: 9, use: "桌面壁纸", gw: 22, gh: 12 },
  { key: "9:16", w: 9, h: 16, use: "手机壁纸", gw: 12, gh: 21 },
  { key: "9:19.5", w: 9, h: 19.5, use: "全面屏手机", gw: 10, gh: 22 },
  { key: "1:1", w: 1, h: 1, use: "头像", gw: 17, gh: 17 },
  { key: "4:3", w: 4, h: 3, use: "平板", gw: 21, gh: 16 },
  { key: "3:4", w: 3, h: 4, use: "竖版", gw: 16, gh: 21 },
  { key: "3:2", w: 3, h: 2, use: "相机", gw: 22, gh: 15 },
  { key: "2:3", w: 2, h: 3, use: "竖拍", gw: 15, gh: 22 },
  { key: "21:9", w: 21, h: 9, use: "超宽屏", gw: 24, gh: 10 },
];

/** A crop in fractions of the image. */
export type Crop = { x: number; y: number; w: number; h: number };

/** The shared quality tier. */
export type Quality = "compressed" | "high";

export const state = {
  docs: [] as Image[],
  selectedId: null as string | null,
  /** Per image: the chosen ratio key. */
  ratios: new Map<string, string>(),
  /** Per image: the crop, in fractions of the image. */
  crops: new Map<string, Crop>(),
  /** Per image: excluded from saving, while its crop is kept. */
  excluded: new Set<string>(),
  /** Per image: the output file name Go will write. */
  names: new Map<string, string>(),
  quality: "compressed" as Quality,
  inPlace: true,
  outDir: "",
  importing: false,
};

export function doc(): Image | null {
  return state.docs.find((d) => d.id === state.selectedId) ?? state.docs[0] ?? null;
}

export function isApplied(d: Image | null): boolean {
  return Boolean(d) && !state.excluded.has((d as Image).id);
}

export function appliedDocs(): Image[] {
  return state.docs.filter((d) => isApplied(d));
}

export function ratio(d: Image | null = doc()): Ratio {
  const key = d ? state.ratios.get(d.id) : undefined;
  return RATIOS.find((r) => r.key === key) ?? RATIOS[0]!;
}

export function totalBytes(): number {
  return state.docs.reduce((sum, d) => sum + d.bytes, 0);
}

export function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
