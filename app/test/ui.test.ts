// End-to-end checks of the real window in Chromium: the page runs against a
// stubbed `window.mygo`, so Go's bindings are the only thing replaced.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type FixtureImage = {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  thumb?: string;
  preview?: string;
};

// The design's own pictures, so the page renders exactly what the prototype does.
const ASSETS = join(import.meta.dir, "..", "..", "prototype", "assets");
const asset = (name: string): string => {
  const mime = name.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(join(ASSETS, name)).toString("base64")}`;
};

const CITY: FixtureImage = {
  id: "city", name: "city.jpg", width: 2400, height: 1489, bytes: 898405, format: "JPEG",
  thumb: asset("thumb-city.jpg"), preview: asset("city.jpg"),
};
const LAKE: FixtureImage = {
  id: "lake", name: "mountain-lake.jpg", width: 2400, height: 1617, bytes: 575556, format: "JPEG",
  thumb: asset("thumb-mountain-lake.jpg"),
};
const COFFEE: FixtureImage = {
  id: "coffee", name: "coffee.png", width: 2400, height: 1602, bytes: 1841607, format: "PNG",
  thumb: asset("thumb-coffee.jpg"),
};
const STREET: FixtureImage = { id: "street", name: "street.jpg", width: 4032, height: 3024, bytes: 3_100_000, format: "JPEG" };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let browser: Browser;
let server: Server;
let base = "";
const open: Page[] = [];

const appDir = join(import.meta.dir, "..");
const distDir = join(appDir, "dist");

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", "run", "build:web"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`build:web failed\n${build.stdout.toString()}\n${build.stderr.toString()}`);
  }
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    try {
      const body = await readFile(join(distDir, normalize(pathname)));
      res.writeHead(200, { "content-type": TYPES[extname(pathname)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
});

afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => {});
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await page.evaluate(() => document.fonts.ready);
}

async function openApp(images: FixtureImage[] = []): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1192, height: 710 } });
  open.push(page);
  await page.addInitScript(
    (fx: { images: FixtureImage[]; pixel: string }) => {
      const known = new Map<string, FixtureImage>();
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      let seq = 0;
      const stub = {
        images: fx.images,
        skipped: 0,
        settings: { inPlace: true, outDir: "~/Desktop/裁剪输出", quality: "compressed" },
        chooseDir: "",
        revealed: [] as string[],
        saved: null as unknown,
        canceled: false,
        fail: [] as number[],
        loaded: false,
        dropPaths: [] as string[],
        retained: () => Array.from(known.keys()),
        picks: 0,
        importCalls: 0,
        importDelay: 0,
        nameDelay: 0,
        emit(name: string, payload: unknown) {
          for (const fn of listeners.get(name) ?? []) fn(payload);
        },
      };
      (window as unknown as { __stub: typeof stub }).__stub = stub;

      const clone = (img: FixtureImage) => {
        const id = `${img.id}#${++seq}`;
        known.set(id, img);
        return { ...img, id, thumb: img.thumb ?? fx.pixel, preview: img.preview ?? fx.pixel };
      };

      const channel = (onmessage?: (value: unknown) => void) => {
        const ch = {
          onmessage: onmessage ?? null,
          onclose: null as (() => void) | null,
          closed: false,
          close() {
            this.closed = true;
            this.onclose?.();
          },
          async *[Symbol.asyncIterator]() {},
        };
        return ch;
      };

      const pick = () => ({ images: stub.images.map(clone), skipped: stub.skipped });

      const handlers: Record<string, (...args: any[]) => unknown> = {
        "Library.ReleaseImages": async (ids: string[]) => ids.forEach(id => known.delete(id)),
        "Library.PickImages": async () => {
          stub.picks++;
          return pick();
        },
        "Library.PickFolder": async () => {
          stub.picks++;
          return pick();
        },
        "Library.ImportPaths": async (paths: string[]) => {
          stub.importCalls++;
          stub.dropPaths = paths;
          if (stub.importDelay) await new Promise((r) => setTimeout(r, stub.importDelay));
          return pick();
        },
        "Library.ChooseOutputDir": async () => stub.chooseDir,
        "Library.PreviewNames": async (
          items: Array<{ id: string; ratio: string; applied: boolean }>,
          quality: string,
          inPlace: boolean,
          outDir: string,
        ) => {
          if (stub.nameDelay) await new Promise((r) => setTimeout(r, stub.nameDelay));
          // Same rule as Go: the images being written reserve names in order.
          const taken = new Map<string, Set<string>>();
          return items.map((item) => {
            const img = known.get(item.id);
            if (!img) return "";
            const dot = img.name.lastIndexOf(".");
            const stem = img.name.slice(0, dot);
            const ext = img.name.slice(dot);
            const tag =
              quality === "high" ? "" : img.format === "PNG" ? "compressed_" : "q80_";
            const head = `${stem}_${item.ratio.replace(":", "x")}_${tag}20261117-103842`;
            const base = `${head}${ext}`;
            if (!item.applied) return base;
            const dir = inPlace ? "/pics" : outDir;
            let set = taken.get(dir);
            if (!set) {
              set = new Set<string>();
              taken.set(dir, set);
            }
            let name = base;
            for (let n = 2; set.has(name); n++) name = `${head}-${n}${ext}`;
            set.add(name);
            return name;
          });
        },
        "Library.Settings": async () => {
          stub.loaded = true;
          return stub.settings;
        },
        "Library.UpdateSettings": (s: typeof stub.settings) => {
          stub.settings = s;
        },
        "Library.ShowInFolder": (path: string) => {
          stub.revealed.push(path);
        },
        "Library.Save": async (
          req: { items: unknown[]; inPlace: boolean; outDir: string },
          ch: { closed: boolean; onmessage: ((p: unknown) => void) | null },
        ) => {
          stub.saved = req;
          const total = req.items.length;
          const saved: string[] = [];
          const failed: Array<{ name: string; error: string }> = [];
          const dir = req.inPlace ? "" : req.outDir;
          const cancel = () => {
            stub.canceled = true;
            return { saved, failed, dir, canceled: true };
          };
          for (let i = 0; i < total; i++) {
            if (ch.closed) return cancel();
            await new Promise((r) => setTimeout(r, 120));
            if (ch.closed) return cancel();
            const ok = !stub.fail.includes(i);
            const error = ok ? "" : "无法读取原图";
            // Go reports every file it moved past, failed or not.
            ch.onmessage?.({ done: i + 1, total, ok, error });
            if (ok) saved.push(`${req.inPlace ? "/pics" : req.outDir}/file-${i + 1}`);
            else failed.push({ name: `file-${i + 1}`, error });
          }
          return { saved, failed, dir, canceled: false };
        },
      };

      (window as any).mygo = {
        version: "0.9.2",
        platform: "darwin",
        windowId: 1,
        locale: "zh-Hans",
        dir: "ltr",
        preferences: {
          accent: "#e8a33d",
          reduceMotion: false,
          reduceTransparency: false,
          highContrast: false,
          textScale: 1,
        },
        call: (method: string, ...args: unknown[]) => handlers[method]?.(...args),
        callWith: (method: string, args: unknown[]) => handlers[method]?.(...args),
        channel,
        on: (name: string, fn: (payload: unknown) => void) => {
          let set = listeners.get(name);
          if (!set) {
            set = new Set();
            listeners.set(name, set);
          }
          set.add(fn);
          return () => set!.delete(fn);
        },
        once: () => () => {},
        window: {
          minimize: async () => {},
          maximize: async () => {},
          unmaximize: async () => {},
          toggleMaximize: async () => {},
          isMaximized: async () => false,
          toggleFullScreen: async () => {},
          close: async () => {},
          setTitle: async () => {},
        },
      };
    },
    { images, pixel: PIXEL },
  );
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector("#side-foot") !== null);
  await page.waitForFunction(
    () => (window as unknown as { __stub: { loaded: boolean } }).__stub.loaded,
    undefined,
    { timeout: 5000 },
  );
  await settle(page);
  return page;
}

