# PictureCut

macOS 桌面版图片裁切工具。界面移植自 `../prototype/index.html`，图片读写由 Go 负责。

技术栈：MyGo 0.9.2（原生窗口 + WKWebView）、Go 1.27、TypeScript + Vite。

## 运行

```bash
bun install
bun run dev          # 开发窗口，前端在 http://localhost:5173
bun run build        # build/darwin-arm64/PictureCut.app 和 .dmg
```

`bun run build` 若在 codesign 阶段报 `resource fork, Finder information, or similar detritus not allowed`，是文件带了扩展属性（仓库放在 iCloud Drive 时常见）：执行 `xattr -cr resources` 后重试。

## 代码结构

| 位置 | 职责 |
| --- | --- |
| `main.go` | 绑定给页面的 `Library` 服务：选图、选文件夹、拖入路径的目录展开、选输出目录、输出文件名、保存、设置、在 Finder 中显示；`img`/`thumb` 协议；窗口参数 |
| `internal/imageinfo` | 解码 JPEG/PNG、文件头校验、EXIF 方向、缩略图 |
| `internal/crop` | 归一化裁切框 → 像素矩形，与 `src/crop.ts` 共用 `testdata/crop-cases.json` |
| `internal/naming` | 文件名（`stem_比例_质量_时间戳.ext`）与同名 `-2` 后缀 |
| `internal/encode` | JPEG q80/q95；PNG 无损或按颜色量化 |
| `internal/saver` | 裁切 + 编码 + 原子写入（临时文件后重命名） |
| `internal/settings` | 质量档位、输出目录的持久化 |
| `src/main.ts` | 窗口逻辑：列表、裁切框拖拽与键盘微调、检查器、保存面板、确认框、toast |
| `src/state.ts`、`src/crop.ts` | 列表状态与裁切几何（纯函数） |
| `src/style.css`、`index.html` | 从原型复制的样式与窗口结构 |

前端只通过 `src/mygo.ts`（`mygo generate` 生成）调 Go。输出文件名只在 Go 生成，页面用 `PreviewNames` 显示，因此摘要里的名字就是写盘的名字，包括同名时的 `-2`。

## 与原型一致的地方

- 所有比例、裁切框、暗部、网格线、手柄、检查器、保存摘要、进度、完成、确认框、toast 的 DOM 和 CSS 都来自原型，未重画。
- 每张图独立保存比例和裁切，参与开关只影响保存。
- 质量档位与输出目录是整批共用设置，改动时写入 `~/Library/Application Support/PictureCut/settings.json`。
- 拖入文件或文件夹时显示遮罩，松手后按 `ImportPaths` 导入。文件夹递归导入其中的 JPG/JPEG、PNG，文件夹里的隐藏项和非图片跳过；直接拖入的文件按能否解码判断。
- 保存进度逐张上报，失败的文件在保存进度里显示红叉，完成页按实际写盘数量报数。原型没有失败态，这是唯一的新增样式。

原型里为了演示加的东西没有搬过来：假红绿灯（换成系统窗口按钮）、外层 `.page` 画框、隐藏的 `<input type=file>`、可编辑的输出路径输入框（改为点击选择目录）。工具栏加了拖动区域，并按系统窗口按钮的宽度留出左侧和右侧内边距。

## 测试

```bash
go test ./...        # 解码、裁切、命名、编码、保存、协议、导入与保存编排
bun test             # 裁切几何（与 Go 共用的用例）+ 30 个浏览器端用例
```

浏览器用例在 Chromium 里跑打包后的真实页面，只把 `window.mygo` 换成桩：覆盖空状态、导入、拖入投递与遮罩、每图比例与裁切保留、参与开关、比例方向键、移除撤销、列表语义、弹窗焦点、弹窗打开时 toast 不可操作、保存进度、单张失败、取消保存，并把窗口与原型做逐像素对比（标题栏以下差异 < 0.2%）。第一次运行前装 Chromium：

```bash
bunx playwright install chromium
```

原型自身的回归测试仍在仓库根目录：`npm test`。

## 已验证 / 未验证

2026-11-18 在打包的 0.2.0 上做了真实应用验收：`bun run build` 产物能启动；系统文件框导入 JPG/PNG；「打开文件夹」递归导入子目录；从 Finder 拖入文件；WKWebView 中显示 2400px 原图；拖动裁切框、方向键切换比例；保存成功写入磁盘；只读目录保存失败时显示「保存未全部完成」和 1 个失败；「在 Finder 中显示」选中输出文件。macOS AX 树也核对了：文件行是 button，名称带「当前选中」，移除键独立，比例和质量是 radiogroup，保存 sheet 的 Tab 在弹窗内循环。

还没做：真实 VoiceOver 语音走查（只读了 AX 树）；浅色主题；非图片拖入的界面提示。系统文件框、`img://`、真实拖入和保存编排现在都有真机证据。

## 已知限制

- 只支持 JPEG/PNG，不转换格式。
- 16-bit/通道的 PNG 选「无损保存」会降到 8-bit（裁切统一画进 8-bit 缓冲），颜色被截断。
- 按文件夹导入（含拖入文件夹）时，非 JPG/PNG 文件和隐藏项不计数；直接拖入的文件只要读不出（非图片、已删除的路径）都计入「跳过 N 个文件」。
- 一次只处理一张图的内存峰值约为「像素数 × 4 字节」；8000×6000 的图约 192 MB。
- 会话内为每张导入图片保留一份 96 px 缩略图（约几 KB），移除图片后不回收；一次会话导入上千张时占几 MB。
- 输出目录只能用鼠标点选。
- v1 不做：旋转/翻转、自由比例、命名模板、EXIF 回写、ICC 色彩管理、多语言、菜单栏、签名与公证。
