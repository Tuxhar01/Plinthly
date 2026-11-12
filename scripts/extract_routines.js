const fs = require('fs');
const path = 'C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9/STAGE_2_ARCHITECTURE_CONTRACT_v2.0.11.md';
const content = fs.readFileSync(path, 'utf8');

const rRegex = /#### Routine `R2-ROUTINE-0(\d)`: `([^`]+)`/g;
let match;
const routines = [];
while ((match = rRegex.exec(content)) !== null) {
  routines.push({ num: match[1], name: match[2], index: match.index });
}

for (let i = 0; i < routines.length; i++) {
  const start = routines[i].index;
  const end = (i + 1 < routines.length) ? routines[i+1].index : content.indexOf('## 5. TypeScript, Zod and SQL Contract Parity');
  const sectionText = content.substring(start, end);
  fs.writeFileSync(`scripts/routine_${routines[i].num}.txt`, sectionText, 'utf8');
  console.log(`Wrote routine_${routines[i].num}.txt (${sectionText.length} chars)`);
}