async function addImages(page: Page): Promise<void> {
  await page.locator("#add-btn").click();
  await page.locator("#add-image").click();
  await page.waitForSelector(".file");
  await settle(page);
}

/** Dispatches a drag event with one file, like a drag from Finder. */
async function dragFile(page: Page, type: string): Promise<boolean> {
  return page.evaluate((t) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1])], "one.jpg", { type: "image/jpeg" }));
    const event = new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: data });
    return !document.dispatchEvent(event);
  }, type);
}

describe("window chrome", () => {
  test("starts empty, with the design's columns", async () => {
    const page = await openApp();
    expect(await page.locator("#empty").isVisible()).toBe(true);
    expect(await page.locator("#photo").isHidden()).toBe(true);
    expect(await page.locator("#save-all").isDisabled()).toBe(true);
    expect(await page.locator("#crop-size").textContent()).toBe("未选择");
    expect(await page.locator("#ratio-hint").textContent()).toBe("添加图片后选择比例");
    expect(await page.locator("#status-crop").textContent()).toBe("未选择图片");

    const box = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return {
        win: r(".window").width,
        sidebar: r(".sidebar").width,
        inspector: r(".inspector").width,
        toolbar: r(".toolbar").height,
        status: r(".status").height,
      };
    });
    expect(box).toEqual({ win: 1192, sidebar: 236, inspector: 288, toolbar: 52, status: 28 });
  });
});

