import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { formatSkillsForPrompt } from './node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js';

async function main() {
  const cwd = '/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux';
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const { skills } = loader.getSkills();
  
  const formatted = formatSkillsForPrompt(skills);
  console.log('Skills formatted for prompt:');
  console.log(formatted);
  
  console.log('\nContains ccomit-auto-git:', formatted.includes('ccomit-auto-git'));
  console.log('Contains ui-ux-pro-max:', formatted.includes('ui-ux-pro-max'));
}
main().catch(e => console.error(e));
