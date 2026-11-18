# PictureCut

桌面端的图片裁切工具。一次导入一批图，逐张定比例、拖好裁切框，再按两档质量导出 JPEG 或 PNG。

[在线预览](https://11ze.github.io/picture-cut/) · [下载](https://github.com/11ze/picture-cut/releases)

在线预览是网页版原型：裁切界面和桌面应用一致，但不会真的读写文件。要验证真实保存，用下面的方式本地运行。

## 功能

- 导入单张、多张图片，或整个文件夹，也可以把图片或文件夹拖进窗口。只收能解码的 JPG/JPEG、PNG，其他跳过并提示。
- 9 个固定比例，没有自由比例。每张图单独保存自己的比例和裁切位置。
- 「参与保存」只控制这张图是否写盘，关掉后裁切设置保留。移除图片不会删除源文件，可以从 toast 撤销。
- Cmd+O 打开图片，Delete 移除当前图片，列表内用上下键切换。
- 质量档位和输出目录是整批共用设置。JPEG 两档为 q80、q95；PNG 标准压缩降到 256 色并保留透明，无损保存不压色。
- 输出格式跟随原图，不做格式转换。文件名是 `原名_比例_质量_时间戳.ext`，同名自动加 `-2`，摘要里显示的名字就是写盘的名字。
- 保存时逐张上报进度，可随时取消。已写出的文件保留，源文件始终不动。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `prototype/` | 设计稿与交互原型，纯静态 HTML，也是在线预览的部署内容 |
| `app/` | 桌面应用：Go 后端、TypeScript 前端、单元测试与界面测试 |
| `tests/` | 原型的 Playwright 回归测试 |

## 运行桌面应用

需要 Go 1.27 和 Bun。

```bash
cd app
bun install
bun run dev     # 开发窗口，前端在 http://localhost:5173
bun run build   # 产物在 app/build/darwin-arm64/
```

打包出的应用未签名。首次打开被系统拦下时，右键选择「打开」。

## 测试

```bash
# 都在仓库根目录执行
(cd app && go test ./...)   # 解码、裁切、命名、编码、保存、协议
(cd app && bun run test)    # 裁切几何 + 30 个浏览器端用例，含与原型逐像素对比
npm test                    # 原型自身的回归，23 个用例
```

第一次跑浏览器用例前装 Chromium：`cd app && bunx playwright install chromium`。跑原型回归前先在仓库根目录 `npm ci`，再 `npx playwright install chromium`。

## 发布

发版由 [.github/workflows/release.yml](.github/workflows/release.yml) 完成，本机只负责打 tag。

1. 改 `app/mygo.config.ts` 的 `version`，提交并推送到 `main`。
2. 打 tag 推送：`git tag -a v0.2.2 -m "version 0.2.2" && git push origin v0.2.2`。
3. Actions 的 Release 工作流先校验 tag 与配置一致，再在 macOS、Windows、Linux 三个 runner 上构建，把安装包传到 [Releases](https://github.com/11ze/picture-cut/releases)。版本不一致或构建失败不会产生 release。

补发已有 tag：`gh workflow run release.yml -f tag=v0.2.1`。发布说明由 [scripts/release-notes.sh](scripts/release-notes.sh) 按提交前缀生成，覆盖上一个 tag 之后的提交。

## 技术栈

MyGo 0.9.2 提供原生窗口与 WebView，Go 负责解码、裁切、编码和写盘，前端是 TypeScript + Vite。桌面应用目前只在 macOS（Apple Silicon）上构建和验证。

## 限制

不支持旋转翻转、自由比例、命名模板、EXIF 回写和 ICC 色彩管理。16-bit PNG 的「无损保存」会降到 8-bit。更多细节见 [app/README.md](app/README.md)。

## 素材

示例图片来自 Pexels，按 Pexels License 使用，来源见 [prototype/assets/CREDITS.md](prototype/assets/CREDITS.md)。