describe("import", () => {
  test("adds the picked images and selects the first", async () => {
    const page = await openApp([CITY, LAKE, STREET]);
    await addImages(page);
    expect(await page.locator(".file").count()).toBe(3);
    expect(await page.locator("#doc-title").textContent()).toBe("city.jpg");
    expect(await page.locator("#crop-size").textContent()).toBe("2400 × 1350");
    expect(await page.locator("#filename").textContent()).toBe(
      "city_16x9_q80_20261117-103842.jpg",
    );
    expect(await page.locator("#count").textContent()).toBe("3");
    expect(await page.locator("#side-foot").textContent()).toContain("3 张");
    expect(await page.locator(".file").nth(0).getAttribute("aria-current")).toBe("true");
  });

  test("reports the files it could not read", async () => {
    const page = await openApp([CITY]);
    await page.evaluate(() => {
      (window as unknown as { __stub: { skipped: number } }).__stub.skipped = 2;
    });
    await addImages(page);
    const toast = await page.locator("#toast-text").textContent();
    expect(toast).toContain("已添加 1 张");
    expect(toast).toContain("跳过 2 个文件，仅支持可读取的 JPG/JPEG、PNG");
  });

  test("adds the files dropped on the window", async () => {
    const page = await openApp([CITY, LAKE]);
    await page.evaluate(() => {
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/city.jpg", "/pics/lake.jpg"], x: 400, y: 300 },
      );
    });
    await page.waitForSelector(".file");
    await settle(page);
    expect(await page.locator(".file").count()).toBe(2);
    expect(await page.locator("#toast-text").textContent()).toContain("已添加 2 张");
    const paths = await page.evaluate(
      () => (window as unknown as { __stub: { dropPaths: string[] } }).__stub.dropPaths,
    );
    expect(paths).toEqual(["/pics/city.jpg", "/pics/lake.jpg"]);
  });

  test("shows the drop target while files are dragged over the window", async () => {
    const page = await openApp();
    expect(await page.locator("#drop").isVisible()).toBe(false);
    expect(await dragFile(page, "dragenter")).toBe(true);
    expect(await page.locator("#drop").isVisible()).toBe(true);
    await dragFile(page, "dragover");
    await page.waitForTimeout(300);
    expect(await page.locator("#drop").isVisible()).toBe(true);
    await dragFile(page, "drop");
    expect(await page.locator("#drop").isVisible()).toBe(false);
    await dragFile(page, "dragenter");
    expect(await page.locator("#drop").isVisible()).toBe(true);
    await dragFile(page, "dragleave");
    await page.waitForTimeout(300);
    expect(await page.locator("#drop").isVisible()).toBe(false);
  });

  test("refuses a drop while the save sheet is open", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.locator("#save-all").click();
    await page.locator("#sheet:not([hidden])").waitFor();
    // The drag is still accepted, or its reason would never be told, but the
    // target stays hidden.
    expect(await dragFile(page, "dragenter")).toBe(true);
    expect(await page.locator("#drop").isVisible()).toBe(false);
    await page.evaluate(() => {
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/extra.jpg"], x: 10, y: 10 },
      );
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("先完成当前操作"),
    );
    expect(await page.locator(".file").count()).toBe(1);
    const paths = await page.evaluate(
      () => (window as unknown as { __stub: { dropPaths: string[] } }).__stub.dropPaths,
    );
    expect(paths).toEqual([]);
    // The add buttons take the same guard, not only drops.
    await page.evaluate(() => {
      (window as unknown as { __stub: { picks: number } }).__stub.picks = 0;
      document.getElementById("add-image")!.click();
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("先完成当前操作"),
    );
    const picks = await page.evaluate(
      () => (window as unknown as { __stub: { picks: number } }).__stub.picks,
    );
    expect(picks).toBe(0);
  });

  test("refuses a drop while an import runs", async () => {
    const page = await openApp([CITY]);
    await page.evaluate(() => {
      (window as unknown as { __stub: { importDelay: number } }).__stub.importDelay = 300;
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/city.jpg"], x: 10, y: 10 },
      );
    });
    await page.waitForFunction(() =>
      document.querySelector("#side-foot")?.textContent?.includes("正在读取"),
    );
    await page.evaluate(() => {
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/extra.jpg"], x: 10, y: 10 },
      );
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("正在读取图片，请稍后"),
    );
    await page.waitForFunction(() =>
      document.querySelector("#side-foot")?.textContent?.includes("1 张"),
    );
    expect(await page.locator(".file").count()).toBe(1);
    const state = await page.evaluate(() => {
      const stub = (window as unknown as { __stub: { importCalls: number; dropPaths: string[] } })
        .__stub;
      return { calls: stub.importCalls, paths: stub.dropPaths };
    });
    expect(state).toEqual({ calls: 1, paths: ["/pics/city.jpg"] });
  });

  test("refuses a drop while the confirm dialog is open", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.locator("#add-btn").click();
    await page.locator("#add-clear").click();
    await page.locator("#confirm:not([hidden])").waitFor();
    await page.evaluate(() => {
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/extra.jpg"], x: 10, y: 10 },
      );
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("先完成当前操作"),
    );
    const state = await page.evaluate(() => {
      const stub = (window as unknown as { __stub: { importCalls: number; dropPaths: string[] } })
        .__stub;
      return { calls: stub.importCalls, paths: stub.dropPaths };
    });
    expect(state).toEqual({ calls: 0, paths: [] });
    expect(await page.locator(".file").count()).toBe(1);
  });

  test("reports a dropped file it cannot read", async () => {
    const page = await openApp([CITY]);
    await page.evaluate(() => {
      const stub = (window as unknown as { __stub: { images: unknown[]; skipped: number } }).__stub;
      stub.images = [];
      stub.skipped = 1;
      (stub as unknown as { emit: (name: string, payload: unknown) => void }).emit("mygo:file-drop", {
        paths: ["/pics/notes.txt"],
        x: 10,
        y: 10,
      });
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("跳过 1 个文件"),
    );
    expect(await page.locator(".file").count()).toBe(0);
  });

  test("a drop that adds nothing still says so", async () => {
    const page = await openApp();
    await dragFile(page, "drop");
    await page.waitForFunction(
      () => document.querySelector("#toast-text")?.textContent?.includes("没有可添加的图片"),
      undefined,
      { timeout: 3000 },
    );
  });

  test("a drop MyGo reports is not answered twice", async () => {
    const page = await openApp([CITY]);
    await dragFile(page, "drop");
    await page.evaluate(() => {
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/city.jpg"], x: 10, y: 10 },
      );
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("已添加 1 张"),
    );
    await page.waitForTimeout(1000);
    expect(await page.locator("#toast-text").textContent()).not.toContain("没有可添加");
  });

  test("says so when a drop has no images", async () => {
    const page = await openApp();
    await page.evaluate(() => {
      (window as unknown as { __stub: { emit: (name: string, payload: unknown) => void } }).__stub.emit(
        "mygo:file-drop",
        { paths: ["/pics/empty"], x: 10, y: 10 },
      );
    });
    await page.waitForFunction(() =>
      document.querySelector("#toast-text")?.textContent?.includes("没有找到可添加的图片"),
    );
    expect(await page.locator("#toast-info").isVisible()).toBe(true);
    expect(await page.locator(".file").count()).toBe(0);
  });
});

