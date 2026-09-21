# 成员档案 v2 验收记录（2026-09-21）

基线提交：`4d0f039015de30a9dddd1b0abdbe51c4f982269f`。本轮在未提交工作区上继续实施，没有覆盖或回滚既有修改。

本记录严格区分四种状态：

- `PASS_LOCAL`：当前 Mac arm64 源码环境中，自动测试或真实 React／IPC／SQLite 合成旅程已通过。
- `PASS_CODE`：实现和针对性自动测试已通过，但没有在成品安装包中完整重放该场景。
- `PARTIAL`：主路径已实现，验收场景仍有一段未形成同一条端到端回执。
- `NOT_RUN`：当前环境没有执行，不以 mock、截图或源码门禁冒充通过。

所有截图和数据库均为纯合成数据，不含真实家庭成员或健康资料。

## 本轮可复查证据

- 主导航、五个成员页签、指标／事件／证据详情和窄视口截图索引：[`screenshots/app-pages-2026-09-21`](screenshots/app-pages-2026-09-21/)
- 200% 等效视口与键盘审计：[`audit.json`](screenshots/app-pages-2026-09-21/member-profile/audit.json)
- 采纳行动前的完整页面与交互回执：[`j1-before-refresh`](screenshots/app-pages-2026-09-21/acceptance-scenarios/j1-before-refresh/)
- 新报告更新后的完整页面与行动保留回执：[`j1-after-refresh`](screenshots/app-pages-2026-09-21/acceptance-scenarios/j1-after-refresh/)
- 甲状腺语义整理页面回执：[`j2-thyroid`](screenshots/app-pages-2026-09-21/acceptance-scenarios/j2-thyroid/)
- 一次体检多文件与历史结果页面回执：[`j3-event`](screenshots/app-pages-2026-09-21/acceptance-scenarios/j3-event/)
- 取消、重启和旧事实保留页面回执：[`j4-exception`](screenshots/app-pages-2026-09-21/acceptance-scenarios/j4-exception/)
- 合成工作区播种脚本：[`seed-member-v2-smoke.ts`](../scripts/seed-member-v2-smoke.ts)
- “采纳 → 新报告 → 更新分析 → 保留行动”脚本：[`advance-member-v2-smoke.ts`](../scripts/advance-member-v2-smoke.ts)
- 甲状腺语义旅程脚本：[`seed-member-v2-thyroid-smoke.ts`](../scripts/seed-member-v2-thyroid-smoke.ts)
- 报告转事件旅程脚本：[`seed-member-v2-event-smoke.ts`](../scripts/seed-member-v2-event-smoke.ts)
- 日常更新与例外旅程脚本：[`run-member-v2-exception-smoke.ts`](../scripts/run-member-v2-exception-smoke.ts)
- 可重复逐页截图脚本：[`capture-member-v2-personal-ui.mjs`](../scripts/capture-member-v2-personal-ui.mjs)
- 实施基线与数据保护说明：[`member-profile-v2-implementation-baseline.md`](member-profile-v2-implementation-baseline.md)

截图审计结果：J1–J4 均使用隔离 SQLite 工作区和真实 React／IPC 页面重放。标准视口覆盖 5 个页签以及指标、事件、证据三类详情；每组 200% 等效视口均覆盖 5 个页签，`documentScrollWidth === documentClientWidth === 720`，无横向溢出；当前页面不存在无文字、无 `aria-label`、无 `title` 的按钮。键盘旅程均通过“身体与指标页签 → 身体系统 → 指标 → 证据 → Escape 关闭”，证据侧栏打开时焦点进入关闭按钮，关闭后焦点返回原证据按钮。J1 在同一工作区完成“采纳行动 → 导入第四次 LDL → 系统说明变为四点非单调趋势 → 重启应用”；重启后界面直接显示“已采纳”，没有再次打开采纳表单，也没有重复建议。

## A01–A60 逐项状态

