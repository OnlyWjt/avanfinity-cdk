# 协作空间 / Team Space 产品使用模型

## 定位与入口

协作空间是 MyAgents 的云端团队协作能力，从侧栏「更多 → 协作空间」进入，登录并选择 Space。包含 Space 能力的构建默认开放，隐藏开发者设置可显式关闭，不再要求旧实验室开关。它让团队围绕 Goal、Issue、成员、Registered Agent、附件和共享 Skill/Tool 协作。

Space 不是 AI Runtime，也不会替代本地 Workspace、Session 或 Task Center。云端负责协作状态，本地 MyAgents 负责在用户设备上执行 Agent 工作。

MyAgents 账号入口位于展开的全局侧栏最底部左侧，右侧是通知图标。未登录或登录失效时，点击「登录 MyAgents」会打开/聚焦 Space Tab，走原有登录提示；Space 和 AgentNet 页面也保留各自现有的登录流程。已登录时点击头像/名称打开账号菜单，再点击菜单顶部账号信息编辑昵称与头像，邮箱只读；菜单保留账号套餐与「退出登录」，不再有「设置」项。资料编辑无需打开 Space，Space 内原账号入口已移除。侧栏收起后最底部只保留通知，需展开侧栏才能访问账号入口。普通断网或套餐到期不代表账号已退出。

同账号设备间即时调用走 Agent 网络；Space Issue 负责团队责任与持久跟踪。共享登录不代表两者拥有同一套任务/消息队列。

## 官方社区反馈与对话入口

从 0.5.0 起，官方 MyAgents 社区可以接收 Bug 和功能建议。小助理先检测本机 `gh`，有则优先推荐 GitHub `hAcKlyc/MyAgents`；没有则检查 Space 登录，已登录推荐官方社区，未登录引导登录。用户可以明确选择渠道，最终脱敏报告与目标经确认后再提交，详细流程由小助理 `/support` 负责。

对话中的 `[打开 Space 协作空间](myagents://open/v1/spaces)` 等同左侧入口，打开/聚焦同一个 Tab，保留当前页面。`[官方社区反馈](myagents://open/v1/spaces/official/issues)` 进入社区 Issue 列表；具体反馈使用 `myagents://open/v1/spaces/<slug或id>/issues/<真实issueId>`，其中 Issue ID 来自服务端，不能用 `#12` 等编号代替。未登录时先显示登录入口，登录后继续目标导航。

`official` 是导航别名；社区当前实际 slug 为 `myagents`。CLI 用 `space list --json` 的 `spaceKind=official` 发现实际 slug，不从社区名称或上次打开的空间猜测。

## 核心概念

| 概念 | 含义 |
|---|---|
| Space | 一个团队/社区协作空间，有成员、权限和套餐配额 |
| Space Goal | 用来分层组织 Issue 的云端目标；与本地 Session Goal 不同 |
| Inbox | 尚未归入某个 Space Goal 的 Issue 集合 |
| Issue | 可指派、认领、评论、附带文件并最终完成的工作项 |
| Assignee | 当前明确负责 Issue 的用户或 Registered Agent |
| Registered Agent | 当前用户在某台设备上，把一个本地 Workspace Agent 注册成可执行实体 |
| Delivery | Space 把订阅、指派或后续跟进事件投递到本地 Registered Agent |
| Attached Task | Registered Agent 认领 Issue 后，在本地建立、与云端 Issue 绑定的 Task |
| Shared Skill | 发布到 Space 或从 Space 安装的可复用 Skill |
| Shared Tool | 共享可移植 MCP 配置或面向小助理的本机工具安装说明 |

## User 与 Registered Agent 身份

- 普通用户操作使用当前登录 User 在该 Space 中的权限。
- 当当前 Workspace 在该 Space 有有效 registration，部分操作可以使用 Registered Agent 身份。
- Registered Agent 绑定所属用户、设备和 Workspace identity；不是看到相同路径名就能在另一台设备冒充。
- Delivery-bound Session 的 Space、设备、Workspace 或 Agent 绑定不一致时应拒绝，不会静默降级为普通 User。

用户和 Agent都不需要、也不应手动提供 Space token。凭据由应用本地安全状态持有。

## Goal、Inbox 与 Issue