describe("per-image state", () => {
  test("each image keeps its own ratio and crop", async () => {
    const page = await openApp([CITY, LAKE]);
    await addImages(page);

    await page.getByRole("radio", { name: "1:1，头像", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#crop-size")?.textContent === "1489 × 1489");
    expect(await page.locator("#ratio-hint").textContent()).toBe("1:1 · 头像");

    await page.locator('.file[data-id^="lake#"]').click();
    await settle(page);
    expect(await page.locator("#ratio-hint").textContent()).toBe("16:9 · 桌面壁纸");
    expect(await page.locator("#crop-size").textContent()).toBe("2400 × 1350");

    await page.locator('.file[data-id^="city#"]').click();
    await settle(page);
    expect(await page.locator("#crop-size").textContent()).toBe("1489 × 1489");

    // A nudge on one image stays on that image when the selection changes.
    const readX = () =>
      page.evaluate(() => document.querySelector<HTMLElement>("#photo")!.style.getPropertyValue("--x"));
    const before = await readX();
    await page.locator("#crop").focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    const moved = await readX();
    expect(before).toBe("18.9792%");
    expect(moved).toBe("19.5792%");
    await page.locator('.file[data-id^="lake#"]').click();
    await settle(page);
    await page.locator('.file[data-id^="city#"]').click();
    await settle(page);
    const kept = await readX();
    expect(kept).toBe(moved);
  });

  test("the name follows the images that take part", async () => {
    const page = await openApp([CITY, { ...CITY, id: "twin" }]);
    await addImages(page);
    const name = () => page.locator("#filename").textContent();

    await page.locator('.file[data-id^="twin#"]').click();
    await settle(page);
    expect(await name()).toBe("city_16x9_q80_20261117-103842-2.jpg");

    // The first image sits out, so the twin gets the base name.
    await page.locator('.file[data-id^="city#"]').click();
    await page.locator("#apply-toggle").click();
    await page.locator('.file[data-id^="twin#"]').click();
    await settle(page);
    expect(await name()).toBe("city_16x9_q80_20261117-103842.jpg");
  });

  test("the final removed image is released after undo expires", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.clock.install();
    await page.locator(".remove").click();
    await page.clock.fastForward(6000);
    expect(await page.locator("#toast-action").isHidden()).toBe(true);
    expect(await page.evaluate(() => (window as any).__stub.retained())).toEqual([]);
  });

  test("removed images live through undo and are released when replaced or cleared", async () => {
    const page = await openApp([CITY, LAKE, COFFEE]);
    await addImages(page);
    const retained = () => page.evaluate(() => (window as any).__stub.retained());
    const ids = await retained();
    await page.locator(".remove").first().click();
    expect(await retained()).toEqual(ids);
    await page.locator("#toast-action").click();
    expect(await retained()).toEqual(ids);
    await page.locator(".remove").first().click();
    await page.locator(".remove").first().click();
    expect(await retained()).toEqual(ids.slice(1));
    await page.locator("#add-btn").click();
    await page.locator("#add-clear").click();
    await page.locator("#confirm-ok").click();
    expect(await retained()).toEqual([]);
  });

  test("removing an image frees its name", async () => {
    const page = await openApp([CITY, { ...CITY, id: "twin" }]);
    await addImages(page);
    await page.locator('.file[data-id^="twin#"]').click();
    await settle(page);
    expect(await page.locator("#filename").textContent()).toBe(
      "city_16x9_q80_20261117-103842-2.jpg",
    );

    await page.locator('.file-row[data-id^="city#"] .remove').click();
    await page.locator('.file[data-id^="twin#"]').click();
    await settle(page);
    expect(await page.locator("#filename").textContent()).toBe(
      "city_16x9_q80_20261117-103842.jpg",
    );
  });

  test("an image can sit out a save and keep its crop", async () => {
    const page = await openApp([CITY, LAKE]);
    await addImages(page);
    expect(await page.locator("#save-count").textContent()).toBe("2");

    await page.locator("#apply-toggle").click();
    expect(await page.locator("#save-count").textContent()).toBe("1");
    expect(await page.locator(".file").nth(0).getAttribute("class")).toContain("off");

    await page.locator("#save-all").click();
    await page.waitForSelector("#sheet-summary-view:not([hidden])");
    const tags = await page.locator(".sum-item .stag").allTextContents();
    expect(tags).toEqual(["不参与", "默认"]);
    expect(await page.locator("#summary-count").textContent()).toBe("1 张图片 · 1 张不参与");

    await page.locator("#summary-cancel").click();
    await page.waitForFunction(() => document.querySelector("#sheet")!.hasAttribute("hidden"));
    await page.locator("#apply-toggle").click();
    expect(await page.locator("#save-count").textContent()).toBe("2");
  });
});

describe("save", () => {
  test("saves every image in the list and reports progress", async () => {
    const page = await openApp([CITY, LAKE]);
    await addImages(page);
    // Move the crop so the request carries a crop that is not the default.
    await page.locator("#crop").focus();
    await page.keyboard.press("ArrowDown");
    await page.locator("#save-all").click();
    await page.waitForSelector("#sheet-summary-view:not([hidden])");
    expect(await page.locator("#sheet-title").textContent()).toBe("保存 2 张图片");
    expect(await page.locator(".sum-item").count()).toBe(2);

    await page.locator("#sheet-start").click();
    await page.waitForSelector("#sheet-progress-view:not([hidden])");
    expect(await page.locator("#sheet-count").textContent()).toBe("0 / 2");
    await page.waitForSelector("#sheet-done-view:not([hidden])", { timeout: 5000 });
    expect(await page.locator("#done-title").textContent()).toBe("已保存 2 个文件");
    expect(await page.locator("#sheet-count").textContent()).toBe("2 / 2");

    const request = await page.evaluate(
      () => (window as unknown as { __stub: { saved: any } }).__stub.saved,
    );
    expect(request.items.length).toBe(2);
    expect(request.items[0].ratio).toBe("16:9");
    // 16:9 on a 2400 × 1489 image: the centered box, nudged down once.
    expect(request.items[0].crop.y).toBeCloseTo(0.048676, 5);
    expect(request.items[0].crop.h).toBeCloseTo(0.906649, 5);
    expect(request.quality).toBe("compressed");
    expect(request.inPlace).toBe(true);
    expect(request.outDir).toBe("~/Desktop/裁剪输出");

    await page.locator("#sheet-reveal").click();
    const revealed = await page.evaluate(
      () => (window as unknown as { __stub: { revealed: string[] } }).__stub.revealed,
    );
    expect(revealed).toEqual(["/pics/file-1"]);

    await page.locator("#sheet-finish").click();
    await page.waitForFunction(() => document.querySelector("#sheet")!.hasAttribute("hidden"));
    expect(await page.locator("#sheet").isHidden()).toBe(true);
  });

  test("the done sheet keeps every failed file and its reason", async () => {
    const page = await openApp([CITY, LAKE, STREET]);
    await page.evaluate(() => {
      (window as unknown as { __stub: { fail: number[] } }).__stub.fail = [1, 2];
    });
    await addImages(page);
    await page.locator("#save-all").click();
    await page.waitForSelector("#sheet-summary-view:not([hidden])");
    await page.locator("#sheet-start").click();
    await page.waitForSelector("#sheet-done-view:not([hidden])", { timeout: 5000 });

    expect(await page.locator("#sheet-title").textContent()).toBe("保存未全部完成");
    expect(await page.locator("#done-title").textContent()).toBe("已保存 1 个文件，2 个失败");
    expect(await page.locator("#sheet-count").textContent()).toBe("3 / 3");
    expect(await page.locator("#sheet-pct").textContent()).toBe("100%");
    const states = await page.locator(".save-item").evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.state),
    );
    expect(states).toEqual(["done", "failed", "failed"]);
    expect(await page.getByText("查看失败文件").count()).toBe(1);
    await page.getByText("查看失败文件").click();
    expect(await page.locator("#sheet-done-view li").allTextContents()).toEqual(["file-2：无法读取原图", "file-3：无法读取原图"]);
    expect(await page.locator("#toast-text").textContent()).toContain("file-2：无法读取原图");
  });

  test("cancelling stops the run and closes the sheet", async () => {
    const page = await openApp([CITY, LAKE, STREET]);
    await addImages(page);
    await page.locator("#save-all").click();
    await page.waitForSelector("#sheet-summary-view:not([hidden])");
    await page.locator("#sheet-start").click();
    await page.waitForSelector("#sheet-progress-view:not([hidden])");
    await page.locator("#sheet-cancel").click();
    await page.waitForFunction(() => document.querySelector("#sheet")!.hasAttribute("hidden"), undefined, {
      timeout: 4000,
    });
    const canceled = await page.evaluate(
      () => (window as unknown as { __stub: { canceled: boolean } }).__stub.canceled,
    );
    expect(canceled).toBe(true);
    expect(await page.locator("#sheet-done-view").isHidden()).toBe(true);
  });

  test("closing the sheet while it opens leaves it closed", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.evaluate(() => {
      (window as unknown as { __stub: { nameDelay: number } }).__stub.nameDelay = 300;
    });
    await page.locator("#save-all").click();
    await page.waitForTimeout(50);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    expect(await page.locator("#sheet").isHidden()).toBe(true);
    // The window did not lose its open guard: Cmd+S opens the sheet again.
    await page.locator("#save-all").click();
    await page.locator("#sheet:not([hidden])").waitFor();
  });
});

