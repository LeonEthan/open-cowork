# open-cowork 设计宪法

> 地位：一切 UI 实现的最高准则。issue/PR 可直接引用本文件条款（如「违反 §3.2」）。
> 来源：布局骨架学 **Codex**（三栏工作台）；视觉语言取自 **Typora 官方默认主题**（[typora-default-themes](https://github.com/typora/typora-default-themes)，浅色=github，深色=night）。
> 对应票：#9 原型：Typora 风格界面设计稿。

## §1 布局（Codex 骨架）

- **三栏**：任务侧栏（240px，可折叠）｜会话文档流（居中，内容栏 max-width 860px）｜检查栏（320px，变更/文件/终端 tab，可折叠）。
- 文档流是主角：其余两栏默认克制，焦点永远在中间。
- 任务侧栏项 = 状态点（运行/待批/待复查/完成）+ 标题 + 元信息；无多余装饰。

## §2 色彩（Typora token 直采）

### 浅色（github 主题）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#ffffff` | 文档底色 |
| `--bg-soft` | `#fafafa` | 侧栏/ sunk 面（Typora `--side-bar-bg-color`） |
| `--ink` | `#333333` | 正文 |
| `--ink-2` | `#777777` | 次级（Typora `--control-text-color`） |
| `--accent` | `#4183C4` | 链接/运行态/交互焦点（Typora github 主题链接色） |

### 深色（night 主题）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#363B40` | 文档底色（Typora `--bg-color`） |
| `--bg-soft` | `#2E3033` | 侧栏（Typora night 侧栏色） |
| `--ink` | `#b8bfc6` | 正文（Typora night `--text-color`） |
| `--accent` | `#6dc1e7` | 焦点（Typora night `--primary-color`） |
| 选中 | `#4a89dc` | 文本选中 |

### 语义色（白名单制，除此之外不得引入彩色）

- 成功/批准 `#16a34a`（深色 `#22c55e`）；待批/警告 `#d97706`（深色 `#f59e0b`）；拒绝/错误 `#dc2626`（深色 `#ef4444`）。
- diff：`+` 绿、`-` 红、上下文灰，仅此而已。

## §3 字体与排版

- 正文字体栈（Typora github 主题同款）：`"Open Sans","Clear Sans","Helvetica Neue",Helvetica,Arial,"PingFang SC",sans-serif`。
- 等宽：`"SF Mono","JetBrains Mono",ui-monospace,monospace`。
- 基准 16px，行高 1.6；UI 辅文 13–14px；文档标题 24px/650。
- 用户消息 15px（文档流内说话人区分，次于正文一档）；元信息/徽标 10.5–12.5px（任务元信息、工具行、用量灰字、计数徽标）——第四档是 §7.3 信息密度约定的具名化，新组件引用字号须落在以上档位内。
- 内容栏 max-width 860px（Typora `#write`），水平留白 ≥30px，文档流底部留白 ≥100px。
- 圆角三档：8px / 12px / 9999px（pill）。**零阴影**——浮层（命令面板、切换器除外）一律用边框而非阴影分层。

## §4 组件规则

- **工具调用**：极简行（icon + 名称 + 目标 + 状态），详见 #8 决议；不得渲染成大卡片。
- **思考过程**：左边线 + 折叠（`<details>` 式），摘要一行小字。
- **审批托盘**：输入区上方，逐条聚焦，⌘1/2/3（#8 定稿）。
- **代码块**：`--bg-soft` 底 + 1px 边框 + 8px 圆角；语法高亮仅用 ink/ink-3/accent/语义绿四色。
- **输入区**：单圆角框，内嵌 agent/model chip、附件、权限档位 chip、发送键；聚焦仅边框变深，无光晕。

## §5 动效（克制）

- 只许三类：状态点 pulse（1.2–1.6s）、抽屉/折叠 slide（≤220ms ease）、流式光标 blink（1s steps）。
- 禁止：页面级转场、弹性动画、hover 位移。

## §6 主题

- 明暗双主题，默认跟随系统，手动切换记忆偏好；切换无过渡动画（瞬间切换，Typora 同款）。
- 新组件必须同时交付两套主题值，只允许引用 token，禁止硬编码色值。

## §7 禁区

1. 不得引入白名单外的颜色、阴影、第四种圆角。
2. 不得在文档流中插入营销性/装饰性元素（插画、渐变、徽章墙）。
3. 不得为「好看」牺牲信息密度已有约定（工具行、托盘）；新组件先提 design issue 引用本文件。