| ID | 状态 | 当前证据与边界 |
|---|---|---|
| A01 | PASS_LOCAL | 成员页只有“身体与指标”一个业务入口，原始资料保留为独立证据页；五页截图已重放。 |
| A02 | PASS_LOCAL | 点击系统进入系统详情而不是附件；身体页与指标详情截图已重放。 |
| A03 | PASS_LOCAL | 心血管详情同时展示系统范围、复核后综合、趋势、指标、限制与多条来源入口。 |
| A04 | PASS_CODE | `SystemEvidenceBundle` 保留正常和异常直接事实；系统综合测试覆盖完整引用，未在成品中另做“正常与异常并存”专门截图。 |
| A05 | PASS_LOCAL | 合成系统分析保留资料缺口和边界，不把未收录检查写成正常。 |
| A06 | PASS_LOCAL | TSH／血清促甲状腺激素在隔离应用中映射到同一序列；两次日期保留。 |
| A07 | PASS_LOCAL | 甲状腺旅程中 FT4 与总 T4 保持为两条不同指标；FT3／总 T3 和不同标本仍由核心测试覆盖。 |
| A08 | PASS_LOCAL | 同次 TSH 摘要和明细折叠为一个时间点，同时保留 2 个来源；成品页面与脚本回执通过。 |
| A09 | PASS_CODE | 同日、同值但独立样本继续作为两个观测，存储与提取测试通过。 |
| A10 | PASS_CODE | 未知概念保持原名和未分类状态，不做模糊强塞。 |
| A11 | PASS_CODE | 概念映射修正不改原事实，可撤销并使相关系统失效；SQLite 测试通过。 |
| A12 | PASS_LOCAL | LDL 同一底层事实同时作为心血管直接事实和代谢背景；总次数不复制。 |
| A13 | PASS_LOCAL | 四个明确年度 LDL 结果分别入库并形成四点趋势；新增报告后的趋势更新已在同一隔离工作区重放。 |
| A14 | PASS_CODE | 单点序列只显示值、单位、日期与范围，不生成长期趋势；趋势测试通过。 |
| A15 | PASS_CODE | 两点序列输出差值和间隔并限制措辞；趋势测试通过。 |
| A16 | PASS_CODE | 非单调三点不会被描述为持续上升；趋势方向测试通过。 |
| A17 | PASS_LOCAL | 指标图使用真实日期比例定位，四点非单调趋势截图可复查。 |
| A18 | PASS_CODE | 每个点保存自己的参考范围，图例和表格不把最新范围套给历史。 |
| A19 | PASS_CODE | 比较符保留，界限值不作为精确等值参与差分。 |
| A20 | PASS_CODE | 缺失／不可比点不补零、不连线，并返回原因。 |
| A21 | PASS_CODE | 仅允许受控单位换算并同时保留原值；未知换算拒绝。 |
| A22 | PASS_LOCAL | 体检总报告、检验、心电、超声和历史比较共 5 份文件在隔离应用中形成 1 个体检事件。 |
| A23 | PASS_LOCAL | 历史比较列产生 1 组独立历史观测；时间线仍只有 1 次当前体检。 |
| A24 | PASS_CODE | 同日不同机构不自动归并；强标识唯一性门禁测试通过。 |
| A25 | PASS_CODE | 无机构时保持“未记录”，不从路径或所在地猜测。 |
| A26 | PASS_LOCAL | J3 同时保存当前检查日期与 `history_quoted` 历史日期；事件按当前检查日期显示。 |
| A27 | PASS_CODE | 年／月／日精度单独表达，不补虚假月日。 |
| A28 | PASS_LOCAL | 当前机构没有套给报告引用的 2024 历史结果；事件详情页面和脚本断言通过。 |
| A29 | PASS_LOCAL | J3 修正机构名称后仍为 1 个事件／5 份报告，修正可撤销、未创建模型任务；合并／拆分仍由 SQLite 测试覆盖。 |
| A30 | PASS_CODE | 手动病史／用药保留 `user_reported` 来源并进入相关系统证据包。 |
| A31 | PASS_CODE | 直接事实和背景事实分层，关联理由不写成因果诊断。 |
| A32 | PASS_CODE | 不存在、跨成员或越界证据使发布被本地拒绝。 |
| A33 | PASS_CODE | 模型趋势描述与确定性 `TrendFacts` 不一致时拒绝发布。 |
| A34 | PASS_LOCAL | 系统说明可展开全部三条个人资料依据，证据侧栏保留定位。 |
| A35 | PASS_CODE | 指标按系统／主题压缩并支持搜索；179 项长列表尚未做成品性能回执。 |
| A36 | PASS_CODE | 切换成员以 personId 重新读取所有投影，不复用上个成员结果；React 测试通过。 |
| A37 | PASS_LOCAL | 证据侧栏支持 Escape 关闭，自动把焦点还给原触发按钮；React 测试通过。 |
| A38 | PASS_CODE | 事件进入系统后保存事件上下文，并提供“返回这次检查”。 |
| A39 | PASS_CODE | 页面读取只走只读 IPC；相同系统签名跳过模型任务。 |
| A40 | PASS_CODE | 内容哈希与文档提交键阻止重复导入虚增事实。 |
| A41 | PASS_CODE | 新事实先可读，相关旧快照变 stale，CAS 发布新版范围。 |
| A42 | PASS_CODE | 输入选择按概念和系统规则计算影响，不只依赖旧快照引用。 |
| A43 | PASS_CODE | 称呼和文件显示名不进入健康事实签名，不触发模型。 |
| A44 | PASS_CODE | 系统级签名和相关背景筛选避免全家、全系统重算。 |
| A45 | PASS_LOCAL | 已移除 1100px 强制最小宽度；5 页在 720×450、DPR 2 的 200% 等效视口下无横向溢出。 |
| A46 | PASS_LOCAL | 原生键盘事件已跑通页签、系统、指标和证据；图表有数据表替代；证据侧栏焦点进入关闭按钮，Escape 后返回原触发按钮。 |
| A47 | PASS_CODE | 授权、成员、文档和历史范围在发送前后及写库时重复校验；真实账户传输回执未在本轮执行。 |
| A48 | PASS_LOCAL | Apple M2 Max／96GB／darwin-arm64 上，10 人、500 文档、5 万指标、12 次热读取的 P95 为 668.5ms，目标 1000ms；主快照每人最多读取最近 500 条展示窗口，精确总数和最近日期由 SQL 聚合保留。优化前同一基准 P95 为 4358.5ms。 |
| A49 | PASS_CODE | v29–v33 事务迁移和旧数据兼容测试通过；不确定元数据保持未知。 |
| A50 | PASS_CODE | 一致性备份、错误恢复和旧任务执行守卫测试通过；成品升级回滚仍未跨平台重放。 |
| A51 | PASS_CODE | AI 生活建议缺一般知识依据时 schema 拒绝；个人事实与 HTTPS 一般知识分开。 |
| A52 | PASS_CODE | 同 `dedupeKey` 的跨系统候选合并成一条提议并合并理由。 |
| A53 | PASS_CODE | 目标／限制作为个人背景进入适用性判断；明显冲突由安全复核拒绝。 |
| A54 | PARTIAL | 契约可表达特殊背景和适用范围，但儿童专用合成旅程尚未单独执行。 |
| A55 | PASS_LOCAL | 已采纳行动独立持久化；新增报告和新派生快照后，行动 ID、用户目标、起始方式、计划信息均保留，同一 `dedupeKey` 不再生成重复待确认卡片；重启应用后仍显示已采纳。 |
| A56 | PASS_CODE | “暂不采纳”跨新快照保留且可手动恢复。 |
| A57 | PASS_CODE | 医生原文、AI 提议与就医准备使用不同 `sourceKind` 和界面标签。 |
| A58 | PASS_LOCAL | 合成生活方案可展开目标、步骤、起点、依据、限制与记录方式。 |
| A59 | PASS_LOCAL | J4 在模型 turn 运行中取消任务，随后返回的迟到成功结果未发布；重启后旧事实可读、待核对可继续完成。 |
| A60 | NOT_RUN | 当前只完成 Mac arm64 源码和隔离 Electron 旅程；Mac x64、Windows x64 成品未执行。 |

