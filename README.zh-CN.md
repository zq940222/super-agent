# super-agent

[English](README.md) · **简体中文**

一个用 TypeScript **从零手写**的通用任务 agent，目的是在动手中学习 agent 架构。
它具备：归一化的消息模型、可插拔的模型后端（OpenAI / Anthropic / Azure OpenAI）、
工具注册表、权限门、上下文压缩、会话持久化、MCP 客户端、子代理、以及可自我编写的技能（skills）
——通过十个小而受测的阶段逐步搭起来。运行在 [Bun](https://bun.sh) 上。

第一次来？先看 **[新读者导览](docs/GUIDE.md)**。设计背后的思考在
[`docs/agent-research.md`](docs/agent-research.md)（Claude Code、Codex CLI、
OpenClaw、Hermes 是怎么造的）和 [`docs/our-agent-design.md`](docs/our-agent-design.md)
（我们的设计 + 八阶段计划）。

## 亮点

- **一个"笨"循环，多个后端。** 单一的 `runAgent` ReAct 循环
  （`while stop_reason == tool_use`，`maxSteps` 兜底）按配置驱动 OpenAI /
  Anthropic / Azure OpenAI；每个 adapter 把各家的线格式差异藏在内部。
- **权限在 harness 层，不在 prompt 里。** 一个策略（`deny → ask → allow`，按模式 +
  每个工具的风险等级）决定什么能跑；高风险工具触发 human-in-the-loop 审批。
  模型只能*请求*，只有策略能*放行*。
- **能扛长任务的上下文。** 超过 token 预算时把旧对话压缩成摘要（**防孤儿切割**，
  绝不把 `tool_use` 和它的 `tool_result` 切开）；会话以 append-only JSONL 持久化。
- **开放的工具生态。** 手写的 MCP（Model Context Protocol）stdio 客户端，把外部
  服务器的工具通过**同一条**注册表 + 权限门接进来，和原生工具待遇一致。
- **委派。** `spawn_agent` 工具在隔离的子上下文里跑子任务、只回传蒸馏结果；并行委派白送。
- **技能（自我扩展）。** 可复用的流程文档（`SKILL.md`），agent 能 `find_skill` / `read_skill` /
  `create_skill`——自我改进闭环，且和其它写操作一样受权限门管辖。
- **有测试。** 86 个测试跑在假 provider 和 mock MCP 服务器上——不联网。用 TypeScript 7 做类型检查。

## 安装

```bash
bun install
cp .env.example .env   # 然后填 OPENAI_API_KEY（和/或 ANTHROPIC_API_KEY）
```

## 运行

```bash
bun run agent "./package.json 里有什么？"
echo "总结一下 ./README.md" | bun run agent

# 按配置切后端——同一个循环，不同模型：
AGENT_PROVIDER=anthropic bun run agent "列出 src/，然后解释 engine.ts"
AGENT_PROVIDER=azure     bun run agent "列出 src/，然后解释 engine.ts"
```

想要常驻的多轮对话，用交互式 TUI——同一个引擎，REPL 前端（输入任务，`/exit` 退出，
`Ctrl-C` 中断当前任务）：

```bash
bun run tui
```

或者用浏览器 UI——一个零依赖的 `Bun.serve` 服务端（localhost + 每会话 token）把事件流
推给 React 客户端。先构建一次客户端，再运行，打开打印出的 `http://localhost:8787/?token=…`：

```bash
cd web && bun install && bun run build && cd ..
bun run web
```

写文件是高风险操作，默认策略下 agent 在执行 `write_file` 前会先问你。想给它外部工具，
在当前目录放一个 `mcp.json`（见 [`mcp.json.example`](mcp.json.example)）；每个服务器的
工具会以 `mcp__<服务器>__<工具>` 出现，并和其它工具一样受权限门管辖。

## 开发

```bash
bun test            # 单元 + 集成测试；不联网
bun run typecheck   # tsc --noEmit（TypeScript 7）
```

真实调用后端的路径有可选的冒烟测试。它们会发真实 API 请求，所以需要**显式开启**——
`RUN_LIVE_SMOKE=1 bun test`，并设好对应的 key。默认的 `bun test` 是隔离的（不联网），
即使 `.env` 里填了 key 也不会触发网络请求。

## 配置

环境变量（见 [`.env.example`](.env.example)）：

| 变量 | 用途 | 默认 |
|---|---|---|
| `AGENT_PROVIDER` | 后端：`openai`、`anthropic` 或 `azure` | `openai` |
| `AGENT_PERMISSION_MODE` | `default`（询问）、`auto`（全放行）、`readonly`（拒绝写） | `default` |
| `AGENT_MAX_CONTEXT_TOKENS` | 估算超过此值就压缩上下文 | 内置（默认休眠） |
| `AGENT_SKILLS_DIR` | 可复用技能（`SKILL.md`）存放目录 | `.agent/skills` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` | OpenAI 后端 | 模型 `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL` | Anthropic 后端 | 模型 `claude-sonnet-5` |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI 后端 | api-version `2025-04-01-preview` |

密钥只从环境变量（或 `.env`）读取——绝不写进代码。

## 架构

```
src/
├─ core/
│  ├─ types.ts       Message / ContentBlock / AssistantTurn / ToolSpec（provider 中立）
│  ├─ events.ts      类型化 AgentEvent 事件流 + emitter
│  ├─ engine.ts      runAgent —— ReAct 循环 + 权限门 + 压缩
│  └─ compaction.ts  estimateTokens + compact（防孤儿摘要）
├─ providers/
│  ├─ provider.ts    ModelProvider 接口（可插拔接缝）
│  ├─ openai.ts      OpenAI adapter + 纯归一化函数
│  ├─ anthropic.ts   Anthropic adapter + 纯归一化函数
│  ├─ azure.ts       Azure OpenAI adapter（复用 OpenAI 的归一化函数）
│  └─ factory.ts     createProvider(name) —— 按配置选后端
├─ permissions/
│  └─ gate.ts        PermissionPolicy —— deny→ask→allow，按模式 + 风险
├─ tools/
│  ├─ registry.ts    ToolRegistry + defineTool（Zod → JSON Schema + 校验器）
│  ├─ workspace.ts   resolveInWorkspace —— 文件工具的路径边界
│  ├─ read-file.ts   read_file（输出截断）
│  ├─ list-dir.ts    list_dir（列表截断）
│  └─ write-file.ts  write_file（高风险；受门控）
├─ session/
│  └─ rollout.ts     append-only JSONL 会话持久化
├─ mcp/
│  ├─ client.ts      极简 MCP stdio JSON-RPC 客户端（initialize/list/call）
│  └─ register.ts    connectMcpServer —— 把 MCP 工具注册进 registry
├─ agents/
│  └─ subagent.ts    createSubagentTool —— spawn_agent（隔离的子 runAgent）
├─ skills/
│  ├─ store.ts       SkillStore —— SKILL.md 文件（list/find/read/create）
│  └─ tools.ts       find_skill / read_skill / create_skill + 系统提示目录
└─ cli/main.ts       极简终端前端
```

内置工具：`read_file`、`list_dir`、`write_file`、`spawn_agent`、`find_skill`、
`read_skill`、`create_skill`，以及你配置的任意 MCP 工具。

## 各个阶段

每个阶段是一个已合并的 PR，把一条调研出的原理变成受测的代码：

| 阶段 | 内容 | 原理 |
|---|---|---|
| P1 | 骨架：provider 抽象、消息模型、单步工具往返 | 线协议、tool_use/tool_result |
| P2 | ReAct 循环（`while tool_use` + `maxSteps`） | 循环*就是* agent |
| P4 | 上下文管理：压缩 + 会话 rollout | context rot、外部记忆 |
| P5 | 权限与安全：权限门 + HITL + 工作区边界 | 两层强制、致命三要素 |
| P6 | 可插拔多后端：Anthropic adapter + 工厂 | provider 归一化 |
| P7 | MCP 客户端 | 所有工具来源走同一门 |
| P8 | 子代理：`spawn_agent` | 上下文隔离、orchestrator-worker |
| P9 | 技能：find / read / create | 自我扩展、skills ≠ tools |
| P10 | Azure OpenAI 后端 | api-key 鉴权、api-version、deployment |

## 状态与边界

到 P10 为止功能完整。有意延后（见设计文档）：本地（Ollama/LM Studio）后端、流式输出、
`bash` 工具、内容级提示注入扫描、MCP HTTP 传输、把已存会话 resume 回活循环、共享技能注册中心。

为学习而造——不是一个提供支持的产品。