describe("design parity", () => {
  test("the window matches the prototype, below the title bar", async () => {
    const proto = await browser.newPage({ viewport: { width: 1240, height: 820 } });
    open.push(proto);
    const protoUrl = pathToFileURL(join(appDir, "..", "prototype", "index.html")).href;
    await proto.goto(protoUrl);
    await proto.locator("#photo-img").evaluate((img) => (img as HTMLImageElement).decode());
    await proto.mouse.move(2, 2);
    await settle(proto);
    const expected = await proto.locator("#window").screenshot();

    const page = await openApp([CITY, LAKE, COFFEE]);
    await page.locator("#add-btn").click();
    await page.locator("#add-image").click();
    await page.waitForSelector(".file");
    await page.locator("#photo-img").evaluate((img) => (img as HTMLImageElement).decode());
    await page.mouse.move(2, 2);
    // The import toast takes 2.4s to leave; both windows must be at rest.
    await page.waitForTimeout(2600);
    await settle(page);
    const actual = await page.locator("#window").screenshot();

    const result = await grade(actual, expected);
    expect(result.size).toEqual([1192, 710, 1192, 710]);
    expect(result.ratio, result.worst).toBeLessThan(0.002);

  });
});

/** Compares two PNG screenshots pixel by pixel, ignoring the title bar. */
async function grade(
  actual: Buffer,
  expected: Buffer,
): Promise<{ size: number[]; ratio: number; worst: string }> {
  const page = await browser.newPage();
  const data = await page.evaluate(
    async ({ a, b }: { a: string; b: string }) => {
      const load = async (base64: string) => {
        const res = await fetch(`data:image/png;base64,${base64}`);
        return createImageBitmap(await res.blob());
      };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { size: [ia.width, ia.height, ib.width, ib.height], ratio: 1, worst: "" };
      }
      const read = (img: ImageBitmap) => {
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const pa = read(ia);
      const pb = read(ib);
      let diff = 0;
      const rows = new Map<number, number>();
      for (let y = 52; y < ia.height; y++) {
        for (let x = 0; x < ia.width; x++) {
          const i = (y * ia.width + x) * 4;
          const d = Math.max(
            Math.abs(pa[i]! - pb[i]!),
            Math.abs(pa[i + 1]! - pb[i + 1]!),
            Math.abs(pa[i + 2]! - pb[i + 2]!),
          );
          if (d > 8) {
            diff++;
            rows.set(y, (rows.get(y) ?? 0) + 1);
          }
        }
      }
      const worst = [...rows.entries()]
        .sort((l, r) => r[1] - l[1])
        .slice(0, 3)
        .map(([y, n]) => `y=${y}:${n}`)
        .join(", ");
      const area = ia.width * (ia.height - 52);
      return { size: [ia.width, ia.height, ib.width, ib.height], ratio: diff / area, worst };
    },
    { a: actual.toString("base64"), b: expected.toString("base64") },
  );
  await page.close();
  return data;
}

