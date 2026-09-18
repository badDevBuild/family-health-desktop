# AT001–AT104 逐项验收矩阵

更新日期：2026-09-18  
应用版本：0.1.0  
当前实测平台：macOS arm64（M2 Max）  
真实健康资料：未使用  

状态只使用规范定义的 `PASS / FAIL / BLOCKED / NOT_RUN`。其中 `BLOCKED` 表示已有局部工程证据，但完整验收仍缺真实账户、目标机器、签名、金标或人工参与者。Mock 或单机结果不会把这些项提前标成 PASS。

## G0 与首次使用（AT001–AT020）

| ID | 状态 | 当前证据 | 未完成条件 |
|---|---|---|---|
| AT001 | BLOCKED | arm64/x64 Mac DMG 与 Windows x64 NSIS 均内置目标架构 Codex 0.145.0；arm64 本机与 x64 Rosetta 启动通过 | Windows 目标机与 Intel Mac 实机安装/stdio 回执 |
| AT002 | NOT_RUN | 已实现官方浏览器登录入口 | 需用户授权的真实 Codex 登录 |
| AT003 | NOT_RUN | App 使用私有 `CODEX_HOME` | 需同机其他 Codex 登录会话的隔离实测 |
| AT004 | NOT_RUN | 图像 turn 已接入，扫描 PDF 会生成受控 PNG | 需真实账户与三平台图像回执 |
| AT005 | NOT_RUN | Schema turn、中断和终态处理已实现 | 需真实结构化输出和中断实测 |
| AT006 | BLOCKED | 事实阶段禁用 Web Search；派生阶段只开启内置实时 Web Search。两者命令沙箱均只读、无网络，本地 canary 边界有测试 | 需真实模型对抗回合、搜索词去标识化观测和受控进程/网络观测 |
| AT007 | BLOCKED | App Server 启动显式禁用 shell、browser、apps、plugins、MCP 等；仅派生阶段可用内置 Web Search | 需真实模型与三平台恶意样例 |
| AT008 | BLOCKED | arm64 HEIC 已验证；旧 DOC 固定哈希/版本转换适配器已实现，官方 26.8.0.3 合成 DOC→PDF→证据实探通过 | 官方 arm64 App 严格 codesign 失败而未打包；仍需签名可分发构件、Intel Mac/Windows 实机与许可复核 |
| AT009 | BLOCKED | 未登录真实 model/list 可读；额度缺失显示“未知” | 需真实账户额度回执 |
| AT010 | PASS | `schemas/codex/0.145.0`、`runtime-lock.json`、stdio 协议夹具、真实 initialize 回路，以及搜索禁用/实时两种配置的锁定版 `thread/start` 探针 | — |
| AT011 | PASS | arm64 空白/未登录成品可启动、看演示、建成员 | — |
| AT012 | PASS | 演示与个人工作区分离，切换回归测试通过 | — |
| AT013 | PASS | 未登录可维护本机档案；发送前需独立授权 | — |
| AT014 | BLOCKED | loginId 隔离、超时和脱敏分支已实现 | 需真实取消、回调冲突与过期通知 |
| AT015 | BLOCKED | `waiting_auth` 和重新核验授权机制已实现 | 需真实 token 过期/重登实测 |
| AT016 | PASS | 授权绑定账户指纹；退出会撤回 AI 授权并暂停待发送任务 | — |
| AT017 | PASS | 未知/耗尽/失败会等待，不自动购买、换 API 或无限重试 | — |
| AT018 | PASS | 稳定 personId、允许同名、显示 revision 与临床 revision 分离 | — |
| AT019 | PASS | 病史/过敏/用药/自测作为 `user_reported` 版本化来源，只失效相关派生内容 | — |
| AT020 | PASS | 退出需明确确认；不删本机档案，不增加 App PIN | — |

## 导入、收件箱与日程（AT021–AT050）

