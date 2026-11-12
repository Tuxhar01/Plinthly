const fs = require('fs');
const path = 'C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9/STAGE_2_ARCHITECTURE_CONTRACT_v2.0.11.md';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');
console.log(lines.slice(1625, 1680).join('\n'));