describe("batch and keyboard", () => {
  test("Tab stays inside the save sheet and the background is inert", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.locator("#save-all").click();
    await page.locator("#sheet:not([hidden])").waitFor();
    for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("#sheet")))).toBe(true);
    expect(
      await page.evaluate(() => (document.querySelector(".toolbar") as HTMLElement).inert),
    ).toBe(true);
  });

  test("Tab stays inside the confirm dialog", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.locator("#add-btn").click();
    await page.locator("#add-clear").click();
    await page.locator("#confirm:not([hidden])").waitFor();
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("#confirm")))).toBe(true);
    expect(
      await page.evaluate(() => (document.querySelector(".toolbar") as HTMLElement).inert),
    ).toBe(true);
  });

  test("the toast action is unavailable while a modal is open", async () => {
    const page = await openApp([CITY, LAKE, COFFEE]);
    await addImages(page);

    await page.locator(".file-row").first().locator(".remove").click();
    await page.locator("#save-all").click();
    await page.locator("#sheet:not([hidden])").waitFor();
    expect(
      await page.evaluate(() => (document.querySelector("#toast-action") as HTMLElement).inert),
    ).toBe(true);
    expect(await page.locator("#toast-action").isVisible()).toBe(false);

    await page.locator("#summary-cancel").click();
    await page.locator("#sheet").waitFor({ state: "hidden" });
    await page.locator(".file-row").first().locator(".remove").click();
    await page.locator("#add-btn").click();
    await page.locator("#add-clear").click();
    await page.locator("#confirm:not([hidden])").waitFor();
    expect(
      await page.evaluate(() => (document.querySelector("#toast-action") as HTMLElement).inert),
    ).toBe(true);
    expect(await page.locator("#toast-action").isVisible()).toBe(false);
  });

  test("the ratio group has no apply-to-all control", async () => {
    const page = await openApp([CITY, LAKE]);
    await addImages(page);
    expect(await page.locator("#ratio-all").count()).toBe(0);
    expect(await page.getByRole("button", { name: "应用到全部" }).count()).toBe(0);
  });

  test("removing an image can be undone", async () => {
    const page = await openApp([CITY, LAKE]);
    await addImages(page);
    await page.locator(".file-row").first().locator(".remove").click();
    expect(await page.locator(".file").count()).toBe(1);
    await page.locator("#toast-action").click();
    expect(await page.locator(".file").count()).toBe(2);
    expect(await page.locator(".file").first().getAttribute("aria-current")).toBe("true");
  });
});

