# 验收执行结果

更新时间：2026-09-19

规格中的 AT001–AT104 按真实执行层级记录。缺少账户、目标机器、金标数据或签名条件时保持 `NOT_RUN/BLOCKED`，不以 Mock 或构建成功代替。

## 当前基线

| 项目 | 结果 | 证据 |
|---|---|---|
| 规格包 SHA-256 | PASS | `family-health-desktop-spec-v1/SHA256SUMS.txt` 全部匹配 |
| 锁定 Codex 运行时 | PASS（打包与启动） | `codex-cli 0.145.0`；schema/hash 见 `runtime-lock.json`；成品实际启动私有 `codex app-server --stdio --strict-config` 子进程 |
| 私有环境 stdio | PASS | initialize/initialized/account-read/model-list 在私有环境真实通过；当前 Mac 已完成官方账户连接与成品链路验证 |
| ESLint | PASS | 全工程 0 error |
| TypeScript 严格检查 | PASS | Node 与 Renderer 两套 tsconfig 均通过 |
| 自动测试 | PASS | 206 项常规测试覆盖 Codex 0.145.0 Web Search 禁用/实时 `thread/start` 兼容性探针、500 文档/5 万指标容量基准、Mach-O/PE 目标识别、发行工件目标架构清理和冒烟工作区路径门禁；另覆盖 40 个纯合成来源包/1,000 个字段/20% 留出/18 个安全故障样例及分项计算；同时覆盖 DOCX 表格/嵌入图、旧 DOC 原件保留、组件缺失、固定哈希/版本、独立 profile、无 UNO listener、超时、PDF 输出和转换视图、SQLite 锁/模拟磁盘满、schema v28 迁移与恢复、整篇候选覆盖证明、跨块身份聚合、任务绑定恢复、指标-数值-单位证据对应、双轮差异展示、恶意备份、恢复取消/故障恢复等 |
| LibreOffice arm64 合成探针 | PASS（功能）/ 签名 BLOCKED | 官方 26.8.0 DMG SHA-256 与官方校验文件一致；实际 26.8.0.3 将合成 OLE DOC 转成 12,913-byte、1 页 PDF，PDF 层读出 `LDL 3.8 mmol/L`；严格 codesign 校验失败，未打包，详见 `libreoffice-component-gate.md` |
| Mac arm64 源码构建 | PASS | Electron main/preload/renderer 生产构建与 preload 校验通过 |
| Mac arm64 未签名应用 | PASS（开发验收） | `release/mac-arm64/家庭健康看板.app` 实际启动；受限冒烟参数将主进程与全部 Chromium 子进程隔离到系统临时目录；品牌图标、私有运行时、个人空间、目录授权、处理授权、任务详情、手动补充、事项、导出、显示/通知、隐私/备份设置可达 |
| 约 200% 缩放 | PASS（人工） | 主要导航、成员/设置/事项弹窗仍可操作，无仅 hover 入口 |
| macOS arm64 签名/公证/DMG | BLOCKED | 缺少发行证书与公证条件 |
| macOS x64 | PASS（交叉构建与 Rosetta 冒烟）/ 目标机 NOT_RUN | 独立未签名 DMG 已生成；主程序、Canvas、SQLite、Codex 均为 x86_64；Rosetta 下家庭总览与收件箱可操作；仍缺 Intel Mac 安装运行 |
| Windows x64 | PASS（交叉构建与静态扫描）/ 目标机 NOT_RUN | 独立未签名 NSIS 已生成；解包主程序、Canvas、SQLite、Codex 均为 x86-64 PE，145 文件隐私与架构扫描通过；门禁实际拦截并修复过误带 macOS SQLite 模块；仍缺 Windows 安装运行 |
| 真实 Codex 登录/结构化输出 | PASS（当前 Mac）/ 图像与取消 PARTIAL | 用户已在成品完成官方账户连接；经明确授权的多页文字型 PDF 已完成整篇事实提取、独立核对、事实发布、综合分析与安全复核。图像型报告和运行中取消仍需专用样例补验 |
| 医疗准确率金标 | NOT_RUN（资产已就绪） | 已冻结 `family-health-synthetic-gold-v1` 的 40 个来源包、1,000 个字段、七类真实格式夹具和独立分项计算口径；当前 Mac 40 个夹具均通过应用类型检测，代表性 PDF/DOCX/HEIC/DOC 通过深层读取；没有真实模型、独立专业复核和三平台回执，因此不报告准确率数字 |
| 500 文档 / 5 万指标性能 | PASS（当前 Mac 热缓存） | M2 Max / 96GB / darwin-arm64；本次完整门禁的 12 次快照读取 P95 559.6ms，低于 1,000ms 目标；详见 `performance-results-2026-09-18.md` |
| 30 天无新增日程仿真 | PASS | 连续 30 天、每天 3 次重启；不创建空 batch/job，日程保持单记录，重复检查不调用模型 |
| 三架构发行内容扫描 | PASS（静态） | arm64/x64 Mac App 各 326 个文件，Windows 解包目录 145 个文件；均未发现工作区数据库、加密备份、会话目录、用户绝对路径或令牌值；扫描会解析全部 `.node` 与 Codex 可执行文件的 Mach-O/PE 头，证明只保留目标架构；三架构 CI 矩阵尚未在远端运行 |

