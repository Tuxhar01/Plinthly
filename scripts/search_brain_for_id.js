const fs = require('fs');
const path = require('path');

function searchDir(dir, pattern) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git'].includes(entry.name)) {
        searchDir(fullPath, pattern);
      }
    } else {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes(pattern)) {
          console.log(`Found in: ${fullPath}`);
        }
      } catch (e) {}
    }
  }
}

console.log('Searching for 49M094943E995254D...');
searchDir('C:/Users/Tushar Kumar/.gemini/antigravity/brain/2fe1c32a-c3b1-43e3-8805-e0daa526cad9', '49M094943E995254D');
console.log('Done searching brain.');

