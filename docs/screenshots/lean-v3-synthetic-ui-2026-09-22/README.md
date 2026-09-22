# Lean V3 纯合成界面回执（2026-09-22）

本目录只来自程序生成的“合成成员”单页 PNG：LDL-C 4.2 mmol/L、空腹血糖 5.1 mmol/L、2025-06-10，图片明确写着不是体检报告。先在隔离临时数据库实际执行 P01＋P02，再把该数据库复制到 `family-health-app-smoke-*` 临时 userData，用当前 macOS arm64 **未签名、未安装**的解包应用打开。截图阶段没有再次调用模型，也没有连接正式家庭档案。

- [健康总览](01-overview.png)、[身体与指标](02-body.png)、[指标详情](03-metric-detail.png)
- [检查时间线](04-timeline.png)、[事件详情](05-event-detail.png)、[生活与行动](06-guidance.png)
- [原始资料及来源侧栏](08-evidence-panel.png)、[处理中心](00-processing-center.png)
- [200% 等效视口中的行动正文](06-guidance-action-200-percent.png)，其余五个页签的窄视口截图同目录以 `-200-percent.png` 结尾。
- [机器审计](audit.json)：五个窄视口页面没有整页横向溢出；建议标题在标准／窄视口分别有 575px／426px 宽；指标、事件、来源详情均打开；键盘打开／关闭证据侧栏并恢复焦点；当前页面无缺少可见文字、`aria-label` 或 `title` 的按钮。

截图前发现“生活与行动”新版建议卡片套用了旧建议的 34px 图标栏网格，标题被挤成竖排；此目录是修正 CSS 与重新构建后重拍的结果。这里只证明这份纯合成资料在当前未签名 macOS arm64 解包应用中的页面路径，不证明扫描 PDF、多成员真实数据库、已签名安装包、Windows／Intel Mac 或医学质量。`200%` 使用 720×450 CSS 视口和 2 倍设备像素；顶部截图不代表下方正文可读，故另存滚动后的行动正文。

复现入口：`scripts/prepare-lean-v3-ui-smoke.mjs` 只接受 `P01_P02_IMAGE_SYNTHETIC` 成功回执；应用参数 `--family-health-smoke-user-data=` 只允许系统临时目录下直接以 `family-health-app-smoke-` 开头的目录；`scripts/capture-member-v2-personal-ui.mjs` 用独立本机调试端口逐页截图。使用结束后退出隔离应用；不在仓库发布临时数据库或模型候选文件。