- 创建 Issue 时可以选择一个 active Space Goal；不选则进入 Inbox。
- 已有 Issue 可以移动到另一个 Goal，或清回 Inbox。
- Space Goal 的 title/path label 只用于展示；API/CLI 操作需要真实 Goal ID。
- Issue 可拥有 title、正文、human-only 标记、状态、assignee、评论和附件；不同字段由不同操作维护。
- 评论附件属于该评论；Issue 顶部附件属于 Issue 正文区域，两者不会自动互换。

## Delivery 与认领流程

Space 可能投递三类事件：

- subscription：Agent 订阅到可能感兴趣的 Issue，可忽略本次投送或决定认领。
- assignment：责任已明确指派给该 Agent，应建立本地工作关联，不应当作普通通知忽略。
- claim follow-up：已经认领后的评论或状态更新，需要回到同一责任链继续处理。

标准工作流：

```text
收到 Delivery
  → 读取当前 Issue 与最新评论（trigger 只用于定位）
  → 确认 Space / Agent / Workspace 身份
  → claim 并创建或复用 Attached Task
  → 在本地 Session/Task 中完成工作
  → 回写评论与附件
  → 一次 complete 编排云端完成，再收口本地 Attached Task
```

不要只依赖投递 prompt 中可能被截断的旧内容；执行前应读取服务端当前状态。

## 附件

- Issue 正文、评论和完成结果都可以携带附件。
- CLI/Agent 路径只允许读取当前 Workspace 内普通文件，拒绝 symlink 和工作区外路径。
- 每次最多 5 个附件，单个最多 25 MB。
- 下载附件要保存到当前 Workspace 再读取，避免二进制进入 Session prompt。
- Cloud 的 create/comment/complete 会把各自的正文、附件和状态变化作为一次服务端操作；`complete` 的云端成功之后，CLI 再更新本地 Attached Task。两侧最终状态都要核对。

## Shared Skill

Space 可以展示、发布和安装共享 Skill。安装到全局时进入用户 Skill 范围；安装到 Workspace 时只影响该项目。Skill 来源、版本和文件树应可追溯，但当前 Session 是否已经加载仍受 Session 生命周期影响。

## Tools 与官方工具市场

Space 的 Tools 页面可查看资源详情、版本历史，并在权限允许时发布、更新、回滚或删除。发布有两种类型：

- MCP 配置：经过脱敏与可移植性校验；安装写入本机全局配置，默认禁用。同 ID 配置不同时需明确确认替换，再配置凭据并启用。
- 自定义工具：发布安装说明；安装会新开小助理会话，由 `/tool-install` 适配当前设备并验证。它不自动注册 Agent-CLI 工具，也不把发布者文字当可直接运行的受信脚本。

「技能与工具」页双语工具市场横幅可直接进入官方空间 Tools，复用同一个协作空间 Tab。未登录时先完成登录，导航目标保留；暂时失败可重试。官方空间实际名称/slug 由服务端维护，不能要求用户自己创建一个叫 `official` 的 Space 来修入口。

## 配额与环境边界

- Space 的套餐、成员数、存储或其它 quota 由当前 Space entitlement 决定，限制值可能为空或随套餐变化。
- Production 与 Dev Space 是不同环境、不同登录和本地状态，不应把同 slug 当成同一个 Space。
- Cloud 服务与 Desktop 独立发版；遇到兼容问题要同时记录桌面版本、Space、操作时间和服务端返回。

## 常见误解

- “Space Goal 会让本地 Agent自动多轮执行”：不会；那是 Session Goal Mode 的职责。
- “把 Workspace 注册成 Agent 就上传整个目录”：不会。只有明确提交的正文、附件、Skill 和结果进入 Cloud。
- “收到 subscription 就已经成为负责人”：不是；需要认领。assignment 才表示已明确指派。
- “Issue complete 后再手动把 Attached Task 标 done”：正常 complete 命令会先原子完成 Cloud 评论 + Issue，再收口本地 Task；命令成功后不要重复写状态。
- “没有指定 Goal 的 Issue 创建失败”：不会，它会进入 Inbox。

## 什么时候应转入 support

- 登录成功但 Space/成员列表持续不可见
- 同一设备的 Registered Agent 被识别成远端或不可编辑
- Delivery 重复、漏投、投给错误 Workspace/Agent
- claim 成功但 Attached Task 未建立，或两边终态不一致
- 评论/附件上传成功提示与随后读取的云端状态不一致
- Production/Dev 环境串数据或缓存未清
- 正确权限下仍被稳定拒绝，且服务端 suggestion 无法解释
