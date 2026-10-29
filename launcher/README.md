# 启动器

正式发布包使用根目录的 `GemPurpleCodex.exe`，无需 VBScript。源码中的 `G.E.M. Purple Codex.vbs` 和 `start-gem-purple-codex.ps1` 保留为旧快捷方式的兼容入口。

入口执行 `launcher/start-gem-purple-codex.ps1`，优先使用包内 `tools/node/node.exe`，源码运行时才查找系统 Node.js 24+。安装器不修改 PATH 或系统执行策略，也不在安装完成后自动启动 Codex。

启动脚本通过 `Get-AppxPackage -Name OpenAI.Codex` 和包清单定位当前应用；`activate-codex.ps1` 使用 MSIX 激活接口保留包身份。调试探测同时检查 IPv4 与 IPv6 回环地址，排除透明桌宠页面，等待原生 `app://-` 页面后应用主题并确认 watcher 状态。

专用入口首次启用调试端口时可能退出并重启后台 Codex；使用前先保存工作。日志在 `library/state/launcher.log`。

`install-gem-purple-shortcut.ps1` 创建项目、桌面及开始菜单入口，使用本机缓存的客户端图标；客户端更新后不依赖旧版本的 WindowsApps 路径。安装版卸载时，只移除仍指向该安装目录的快捷方式。

安装、升级、卸载和维护说明见根目录 [README](../README.md) 与 [维护文档](../docs/maintenance.md)。
