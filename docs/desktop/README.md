# 桌面版交付入口

冻结规范保存在 [`../../family-health-desktop-spec-v1/`](../../family-health-desktop-spec-v1/)；实现不会修改规范原文。当前产物是 **macOS arm64 未签名本机测试版**，不是已签名的公开发行包。

- [实施状态](implementation-status.md)：逐任务说明代码、测试、成品和外部阻断。
- [验收结果](acceptance-results.md)：区分 PASS、NOT_RUN 与 BLOCKED。
- [AT001–AT104 逐项矩阵](acceptance-matrix-AT001-AT104.md)：每一项的状态、当前证据和缺失条件。
- [风险与阻断](risks-and-blockers.md)：公开发行前仍必须解决的事项。
- [第三方许可说明](../THIRD_PARTY_NOTICES.md)：关键依赖、来源与发行门禁。
- [本次三架构测试产物清单](release-manifest-2026-09-18.md)：版本、目标架构、签名状态与 SHA-256。
- [本地容量基准](performance-results-2026-09-18.md)：500 文档 / 5 万指标的当前 Mac 实测。
- [纯合成金标与安全故障数据集](synthetic-evaluation-dataset.md)：40 个来源包、1,000 个标注字段、8 个留出来源和 18 个故障样例的固定口径。
- [ADR-001](adr/ADR-001-electron-workspace.md)：Electron 工作区架构选择。
- [桌面端架构](architecture.md)：进程、包边界、数据流与关键不变量。
- [安全设计](security-design.md)：授权、执行栅栏、本地规则与备份控制。
- [隐私与数据边界](privacy-data-boundaries.md)：哪些数据留在本机，什么情况会发送。
- [威胁模型](threat-model.md)：资产、信任边界、主要威胁与剩余风险。
- [发行验收清单](release-acceptance-checklist.md)：公开发行前必须完成的硬门禁。
- [GPT-6 Pro 评审修复记录](review-remediation-2026-09-18.md)：R01–R12 的复现结论、修复门禁与未冒充关闭的运行时风险。

常用验证：

```bash
pnpm check
pnpm build:unpack
pnpm scan:release
```

三架构无签名测试构建模板位于 [cross-platform-beta.yml](../../.github/workflows/cross-platform-beta.yml)。它需要在实际 GitHub 仓库运行后才能形成 macOS arm64、macOS Intel x64 与 Windows x64 的平台回执；模板本身不发布 Release。

本机测试应用位于 `release/mac-arm64/家庭健康看板.app`。首次打开无需登录即可查看纯虚构演示；真实 Codex 登录必须由用户在应用中主动发起。
