# 家庭健康桌面看板

一个以“身体系统 + 时间线”为主线的本地家庭健康桌面应用。它把体检报告、医院检查与个人备注整理成可追溯的健康事实，再生成面向普通家庭成员的解释、提醒与生活指南。

> 当前版本仍处于早期测试阶段。它可以根据来源说明已有诊断或给出有条件的医学判断，但不能代替医生的正式诊断、治疗决策或处方；遇到异常结果或身体不适，请咨询医生。

## 核心特点

- 本地优先：数据库、原始报告和备份默认保存在用户设备中。
- 器官中心：按心血管、代谢、肝胆、肾脏等身体系统组织信息。
- 双轴阅读：同一份事实既能按身体系统查看，也能按时间线查看。
- 来源可追溯：健康结论保留到原报告片段的证据引用。
- 明确授权：目录监控、AI 处理和备份恢复均遵循显式授权边界。
- 适合家庭：大字号、温和平静的状态表达和移动端友好的信息层级。

## 隐私边界

本仓库只包含应用源代码、设计文档、合成测试数据和构建配置，不应包含任何真实健康资料、数据库、备份、账号凭据、登录状态、本机绝对路径或已构建安装包。

AI 处理不是纯本地操作。只有用户明确授权后，应用才会把所选报告及同一成员的相关已接纳历史事实和必要本人补充发送给已登录的 Codex/OpenAI 服务。事实提取和局部修复禁用网页搜索；成员综合可按需使用 Codex 内置 Web Search，重点复核默认不联网。应用要求模型只查询通用医学问题，但目前无法在搜索词发送前逐条拦截；若模型违反要求，敏感内容可能进入搜索服务。详细边界见 [隐私说明](docs/desktop/privacy-data-boundaries.md) 与 [威胁模型](docs/desktop/threat-model.md)。

默认 AI 设置为 GPT-5.6-Sol + Medium。用户可以在应用设置中选择当前 Codex 账号实际可用的模型与推理强度；变更仅影响之后新启动的任务。

## 本地开发

要求：Node.js 22、pnpm 10。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

构建未签名测试包：

```bash
pnpm build:unpack
```

公开提交前，请先暂存文件并运行：

```bash
pnpm scan:public
```

## 文档

- [产品与桌面端规格](family-health-desktop-spec-v1/)
- [架构说明](docs/desktop/architecture.md)
- [安全设计](docs/desktop/security-design.md)
- [发布验收清单](docs/desktop/release-acceptance-checklist.md)
- [第三方组件声明](docs/THIRD_PARTY_NOTICES.md)

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。测试资料必须是合成数据，不得提交真实健康信息。

## 许可证

本项目采用 [MIT License](LICENSE)。