| ID | 状态 | 当前证据 | 未完成条件 |
|---|---|---|---|
| AT021 | PASS | PDF 逐页 manifest、文本/图像定位、原字节不可变存储集成测试 | — |
| AT022 | BLOCKED | 无文本层 PDF 逐页渲染且不漏 span 的测试通过 | 需真实 Codex 对模糊字段回执 |
| AT023 | PASS | JPEG/PNG 类型、像素限制、规范化视图和原对象定位已覆盖 | — |
| AT024 | BLOCKED | arm64 HEIC/HEIF 解码、多图 span 与 PNG 视图测试通过 | 需 macOS x64 / Windows x64 一致性回执 |
| AT025 | PASS | DOCX 正文块、表格单元格和嵌入图分别建立 source span；PNG/JPEG 嵌入图限量解出并随对应 span 进入两次视觉读取，不伪造页码 | — |
| AT026 | BLOCKED | 未安装时保留原件并明确引导；组件已校验时使用独立 profile、禁宏/外链、无 UNO listener、超时和 PDF 输出门禁，原件与转换对象分别保存，证据 UI 标明转换视图；arm64 合成实探通过 | 仍需签名可分发组件，以及复杂版式/批注/嵌入图像和三平台验收 |
| AT027 | PASS | UTF-8/BOM 与未知编码明确失败策略有单元测试 | — |
| AT028 | PASS | 自测值/本人补充可离线保存，来源与检验事实分开 | — |
| AT029 | PASS | SHA-256 内容去重；改名不重复，同名新字节保留新对象 | — |
| AT030 | PASS | 100MB/200页/像素/解包限额与可理解拒绝已实现 | — |
| AT031 | PASS | 魔数检测拒绝伪 PDF 可执行字节，不调用执行器 | — |
| AT032 | PASS | DOCX 仅离线解包白名单内容，不加载外链/执行脚本 | — |
| AT033 | PASS | 宏/未支持类型/损坏数据明确拒绝，单文件失败不阻塞其他文件 | — |
| AT034 | PASS | 缺页或未覆盖 span 会阻止自动接纳 | — |
| AT035 | PASS | 跨成员相同哈希会转待归属，不自动复制/合并 | — |
| AT036 | PASS | 目录授权、拖入/多选导入、发现只入本地队列，不即时发 AI | — |
| AT037 | PASS | size+mtime 稳定窗口、变化重算与去重测试 | — |
| AT038 | PASS | 启动/周期对账、原子替换及未变文件跳过测试 | — |
| AT039 | BLOCKED | 当前 Mac 已阻止工作区/备份/代码目录重叠与 symlink | Windows junction 目标机未验证 |
| AT040 | PASS | 移走收件箱原件不删档案；App 删除留 tombstone 并阻止回灌 | — |
| AT041 | PASS | 持久 slot、cutoff 冻结、任务进度和完成刷新测试 | — |
| AT042 | PASS | 30 天无新资料仿真不建空 batch/job，不调模型 | — |
| AT043 | PASS | 休眠恢复走合并补跑，同日 slot 去重 | — |
| AT044 | PASS | 真退出不承诺后台处理；启动后最多合并补跑一次 | — |
| AT045 | PASS | 手动/日程共用 inputSignature 和单 AI 租约，防重复任务 | — |
| AT046 | PASS | 批次 cutoff 冻结；后到资料留待下批 | — |
| AT047 | PASS | 固定时钟覆盖回拨、跳转、时区和 DST 重复/缺失 | — |
| AT048 | PASS | arm64 成品中日程、驻留、真退出、开机启动和无健康细节的处理通知设置可见可改 | — |
| AT049 | PASS | 停用目录同时撤回 AI 授权；已保存档案不删 | — |
| AT050 | PASS | 未绑定资料不上传；收件箱支持按成员/状态筛选、批量归属/忽略和只处理选中项 | — |

## AI、发布与展示（AT051–AT080）