## 逐项真实状态

完整的 104 项状态见 [`acceptance-matrix-AT001-AT104.md`](acceptance-matrix-AT001-AT104.md)。下表仅是便于阅读的工程能力归组，不替代逐项放行判定。

## 已覆盖的验收子集

| 验收项 | 结果 | 说明 |
|---|---|---|
| AT001–AT003 工程/运行时基线 | 局部完成 | 冻结规格、锁定 schema/runtime、私有 HOME 与严格启动门禁已实现；AT001 因两个目标平台 BLOCKED，AT002‑003 真实认证 NOT_RUN |
| AT011–AT013 启动与演示 | PASS（Mac arm64） | 无登录可打开纯虚构演示；个人空间隔离；无资料不显示健康正常 |
| AT018–AT020 成员契约 | PASS | 离线创建/编辑/归档/恢复成员；同名成员依靠稳定 personId；显示与临床 revision 分离；归档撤回目录/AI 授权且不删除历史；手动资料触发定向失效；无额外 App PIN |
| AT021–AT035 导入/格式 | 当前 Mac 主路已完成 | 支持系统选择和拖入；DOCX 正文块、表格单元格和嵌入图分别定位；旧 DOC 兼容适配器、缺失/失败关闭、转换对象和明确转换视图已实现，arm64 合成实探通过；AT022、024、026 仍有真模型、签名组件或跨平台 BLOCKED |
| AT040、AT062、AT096 报告删除 | PASS（本地集成） | 收件箱原文件移走不删档案；App 删除需双重确认并等待任务结束，级联移除当前事实/证据/派生/发布历史；tombstone 阻止回灌并可由用户解除；恢复点引用的共享原件不危险删除且回执明确残留 |
| AT036–AT050 收件箱/调度 | 当前 Mac 主路已完成 | 新增成员/状态筛选、批量归属/忽略、只处理选中项；slot 防重、DST/补跑、无新资料不调模型；AT039 的 Windows junction 仍 BLOCKED |
| AT051–AT070 事实与派生主流程 | PASS（当前 Mac 文字型 PDF） | 两次独立事实处理、覆盖门禁、CAS 发布、安全复核；真实成品整篇处理已完成；越界说明只阻断派生层，不回滚事实 |
| AT071–AT074 个人数据投影 | PASS | 成员隔离、报告日期/参考范围/来源保留；未知日期和比较符不伪造精确趋势；旧派生状态可见 |
| AT075–AT080 看板/证据/事项 | PASS（本机） | 六页签、原文受控预览、任务详情、例外核对、手动资料、事项状态、成员摘要导出和空状态可达 |
| AT081–AT096 安全/隐私/恢复 | 当前本机范围已完成 | sandbox/CSP/sender 校验、路径隔离、目录撤权、无 PHI 通知、脱敏诊断 canary、受控到期清理；第二实例实测退出，DB 锁和模拟磁盘满不产生半事务；备份篡改/截断/路径穿越整体失败，恢复可取消，磁盘写满会清理准备副本，切换失败或进程中断可回滚；AT082、085、089、094 的 Windows/真模型/同机真实任务条件仍 BLOCKED |
| AT101 本地读取容量 | PASS（当前 Mac 热缓存） | 10 位成员、500 文档、5 万指标；完整 Dashboard 快照 12 次 P95 559.6ms；收件箱/资料/时间线每批渲染 50 项，指标每批 12 组，55 份列表渐进加载回归通过；跨平台/低配机仍需另验 |
| AT102 30 天日程稳定性 | PASS（本地集成） | 30 天无新增、每天 3 次重启，不产生空任务或重复日程记录 |
| AT103 发行工件清洁度 | PASS（三架构静态工件） | 两个 Mac App 与 Windows 解包目录均扫描通过；仍缺公开仓库和正式签名 Release 工件复扫 |

## 尚未宣称通过

- 真实 Codex 的图像输入、运行中取消与超时边界；当前 Mac 的账户连接、文字型 PDF 结构化输出和完整发布链路已验证。
- macOS x64、Windows x64 的格式解析、运行时 helper、安装和升级。
- Apple/Windows 签名、公证及面向公众的下载体验。
- libheif LGPL 发行材料的最终法律/合规复核。
- 已冻结的 1,000 字段医疗金标与 18 个安全/故障样例的独立专业复核、真模型评测，以及五位外部目标用户任务观察。
- 低配置机器冷启动、跨平台容量/持续导入目标，以及具备签名发布物的官方更新源。
