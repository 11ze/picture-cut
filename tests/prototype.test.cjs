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
  assert.equal(await page.locator('#quality-note').innerText(), '256 色 · 保留透明背景');
  assert.match(await page.locator('#quality-compressed').getAttribute('title'), /保留透明背景/);
  assert.match(await page.locator('#filename').innerText(), /\.png$/);
  const compressedName = await page.locator('#filename').innerText();
  await page.locator('#quality-high').click();
  assert.equal(await page.locator('#quality-high').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#quality-note').innerText(), '无损 · 保留透明背景');
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
  assert.equal(await page.locator('#summary-quality').innerText(), 'JPEG 标准压缩 · PNG 256 色');
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

// Drag and drop: a drop event carries files as a DataTransfer. Chromium gives
// no file entries to a DataTransfer the page builds, so one test covers the
// fallback path and another supplies stand-ins shaped like the browser's
// FileSystemEntry objects for the folder walk.
const PNG = readFileSync(path.join(__dirname, 'fixtures/transparent.png')).toString('base64');

async function dispatchDrag(page, type, files, target = '#canvas') {
  return page.evaluate(({ type, files, target }) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type || '' }));
    }
    return document.querySelector(target).dispatchEvent(
      new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }, { type, files, target });
}

async function dragEffect(page, type, files) {
  return page.evaluate(({ type, files }) => {
    const dt = new DataTransfer();
    let effect = 'none';
    // Chromium drops writes to dropEffect on a synthetic DataTransfer, so the
    // test keeps the value the page wrote itself.
    Object.defineProperty(dt, 'dropEffect', {
      configurable: true,
      get: () => effect,
      set: (value) => { effect = value; },
    });
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type || '' }));
    }
    document.querySelector('#canvas').dispatchEvent(
      new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    return effect;
  }, { type, files });
}

async function dropTree(page, tree) {
  return page.evaluate(({ tree, png }) => {
    const bytes = () => Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const entry = (node) => {
      if (node.type === 'dir') {
        let next = 0;
        return {
          isFile: false, isDirectory: true, name: node.name, fullPath: '/' + node.name + '/',
          createReader() {
            return {
              // One child per call, the way the browser pages a large folder.
              readEntries(done, fail) {
                if (node.fail) return fail(new Error('unreadable folder'));
                if (next >= node.children.length) return done([]);
                done([entry(node.children[next++])]);
              },
            };
          },
        };
      }
      return {
        isFile: true, isDirectory: false, name: node.name, fullPath: '/' + node.name,
        file(done, fail) {
          if (node.fail) return fail(new Error('unreadable file'));
          const body = node.text ? new TextEncoder().encode(node.text) : bytes();
          done(new File([body], node.name));
        },
      };
    };
    const dt = new DataTransfer();
    Object.defineProperty(dt, 'items', {
      value: [{ kind: 'file', type: '', webkitGetAsEntry: () => entry(tree) }],
    });
    return document.querySelector('#canvas').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }, { tree, png: PNG });
}

test('dropping image files adds them and reports what it skipped', async t => {
  const page = await openPrototype(t);
  await dispatchDrag(page, 'drop', [
    { name: 'dropped.png', type: 'image/png', base64: PNG },
    { name: 'notes.txt', type: 'text/plain', base64: Buffer.from('notes').toString('base64') },
    { name: 'broken.jpg', type: 'image/jpeg', base64: Buffer.from('broken').toString('base64') },
  ]);
  await page.locator('.file').filter({ hasText: 'dropped.png' }).waitFor();
  assert.equal(await page.locator('#count').innerText(), '4');
  assert.match(await page.locator('#toast-text').innerText(), /已添加 1 张 · 跳过 2 个文件/);
});

