const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { chromium } = require('playwright');

let browser;
before(async () => {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
});
after(async () => { await browser?.close(); });

async function settleLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openPrototype(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(() => page.close());
  await page.goto(pathToFileURL(path.resolve(__dirname, '../prototype/index.html')).href);
  await page.locator('#photo-img').evaluate(img => img.decode());
  await settleLayout(page);
  return page;
}

test('each image retains its own ratio and crop when another image changes', async t => {
  const page = await openPrototype(t);
  const centeredCity = await page.locator('#crop').boundingBox();
  await page.locator('#crop').focus();
  await page.keyboard.press('ArrowDown');
  const cityCrop = await page.locator('#crop').boundingBox();
  assert.ok(cityCrop.y > centeredCity.y);
  await page.locator('.file[data-id="mountain-lake"]').click();
  await page.getByRole('radio', { name: '1:1，头像', exact: true }).click();
  const centeredLake = await page.locator('#crop').boundingBox();
  await page.locator('#crop').focus();
  await page.keyboard.press('ArrowRight');
  const lakeCrop = await page.locator('#crop').boundingBox();
  assert.ok(lakeCrop.x > centeredLake.x);

  await page.locator('.file[data-id="city"]').click();
  assert.match(await page.locator('#status-crop').innerText(), /^16:9 · 2400 × 1350 px$/);
  assert.deepEqual(await page.locator('#crop').boundingBox(), cityCrop);
  await page.getByRole('radio', { name: '9:16，手机壁纸', exact: true }).click();

  await page.locator('.file[data-id="mountain-lake"]').click();
  assert.match(await page.locator('#status-crop').innerText(), /^1:1 · 1617 × 1617 px$/);
  assert.deepEqual(await page.locator('#crop').boundingBox(), lakeCrop);
  await page.locator('#save-all').click();
  const names = await page.locator('#summary-list .sname').allTextContents();
  assert.match(names[0], /^city_9x16_/);
  assert.match(names[1], /^mountain-lake_1x1_/);
  assert.match(names[2], /^coffee_16x9_/);
  assert.match(await page.locator('#summary-ratio').innerText(), /各图比例/);
});

test('a smaller desktop window preserves control sizes and keeps settings reachable', async t => {
  const page = await openPrototype(t);
  const desktopRatio = await page.locator('.ratio').first().boundingBox();
  const desktopCanvas = await page.locator('#canvas').boundingBox();
  await page.setViewportSize({ width: 1024, height: 768 });
  await settleLayout(page);
  const smallRatio = await page.locator('.ratio').first().boundingBox();
  const smallCanvas = await page.locator('#canvas').boundingBox();
  assert.equal(smallRatio.height, desktopRatio.height);
  assert.ok(smallCanvas.width < desktopCanvas.width);
  const app = await page.locator('#window').boundingBox();
  assert.ok(app.x >= 0 && app.x + app.width <= 1024);
  await page.locator('.fname-box').scrollIntoViewIfNeeded();
  const settings = await page.locator('.insp-scroll').boundingBox();
  const filename = await page.locator('.fname-box').boundingBox();
  assert.ok(filename.y >= settings.y && filename.y + filename.height <= settings.y + settings.height);
  await page.setViewportSize({ width: 1024, height: 600 });
  await settleLayout(page);
  await page.locator('#save-all').click();
  const saveButton = await page.locator('#sheet-start').boundingBox();
  const windowBox = await page.locator('#window').boundingBox();
  assert.ok(saveButton.y + saveButton.height <= windowBox.y + windowBox.height);
});

test('participation controls saving while preserving the image crop', async t => {
  const page = await openPrototype(t);
  await page.getByRole('radio', { name: '1:1，头像', exact: true }).click();
  await page.locator('#crop').focus();
  await page.keyboard.press('ArrowRight');
  const crop = await page.locator('#crop').boundingBox();
  await page.getByRole('switch', { name: '是否参与保存', exact: true }).click();
  assert.equal(await page.locator('#save-count').innerText(), '2');
  await page.locator('#save-all').click();
  assert.match(await page.locator('#sheet-sub').innerText(), /2 张参与 · 1 张不参与/);
  assert.match(await page.locator('#summary-ratio').innerText(), /^16:9/);
  assert.equal(await page.locator('#summary-list .sum-item').first().locator('.stag').innerText(), '不参与');
  assert.equal(await page.locator('#summary-crops').innerText(), '0 张手动 · 2 张默认 · 1 张不参与');
  await page.locator('#summary-cancel').click();
  await page.getByRole('switch', { name: '是否参与保存', exact: true }).click();
  assert.equal(await page.locator('#save-count').innerText(), '3');
  assert.deepEqual(await page.locator('#crop').boundingBox(), crop);
});

