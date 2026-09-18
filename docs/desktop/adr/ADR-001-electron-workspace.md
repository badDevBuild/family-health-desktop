# ADR-001：Electron 单代码库与工程边界

- 状态：Accepted for implementation
- 日期：2026-09-17

## 决策

使用 Electron、React、TypeScript、Vite 与 pnpm workspace，在一个工程中维护桌面外壳、Renderer 和领域包。平台差异限制在运行时、凭据、托盘、文件权限和转换适配器中；不复制 Mac/Windows 业务代码。

Renderer 保持浏览器权限边界；Preload 只暴露经 Zod 校验的业务 API；Main 与独立服务持有文件、SQLite、调度和 Codex 子进程能力。应用不监听公共 HTTP 端口。

## 影响

- 需要为 Electron ABI 重建原生 SQLite 依赖。
- macOS arm64/x64 与 Windows x64 分别构建安装包，但同一 tag、同一版本、同一业务测试集。
- 目标平台与签名状态必须各自记录，源码可编译不等于平台验收完成。

