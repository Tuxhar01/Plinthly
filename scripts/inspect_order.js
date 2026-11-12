const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ 
  input: fs.createReadStream('C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9/.system_generated/logs/transcript_full.jsonl') 
});
let count = 0;
rl.on('line', (line) => {
  if (line.includes('2BR08855VR6881230')) {
    count++;
    if (count <= 5) {
      const obj = JSON.parse(line);
      console.log(`Step ${obj.step_index} (${obj.source}/${obj.type}):`, line.substring(0, 150));
    }
  }
});
rl.on('close', () => console.log('Total occurrences of 2BR08855VR6881230:', count));

