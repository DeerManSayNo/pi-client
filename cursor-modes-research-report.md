# Cursor Plan / Ask / Agent 模式控制机制调研报告

> 调研日期：2026-06-12
> 范围：全网公开资料、官方文档、社区讨论、安全分析报告

---

## 一、模式总览

Cursor 目前提供四种主要交互模式，通过 **Shift+Tab** 或模式选择器切换：

| 模式 | 核心定位 | 文件读写 | 终端执行 | 适用场景 |
|------|---------|---------|---------|---------|
| **Ask** | 只读问答 | ❌ 只读 | ❌ | 理解代码、架构讨论、trade-off 分析 |
| **Agent** | 全功能自主编码 | ✅ 读写 | ✅ | 写代码、重构、修复 bug、运行测试 |
| **Plan** | 先规划再实施 | ⚠️ 仅写计划文件 | ❌（Build 前） | 复杂功能、多文件重构、团队 review |
| **Debug** | 运行时诊断 | ⚠️ 仅注入日志 | 读取运行输出 | 难以复现的 bug、运行时状态分析 |

---

## 二、各模式控制机制详解

### 2.1 Ask 模式——「只思考，不动手」

#### 核心行为
Ask 模式是一个**纯只读**的对话模式，模型不会修改任何文件，也不会执行终端命令。

#### 控制方式

**工具白名单（硬控制）：**
```
✅ 可用工具：read_file、search、grep、codebase_search
❌ 不可用：edit_file、execute_command、git 操作
```

**System Prompt（软控制）：**
- 省略整个 `<making_code_changes>` 指令块
- 只保留 `<search_and_reading>` 指导：
  > "If you are unsure about the answer to the USER's request... you should gather more information. This can be done with additional tool calls, asking clarifying questions..."
- 不包含任何关于文件修改的指令

**用户感知：**
模型可能会在聊天中输出代码建议（文本），但**无法实际修改文件**。社区报告显示某些版本可能存在行为不一致的情况。

#### 适用场景
- 新人快速理解代码库
- 架构方案讨论和 trade-off 分析
- 代码逻辑解释
- 粘贴错误信息请求诊断（不修改代码）

---

### 2.2 Agent 模式——「全功能自主编码」

#### 核心行为
Agent 模式是 Cursor 的**核心模式**，具备完整的代码搜索、文件编辑、终端执行能力。

#### 控制方式

**工具白名单（全量）：**
```
✅ read_file          — 读取文件内容
✅ search / grep      — 搜索代码库
✅ edit_file          — 编辑/修改文件
✅ execute_command    — 执行终端命令
✅ git 相关操作        — 创建 commit、PR 等
```

**System Prompt（完整指令块）：**
```
<communication>       — 对话风格约束
<tool_calling>        — 工具调用规则
<search_and_reading>  — 信息收集指导
<making_code_changes> — 文件修改指导（核心差异）
<debugging>           — 调试最佳实践
<calling_external_apis> — 外部 API 调用规范
```

其中 `<making_code_changes>` 是 Agent 模式的关键：
> "When making code changes, NEVER output code to the USER, unless requested. Instead use one of the code edit tools to implement the change."

**执行模式：**
- **Local Agent：** 在 IDE 内运行，直接操作本地文件系统
- **Background Agent：** 在容器中异步运行，完成后自动创建 PR

#### 适用场景
- 日常编码和功能开发
- 跨文件重构
- 修复编译/lint 错误
- 运行测试并迭代修复

---

### 2.3 Plan 模式——「先出计划，再动手」

#### 核心行为
Plan 模式是 Cursor 最新引入的**两阶段工作流**，将复杂任务拆分为规划阶段和构建阶段。

#### 工作流程

```
用户描述任务
     │
     ▼
┌─────────────────────────────┐
│  阶段一：规划（Plan）         │
│                             │
│  1. 研究代码库               │
│  2. 提出澄清性问题            │
│  3. 生成 .plan.md 计划文件    │
│  4. 用户审查、编辑计划         │
│  5. 用户点击 Build            │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  阶段二：构建（Build）        │
│                             │
│  1. 复用规划阶段的对话上下文   │
│  2. 获得完整 Agent 权限       │
│  3. 按计划逐步实施            │
└─────────────────────────────┘
```

#### 控制方式

**阶段一工具白名单：**
```
✅ read_file、search、grep     — 研究代码库
✅ write_plan_file              — 写入 .plan.md
❌ edit_file（不能修改源代码）   — 硬限制
❌ execute_command              — 不能执行 shell
```

**阶段一 System Prompt 差异：**
注入 plan-first 指令，引导模型：
- 先研究相关文件
- 主动向用户提澄清性问题
- 生成包含文件路径和代码引用的结构化计划
- 明确告知「等待用户批准后再实施」

