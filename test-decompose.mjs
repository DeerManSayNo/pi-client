import { decomposeSystemPrompt, composeSystemPrompt, applySectionOverrides, applyRolePromptConfigToPrompt } from './lib/system-prompt-decomposer.ts';

// 模拟一个包含 skills 的 system prompt
const prompt = `You are an expert coding assistant operating inside DeerHux, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.1查找函数、组件、类、接口、调用关系时，优先使用 codegraph_search / codegraph_callers / codegraph_callees / codegraph_impact。

Available tools:
- read: Read file contents
- bash: Execute shell commands

Guidelines:
- Be concise in your responses and thinking all use chinese language
- Show file paths clearly when working with files

<deerhux_mode>
Mode: Agent
You are in Agent mode. You may read, edit, write files, and run commands when needed to complete the user's task.
- Prefer the repository's existing patterns.
- Keep changes scoped to the user's request.
- Validate meaningful changes with the appropriate typecheck, lint, or focused tests when practical.
</deerhux_mode>

<available_skills>
  <skill>
    <name>ccomit-auto-git</name>
    <description>自动拉取最新代码、解决冲突、提交并推送。</description>
    <location>/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux/.deerhux/skills/ccomit-auto-git/SKILL.md</location>
  </skill>
  <skill>
    <name>ui-ux-pro-max</name>
    <description>UI/UX design intelligence.</description>
    <location>/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux/.deerhux/skills/ui-ux-pro-max/SKILL.md</location>
  </skill>
</available_skills>

Current date: 2026-06-14
Current working directory: /Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux`;

console.log('=== 测试 decompose → compose 往返 ===');
const sections = decomposeSystemPrompt(prompt);
console.log('Sections:', sections.map(s => `${s.id}(enabled=${s.enabled}, editable=${s.editable}, hasContent=${s.content.length > 0})`));
console.log('');

const skillsSection = sections.find(s => s.id === 'skills');
if (skillsSection) {
  console.log('Skills section content:');
  console.log(skillsSection.content.substring(0, 200));
  console.log('');
}

const recomposed = composeSystemPrompt(sections);
console.log('Recomposed contains ccomit-auto-git:', recomposed.includes('ccomit-auto-git'));

console.log('');
console.log('=== 测试 applyRolePromptConfigToPrompt ===');
const configured = applyRolePromptConfigToPrompt(prompt, 'default');
console.log('Configured contains ccomit-auto-git:', configured.includes('ccomit-auto-git'));
console.log('');
console.log('Configured skills section:');
const skillsIdx = configured.indexOf('<available_skills>');
if (skillsIdx >= 0) {
  const endIdx = configured.indexOf('</available_skills>', skillsIdx) + '</available_skills>'.length;
  console.log(configured.substring(skillsIdx, endIdx));
} else {
  console.log('No <available_skills> found!');
}