test('dragging files over the window shows the drop target, and leaving hides it', async t => {
  const page = await openPrototype(t);
  const prevented = await dispatchDrag(page, 'dragenter', [
    { name: 'hover.png', type: 'image/png', base64: PNG },
  ]);
  assert.equal(prevented, false);
  await page.locator('#drop').waitFor();
  assert.match(await page.locator('#drop').innerText(), /松开.*添加/);
  assert.match(await page.locator('#drop').innerText(), /文件夹/);

  // Moving between the window's children fires dragleave too.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'hover.png'));
    for (const target of ['#canvas', '#stage']) {
      document.querySelector(target).dispatchEvent(
        new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }
    document.querySelector('#canvas').dispatchEvent(
      new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    document.querySelector('#stage').dispatchEvent(
      new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  assert.equal(await page.locator('#drop').isVisible(), true);
  await page.evaluate(() => {
    document.querySelector('#window').dispatchEvent(
      new DragEvent('dragleave', { bubbles: true, cancelable: true }),
    );
  });
  await page.locator('#drop').waitFor({ state: 'hidden' });

  await dispatchDrag(page, 'drop', [{ name: 'hover.png', type: 'image/png', base64: PNG }]);
  await page.locator('.file').filter({ hasText: 'hover.png' }).waitFor();
  assert.equal(await page.locator('#drop').isVisible(), false);

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    document.querySelector('#canvas').dispatchEvent(
      new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  assert.equal(await page.locator('#drop').isVisible(), false);
});

test('dropping a folder adds every image inside, including nested folders', async t => {
  const page = await openPrototype(t);
  const before = await page.locator('.file .fname').allTextContents();
  await dropTree(page, {
    type: 'dir', name: 'Trip', children: [
      { type: 'file', name: 'first.png' },
      { type: 'file', name: '.hidden.png' },
      { type: 'file', name: '.DS_Store', text: 'junk' },
      { type: 'file', name: 'notes.txt', text: 'notes' },
      { type: 'file', name: 'broken.png', fail: true },
      { type: 'dir', name: '.trash', children: [{ type: 'file', name: 'old.png' }] },
      { type: 'dir', name: 'nested', children: [{ type: 'file', name: 'second.png' }] },
    ],
  });

  await page.locator('.file').filter({ hasText: 'second.png' }).waitFor();
  const after = await page.locator('.file .fname').allTextContents();
  assert.deepEqual(after.filter((name) => !before.includes(name)), ['first.png', 'second.png']);
  assert.equal(await page.locator('#count').innerText(), '5');
  assert.match(await page.locator('#toast-text').innerText(), /^已添加 2 张 · 跳过 1 个文件/);
});

test('a drop is refused while the save sheet is open', async t => {
  const page = await openPrototype(t);
  await page.locator('#save-all').click();
  await page.locator('#sheet').waitFor();
  const prevented = await dispatchDrag(page, 'dragover', [
    { name: 'late.png', type: 'image/png', base64: PNG },
  ]);
  assert.equal(prevented, false);
  assert.equal(await page.locator('#drop').isVisible(), false);
  const effect = await dragEffect(page, 'dragover', [
    { name: 'late.png', type: 'image/png', base64: PNG },
  ]);
  assert.equal(effect, 'copy');
  await dispatchDrag(page, 'drop', [{ name: 'late.png', type: 'image/png', base64: PNG }]);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#count').innerText(), '3');
  assert.match(await page.locator('#toast-text').innerText(), /先完成当前操作再添加图片/);
});

test('a dropped folder whose own name starts with a dot is still imported', async t => {
  const page = await openPrototype(t);
  const before = await page.locator('.file .fname').allTextContents();
  await dropTree(page, {
    type: 'dir', name: '.photos', children: [{ type: 'file', name: 'keep.png' }],
  });
  await page.locator('.file').filter({ hasText: 'keep.png' }).waitFor();
  const after = await page.locator('.file .fname').allTextContents();
  assert.deepEqual(after.filter((name) => !before.includes(name)), ['keep.png']);
});

test('a picked folder whose own name starts with a dot is still imported', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'picturecut-dot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, '.photos'));
  writeFileSync(path.join(directory, '.photos/keep.png'), Buffer.from(PNG, 'base64'));

  const page = await openPrototype(t);
  await page.locator('#folder-input').setInputFiles(path.join(directory, '.photos'));
  await page.locator('.file').filter({ hasText: 'keep.png' }).waitFor();
  assert.equal(await page.locator('#count').innerText(), '4');
});

test('a folder picked in the dialog leaves out other files without counting them', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'picturecut-folder-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'nested'));
  mkdirSync(path.join(directory, '.cache'));
  writeFileSync(path.join(directory, 'photo.png'), Buffer.from(PNG, 'base64'));
  writeFileSync(path.join(directory, 'nested/other.png'), Buffer.from(PNG, 'base64'));
  writeFileSync(path.join(directory, '.cache/inside.png'), Buffer.from(PNG, 'base64'));
  writeFileSync(path.join(directory, 'notes.txt'), 'notes');
  writeFileSync(path.join(directory, '.DS_Store'), 'junk');

  const page = await openPrototype(t);
  await page.locator('#folder-input').setInputFiles(directory);
  await page.locator('.file').filter({ hasText: 'other.png' }).waitFor();
  assert.equal(await page.locator('#count').innerText(), '5');
  assert.match(await page.locator('#toast-text').innerText(), /^已添加 2 张$/);
});

test('the inspector fits a 790px window without scrolling', async t => {
  const page = await openPrototype(t);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleLayout(page);
  const size = await page.locator('.insp-scroll').evaluate(sc => ({ client: sc.clientHeight, scroll: sc.scrollHeight }));
  assert.ok(size.scroll <= size.client + 1, `inspector overflows: ${size.scroll} > ${size.client}`);
});

test('Tab stays inside the save sheet', async t => {
  const page = await openPrototype(t);
  await page.locator('#save-all').click();
  await page.locator('#sheet').waitFor({ state: 'visible' });
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#sheet'))), true);
  assert.equal(await page.evaluate(() => document.querySelector('.toolbar').inert), true);
});

test('Tab stays inside the confirm dialog', async t => {
  const page = await openPrototype(t);
  await page.locator('#add-btn').click();
  await page.locator('#add-clear').click();
  await page.locator('#confirm').waitFor({ state: 'visible' });
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#confirm'))), true);
  assert.equal(await page.evaluate(() => document.querySelector('.toolbar').inert), true);
});

test('the toast action is unavailable while a modal is open', async t => {
  const page = await openPrototype(t);
  await page.locator('.file-row[data-id="city"] .remove').click();
  await page.locator('#save-all').click();
  await page.locator('#sheet').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.querySelector('#toast-action').inert), true);
  assert.equal(await page.locator('#toast-action').isVisible(), false);

  await page.locator('#summary-cancel').click();
  await page.locator('#sheet').waitFor({ state: 'hidden' });
  await page.locator('.file-row[data-id="mountain-lake"] .remove').click();
  await page.locator('#add-btn').click();
  await page.locator('#add-clear').click();
  await page.locator('#confirm').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.querySelector('#toast-action').inert), true);
  assert.equal(await page.locator('#toast-action').isVisible(), false);
});