**阶段二（Build）控制：**
- 用户点击 Build 后，模式自动切换
- 复用阶段一的完整对话上下文（不丢失之前的分析）
- 开放完整 Agent 工具权限
- 按照之前制定的计划逐步执行

**计划文件管理：**
- 默认存储：`~/.cursor/plans/`
- 可保存到 workspace：`.cursor/plans/`（推荐，便于团队共享和版本控制）
- 计划为 Markdown 格式，用户可直接编辑增删任务项

#### 适用场景
- 复杂跨文件的架构改动
- 需要团队 review 后再实施的重构
- 多步骤的大功能开发
- 需要文档记录的任务

#### ⚠️ 社区反馈的局限性
- 部分用户报告 Plan 模式在某些版本中**未能完全阻止文件修改**
- 建议额外搭配 `.cursor/rules` 规则做双重防护
- 官方正在持续改进 enforcement 机制

---

### 2.4 Debug 模式——「运行时诊断」

#### 核心行为
Debug 模式是一个特殊的 Agent 循环，围绕**运行时信息**和**人工验证**构建。

#### 控制方式

**工具集：**
```
✅ inject_logging          — 自动注入诊断日志
✅ read_runtime_output     — 捕获运行时输出
✅ read_file、search       — 阅读代码
⚠️ edit_file              — 仅限注入日志的修改（初始阶段）
```

**工作流程：**
1. 读取相关代码
2. 自动注入 `console.log` / `print` 等诊断语句
3. 生成多个问题假设
4. 引导用户复现 bug
5. 读取运行时输出，定位根因
6. 提出修复方案，等待用户确认后修改

#### 适用场景
- 难以复现的 bug
- 需要观察变量运行时状态的问题
- 异步/并发相关的复杂 bug

---

## 三、内部实现架构

### 3.1 Agent Harness 三层架构

Cursor 的 Agent 系统由三个核心组件组成（官方披露）：

```
┌──────────────────────────────────────────────────────────────┐
│                    Cursor Agent Harness                       │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │   Instructions   │  │      Tools       │  │   Model    │ │
│  │                  │  │                  │  │            │ │
│  │ • System Prompt  │  │ • read_file      │  │ • Claude   │ │
│  │   (Priompt 组装)  │  │ • grep/search    │  │ • GPT      │ │
│  │ • Mode-specific  │  │ • edit_file      │  │ • Gemini   │ │
│  │   instruction    │  │ • execute_cmd    │  │ • Auto     │ │
│  │   blocks         │  │ • git operations │  │   Select   │ │
│  │ • .cursor/rules  │  │ • plan tools     │  │            │ │
│  │   (*.mdc files)  │  │ • debug tools    │  │            │ │
│  └──────────────────┘  └──────────────────┘  └────────────┘ │
│                                                              │
│              ▲ Mode Selector 控制哪些组件激活                  │
│              │                                               │
│   ┌──────────┼──────────┬──────────┬──────────┐              │
│   │    Ask   │  Agent   │   Plan   │  Debug   │              │
│   │  (只读)  │ (全功能)  │ (先规划)  │ (诊断)   │              │
│   └──────────┴──────────┴──────────┴──────────┘              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 控制层级：硬控制 vs 软控制

```
┌─────────────────────────────────────────────────┐
│              第一层：工具白名单（硬控制）          │
│  客户端强制执行，决定哪些 tool schema 发送给模型   │
│  模型无法调用未暴露的工具                          │
│  可靠性：★★★★★                                  │
├─────────────────────────────────────────────────┤
│              第二层：System Prompt（软控制）       │
│  动态注入模式特定的指令块，引导模型行为             │
│  例如：Plan 模式注入 "等待批准后再修改"            │
│  可靠性：★★★★                                   │
├─────────────────────────────────────────────────┤
│           第三层：.cursor/rules（项目规则）        │
│  .mdc 文件定义项目级约束，可指定 mode/glob 作用域  │
│  例如：强制 Plan 模式不得修改文件                   │
│  可靠性：★★★                                    │
└─────────────────────────────────────────────────┘
```

### 3.3 Priompt 提示词装配系统

Cursor 使用自研的 **Priompt** 系统进行动态 Prompt 组装：

```
Base Template
    │
    ├── 模式选择器 ──→ 注入对应指令块
    │   ├── Ask:     +search_and_reading（仅）
    │   ├── Agent:   +making_code_changes +debugging +external_apis
    │   ├── Plan:    +plan_first_research +clarifying_questions
    │   └── Debug:   +runtime_logging +hypothesis_generation
    │
    ├── 规则引擎 ────→ 注入匹配的 .mdc 规则
    │   根据 mode / glob / activation type 筛选
    │
    └── 上下文注入 ──→ 当前文件、光标位置、linter 错误等
