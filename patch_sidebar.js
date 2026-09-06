const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'public/admin');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== 'login.html');

const toAdd = `      <a href="/admin/shortlinks.html"
        class="flex items-center gap-3 px-4 py-3 rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-all">
        <span class="material-symbols-outlined">link</span>
        <span class="font-label-md">Shortlink</span>
      </a>`;

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('href="/admin/shortlinks.html"')) continue; // Already added
  content = content.replace(
    /<\/nav>/,
    `${toAdd}\n    </nav>`
  );
  fs.writeFileSync(filePath, content);
  console.log('Updated ' + file);
}
