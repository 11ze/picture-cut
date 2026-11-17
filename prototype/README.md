# PictureCut 高保真原型

静态 HTML。自包含，无外部依赖。

## 本地预览

```bash
python3 -m http.server 8000 --directory prototype
```

打开 `http://127.0.0.1:8000/`。

## 交互范围

- 可从本地选择图片或文件夹，也可以把图片或文件夹拖进窗口。拖入或选择的文件夹都会递归导入其中的图片；点开头的隐藏文件和非 JPG/PNG 不计入跳过数，读不出的图片计入跳过数。
- 仅接受 `.jpg`、`.jpeg`、`.png`（不区分大小写），同时检查文件头与图片能否解码；其他格式、扩展名与内容不符、损坏图片会跳过并提示。
- 输出格式跟随每张原图：JPG/JPEG 输出 JPEG，PNG 输出 PNG，不做格式转换。两种格式都有两档：JPEG 为“标准压缩 / 高质量”；PNG 为“标准压缩 / 无损保存”。PNG 两档均保留透明背景，标准压缩通过减少颜色缩小文件，可能影响渐变和细节；无损保存保留全部颜色。
- 每张图片独立保存比例和裁切位置，初始比例为 16:9。切换比例只重置当前图片的裁切框。
- “是否参与保存”只控制当前图片是否保存；关闭后仍保留裁切设置。
- 质量档位和保存目录是本次列表共用设置。JPEG 两档都会有损重新编码，对应编码参数为 q80 和 q95，不代表保留的画质百分比。
- 保存摘要按各图比例和质量档位生成文件名。右侧只显示质量说明，不预估输出体积。保存完成显示状态、数量和目标目录，不回传生成文件的实际体积等元数据。原型只模拟保存进度，不执行 JPEG 编码或 PNG 颜色压缩，不写入磁盘。
- 窗口缩小时，画布缩小、设置区滚动，文字和控件不整体缩放。应用最小宽度为 960 px，低于此宽度时页面可横向滚动。

## 回归测试

在仓库根目录执行：

```bash
npm ci
npx playwright install chromium
npm test
```

已有 Google Chrome 时，可用 `PLAYWRIGHT_CHANNEL=chrome npm test`。
测试通过页面操作检查各图比例、裁切位置、保存摘要、是否参与保存开关、小窗口布局、本地图片导入限制、输出格式，以及拖拽添加文件与文件夹。

## GitHub Pages

线上地址：<https://11ze.github.io/picture-cut/>。

仓库已带 `.github/workflows/pages.yml`。步骤：

1. 推送到 GitHub。
2. 打开仓库 Settings > Pages。
3. Build and deployment 选择 GitHub Actions。
4. 推送 `main`，或在 Actions 页面手动运行 `Deploy prototype to GitHub Pages`。

发布内容是 `prototype/` 目录。

## 示例图片

`assets/` 里的 3 张示例图片来自 Pexels，按 Pexels License 使用。默认示例包含 2 张 JPEG 和 1 张 PNG（`coffee.png`）。来源和许可见 [assets/CREDITS.md](assets/CREDITS.md)。
