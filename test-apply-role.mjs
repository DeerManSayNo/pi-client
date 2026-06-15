import { createAgentSession, getAgentDir } from '@earendil-works/pi-coding-agent';
import { stripModePrompt } from './lib/agent-modes.ts';
import { applyRolePromptConfigToPrompt } from './lib/system-prompt-decomposer.ts';

async function main() {
  const cwd = '/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux';
  
  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
  
  const rawSp = session.agent.state.systemPrompt;
  console.log('Raw SP length:', rawSp?.length ?? 0);
  
  // Step 1: stripModePrompt
  const basePrompt = stripModePrompt(rawSp ?? "");
  console.log('After stripModePrompt length:', basePrompt?.length ?? 0);
  console.log('After stripModePrompt has skills:', basePrompt?.includes('ccomit-auto-git'));
  
  // Step 2: applyRolePromptConfigToPrompt (default role)
  const configured = applyRolePromptConfigToPrompt(basePrompt, 'default');
  console.log('After configure length:', configured?.length ?? 0);
  console.log('After configure has skills:', configured?.includes('ccomit-auto-git'));
  
  if (configured?.includes('<available_skills>')) {
    const idx = configured.indexOf('<available_skills>');
    const end = configured.indexOf('</available_skills>', idx) + '</available_skills>'.length;
    console.log('Skills section:');
    console.log(configured.substring(idx, end).substring(0, 500));
  } else {
    console.log('❌ No <available_skills> after configure!');
    console.log('First 1000 chars:');
    console.log(configured?.substring(0, 1000));
  }
  
  session.dispose();
}
main().catch(e => console.error(e.stack || e));
