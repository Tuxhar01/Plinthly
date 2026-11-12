const fs = require('fs');
const path = 'C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9/STAGE_2_ARCHITECTURE_CONTRACT_v2.0.11.md';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.toLowerCase().includes('crypto_asym_verify')) {
    console.log(`--- Line ${idx+1} ---`);
    console.log(lines.slice(Math.max(0, idx - 5), Math.min(lines.length, idx + 10)).join('\n'));
  }
});

