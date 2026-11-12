const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ 
  input: fs.createReadStream('C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9/.system_generated/logs/transcript_full.jsonl') 
});
rl.on('line', (line) => {
  if (line.includes('49M094943E995254D') && line.includes('"step_index":18868')) {
    const obj = JSON.parse(line);
    console.log('Thinking:', obj.thinking);
  }
});