describe("copy", () => {
  test("PNG standard quality names the 256-color preview", async () => {
    const page = await openApp([COFFEE]);
    await addImages(page);
    expect(await page.locator("#quality-compressed").textContent()).toBe("256 色");
    expect(await page.locator("#quality-note").textContent()).toBe("256 色 · 保留透明背景");
    await page.locator("#save-all").click();
    await page.locator("#sheet-summary-view:not([hidden])").waitFor();
    expect(await page.locator("#summary-quality").textContent()).toBe("PNG 256 色");
  });

  test("the done sheet shows the saved result once", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    await page.locator("#save-all").click();
    await page.locator("#sheet-start").click();
    await page.waitForSelector("#sheet-done-view:not([hidden])", { timeout: 5000 });
    expect(await page.locator("#sheet-done-view .done-mark").count()).toBe(0);
    const text = await page.locator("#sheet-done-view").innerText();
    expect((text.match(/已保存/g) || []).length).toBe(1);
  });
});

describe("accessibility", () => {
  test("image rows are list items with separate remove buttons", async () => {
    const page = await openApp([CITY, LAKE]);
    await addImages(page);
    const shape = await page.evaluate(() => {
      const list = document.querySelector("#file-list")!;
      const rows = [...list.querySelectorAll(":scope > .file-row")];
      return {
        role: list.getAttribute("role"),
        rows: rows.length,
        listitems: rows.every((row) => row.getAttribute("role") === "listitem"),
        buttons: rows.every((row) =>
          row.querySelector(':scope > .file[role="button"][aria-current]'),
        ),
        pressed: rows.some((row) => row.querySelector(':scope > .file[aria-pressed]')),
        cleanAlts: rows.every(
          (row) => row.querySelector(":scope > .file img")?.getAttribute("alt") === "",
        ),
        removes: rows.every((row) =>
          row.querySelector(":scope > .remove")?.getAttribute("aria-label"),
        ),
        nested: rows.some((row) => row.querySelector(".file .remove")),
      };
    });
    expect(shape).toEqual({
      role: "list",
      rows: 2,
      listitems: true,
      buttons: true,
      pressed: false,
      cleanAlts: true,
      removes: true,
      nested: false,
    });
    expect(await page.locator(".file").first().getAttribute("aria-current")).toBe("true");
    expect(await page.locator(".file").first().getAttribute("aria-label")).toContain("当前选中");
    await page.locator(".file").nth(1).click();
    expect(await page.locator(".file").first().getAttribute("aria-current")).toBe("false");
    expect(await page.locator(".file").first().getAttribute("aria-label")).not.toContain("当前选中");
  });

  test("the ratio group exposes one checked radio", async () => {
    const page = await openApp([CITY]);
    await addImages(page);
    expect(await page.locator("#ratio-grid").getAttribute("role")).toBe("radiogroup");
    expect(await page.locator("#ratio-grid .ratio").count()).toBe(9);
    expect(
      await page.locator('#ratio-grid .ratio[role="radio"][aria-checked="true"]').count(),
    ).toBe(1);
    await page.getByRole("radio", { name: "1:1，头像", exact: true }).click();
    expect(await page.locator('#ratio-grid .ratio[aria-checked="true"] .lbl').textContent()).toBe(
      "1:1",
    );
    const tabStops = await page
      .locator("#ratio-grid .ratio")
      .evaluateAll((els) => els.filter((el) => el.tabIndex === 0).length);
    expect(tabStops).toBe(1);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector('#ratio-grid .ratio[aria-checked="true"] .lbl')?.textContent ===
        "4:3",
    );
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe(
      "4:3",
    );
  });
});
