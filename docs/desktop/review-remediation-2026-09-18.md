# GPT-6 Pro 评审核实与修复记录

核对基线：Git commit `37ebbd85d37b7b9f7f12f8d65e2fe8f722001821`。本地重跑评审证据包的 9 个观察项，全部复现，因此 R01–R12 均按有效问题处理，不仅修改界面文案。

| ID | 结论 | 修复后的硬门禁 / 出口 |
|---|---|---|
| R01 | 已修复 | 提取和复核必须返回独立 subject 证据；明示姓名不匹配会阻断，无姓名只接受可审计的用户/目录归属。 |
| R02 | 已修复 | 每个文档有与修订号无关的稳定提交键；事实、提交记录和文档完成状态同一事务；重启跳过已提交文档。 |
| R03 | 已修复 | 每次 AI 调用前后与最终 SQLite 事务内都验证 job/attempt/consent/account/cancel 执行栅栏。 |
| R04 | 已修复 | `SourceManifest` 的 total/covered/normalizer/warnings 原样持久化；历史缺失元数据失败关闭，不再伪造完整覆盖。 |
| R05 | 已修复 | 校验引用是来源片段子串，数值出现在引用中，日期是真实日历日。 |
| R06 | 已修复 | 派生包含 birthYear/genderContext/user_reported notes；出生年变化推进临床上下文 revision；“立即处理全部”支持只刷新过期派生说明。 |
| R07 | 已修复 | specimen/method/bodySite/全部 evidence 进入 observation revision；趋势按单位+标本+方法+部位分组。 |
| R08 | 已修复 | 复核冲突保存可编辑候选；用户可核对名称、结果、单位和日期后本地重跑确定性校验并原子发布。 |
| R09 | 已修复 | Dashboard 独立输出 timeline events，包含定性/文本事实、未知临床日期报告和用户补充，不再从数值趋势反推。 |
| R10 | 已修复 | 持久化每次 AI 发送事件和 sending/completed/unknown 状态；收件箱从审计表投影。 |
| R11 | 已修复配置 | `main` push 触发 macOS arm64、macOS x64、Windows x64 真实构建矩阵。远程回执需在推送本修复 commit 后读回。 |
| R12 | 已修复 | 补齐架构、安全、隐私、威胁模型和发行清单；`pnpm docs:check` 检查所有相对链接。 |

评审中另列的 App Server 读取根、超大派生上下文、解析器隔离和单文件可维护性是运行时/演进风险，证据包没有证明当前已发生安全突破。它们保留在发行验收和威胁模型中，不被冒充为“已验证无风险”。
