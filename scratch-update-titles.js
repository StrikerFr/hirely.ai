const fs = require('fs');
const path = require('path');
const dir = './src/routes';
const files = fs.readdirSync(dir);
files.forEach(file => {
  if (!file.endsWith('.tsx') && !file.endsWith('.ts')) return;
  const p = path.join(dir, file);
  let content = fs.readFileSync(p, 'utf8');
  const initialContent = content;
  content = content.replace(/title: \"(.*?) — (.*?)\"/g, 'title: "$1 - $2"');
  content = content.replace(/content: \"(.*?) — (.*?)\"/g, 'content: "$1 - $2"');
  if (content !== initialContent) {
    fs.writeFileSync(p, content);
    console.log(`Updated ${file}`);
  }
});