| ID | 状态 | 当前证据 | 未完成条件 |
|---|---|---|---|
| AT051 | BLOCKED | Mock 纵向流程可自动完成事实与派生发布 | 需真实 Codex 清晰报告端到端回执 |
| AT052 | PASS | 不存在的 sourceSpanId 被规则拒绝 | — |
| AT053 | PASS | 定性/未知/比较符/缺单位契约与测试保留原语义 | — |
| AT054 | BLOCKED | Mock 双读不一致会转人工，不无限互评 | 需真实模型定向纠错回执 |
| AT055 | PASS | 复核 turn 必须带原始 span/页图，不只给结论 | — |
| AT056 | PASS | 事实可先于分析提交，派生状态显示 building/stale/unavailable | — |
| AT057 | PASS | 派生失败不回滚已接纳事实，下游可单独重试 | — |
| AT058 | PASS | 按成员分组任务；单个例外不堵塞其他成员 | — |
| AT059 | PASS | revision/CAS 拒绝旧输出静默覆盖 | — |
| AT060 | PASS | 显示名不动临床 revision；用药等上下文只失效该成员派生内容 | — |
| AT061 | PASS | 文档/事件 ID 独立，同日不靠日期静默合并 | — |
| AT062 | PASS | 删除/修正会推进 revision，旧 expectedRevision 和迟到结果被拒绝 | — |
| AT063 | PASS | 租约恢复、幂等提交键和 CAS 覆盖提交前后恢复 | — |
| AT064 | PASS | 非法/截断/Schema 不符输出不从局部文本入库 | — |
| AT065 | PASS | turn.completed 不等于可发布；缺必需阶段或安全复核会拒绝 | — |
| AT066 | PASS | 输入包按 personId/documentIds 构建，不默认带整家上下文 | — |
| AT067 | PASS | 报告原文与 AI 推断来源分层，推断不升级为医生确认 | — |
| AT068 | PASS | 诊断/剂量/个性化治疗文本由本地规则阻断派生发布 | — |
| AT069 | PASS | 自动接纳记录 policy actor、规则版本和证据，不伪造人工/医生签名 | — |
| AT070 | PASS | 例外处理保留原文和修订，只失效必要依赖 | — |
| AT071 | PASS | 空档案/资料不足/待更新有独立文案，不填充“正常” | — |
| AT072 | PASS | 趋势仅对相同指标+单位分组，每个点保留当次范围与原值 | — |
| AT073 | PASS | 线图不把升降默认染成好/坏；未知和非等值不造精确点 | — |
| AT074 | PASS | 指标/事件/资料可回到受控 span 或页预览，Renderer 不拿真实路径 | — |
| AT075 | PASS | 1100×720、1440宽与约 200% 缩放在当前 Mac 人工检查可操作 | — |
| AT076 | PASS | 语义标签、焦点样式、弹窗焦点环和状态文字已落地 | — |
| AT077 | PASS | 事项保留来源/状态/审计，完成状态用 revision 阻止旧输出覆盖 | — |
| AT078 | PASS | 用户安排、医嘱来源和 AI 待核实来源分开，不自动预约/代发 | — |
| AT079 | PASS | JSON/HTML/PDF 成员摘要只取所选成员和日期范围，含边界说明 | — |
| AT080 | PASS | 未登录/退出后本机看板、证据和导出仍可用 | — |

## 安全、备份、发行与人工验收（AT081–AT104）

