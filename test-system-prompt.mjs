import { createAgentSession, getAgentDir } from '@earendil-works/pi-coding-agent';

async function main() {
  const cwd = '/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux';
  
  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
  
  const sp = session.agent.state.systemPrompt;
  console.log('System prompt length:', sp?.length ?? 0);
  
  if (sp?.includes('<available_skills>')) {
    console.log('✅ <available_skills> found');
    if (sp.includes('ccomit-auto-git')) {
      console.log('✅ ccomit-auto-git found');
    }
  } else {
    console.log('❌ <available_skills> NOT found');
    console.log('First 500 chars:');
    console.log(sp?.substring(0, 500));
  }
  
  // Also check _baseSystemPrompt
  const basePrompt = session._baseSystemPrompt;
  console.log('\n_baseSystemPrompt length:', basePrompt?.length ?? 0);
  if (basePrompt?.includes('<available_skills>')) {
    console.log('✅ _baseSystemPrompt has skills');
  } else {
    console.log('❌ _baseSystemPrompt MISSING skills');
  }
  
  session.dispose();
}
main().catch(e => console.error(e));
