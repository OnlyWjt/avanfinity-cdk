# Provider、Model 与 Agent Runtime

## 先分清三个维度

| 概念 | 回答的问题 |
|---|---|
| Provider | 模型从哪家服务获得、怎样认证和计费 |
| Model | 当前具体使用哪个模型及其能力/上下文窗口 |
| Runtime | 谁实际驱动 Agent 回合、工具协议和会话恢复 |

切换 Provider/Model 不一定切换 Runtime；选择某些 runtime-backed Provider 时，Provider 才会同时决定 Runtime 身份。

## Provider 类型

### API Key Provider

用户提供 API Key 和服务地址，MyAgents 按 Provider/模型声明使用 Anthropic、OpenAI Responses 或 Chat Completions 等接口。内置列表和模型会随版本变化，应在「模型供应商」或 `myagents model list` 查询，不依赖静态名称表。

适合：用户已有第三方 API 额度，或需要特定厂商模型。

词元跳动支持网页登录连接账户、查看余额和扫码充值；支持的模型自动选择接入协议。OpenCode Go 支持发现模型，预设模型按对应协议执行；未提供唯一可信协议的自定义模型需在模型编辑器明确选择协议，不能靠反复换接口猜测。

### Anthropic 订阅

复用 Claude Code/Claude 官方订阅凭据体系，不是普通 API Key Provider。用户通过官方登录完成授权；验证要以真实模型请求为准。出现问题时不要要求用户粘贴 API Key。

### Grok 订阅（`xai-sub`）

用户通过 xAI OAuth 登录，MyAgents 管理安全刷新凭据。可由 Claude Agent SDK 的 Responses 兼容路径或支持该 Provider 的 DeepSeek Harness 执行，不是外部 Grok CLI Runtime。两种 Runtime 的认证失败恢复能力不完全相同，不能承诺同轮自动恢复。

登录成功和模型验证是两个状态：OAuth 完成后仍要验证账户权益和真实推理是否可用。401 通常要求重新登录；403 可能是权益问题；429 可能是额度或限流。

### Codex 订阅（`codex-sub`）

这是 runtime-backed Provider。MyAgents 管理 Codex Runtime 资源和订阅登录；新 Session 的执行身份是 `runtime=codex`、`runtimeSource=managed-provider`。由自己的安装、版本、登录和 Provider readiness 决定，不要求安装系统 Codex。

### Antigravity 订阅（`antigravity-sub`）

通过客户端连接 Google Antigravity 账户，应用自动准备与维护所需 CLIProxy 组件，并读取组件提供的模型目录；可由 Claude Agent SDK 或支持该 Provider 的 DeepSeek Harness 执行。登录完成不要求再添加 API Key，实际可用性以账户、组件与模型状态为准。它不等于 Grok OAuth 或用户安装的 Codex。

订阅卡片的信息按钮说明接入方式：Claude 使用官方 Agent SDK、Codex 使用内置 Codex CLI，Grok/Antigravity 提示非官方 API 接入风险。说明用于帮助用户判断接入路径，不能把它扩展成账号安全或供应商政策的永久保证。

## Runtime 类型

### Claude Agent SDK（`builtin`）

MyAgents 自带的一种集成执行引擎，无需用户另装外部 CLI，并能使用 MyAgents 管理的 Provider、MCP、子智能体与 Claude Plugin 等能力。

### MyAgents (DeepSeek Harness)（`dsh`）

应用内置的另一种集成运行环境，支持对话、文件与工具操作、子 Agent、权限审批、问答、历史恢复、回退和分叉。无需安装系统 Node 或独立 DSH CLI；它使用当前 Provider 的模型目录，不只用于 DeepSeek 模型。

通用设置的「Agent 功能设置」可选择默认集成运行环境（Claude Agent SDK / DeepSeek Harness）；Agent 设置中的明确选择优先。修改默认值不改变已有 Session。官方 Claude 订阅/API 固定使用 Claude Agent SDK，Codex 订阅固定使用 Managed Codex；其他 Provider 的可用组合以当前产品选项为准。

### Claude Code CLI / Codex CLI

这些属于 `runtimeSource=system-cli`：使用用户本机安装和登录的外部 CLI。Agent 运行环境选择已直接开放，不需要旧「更多 Agent Runtime」实验开关；仍需安装、登录并满足该 Runtime readiness。它们的模型、权限模式、MCP、登录和恢复能力各不相同，不能套用 builtin 的固定值。Gemini CLI 已不在当前支持的 Runtime 列表中。

