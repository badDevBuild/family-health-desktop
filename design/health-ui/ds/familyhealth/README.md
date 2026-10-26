# 家庭健康

温暖、可信、平静。让家人先读懂身体情况，再按需要查看检查记录和原文依据。

## 内容准则

以已发布的健康解读为正文。完整保留否定词、检查条件、日期与来源；不从颜色或数值变化推导新的医学判断。没有资料就说“尚无相关检查”，有记录但未完成解读就说“已有检查记录”。不使用健康分数。

首屏依次呈现成员身份、整体解读、具体重点和身体目录。上传资料和管理入口可找到，但不抢占阅读内容。长文可展开，必要条件紧随相关结论。

示例：“血脂指标较上次升高，建议结合医生意见复核。”与“本次血糖相关记录在报告参考范围内。”来自项目的虚构演示数据。设计稿始终标出“虚构演示资料”，不放真实家庭档案。

## 视觉基础

- 颜色见 tokens.json：warm-50 是页面底，surface 是卡片，warm-900 是正文，warm-600 是日期与说明。
- primary 保留品牌识别。primary-dark 用于链接、主按钮和选中项；主按钮配白字。primary-light 只给整体解读和选中区域适量着色。
- warning-bg 配 warm-900 文字表达“需关注”；同时写状态文字。已有资料与无资料分别表述，不只靠绿色和灰色。
- warm-400、primary、warning、info 的小字在浅底上对比不足；保留来源值，但不用作正文或辅助文字。warm-200 用作装饰分隔线，交互边界和焦点使用 primary-dark。
- body 16px 是健康正文的下限，body-strong 18px 用于主题，section-title 22px 用于分区，page-title 28px 用于页面标题。label 14px 只写日期和短标签。
- space-md 16px 为卡片内边距，space-lg 24px 为区块间距，space-xl 32px 为章节间距；控件最小触控范围 44px。
- 卡片用 radius-lg 16px，控件用 radius-md 12px。大段文字限制在约 44 个汉字宽，保持自然换行。
- 默认 shadow 提供柔和层次，嵌套内容用分隔线而非层层阴影。动效沿用原规范 150–250ms，尊重减少动态效果设置。

## 图标与字体

应用已有 lucide-react 描边图标，保持 18–22px、统一线宽。图标与文字同时出现时只装饰，不替代按钮名称。不使用 emoji 或新造品牌标志；本设计系统以“家庭健康”文字识别。

采用桌面源码的本机中文系统字体栈。原规范提到 Plus Jakarta Sans、Geist、JetBrains Mono，但当前 renderer 没有对应字体文件，本次未引入网络字体、未制作替代字体。

## 来源与完整清单

值以 docs/DESIGN-SYSTEM.md 与 dashboardApp/apps/desktop/src/renderer/src/styles.css 为依据；阅读顺序参考 dashboardApp/docs/desktop/reading-experience-plan.md。

已整理：浅色主题、16 个现有颜色变量加卡片白色、6 级字号、9 个间距值、4 个圆角、2 个阴影。字号的使用规则来自项目规范，正文行高沿用现有阅读层。

组件盘点：Sidebar、Topbar、PersonCard、MemberHeader、StatusBadge、ReadingHealthMap、ReadingPriorityPreview、ReadingMetricPreview、MemberTrendChart、DailyLifeGuide。它们继续以现有 React 代码为实现来源；本次不复制成第二套运行组件。

Not synced：未打包上述 React 组件；无独立品牌标志和本地字体资产可导入；应用的业务状态、数据接口和医学判断不属于本设计系统。

## 在设计稿中使用

安装 tokens.json 到设计稿的 ds/familyhealth/ 下，并在 canvas.json 登记。本系统不提供 JavaScript bundle。设计稿使用普通可编辑 markup 与现有语义值；不伪造组件运行时，不加载外部资源。