## J1–J4 完整旅程

| 旅程 | 状态 | 已完成 | 尚缺 |
|---|---|---|---|
| J1 心血管纵向管理 | PASS_LOCAL | 同一隔离 React／IPC／SQLite 工作区已完成三年 LDL 与系统综合、采纳行动、导入第四次 LDL、更新为四点非单调趋势、保留原行动并重启复查；重复建议数为 0 | 真实 Codex 账户调用仍按 A47 单独标记，不冒充本地旅程结果 |
| J2 甲状腺语义整理 | PASS_LOCAL | 同一隔离应用已完成 TSH 别名归一、同次来源去重、FT4／总 T4 分离、TPOAb、左右叶超声分离及不确定病灶不计算增长；页面和键盘回执通过 | 真实 Codex 账户调用仍按 A47 单独标记 |
| J3 报告转事件 | PASS_LOCAL | 同一隔离应用已将 5 份资料归为 1 次体检，分开 5 条本次结果与 1 条历史结果；机构修正后时间线更新、可撤销且模型任务增量为 0 | Mac x64／Windows 成品仍按 A60 单独标记 |
| J4 日常更新与例外 | PASS_LOCAL | 同一隔离工作区完成成功处理、病史补充、重新分析、资料移出／恢复、混合冲突单项修正、取消迟到任务、重启、旧事实保留和待核对继续完成 | 真实账户撤权回执仍按 A47 单独标记；本地取消回执已完成 |

## 工程门禁

命令：`pnpm check`

- lint：通过
- Node/Web TypeScript：通过
- Codex 线程配置探针：通过
- Vitest：30 个文件、282 项通过
- 文档链接：36 个 Markdown 文件通过
- Electron 生产构建和构建产物校验：通过

本结果不等于签名／公证安装包、真实 Codex 账户调用或 Windows 成品通过。

附加容量门禁：`pnpm benchmark:local` 单独通过，样本为 10 位成员、500 份文档、50,000 条指标；最近一次构造 5968.4ms，快照读取 12 次，P95 668.5ms。