```

### 3.4 .cursor/rules（MDC 规则）系统

规则文件格式：

```yaml
---
mode: [agent, plan]           # 指定在此类模式下激活（可选）
description: "组件命名规范"    # 规则描述
globs: "src/components/**/*"  # 文件匹配模式（可选）
---
# 规则正文（Markdown）
所有 React 组件必须使用 PascalCase 命名。
文件命名规则：`ComponentName.tsx`
```

四种激活类型：

| 类型 | 行为 |
|------|------|
| **always** | 每次对话都注入 |
| **manual** | 仅当用户 @引用时激活 |
| **agent-requested** | Agent 自行判断是否需要 |
| **glob-matched** | 当前操作文件匹配 glob 时激活 |

---

## 四、模式差异对比矩阵

| 维度 | Ask | Agent | Plan | Debug |
|------|-----|-------|------|-------|
| **文件读取** | ✅ | ✅ | ✅ | ✅ |
| **代码搜索** | ✅ | ✅ | ✅ | ✅ |
| **文件编辑** | ❌ | ✅ | ⚠️ 仅 plan.md | ⚠️ 仅日志 |
| **终端执行** | ❌ | ✅ | ❌（Build 前）| ⚠️ 受限 |
| **Git 操作** | ❌ | ✅ | ❌（Build 前）| ❌ |
| **外部 API** | ❌ | ✅ | ❌ | ❌ |
| **需用户确认** | 无需 | 可配置 | 必须 Build | 需验证 |
| **后台运行** | ❌ | ✅ Background | ❌ | ❌ |
| **产出物** | 聊天回复 | 代码修改 | .plan.md + 代码 | 诊断报告 |

---

## 五、自建方案设计

若要在自己的系统中实现类似的多模式控制，推荐以下架构：

### 5.1 方案架构图

```
                        ┌──────────────────────────┐
                        │     ModeController        │
                        │  (状态机 / 模式管理器)      │
                        └────────────┬─────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
   ┌──────────▼──────────┐ ┌───────▼────────┐ ┌───────────▼──────────┐
   │   PromptBuilder     │ │  ToolRegistry  │ │    RuleEngine        │
   │                     │ │                │ │                      │
   │ • base_template     │ │ • allowlist    │ │ • .rules/*.mdc       │
   │ • mode_blocks[]     │ │   per mode     │ │ • glob matching      │
   │ • rules_inject      │ │ • tool_schemas │ │ • mode targeting     │
   │ • context_attach    │ │ • permissions  │ │ • activation types   │
   └─────────────────────┘ └────────────────┘ └──────────────────────┘
```

### 5.2 各模式配置示例

```typescript
// 模式配置类型
interface ModeConfig {
  id: 'ask' | 'agent' | 'plan' | 'debug';
  tools: string[];                    // 可用工具白名单
  promptBlocks: string[];             // 要注入的指令块
  ruleModes: string[];                // 要激活的规则模式标签
  requireApproval: boolean;           // 是否需要用户审批
  allowTerminal: boolean;             // 是否允许终端执行
  allowFileEdit: boolean;             // 是否允许文件编辑
}

// Ask 模式配置
const ASK_MODE: ModeConfig = {
  id: 'ask',
  tools: ['read_file', 'search', 'grep', 'codebase_search'],
  promptBlocks: ['base', 'communication', 'search_and_reading'],
  ruleModes: ['ask', 'all'],
  requireApproval: false,
  allowTerminal: false,
  allowFileEdit: false,
};

// Agent 模式配置
const AGENT_MODE: ModeConfig = {
  id: 'agent',
  tools: [
    'read_file', 'search', 'grep', 'codebase_search',
    'edit_file', 'execute_command', 'git_commit', 'git_pr'
  ],
  promptBlocks: [
    'base', 'communication', 'tool_calling',
    'search_and_reading', 'making_code_changes',
    'debugging', 'calling_external_apis'
  ],
  ruleModes: ['agent', 'all'],
  requireApproval: false,
  allowTerminal: true,
  allowFileEdit: true,
};

// Plan 模式配置（两阶段）
const PLAN_RESEARCH_MODE: ModeConfig = {
  id: 'plan_research',
  tools: ['read_file', 'search', 'grep', 'write_plan_file'],
  promptBlocks: [
    'base', 'plan_first_research',
    'ask_clarifying_questions', 'wait_for_approval'
  ],
  ruleModes: ['plan', 'all'],
  requireApproval: true,
  allowTerminal: false,
  allowFileEdit: false, // 仅能写 plan 文件
};

const PLAN_BUILD_MODE: ModeConfig = {
  id: 'plan_build',
  tools: [
    'read_file', 'search', 'grep',
    'edit_file', 'execute_command', 'git_commit'
  ],
  promptBlocks: [
    'base', 'plan_build_execute',
    'follow_previous_plan'
  ],
  ruleModes: ['plan', 'agent', 'all'],
  requireApproval: false,
  allowTerminal: true,
  allowFileEdit: true,
  // 关键：复用 Plan 阶段的对话上下文
  inheritContext: 'plan_research',
};
```

### 5.3 System Prompt 差异管理

```typescript
// 模式专用指令块
const MODE_PROMPT_BLOCKS: Record<string, string> = {
  making_code_changes: `
<making_code_changes>
When making code changes, NEVER output code to the USER, unless requested.
Instead use one of the code edit tools to implement the change.
Ensure generated code can be run immediately by adding all necessary imports.
</making_code_changes>
  `,

  plan_first_research: `
<plan_first_mode>
You are in Plan mode. Your goal is NOT to immediately write code. Instead:
1. Research the codebase to find all relevant files and patterns
2. Ask clarifying questions if requirements are ambiguous
3. Generate a detailed implementation plan as a Markdown file (.plan.md)
4. Include file paths, code references, and a step-by-step checklist
5. WAIT for the user to approve the plan before you execute it
Do NOT modify any source code until the plan is approved.
</plan_first_mode>
  `,

  search_and_reading: `
<search_and_reading>
If you are unsure about the answer to the USER's request, gather more
information through tool calls, clarifying questions, etc. Bias towards
not asking the user for help if you can find the answer yourself.
</search_and_reading>
  `,
};
```

### 5.4 关键设计原则

| 原则 | 说明 |
|------|------|
| **客户端强制优先** | 工具白名单在客户端侧执行，模型无法调用未暴露的工具。这比 prompt 约束可靠得多 |
| **Prompt 作为辅助层** | 在硬控制之上用 prompt 引导行为（如 Plan 模式的工作流引导） |
| **规则分层** | 全局规则 > 项目规则(.cursor/rules) > 模式规则(mode: targeting) |
| **上下文保持** | 模式切换时不丢失对话上下文，Plan → Build 必须保留之前的所有分析 |
| **安全边界** | 即使 Agent 模式，也可配置命令审批机制（auto-run 关闭时每次需用户确认） |
| **可观测性** | 工具调用日志、模式切换日志、规则匹配日志，便于调试和审计 |

---

## 六、总结

### Cursor 模式控制的核心机制

1. **工具白名单（硬控制）**——客户端强制执行，是模式隔离的最可靠手段
2. **动态 System Prompt 装配（Priompt）**——根据模式注入不同的指令块，引导模型行为
3. **规则分层（.cursor/rules .mdc）**——项目级约束，可指定 mode / glob 作用域

### 三层防护的有效性排序

```
客户端工具白名单（最可靠）
         ｜
    System Prompt 指令约束
         ｜
    .cursor/rules 规则文件（最灵活但依赖模型遵循）
```

### 给你的建议

如果你正在设计一个类似的 Agent 系统，建议：

- **第一优先级：** 实现客户端工具白名单，这是模式隔离的根基
- **第二优先级：** 设计可插拔的 Prompt 指令块系统，按模式动态组装
- **第三优先级：** 建设规则引擎，支持项目级 / 模式级 / 文件级的作用域控制
- **可选增强：** Plan 模式的两阶段设计非常值得借鉴，它能显著提升复杂任务的成功率

---

## 七、参考资料

| # | 来源 | 链接 |
|---|------|------|
| 1 | Cursor Agent Best Practices | https://cursor.com/blog/agent-best-practices |
| 2 | Plan Mode 官方文档 | https://cursor.com/docs/agent/plan-mode |
| 3 | Introducing Plan Mode | https://cursor.com/blog/plan-mode |
| 4 | Ask Mode 文档 | https://cursor.com/help/ai-features/ask-mode |
| 5 | Cursor Agent System Prompt（Gist）| https://gist.github.com/sshh12/25ad2e40529b269a88b80e7cf1c38084 |
| 6 | Cursor Agent Sandbox Analysis | https://agent-safehouse.dev/docs/agent-investigations/cursor-agent |
| 7 | How Cursor Works Internally | https://adityarohilla.com/2025/05/08/how-cursor-works-internally |
| 8 | Cursor Security | https://cursor.com/security |
| 9 | Debug Mode 介绍 | https://cursor.com/blog/debug-mode |
| 10 | Cursor 社区论坛（模式讨论）| https://forum.cursor.com/ |
