# 旧版 DOC 兼容组件门禁

更新时间：2026-09-18

## 已实现的产品链路

- 旧 `.doc` 原始字节先按 OLE/CFB 魔数登记到不可变对象库，转换不会修改或替换原对象。
- 只有具有目标平台、固定版本和可执行文件 SHA-256 的 `component-manifest.json` 才能启用转换器；路径穿越和逃逸到组件目录外的符号链接会被拒绝。
- LibreOffice 以参数数组直接启动，不使用 shell 字符串；使用一次性独立 `UserInstallation` profile，不开放 UNO listener。
- 临时 profile 将宏安全级别固定为 Very High、可信目录置空并阻止非可信来源链接；启动参数使用 headless、无恢复、无默认窗口和无首次启动向导模式。
- 转换限时 45 秒，只接受不超过 200MB 且以 `%PDF-` 开头的输出；无输出、超时、异常退出、版本/哈希不符均失败关闭并保留原件。
- 转换 PDF 作为单独 SHA-256 对象持久化，数据库记录转换器版本、可执行文件哈希和遗漏警告；证据侧栏明确显示“旧版 Word 转换视图，分页可能与原件不同”。
- 原 `.doc` 与转换 PDF 都会进入加密备份对象清单；删除报告时清理无其他引用的转换对象。

LibreOffice 官方说明确认 `--headless`、`--convert-to`、`--outdir` 和独立 `UserInstallation` profile 的命令行能力：<https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html>。宏安全“Very High”只允许可信位置中的宏，其余禁用：<https://help.libreoffice.org/latest/en-ZA/text/shared/optionen/macrosecurity_sl.html>。外部链接更新仍受安全设置约束：<https://help.libreoffice.org/latest/en-GB/text/shared/optionen/01040900.html>。

## 2026-09-18 本机真实探针

| 项目 | 结果 |
|---|---|
| 上游包 | LibreOffice 26.8.0 macOS Apple Silicon 官方 DMG |
| 官方下载 SHA-256 | `8858d8058da4f862f47559486814e65efc27294da67c5e4bb56b006b1ee59f89`，与同目录官方 `.sha256` 一致 |
| 实际运行版本 | `26.8.0.3`，build `bce0998afefdbc355585ca324285661a2170ba77` |
| `soffice` SHA-256 | `820ce37c7f7f496f73516d932109b1254463b33a993ceae0cfbaabac62f164bf` |
| 输入 | macOS `textutil` 生成的纯合成 OLE `.doc`，不含真实健康资料 |
| 输出 | 12,913 bytes、1 页 PDF；现有 PDF 层成功读出 `LDL 3.8 mmol/L` |
| 临时数据 | DMG、挂载点、合成 DOC/PDF 均在探针后删除 |
| 签名门禁 | **未通过**：`codesign --verify --deep --strict` 对官方 App 返回 `invalid signature (code or signature have been modified)`；因此未复制进发行暂存目录，也不宣称可分发 |

中文文本在未附带一致字体时出现字形替代，证明不能承诺分页和字体与 Word 完全一致；数值/单位仍能被 PDF 文本层读取。此探针只证明当前 arm64 主机上的功能链路，不替代复杂版式、批注、嵌入图像、恶意样例以及 Intel Mac / Windows x64 的验证。

## 仍需满足的 G0 条件

1. 确定可合法再分发且签名验证通过的固定 LibreOffice 构件；发行包内附 MPL-2.0、第三方许可证和对应源码获取说明。LibreOffice 官方许可证页：<https://www.libreoffice.org/licenses/>。
2. 为 `darwin-arm64`、`darwin-x64`、`win32-x64` 各生成独立组件 manifest、完整构件校验和和架构证据，不共享未验证目录。
3. 在三个目标环境分别执行简单文本、复杂表格、图片、批注、损坏文件、宏和外链样例，并观察进程、网络、超时、临时目录与崩溃恢复。
4. 发行扫描必须证明安装器只包含目标架构组件；App UI 在组件缺失时提供明确安装/恢复路径，不能要求用户使用终端或在线转换站。

