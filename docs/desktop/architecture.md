# 桌面端架构

家庭健康看板是 Electron + React 的本机应用。渲染层只通过预加载桥接调用经过 Zod 校验的 IPC；主进程管理工作区、SQLite、不可变原始对象、Codex App Server 与本机文件预览。

数据流程：

1. 导入字节先写入按 SHA-256 寻址的对象库。
2. 本地规范化产生完整 `SourceManifest` 和可定位 `SourceSpan`。
3. 每个文档经过事实提取与独立复核，本地规则校验成员、覆盖、引用内容与日期。
4. 文档事实、修订号、文档完成状态以及稳定提交键在同一 SQLite 事务中写入。
5. 派生分析只读已接纳事实、成员临床上下文与用户补充，再经安全复核发布。这两个派生阶段可按需使用 Codex 内置 Web Search 查询去标识化的通用医学背景；搜索结果不能替代或改写已接纳事实。

事实提取与事实复核的线程配置使用 `web_search = "disabled"`；派生分析与安全复核使用 `web_search = "live"`。两者的命令沙箱都保持只读且 `networkAccess = false`，shell、browser、apps、plugins 和 MCP 等能力在 App Server 进程级显式禁用。锁定版 Codex 0.145.0 的真实 `thread/start` 兼容性探针覆盖搜索禁用与实时两种配置，防止 mock 接口掩盖未知配置字段。

Codex 模型设置默认使用 `gpt-5.6-sol` 与 `medium` 推理强度。设置页通过 App Server 的 `model/list` 读取当前账号真实可用、同时支持文本和图像的模型，再只展示该模型声明支持的推理强度；保存时主进程会再次校验组合。每个任务在领取时冻结模型与推理强度，后续设置变更只影响新任务，冻结值写入 `job_attempts` 审计记录。

分层包：`contracts` 定义边界，`ingestion` 负责本地规范化，`health-core` 负责确定性接纳规则，`storage` 负责事务与审计，`apps/desktop` 组装运行时和界面。

关键不变量：未授权不发送；取消或撤权后迟到结果不落库；一份文档只有一次事实提交；原始依据可回链；派生内容不覆写事实。
