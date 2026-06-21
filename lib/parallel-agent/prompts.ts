export function buildWorkerPrompt(question: string, task: string): string {
  return [
    `你是一个专业代码分析专家，只能使用只读工具（read、grep、find、ls）进行分析，不能修改任何文件。`,
    ``,
    `## 用户总体问题`,
    question,
    ``,
    `## 你负责的子任务`,
    task,
    ``,
    `请完成该子任务的分析，并返回你的发现和结论。如果发现关键代码，请提供具体的文件路径、行号和代码片段作为证据。`,
  ].join("\n");
}

export function buildIsolatedWorkerPrompt(question: string, task: string): string {
  return [
    `你是一个专业的编程专家，可以读取、搜索和修改文件。`,
    `你在一个隔离的工作环境中操作（git worktree），你的修改不会直接影响主分支。`,
    `请完成以下子任务，大胆修改代码以解决问题。完成后请总结你做了哪些修改。`,
    ``,
    `## 用户总体问题`,
    question,
    ``,
    `## 你负责的子任务`,
    task,
    ``,
    `请修改相关文件以完成子任务，并简要总结你做的所有修改。`,
  ].join("\n");
}

