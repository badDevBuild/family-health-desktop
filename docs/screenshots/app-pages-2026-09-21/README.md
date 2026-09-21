# 家庭健康看板逐页截图（2026-09-21）

本目录使用隔离 SQLite 工作区和纯合成健康资料生成，不包含真实家庭成员、真实报告、账号邮箱或本机资料路径。

## 主导航页面

- [家庭总览](main-navigation/01-family-overview.png)
- [成员档案入口](main-navigation/02-member-profile.png)
- [报告收件箱](main-navigation/03-inbox.png)
- [处理中心](main-navigation/04-processing.png)
- [后续事项](main-navigation/05-actions.png)
- [设置](main-navigation/06-settings.png)
- [成员档案 200% 等效窄视口](main-navigation/08-member-profile-200-percent.png)
- [主导航页面审计](main-navigation/audit.json)

## 成员档案页面与详情

- [处理中心状态](member-profile/00-processing-center.png)
- [健康总览](member-profile/01-overview.png)
- [身体与指标](member-profile/02-body.png)
- [指标详情](member-profile/03-metric-detail.png)
- [检查时间线](member-profile/04-timeline.png)
- [检查事件详情](member-profile/05-event-detail.png)
- [生活与行动](member-profile/06-guidance.png)
- [原始资料](member-profile/07-sources.png)
- [证据侧栏](member-profile/08-evidence-panel.png)
- [已采纳行动](member-profile/09-adopted-action.png)
- [成员页签、键盘与窄视口审计](member-profile/audit.json)

成员档案 5 个页签另有对应的 `*-200-percent.png`，用于检查 200% 等效窄视口下的可读性和横向溢出。

## J1–J4 验收场景

- [J1 新报告更新前](acceptance-scenarios/j1-before-refresh/)
- [J1 新报告更新后](acceptance-scenarios/j1-after-refresh/)
- [J2 甲状腺语义整理](acceptance-scenarios/j2-thyroid/)
- [J3 多报告归并为一次健康事件](acceptance-scenarios/j3-event/)
- [J4 取消、重启与异常恢复](acceptance-scenarios/j4-exception/)

截图由 `scripts/capture-member-v2-ui.mjs` 和 `scripts/capture-member-v2-personal-ui.mjs` 通过 Electron 本机调试协议生成。截图过程不连接 Codex，不发送健康资料。
