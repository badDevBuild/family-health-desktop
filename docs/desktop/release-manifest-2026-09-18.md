# 三架构本机测试产物清单

生成时间：2026-09-18 09:37 +0800

## 当前产物

- `release/家庭健康看板-0.1.0-arm64.dmg`：macOS arm64，267,016,936 bytes
- `release/家庭健康看板-0.1.0.dmg`：macOS x64，283,691,267 bytes
- `release/家庭健康看板 Setup 0.1.0.exe`：Windows x64 NSIS，217,757,879 bytes
- 应用版本：0.1.0
- Bundle ID：`com.familyhealth.desktop`
- Codex runtime：0.145.0，私有 `CODEX_HOME`
- 签名/公证：未执行，仅供开发验收
- macOS arm64：326 个文件；主程序、Canvas、SQLite、Codex 均为 arm64；本机正常 App 启动路径通过，专用冒烟参数使主进程、GPU、网络与 Renderer 全部使用受限系统临时目录
- macOS x64：326 个文件；主程序、Canvas、SQLite、Codex 均为 x86_64；Rosetta 启动通过，主进程、GPU、网络与 Renderer 全部使用受限系统临时目录
- Windows x64：解包目录 145 个文件；主程序、Canvas、SQLite、Codex 均为 x86-64 PE；仅完成交叉构建与静态扫描，未在 Windows 目标机启动
- 三个解包工件均未发现工作区数据库、备份、会话目录、用户绝对路径或令牌值；每个工件只保留自身目标架构的原生模块和 Codex runtime
- 打包前按 Electron 38.8.6 和目标平台单独取得 `better-sqlite3` 12.11.1 预编译模块，关闭 builder 的隐式宿主机重建；after-pack 与发行扫描都会解析 Mach-O/PE 头并拒绝架构不符。该门禁曾实际拦截 Windows 包误带 macOS x64 SQLite 模块，修复后重建通过。
- `runtime/libreoffice` 仅含占位文件，没有把严格签名校验失败的候选组件带入任何安装包。
- 当前源码对应的权威候选工件已提升到 `release/`。提升前确认所有应用进程均已退出；上一批工件完整保留在 `release-previous-20260918/`，仅用于回退和对照。

## SHA-256

```text
d72461a543ec2034b37b7138e2c8b261ec1fc6498737810534a5c1719fc3da40  家庭健康看板-0.1.0-arm64.dmg
91d005383bb37185d309c144099b3a0e653edd0b3ac81a05b0f6f43309124777  家庭健康看板-0.1.0.dmg
2733a74d6f4143f42f28e68bd8dc2b41ad78d9940bb9c34599e67ee8fa078875  家庭健康看板 Setup 0.1.0.exe

1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590  darwin-arm64/bin/codex
6db9193ce2c9a8cef2b5482612cde24202a4329dfc34f4687a036d5d7da619af  darwin-x64/bin/codex
83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c  win32-x64/bin/codex.exe

252525b37ab070c03ef7b1457b30e5f5792a07b74e34ff12bfbd5059c29b3c36  darwin-arm64/better_sqlite3.node
fa63a771f59495f477233fa2b9de566e21097da5e062d2723e1d2ab3c5d6f1ed  darwin-x64/better_sqlite3.node
69d712b1a0a8d94e45b9ebd75de13fea01fafad5edf883ec6b0c2fba76e445a4  win32-x64/better_sqlite3.node
```

这些校验和只对应本次未签名测试构建。macOS x64 的 Rosetta 冒烟不能替代 Intel Mac 实机，Windows 静态扫描不能替代 Windows 安装与运行。重新打包、签名或公证后必须重新生成校验和。
