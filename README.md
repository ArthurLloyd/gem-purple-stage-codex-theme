<div align="center">

# G.E.M. Purple Stage

**A violet stage theme for the Codex desktop app on Windows.**

为 Codex 桌面应用打造的紫色舞台主题。

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-8064a2)
![Version](https://img.shields.io/badge/version-1.2.1-b996eb)
![Code License](https://img.shields.io/badge/code_license-Apache--2.0-blue)

[下载安装](#安装) · [功能特性](#功能特性) · [使用说明](#使用说明) · [开发与构建](#开发与构建) · [更新记录](CHANGELOG.md)

</div>

## 简介

G.E.M. Purple Stage 为 Windows Codex 桌面应用提供统一的深紫配色、舞台人像和装饰布局，覆盖首页、对话、侧边栏、输入区、设置、弹窗与终端。

主题通过本机 Chromium 调试接口加载，保留原生功能与交互，不修改 Codex 安装文件。当前发行版为 **1.2.1**，主题视觉版本为 **v3.1**。

## 功能特性

- **统一外观**：深紫色界面、Inter 字体、舞台背景、功能卡片和拍立得装饰。
- **自适应布局**：根据窗口宽度调整装饰，保留输入区和原生滚动。
- **持续注入**：监测页面切换和新窗口，自动重新加载主题。
- **独立运行环境**：安装包和便携包内置 Node.js，无需额外安装 npm、Git 或全局依赖。
- **完整安装流程**：支持当前用户安装、桌面及开始菜单入口、原目录升级与按清单卸载。

## 安装

### 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11 x64 |
| 客户端 | 已安装的 Codex 桌面应用 |
| 系统组件 | Windows PowerShell 5.1、.NET Framework 4.7.2 或更新版本 |
| 调试端口 | 本机回环端口 `9335` 可用 |
| 额外运行环境 | 无；正式包内置 Node.js 24.16.0 |

暂未提供 macOS、Linux 或原生 ARM64 安装包。Codex 客户端本身不包含在发行包中。

### 推荐：安装程序

1. 前往 [Releases](https://github.com/ArthurLloyd/gem-purple-stage-codex-theme/releases/latest)。
2. 下载 `gem-purple-stage-1.2.1-windows-x64-setup.exe`。
3. 运行安装程序，选择安装目录。默认目录为 `%LOCALAPPDATA%\GemPurpleCodex`，无需管理员权限。
4. 保存正在进行的工作，从桌面或开始菜单中的 **G.E.M. Purple Codex** 启动。

### 便携运行

下载 Release 附件中的 `*-portable.zip`，完整解压到可写目录，运行 `GemPurpleCodex.exe`。需要安装到默认目录时，运行 `Install.cmd`。

GitHub 自动生成的 **Source code ZIP** 不包含 Node.js 和编译后的启动器，供开发使用，不能代替便携包。

### 校验下载文件

Release 同时提供 `SHA256SUMS.txt`，可对照检查下载文件的 SHA-256：

```powershell
Get-FileHash .\gem-purple-stage-1.2.1-windows-x64-setup.exe -Algorithm SHA256
```

安装程序尚未进行代码签名。下载的便携 ZIP 如被 Windows 标记为来自互联网，请在确认来源后，在 ZIP 属性中选择“解除锁定”再解压。

## 使用说明

请通过 **G.E.M. Purple Codex** 专用入口启动。直接运行官方 Codex 入口，不保证自动加载主题。

首次启用调试端口时，启动器可能退出并重启已驻留后台的 Codex；使用前请保存工作。主题加载可能需要几十秒。安装程序本身不会启动或重启 Codex。

| 操作 | 方法 |
| --- | --- |
| 升级 | 运行新版安装程序，选择原安装目录；保留日志和运行状态 |
| 移动便携目录 | 移动整个目录；需要快捷方式时重新运行 `install-gem-purple-shortcut.ps1` |
| 卸载 | 运行安装目录中的 `Uninstall.cmd`；保留未知文件和主题日志 |
| 完整清理主题状态 | 运行 `Uninstall.cmd -PurgeState`；不删除 Codex 或聊天数据 |

### 查看状态或撤销主题

在安装或便携目录打开 PowerShell：

```powershell
$env:CODEX_THEMES_HOME = Join-Path (Get-Location) 'library'
.\tools\node\node.exe --experimental-transform-types runtime/apply-theme.ts status
.\tools\node\node.exe --experimental-transform-types runtime/apply-theme.ts restore
```

每个终端会话都需要设置 `CODEX_THEMES_HOME`。`restore` 撤销当前注入；下一次使用专用入口启动时，主题会重新启用。不要同时从多个目录运行主题 watcher。

## 常见问题

**无法启动或主题没有生效？**

先确认安装了 Codex，并使用主题专用入口。启动日志位于安装目录的 `library\state\launcher.log`，watcher 日志为 `library\state\watch.log`。安装程序日志为 `%TEMP%\gem-purple-setup.log`。

**客户端更新后界面显示异常？**

Codex 更新可能改变页面结构，导致部分选择器失效。请参阅 [兼容性说明](docs/compatibility.md)、[发布验证](docs/release-validation.md) 和 [维护文档](docs/maintenance.md)。

**卸载时有文件被占用？**

卸载程序会在安装目录生成 `cleanup-failures.txt`，列出未能删除的具体路径。关闭占用程序后可重试。

## 开发与构建

源码开发需要 Windows 和 Node.js 24+，无需安装 npm 依赖：

```powershell
node --experimental-transform-types --test runtime/injection-session.test.ts runtime/repair-renderer.test.ts
powershell.exe -NoProfile -File scripts/build-release.ps1
powershell.exe -NoProfile -File scripts/test-release.ps1
```

输出位于 `dist/v1.2.1/`。构建脚本校验固定版本的 Node.js 二进制和许可，并使用 Windows 自带的 .NET Framework 编译器生成 EXE。更多说明见 [维护文档](docs/maintenance.md)。

```text
launcher/       Windows 启动、MSIX 激活与安装辅助
runtime/        注入、诊断、恢复与单元测试
library/themes/ 主题清单、CSS 源码、生成样式与运行素材
packaging/      发布配置与原生程序源码
scripts/        构建、隐私检查与安装卸载测试
docs/           使用、兼容性与发布文档
```

## 参与贡献

欢迎通过 [Issues](https://github.com/ArthurLloyd/gem-purple-stage-codex-theme/issues) 报告兼容性问题，或提交改进。请遵循 [贡献指南](CONTRIBUTING.md)，在日志和截图中移除账号、聊天内容、访问凭证及本机路径。

## 许可与致谢

程序代码采用 [Apache-2.0](LICENSE)。注入运行时基于 CodexThemes 工具修改，保留其 [版权声明](runtime/NOTICE)；Node.js、Inter 字体和图片素材的授权范围见 [第三方声明](THIRD-PARTY-NOTICES.md)。

**照片、人像和衍生图片不属于代码许可范围。** 代码的开源许可不代表取得图片的公开再分发或商业使用授权。公开包含这些素材的仓库或发行包之前，应确认相应授权。

本项目为非官方社区定制，与 OpenAI、CodexThemes、G.E.M. 及其权利人没有官方关联。
