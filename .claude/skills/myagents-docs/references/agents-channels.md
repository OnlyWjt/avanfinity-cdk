# Agent、Channel 与跨入口使用

## Agent 是什么

MyAgents 中的 Agent 围绕一个 Workspace 工作。它不仅是一段 Prompt，还可以包含：

- 默认 Provider、Model、Runtime 与 permission mode
- Workspace 级 MCP、Skills、Plugin 与官方工具选择
- 主动运行开关、heartbeat 与长期记忆维护
- 一个或多个 IM Channel
- 归档状态和工作区身份

普通 Workspace Agent 可以只在用户打开 Chat 时工作；启用主动能力和 Channel 后，它也可以在桌面之外持续接收触发。

## Agent、Workspace 与 Session

- Workspace 是文件与项目背景。
- Agent 是围绕该 Workspace 的配置和长期行为。
- Session 是一次具体对话/执行身份。
- 一个 Agent 可以产生多个 Session；Channel、Task 和 Goal 会选择或复用合适 Session。

修改 Agent 默认配置主要影响后续 Session 或后续消息的 live-follow 配置，不应把已有 Session 的历史身份静默改写。

`enabled` 管理 heartbeat 和记忆维护等主动能力；Channel 有自己的开关，显式 Session 协作与 Agent 网络开放也不由这个字段控制。Agent 网络与 `@` Agent 的即时协作见 `agent-network.md`。

## Channel

Channel 把 Agent 接入外部消息平台。

### 内置 Channel

Telegram、钉钉、飞书由 MyAgents 桌面应用直接提供配置向导并管理连接。通常优先使用设置页中直接出现的内置 Channel。

飞书向导支持扫码授权，也保留手动配置方式；无需为了使用内置飞书先寻找社区插件。

### 社区 Channel

微信、QQ 等更多平台可以由 OpenClaw 社区插件提供；部分内置平台也可能有社区实现。社区 Channel 使用前要先安装对应插件，再添加该插件对应的 Channel，并完成平台要求的凭据或 QR 登录。

### 私聊与群聊

- 私聊通常可以持续复用对应该用户/Channel 的 Session。
- 群聊需要遵守群上下文与静默回复规则；不是每条 heartbeat 或工具结果都应该公开发送。
- 渠道是否支持原生交互卡片、AskUserQuestion、媒体类型和文件名取决于平台能力；不支持时应安全降级，而不是等待一个用户无法响应的 UI。

## Team AI

Team AI 是共享 Agent 工作区的管理面板。先在“设置 → 关于 → 实验室”打开“Team AI 面板”（默认关闭），再从侧栏“更多”进入。关闭开关只隐藏入口，已打开的面板、渠道连接和任务仍保留。

- 可以创建 Team AI，也可以选择已有 Agent 工作区加入；创建沿用普通 Agent 面板和 mino 模板，工作区仍显示在侧栏。
- 左侧列出连接的 Bot 及群聊、私聊；右侧查看当前会话、历史会话、统计和配置。点击 Session 会打开对应对话。
- 同一个 Bot 内，每个群聊或私聊有稳定的 `sessionKey`，可先后绑定多个 Session；不同 Bot 的聊天不能只凭 `sessionKey` 合并。
- 每个聊天可保存自己的 Runtime、模型、推理强度和工具配置，不修改 Agent 默认值，也不在此配置权限。兼容改动会同步到当前 Session；需要新会话才能生效时，先保存配置，再询问是否新建。
- 可以把本聊天下的历史 Session 设为当前，换绑不会停止旧任务。恢复跟随 Agent 默认只影响以后新建的 Session；移出 Team AI 不删除工作区或聊天记录。

## 主动 Agent、Heartbeat 与长期记忆

主动 Agent 可以按 heartbeat 感知工作区或执行周期性维护。长期记忆更新、整理和进化可以由隐藏的系统维护 Task 驱动，普通任务列表不一定显示这些内部维护行。

理解边界：

- heartbeat 是触发机制，不是永远运行的独立 Runtime。
- 记忆文件仍属于 Workspace，由用户内容和系统维护流程共同管理。
- Channel 未启用、凭据缺失或 Agent 被归档时，主动 Channel 不会正常运行。
- 归档 Workspace 会暂停主动行为；取消归档后按配置恢复。

## IM 中的媒体与结果

Agent 可通过现有 IM 命令发送文本与当前平台支持的附件，文件必须通过工作区/安全路径校验。当前绑定位置可以直接发送；不同位置通过目标会话 handoff 接续。没有默认绑定的桌面或后台 Session，可以显式指定所属 Agent 的 Channel 和目标，并提供转交正文与背景；不能把“没有默认绑定”理解为所有发送能力均不可用。

Task 的执行 Session 与通知目标分别配置。通知按 Channel + sessionKey 定位聊天，与 Heartbeat 独立；默认来源、目标选择和投递状态见 [自动化与结果通知](automation.md#结果通知)。普通 IM 回复和 Goal 仍遵循各自的投递规则。

## AI 小助理

小助理是 MyAgents 的产品使用与本地支持入口：

- 解释功能、比较概念、帮助用户选择能力
- 通过既有 CLI 代为完成安全的产品操作
- 在实际异常时读取脱敏状态与统一日志进行诊断
- 能修复的配置问题修复并验证
- 确认产品 Bug 或功能建议后，经用户确认整理并提交 Issue

小助理不是用户业务 Workspace 的长期 Agent，也不应把 `~/.myagents` 内部数据目录当普通项目随意改写。

## 桌面宠物 / 悬浮窗

悬浮球和伴随窗口提供轻量唤起入口，可以跟随默认 Workspace 或绑定特定 Workspace。它复用 MyAgents 的 Global/Session 能力，不维护另一份独立配置。

适合快速提问和小任务；需要查看大量历史、文件树、终端或多 Tab 时回到主窗口。

## 怎样判断 Channel 是否可用

配置存在不等于运行在线。检查时要区分：

- Agent 是否归档；涉及 heartbeat/记忆维护时再核对 Agent enabled
- Channel 是否 enabled、凭据或登录是否有效
- 社区 Plugin 是否安装并健康
- runtime status 是否在线
- 最近消息是否真正进入 Agent Session
- AI Runtime/Provider 是否成功生成回复

普通使用说明不需要查日志；已经完成正确配置但 Channel 不在线、不收消息或投错对象时转 `/support`。
