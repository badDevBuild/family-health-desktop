# 发行验收清单

只有下列门禁全部满足，才能把构建称为可公开发行：

- [ ] `pnpm check` 、`pnpm scan:public` 和文档链接检查通过。
- [ ] GitHub Actions 在同一 commit 上完成 macOS arm64、macOS x64 和 Windows x64 的真实目标构建与运行时边界扫描。
- [ ] 取消、授权撤回、重试幂等、错人冲突、证据错位和 SourceManifest 覆盖缺口回归测试通过。
- [ ] 所有新增依赖已在 `THIRD_PARTY_NOTICES.md` 中复核，无未授权资产。
- [ ] 仓库公开扫描无真实健康资料、姓名、本机路径、token、cookie、登录链接或评审临时包。
- [ ] 安装包签名/公证、安装、启动、升级、备份恢复和卸载已在目标机实测。
- [ ] 版本号、commit SHA、平台、签名状态和产物 SHA-256 已写入发行清单。
- [ ] 已复核 [`security-design.md`](security-design.md)、[`privacy-data-boundaries.md`](privacy-data-boundaries.md) 和 [`threat-model.md`](threat-model.md) 中的剩余风险。

当前未签名本机构建只是 Beta 测试产物，不因自动化测试通过而自动升格为公开发行。
