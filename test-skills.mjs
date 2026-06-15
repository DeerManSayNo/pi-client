import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';

async function main() {
  const cwd = '/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux';
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  console.log('=== Skills found:', skills.length, '===');
  for (const s of skills) {
    console.log(`- ${s.name} (${s.filePath}) sourceInfo:`, JSON.stringify(s.sourceInfo));
  }
  if (diagnostics.length > 0) {
    console.log('=== Diagnostics ===');
    for (const d of diagnostics) {
      console.log(JSON.stringify(d));
    }
  }
}
main().catch(e => console.error(e));
