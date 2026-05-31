# pi-agent

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的网页界面。在浏览器中浏览会话、与智能体对话、分叉对话、切换消息分支。

## 快速开始

**从源码启动（中文版）：**

```bash
git clone https://github.com/DeerManSayNo/pi-client.git
cd pi-client
npm install
npm run dev
```

启动后打开 [http://localhost:30141](http://localhost:30141)。

> **注意**：本仓库项目名为 `pi-agent`，仓库地址为 `pi-client`。

**可选参数：**

```bash
npm run dev -- -p 8080           # 自定义端口
npm run dev -- -H 127.0.0.1      # 仅本机访问

PORT=8080 npm run dev            # 也支持环境变量
```

## 功能介绍

- **会话浏览器** — 按工作目录分组展示所有 pi 会话，支持重命名和删除
- **实时对话** — 通过 SSE 流式输出与智能体实时交互，支持 Markdown 渲染和代码高亮
- **会话分叉** — 从任意用户消息创建独立的新会话分支
- **会话内分支** — 回退到任意节点继续对话，在同一文件内创建分支
- **分支导航器** — 可视化切换同一会话内的各个分支
- **模型切换** — 对话中途随时切换模型
- **技能配置** — 搜索、安装、启用/禁用 Agent 技能
- **推理强度** — 控制模型推理深度（auto / off / minimal / low / medium / high / xhigh）
- **工具面板** — 控制智能体可使用的工具（关闭 / 默认 / 全部）
- **压缩会话** — 对长会话进行摘要，节省上下文窗口
- **引导 / 追加** — 打断正在运行的智能体（Steer），或在其完成后追加消息（Follow-up）
- **图片附件** — 支持粘贴或拖拽上传图片
- **文件浏览** — 侧边栏内置文件浏览器，支持 @ 引用文件路径到输入框
- **音效提示** — Agent 完成时播放提示音（可开关）

## 注意事项

- **数据目录** — 默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他目录。
- **模型配置** — 从智能体数据目录下的 `models.json` 读取可用模型，可在侧边栏的「模型配置」面板中编辑。
- **技能配置** — 从 `skills.sh` 搜索并安装技能，可在侧边栏的「技能配置」面板中管理。

## 开发

```bash
npm install
npm run dev   # 端口 30141
```

## 项目结构

```
app/
  api/
    sessions/       # 读写会话文件（列表、详情、新建、重命名、删除）
    agent/          # 发送命令、SSE 事件流
    files/          # 文件内容读取与目录浏览
    models/         # 可用模型列表与默认模型
    models-config/  # 读写 models.json、模型连接测试
    skills/         # 技能搜索与安装
    auth/           # OAuth / API Key 认证
    home/           # 获取用户主目录
    default-cwd/    # 获取默认工作目录
components/         # UI 组件
hooks/              # 自定义 Hook（useAgentSession、useAudio 等）
lib/
  session-reader.ts  # 解析 .jsonl 会话文件
  rpc-manager.ts     # 管理 AgentSession 生命周期
  agent-client.ts    # Agent 客户端通信
  normalize.ts       # 规范化 toolCall 字段名
  file-paths.ts      # 跨平台文件路径处理
  pi-types.ts        # pi 类型定义
  npx.ts             # npx 运行工具
  types.ts           # UI 类型定义
```

会话文件存储路径：`~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`

## 中文界面

pi-agent 的界面已全面中文化，所有 UI 文本直接内联在组件中，无需额外配置或语言包。

### 启动中文界面

界面语言随代码内置，从本仓库源码启动即中文：

```bash
git clone https://github.com/DeerManSayNo/pi-client.git
cd pi-client
npm install
npm run dev
```

启动后访问 http://localhost:30141 即可看到完整的中文界面。

> 本仓库项目名为 `pi-agent`，仓库地址为 `pi-client`。

### 实现方式

采用**硬编码中文字符串**的方式，直接在 TSX 组件中写入中文文本，未使用 i18n 库。涉及的文件包括：

- `components/AppShell.tsx` — 侧边栏按钮、占位提示、顶栏标签
- `components/SessionSidebar.tsx` — 会话列表、时间格式、操作按钮
- `components/ChatInput.tsx` — 输入框、模型选择、推理等级、工具预设
- `components/ChatWindow.tsx` — 欢迎语、Agent 状态提示
- `components/MessageView.tsx` — 思考过程、工具调用、复制操作
- `components/ModelsConfig.tsx` — 模型配置面板全部字段
- `components/SkillsConfig.tsx` — 技能配置面板
- `components/ToolPanel.tsx` — 工具预设选择面板
- `components/FileExplorer.tsx` — 文件浏览器
- `components/BranchNavigator.tsx` — 分支导航器
- `components/TabBar.tsx` — 文件标签页
- `components/FileViewer.tsx` — 文件查看器
- `components/ChatMinimap.tsx` — 对话缩略图

### 扩展其他语言

如需支持多语言切换，建议抽取一个 `lib/locale.ts` 文件集中管理所有字符串，按语言 key 映射：

```
lib/
  locale.ts       # 语言上下文与切换逻辑
  zh-CN.ts        # 中文字符串
  en.ts           # 英文字符串
```

然后将各组件中的硬编码文本替换为 locale key 引用即可。
