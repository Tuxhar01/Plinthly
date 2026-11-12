const fs = require('fs');
const path = 'C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9/STAGE_2_ARCHITECTURE_CONTRACT_v2.0.11.md';
const content = fs.readFileSync(path, 'utf8');

const regexes = [/CREATE OR REPLACE FUNCTION/i, /CREATE FUNCTION/i];
regexes.forEach(r => {
  let match;
  const re = new RegExp(r, 'gi');
  while ((match = re.exec(content)) !== null) {
    const idx = content.substring(0, match.index).split('\n').length;
    console.log(`Found ${match[0]} at line ${idx}`);
    console.log(content.split('\n').slice(idx - 1, idx + 15).join('\n'));
  }
});