test('the ratio group has no apply-to-all control', async t => {
  const page = await openPrototype(t);
  assert.equal(await page.locator('#ratio-all').count(), 0);
  assert.equal(await page.getByRole('button', { name: '应用到全部' }).count(), 0);
});

test('removing an image offers an undo', async t => {
  const page = await openPrototype(t);
  assert.equal(await page.locator('.file').count(), 3);
  await page.locator('.file-row[data-id="city"] .remove').click();
  assert.equal(await page.locator('.file').count(), 2);
  await page.locator('#toast-action').click();
  assert.equal(await page.locator('.file').count(), 3);
  assert.equal(await page.locator('.file[data-id="city"]').getAttribute('aria-current'), 'true');
});

test('keyboard opens, moves in and removes from the list', async t => {
  const page = await openPrototype(t);
  await page.locator('.file[data-id="city"]').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.file[data-id="mountain-lake"]').getAttribute('aria-current'), 'true');
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('.file').count(), 2);
  await page.locator('#toast-action').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 2000 }),
    page.keyboard.press('Meta+O'),
  ]);
  assert.ok(chooser);
});
test('PNG standard quality says 256 colors', async t => {
  const page = await openPrototype(t);
  await page.locator('.file[data-id="coffee"]').click();
  assert.equal(await page.locator('#quality-compressed').textContent(), '256 色');
  assert.match(await page.locator('#quality-note').textContent(), /256 色/);
  await page.locator('#save-all').click();
  await page.locator('#sheet-summary-view:not([hidden])').waitFor();
  assert.match(await page.locator('#summary-quality').textContent(), /PNG 256 色/);
});

