# 产品定位与能力地图

## MyAgents 是什么

MyAgents 是开源、桌面端、本地优先的个人 Agent 工作台。它把对话、真实工作区、文件、终端、浏览器、模型、工具、任务、长期记忆和多种交互入口放在同一套产品里。Chat 是入口之一，不是产品的全部。

从用户视角理解，产品包含三个以本地客户端为核心的部分：Agent 工作台、用户与 Agent 共用的产品能力、Record 上下文收集；并通过 Agent 网络与 MyAgents Space 两项云端能力扩展协作范围。

## 产品心智模型

```text
本地客户端
  ├─ Agent 工作台
  │   └─ Agent（以 Workspace 为基础）
  │       ├─ Provider + Model + Runtime（模型、认证与执行引擎）
  │       ├─ MCP + Skills + Plugins + Tools（工具与工作方法）
  │       ├─ Channel / 飞书 Bot 等（通信入口）
  │       ├─ 长期记忆 / 记忆维护 / 主动机制（持续上下文与主动性）
  │       └─ 多个独立 Session（不同工作；Session 内可用 Goal 持续推进）
  ├─ 用户与 Agent 共用的产品能力（GUI / myagents CLI）
  │   └─ Task（Session 之外的持久任务、追踪与调度）
  │       └─ 定时唤醒，或先运行脚本、按结果决定是否唤起 AI
  └─ Record（面向用户的文字 / 录音上下文收集）
      └─ 保存与整理 → 讨论 / 处理 / 转为 Task

云端协作能力
  ├─ Agent 网络（同账号设备间的在线 Agent-to-Agent 通信）
  │   └─ 已入网设备 / 开放的 Agent / Session 请求与回传；目标设备执行
  └─ MyAgents Space（以 Space 成员身份组织的轻量协作服务）
      └─ Member / Issue / Goal / Shared Skill / Shared Tool / Registered Agent
```

这张图描述产品关系，不代表所有能力都在同一个进程或同一个页面里。Task 和 Record 是客户端能力，不是 Agent 的内部组成；Session Goal 驱动当前会话持续执行，Space Goal 用来组织协作事项。Agent 网络以同账号设备通信为范围，Space 以空间成员、责任和资源共享为范围。

## 主要用户入口

### Launcher

用来选择或创建 Agent 工作区、查看历史 Session、进入任务中心，并在还没打开 Chat 前准备工作。首页可切换「对话 / 记录」；侧栏加号、空状态与首页工作区选择器统一打开「新建 Agent」面板，选择本地项目、官方 Agent（如 Mino）或用户模板。

### Chat

适合围绕当前工作区进行长对话、文件操作、工具调用和持续执行。支持多 Tab、历史恢复、模型与权限选择、`@` Agent/想法/文件、`/` Skills、内嵌终端和浏览器。默认集成运行环境可选 Claude Agent SDK 或 DeepSeek Harness；具体 Provider 仍可能限定执行引擎。

### 任务中心

把 Record 对齐成 Task，安排一次性或周期执行，追踪状态、运行记录、文档和验收结果。适合不应只留在聊天历史里的工作。

### 设置

管理 Provider、MCP、Agent、Channel、Skills、插件、代理、实验功能、语言和应用行为。动态可用项以当前版本设置页和 CLI discovery 为准。

### MyAgents 账号与通知

展开全局侧栏最底一行左侧是账号、右侧是通知，上方保留小助理与设置。未登录点击账号会打开 Space 的现有登录页；已登录点击打开账号菜单，菜单顶部账号信息可编辑资料，另有账号套餐和退出登录。该入口供 Space 与 AgentNet 共用，不需要进入 Space 编辑资料；收起侧栏后底部只保留通知。

### AI 小助理

负责 MyAgents 功能答疑、代为配置、诊断本地问题和整理反馈。普通使用问题先查产品知识；实际异常再进入 support 诊断。

### 桌面宠物 / 悬浮窗

提供轻量桌面入口，可以绑定工作区并复用 MyAgents 的会话能力。它不是另一套独立产品状态；复杂工作仍可以回到主窗口继续。

### IM Agent / Channel

让 Agent 通过 Telegram、钉钉、飞书或社区插件 Channel 在桌面之外接收和回复消息，并延续对应工作区与 Session 的能力边界。

### Agent 网络

从侧栏「更多 → Agent 网络」进入，复用 MyAgents 账号登录。选择设备入网，再开放希望被调用的 Agent；同账号其它设备上的 Agent 可发现并发起即时协作。它不提供离线排队或团队 Issue 管理，详见 `agent-network.md`。

### 协作空间 / Team Space

从侧栏「更多 → 协作空间」进入，在包含云端能力的构建中默认开放，登录后使用。提供成员、分层 Goal、Issue、共享 Skill/Tool 与 Registered Agent 协作。「技能与工具」页的工具市场横幅可直接进入官方空间 Tools。

## 怎样选择承载方式

| 用户目标 | 优先能力 |
|---|---|
| 临时讨论、立即处理 | Chat Session |
| 保存文字想法、笔记或会议录音 | Record |
| 有明确目标、需要状态和验收 | Task |
| 到时间自动执行 | 带 schedule 的 Task；用户仍可使用 Cron 入口管理 |
| 当前会话持续推进直到完成 | Goal Mode |
| 从 IM 与 Agent 互动 | Agent Channel |
| 让本机或同账号另一台设备的 Agent 立即协助 | Agent 发现 + Session start/send；只观察用 get/state/watch |
| 团队分配和跟踪工作 | Team Space Issue + Registered Agent |
| 接入外部能力 | MCP、Skill、Plugin 或 CLI Tool，按能力形态选择 |

## 本地优先意味着什么

- 工作区文件、会话、任务、配置和多数生成产物默认保存在本机。
- Cloud Space、远程 Provider、远程 MCP、IM 平台等能力会按功能需要访问外部服务。
- Agent 网络会交换开放 Agent 的目录元数据，以及用户明确发起的请求、读取结果和回传；业务流量在设备之间加密，但目录信息不属于业务正文加密范围。
- 本地优先不等于所有功能离线可用；模型请求、OAuth、插件安装和云端协作仍需要网络。
- 用户数据目录是应用内部状态，不应通过手工改 JSON 来替代产品 API 或 CLI。

## 常见误解

- “关掉 Tab 就一定终止所有后台工作”：不一定。Task、Goal 或 Channel 可能仍拥有该 Session 的执行需求。
- “Agent 就是一段 system prompt”：不完整。Agent 还关联工作区、模型、Runtime、权限、工具、Channel 和长期行为。
- “所有自动化都是 Cron”：0.3.0 起 Task 是持久任务与调度权威；Cron 是兼容的用户操作名称。
- “换了模型就是换 Runtime”：不是。Provider/Model 与 Runtime 是两个维度，订阅型 Provider 还可能选择受管 Runtime。
- “Cloud Space 会把本地工作区自动上传”：不是。Space 只通过明确的 Issue、附件、Skill 和 Registered Agent 流程交换被选择的数据。
