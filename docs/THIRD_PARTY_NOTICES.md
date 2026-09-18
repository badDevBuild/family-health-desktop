# 第三方组件与发行提示

本文件记录桌面应用关键运行时和格式兼容组件。完整依赖树仍以锁定的 `pnpm-lock.yaml`、各包内 LICENSE 文件和最终发行工件扫描结果为准。

## 关键组件

| 组件 | 锁定版本 | 用途 | 许可证 | 上游 |
|---|---:|---|---|---|
| `@napi-rs/canvas` | 0.1.100 | 将扫描 PDF 页面渲染成受控 PNG | MIT | <https://github.com/Brooooooklyn/canvas> |
| `libheif-js` | 1.19.8 | 在本机解码 HEIC/HEIF，多图容器逐图处理 | LGPL-3.0 | <https://github.com/catdad-experiments/libheif-js> |
| `word-extractor` | 1.0.4 | 读取旧版二进制 `.doc` 的文字流 | MIT | <https://github.com/morungos/node-word-extractor> |
| `mammoth` | 锁文件所列版本 | 解析 DOCX 正文、表格与媒体关系 | BSD-2-Clause | <https://github.com/mwilliamson/mammoth.js> |
| `jszip` | 3.10.2 | DOCX 容器路径、条目数量与解包体积预检 | MIT | <https://github.com/Stuk/jszip> |
| `pdfjs-dist` | 锁文件所列版本 | PDF 文本、页数与页面渲染 | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| `better-sqlite3` | 锁文件所列版本 | 本机 SQLite 数据库与一致性备份 | MIT | <https://github.com/WiseLibs/better-sqlite3> |
| LibreOffice | 候选 26.8.0.3，**当前未随 App 分发** | 旧版 `.doc` 本地 headless 转换候选组件 | MPL-2.0，安装包另含多种第三方许可证 | <https://www.libreoffice.org/> |

## LGPL 发行边界

`libheif-js` 及其 `libheif` WebAssembly 构件按 LGPL-3.0 分发。公开发布前必须完成发行法务/许可证复核，至少确认：

1. App 内或发行包中提供 LGPL-3.0 许可证全文和显著的组件使用说明；
2. 保留上游版权与许可证声明，并提供所分发精确版本的对应源码获取方式；
3. 不阻止用户按照许可证替换或调试该 LGPL 组件；
4. 若对该组件有修改，按许可证提供相应修改源码；
5. 最终安装包与更新机制经实际检查，确认组件仍可识别、可替换，且说明不会被打包流程遗漏。

当前仓库已锁定版本并保留上游许可证文件，但这不等于已经完成公开 Beta 的法律放行。未完成上述工件级复核前，不得宣称许可证门禁通过。

## 旧 DOC 能力边界

`word-extractor` 只用于受控测试/诊断文字流，不能作为完整旧 DOC 证据主路径。产品主路径已实现 LibreOffice headless 适配器，但只有目标平台、固定版本、可执行文件哈希、签名和许可门禁全部通过的组件才会启用。复杂版式、字体、分页、批注和嵌入图像必须显示转换边界；当前候选组件因严格签名校验失败未随 App 分发，详见 `desktop/libreoffice-component-gate.md`。