test('the done screen shows the saved result once', async t => {
  const page = await openPrototype(t);
  await page.locator('#save-all').click();
  await page.locator('#sheet-start').click();
  await page.locator('#sheet-done-view:not([hidden])').waitFor();
  assert.equal(await page.locator('#sheet-done-view .done-mark').count(), 0);
  const text = await page.locator('#sheet-done-view').innerText();
  assert.equal((text.match(/已保存/g) || []).length, 1);
});

test('the image list exposes list items with separate remove buttons', async t => {
  const page = await openPrototype(t);
  const shape = await page.evaluate(() => {
    const list = document.querySelector('#file-list');
    const rows = [...list.querySelectorAll(':scope > .file-row')];
    return {
      role: list.getAttribute('role'),
      rows: rows.length,
      listitems: rows.every((row) => row.getAttribute('role') === 'listitem'),
      buttons: rows.every((row) => row.querySelector(':scope > .file[role="button"][aria-current]')),
      pressed: rows.some((row) => row.querySelector(':scope > .file[aria-pressed]')),
      cleanAlts: rows.every((row) => row.querySelector(':scope > .file img')?.getAttribute('alt') === ''),
      removes: rows.every((row) => row.querySelector(':scope > .remove')?.getAttribute('aria-label')),
      nested: rows.some((row) => row.querySelector('.file .remove')),
    };
  });
  assert.equal(shape.role, 'list');
  assert.equal(shape.rows, 3);
  assert.equal(shape.listitems, true);
  assert.equal(shape.buttons, true);
  assert.equal(shape.pressed, false);
  assert.equal(shape.cleanAlts, true);
  assert.equal(shape.removes, true);
  assert.equal(shape.nested, false);
  assert.equal(await page.locator('.file[data-id="city"]').getAttribute('aria-current'), 'true');
  assert.match(await page.locator('.file[data-id="city"]').getAttribute('aria-label'), /当前选中/);
  await page.locator('.file[data-id="mountain-lake"]').click();
  assert.equal(await page.locator('.file[data-id="city"]').getAttribute('aria-current'), 'false');
  assert.doesNotMatch(await page.locator('.file[data-id="city"]').getAttribute('aria-label'), /当前选中/);
});

test('the ratio group exposes one checked radio', async t => {
  const page = await openPrototype(t);
  assert.equal(await page.locator('#ratio-grid').getAttribute('role'), 'radiogroup');
  const radios = page.locator('#ratio-grid .ratio');
  assert.equal(await radios.count(), 9);
  assert.equal(await page.locator('#ratio-grid .ratio[role="radio"][aria-checked="true"]').count(), 1);
  await page.getByRole('radio', { name: '1:1，头像', exact: true }).click();
  assert.equal(await page.locator('#ratio-grid .ratio[aria-checked="true"] .lbl').textContent(), '1:1');
  const tabStops = await page.locator('#ratio-grid .ratio').evaluateAll((els) => els.filter((el) => el.tabIndex === 0).length);
  assert.equal(tabStops, 1);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#ratio-grid .ratio[aria-checked="true"] .lbl')?.textContent === '4:3');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key')), '4:3');
});