| ID | 状态 | 当前证据 | 未完成条件 |
|---|---|---|---|
| AT081 | PASS | contextIsolation+sandbox、最小 preload、sender 校验和严格 Zod IPC | — |
| AT082 | BLOCKED | 对象 ID 读取、路径穿越/symlink canary 在 Mac 通过 | Windows junction 目标机未验证 |
| AT083 | PASS | 无静默外链/导航；HTML 导出转义；只允许白名单登录主机 | — |
| AT084 | PASS | 脱敏诊断 canary 测试及 arm64/x64 Mac、Windows x64 三个解包成品扫描均未发现凭据/数据库/正文 | — |
| AT085 | BLOCKED | 适配器默认拒绝工具/权限请求 | 需真实 Codex 越界请求的运行时证据 |
| AT086 | PASS | 只清 7 天临时视图与 30 天终结尝试；canary 证明不碰正式档案/相邻目录 | — |
| AT087 | PASS | 授权/额度等待、有限重试、取消后迟到输出隔离和单队列租约 | — |
| AT088 | PASS | 第二实例实测立即退出；旧租约恢复有集成测试；DB 锁快速失败，模拟磁盘满会同时回滚对象登记/审计并清理未引用文件，释放后可重试 | — |
| AT089 | BLOCKED | App 仅跟踪自己启动的 app-server/turn | 需同机另一 Codex 真实任务不受影响的回执 |
| AT090 | PASS | OAuth 不自动授权报告；目录/成员/用途/账户指纹发送前校验 | — |
| AT091 | PASS | SQLite backup API 一致性快照+对象 manifest/hash 验证 | — |
| AT092 | PASS | 加密备份正确口令恢复，错误口令整体失败 | — |
| AT093 | PASS | 篡改/截断整体失败且清理准备目录；条目白名单拒绝路径穿越；解包头/总量有硬上限；格式使用固定参数 scrypt，不接受备份文件提供的 KDF 成本参数 | — |
| AT094 | BLOCKED | 备份不保存 OAuth/原绝对路径，恢复后授权不继承 | 需 Mac↔Windows 真实双向恢复 |
| AT095 | PASS | 独立准备目录+全量校验后才进入原子切换；准备阶段取消和模拟磁盘写满均清理临时副本且不改当前库；切换失败会立即回滚；若进程中断在旧库改名与新库启用之间，下次启动自动恢复最新 `.before-restore-*` 工作区并通过 `integrity_check` | — |
| AT096 | PASS | 自动恢复点按 7 日+4 周轮转；删除回执明确恢复点残留 | — |
| AT097 | BLOCKED | 同一源码版本已产生 arm64/x64 Mac DMG 和 Windows x64 NSIS；原生模块与 runtime 均按目标架构净化；arm64 本机和 x64 Rosetta 启动通过 | 仍需 Intel Mac 与 Windows 目标机全新安装，以及同一 tag 的远端 CI/Release 回执 |
| AT098 | BLOCKED | schema v2→v5 前自动生成可识别一致性恢复点；多步迁移在单一事务内完成，故障注入后原库完整回到 v2；旧版面对 v99 schema 在创建 vault/恢复点或写库前明确拒绝，数据库字节不变 | 仍需用真实旧安装包→新安装包执行平台级安装升级、安装失败回滚与 UI 提示验收 |
| AT099 | BLOCKED | 当前应用 hash 与第三方许可清单可查 | 缺 Apple/Windows 签名、公证和正式下载渠道 |
| AT100 | BLOCKED | 已固定 `family-health-synthetic-gold-v1`：40 个纯合成来源包、1,000 个字段、8 个留出来源、18 个安全/故障样例；CLI 在干净目录物化 83 个文件，其中 40 个是真实 PDF/JPEG/PNG/HEIC/DOCX/OLE DOC/TXT 夹具；结构 manifest SHA-256 `e4c3667a…a929338`，当前 Mac 二进制夹具 manifest SHA-256 `e5505861…9cf875f` 且重复生成一致；40 个夹具均通过应用类型识别，代表性 PDF/DOCX/HEIC/DOC 通过深层读取；评测器分别计算精确率、覆盖率、成员错配、伪造证据、诊断升级与处方违规，空输出不会得到虚假高分 | 仍需使用获授权测试账户运行真实模型，并完成独立专业复核和三个目标平台评测；HEIC/OLE DOC 生成器当前仅在 macOS 可用 |
| AT101 | BLOCKED | 当前 M2 Max 热缓存 500 文档/5万指标快照 P95 559.6ms，且容量基准已纳入常规门禁；收件箱/资料/时间线每批最多挂载 50 项，指标每批 12 组，用户可继续加载且 55 份列表有界渲染测试通过 | 仍需 8GB 参考机冷启动、持续导入期间的 UI 主线程观测和三平台资源回执 |
| AT102 | PASS | 30 天、每天 3 次重启的无新增仿真无空任务/日程膨胀 | — |
| AT103 | BLOCKED | arm64/x64 Mac App 各 326 文件、Windows 解包目录 145 文件均通过扫描，无工作区 DB/备份/会话/用户路径/令牌哨兵；扫描解析 Mach-O/PE 头校验 Canvas、SQLite 与 Codex 目标，曾实际拦截错误的 Windows SQLite 构件；三个安装器均有 SHA-256 | 需公开仓库与签名后的正式 Release 工件复扫 |
| AT104 | NOT_RUN | 尚无未参与开发的目标用户回执 | 需 5 位外部目标用户完成首份/第二份导入任务观察 |

## 当前放行结论

- **G1 本地可靠内核：已达到当前 Mac arm64 开发验收范围。**
- **G0 真实集成：未放行。** 真实官方登录、真模型图像/Schema/中断和对抗能力仍未运行。
- **G2 医疗质量：未放行。** 合成金标、留出集和七类真实格式夹具已经冻结；仍缺真模型评测、独立专业复核和三平台回执。
- **G3/G4 跨平台与公开 Beta：未放行。** 缺 x64/Windows 目标机、签名/公证、正式更新源与五位外部用户验收。
