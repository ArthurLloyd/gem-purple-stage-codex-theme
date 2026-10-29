# 维护与排错

源码开发需要 Windows 和 Node.js 24+，不需要 npm 依赖。以下命令在仓库根目录运行；发布包可把 `node` 换成 `tools\node\node.exe`。

```powershell
$env:CODEX_THEMES_HOME = Join-Path (Get-Location) 'library'
node --experimental-transform-types library/themes/gem-purple-stage-v3.1/build-theme.ts
node --experimental-transform-types runtime/validate-theme.ts library/themes/gem-purple-stage-v3.1
node --experimental-transform-types --test runtime/injection-session.test.ts runtime/repair-renderer.test.ts
node --experimental-transform-types scripts/check-public-source.ts
node --experimental-transform-types runtime/apply-theme.ts status
node --experimental-transform-types runtime/qa-contrast.ts
node --experimental-transform-types runtime/qa-layout.ts
```

每个 PowerShell 会话都要设置 `CODEX_THEMES_HOME`。状态应为 `active`，主题 ID 为 `gem-purple-stage-v3-1`，watcher 为 `active`。调试地址可能是 `127.0.0.1:9335` 或 `[::1]:9335`。不要让源码目录和安装目录同时运行主题 watcher；切换前在旧目录执行 `restore`。

布局检查仅覆盖实际打开的页面。升级 Codex 后，应分别检查聊天、工作和 Codex 首页、含正文的对话、通知列表、设置、终端、首页选项及收起侧栏的悬浮列表，并在宽窄窗口中实际滚动。相关计数为 0 表示该组件尚未被检查，不能据此判定通过。适配要点见 [兼容性说明](compatibility.md)。

主区域空白时，先运行诊断，再按需恢复：

```powershell
node --experimental-transform-types runtime/repair-renderer.ts
node --experimental-transform-types runtime/repair-renderer.ts --reload-empty
```

恢复工具仅在唯一主页面确实空白且所有编辑器没有草稿时重新加载一次；健康页面不重载，有草稿则返回 `blocked`。它不修改客户端安装文件或数据库。

## 构建发布包

```powershell
powershell.exe -NoProfile -File scripts/build-release.ps1
powershell.exe -NoProfile -File scripts/test-release.ps1
```

构建脚本从 Node.js 官方站点下载固定版本的 `node.exe`，从 Node.js 官方仓库下载完整许可，分别校验固定 SHA-256。若本机 Node.js 与固定版本完全相同，可加 `-UseLocalNode` 复用本机二进制。编译使用 Windows 自带的 .NET Framework C# 编译器，不安装全局工具。

输出目录为 `dist/v<版本号>/`，包括安装 EXE、便携 ZIP 和 `SHA256SUMS.txt`。构建临时目录位于 `.tmp/`，退出时自动清理。源照片、原始人物 PNG、历史报告、测试文件和运行状态通过发布白名单排除；必要的运行代码、CSS、字体、WebP 与许可保留。

版本以 `packaging/release.json` 为发布配置，并与 `theme.json` 保持一致。同版本构建不会覆盖已有文件；重新构建前只删除自己确认过的 `dist/` 输出。CI 执行单元测试、主题构建和完整的打包安装卸载测试；CI 不能证明某个 Codex 客户端界面已经完成视觉验收。

发布到现有私有仓库：

```powershell
gh release create v1.2.0 dist/v1.2.0/* --verify-tag --title 'G.E.M. Purple Stage 1.2.0' --notes-file docs/releases/v1.2.0.md
```

先提交、同步代码并推送对应 tag，再执行发布。构建产物只上传 Release，不提交 Git。构建 EXE 未做商业代码签名；保留 Release 校验文件供接收者核对，不建议关闭系统安全功能。