test('only JPEG and PNG images can be imported and each keeps its output format', async t => {
  const page = await openPrototype(t);
  await page.locator('#add-btn').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 2000 }),
    page.getByRole('menuitem', { name: '打开图片…', exact: true }).click(),
  ]);
  await chooser.setFiles([
    { name: 'transparent.png', mimeType: 'image/png', buffer: readFileSync(path.join(__dirname, 'fixtures/transparent.png')) },
    { name: 'portrait.JPEG', mimeType: 'image/jpeg', buffer: readFileSync(path.join(__dirname, '../prototype/assets/city.jpg')) },
    { name: 'animation.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') },
    { name: 'disguised.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>') },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  ]);
  await page.locator('.file').filter({ hasText: 'portrait.JPEG' }).waitFor();
  assert.equal(await page.locator('.file').count(), 5);
  assert.match(await page.locator('#toast-text').innerText(), /已添加 2 张.*跳过 3 个.*仅支持/);
  assert.equal(await page.locator('#output-format').innerText(), 'PNG · 跟随原图');
  assert.equal(await page.locator('#quality-seg').isVisible(), true);
  assert.equal(await page.locator('#quality-high').isEnabled(), true);
  assert.equal(await page.locator('#quality-compressed').isEnabled(), true);
  assert.equal(await page.locator('#quality-high').innerText(), '无损保存');
  assert.equal(await page.locator('#quality-note').innerText(), '文件较小');
  assert.match(await page.locator('#quality-compressed').getAttribute('title'), /保留透明背景/);
  assert.match(await page.locator('#filename').innerText(), /\.png$/);
  const compressedName = await page.locator('#filename').innerText();
  await page.locator('#quality-high').click();
  assert.equal(await page.locator('#quality-high').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#quality-note').innerText(), '保留全部颜色 · 保留透明背景');
  assert.notEqual(await page.locator('#filename').innerText(), compressedName);
  await page.locator('#save-all').click();
  assert.equal(await page.locator('#summary-quality').innerText(), 'JPEG 高质量 · PNG 无损保存');
  await page.locator('#summary-cancel').click();
  await page.locator('#quality-compressed').click();
  assert.equal(await page.locator('#filename').innerText(), compressedName);
  await page.locator('.file').filter({ hasText: 'portrait.JPEG' }).click();
  assert.equal(await page.locator('#output-format').innerText(), 'JPEG · 跟随原图');
  assert.equal(await page.locator('#quality-seg').isVisible(), true);
  assert.equal(await page.locator('#quality-high').innerText(), '高质量');
  assert.match(await page.locator('#filename').innerText(), /\.JPEG$/);
  await page.locator('#save-all').click();
  assert.equal(await page.locator('#summary-quality').innerText(), 'JPEG 标准压缩 · PNG 标准压缩');
  assert.equal(await page.locator('#summary-format').innerText(), 'JPEG · PNG（跟随原图）');
  const names = await page.locator('#summary-list .sname').allTextContents();
  assert.match(names[3], /^transparent_16x9_.*\.png$/);
  assert.match(names[4], /^portrait_16x9_.*\.JPEG$/);
});

test('different images with the same name, size and modification time are both imported', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'picturecut-same-name-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pngs = [
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAH0lEQVR4AdzKMQ0AAADCsAX/nsEB/CzZVxncFqMPEAAAAP//wlBBlQAAAAZJREFUAwBzuRABOKKDRAAAAABJRU5ErkJggg==',
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAH0lEQVR4AdzKMQ0AAADCMIJ/z8MB/CzZVwtoW6MPEAAAAP//EV1angAAAAZJREFUAwAcgRf5jbg80AAAAABJRU5ErkJggg==',
  ];
  const files = pngs.map((png, index) => {
    const folder = path.join(directory, String(index));
    mkdirSync(folder);
    const file = path.join(folder, 'same.png');
    writeFileSync(file, Buffer.from(png, 'base64'));
    utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    return file;
  });
  const page = await openPrototype(t);
  await page.locator('#add-btn').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 2000 }),
    page.locator('#add-image').click(),
  ]);
  await chooser.setFiles(files);
  await page.locator('.file').filter({ hasText: 'same.png' }).first().waitFor();
  assert.equal(await page.locator('.file').filter({ hasText: 'same.png' }).count(), 2);
  assert.equal(await page.locator('#count').innerText(), '5');
});