## `runtimeSource` 为什么重要

`codex/system-cli` 与 `codex/managed-provider` 都写作 `runtime=codex`，但前者使用用户安装的 Codex 与用户 Codex Home，后者使用 MyAgents 管理的 Runtime 和订阅身份。它们不能互相恢复同一个 Runtime 会话，也不能用同一套登录/MCP 诊断结论。

遇到 Codex 问题时至少确认：

- 当前 Provider 是不是 `codex-sub`
- Session 的 `runtimeSource` 是 `system-cli` 还是 `managed-provider`
- 使用的是哪个模型和 permission mode

## Model 与权限模式

- Provider 可用模型会变化，外部 Runtime 还会动态报告自己的模型列表。
- 不同 Runtime 的 permission mode 名称和含义不同。例如 builtin 的选择不能直接套给 Codex。
- Codex 的审批、自动审查与完全访问有不同含义；DSH 的计划状态又独立于权限模式。按 `runtime describe` 和当前 Session 设置选择，不沿用旧 CLI 模式名称。
- Task 可以覆盖该次执行的 Runtime、Model、Permission 和 MCP，不必修改 Agent 默认值。
- Session 出生后会保留必要的 Runtime identity；切换 Agent 默认值不会把历史 Session 静默变成另一种 Runtime。

需要现场值时使用 `myagents runtime list`、`runtime describe`、`agent show` 或设置页，不猜模型 ID。

## MCP 在不同 Runtime 中的关系

- builtin Session 使用 MyAgents MCP 配置，并在会话边界应用变化。
- DSH 使用 MyAgents 管理的 MCP、Skills、命令与支持的产品扩展；每个组件的实际支持/admission 以现场状态为准，不承诺所有 SDK Plugin 组件都能等价执行。
- `codex/system-cli` 的 MCP 由用户 Codex 自己的配置管理，可通过 Runtime diagnostics 查看，MyAgents 不把自己的 MCP 列表注入它。
- `codex/managed-provider` 可以使用当前 Workspace 中安全且兼容的 MyAgents MCP，但并非每种 MCP 都适用；以当前 Session 实际显示的工具为准。
- Claude Code 的工具与扩展支持以当前 Runtime 实际显示的能力为准。

## 代理与环境

MyAgents 自身的 Provider 请求、插件安装、远程 MCP 与外部 Runtime 是不同网络链路。外部 system-cli Runtime 可以选择跟随 MyAgents 代理或终端环境；订阅管理的 Runtime 跟随对应 Provider 设置。

“终端能用、MyAgents 里不行”不一定是 Runtime 没安装，可能是 PATH、代理、认证 home 或所选 Runtime 身份不同。Codex system-cli 可使用 Runtime diagnostics 对比实际 auth、MCP、apps 和 effective env；DSH 使用 `myagents diagnose runtime dsh` 读取资源、进程及有效配置，不启动新的 Session。

## 正确预期与生效时机

- 新建 Session 会采用当时选择的 Runtime identity；切换到不兼容 Runtime 通常应新开 Session，而不是原地恢复。
- Model/Permission 是否能在当前 Session 即时切换取决于 Runtime 能力；产品会选择 live RPC、下轮生效或重启 Session。
- 由 MyAgents 管理的 Runtime 更新不会为了升级而中断已验证的活跃 Session；下载完成后主要影响后续新 Session。
- Provider 验证会实际消耗一次请求并可能受到网络、额度、权限和模型可用性的影响。

## 常见误解

- “`codex --version` 能跑，所以 MyAgents Codex 一定健康”：只能证明终端路径，不能证明 MyAgents 看到的 auth/env/MCP。
- “Grok 订阅是外部 Runtime”：不是，它是 Provider，可由 SDK 兼容桥或支持该 Provider 的 DSH 执行。
- “Codex 订阅等于用户自己的 Codex CLI”：不是，两者的 runtimeSource、运行资源和登录状态由不同路径管理。
- “Provider 验证超时就是 API Key 错”：超时也可能是网络；应结合真实状态与日志判断。
- “所有 Runtime 都能使用同一套 MCP/Plugin”：不同 Runtime 各自支持和管理不同的工具能力。
