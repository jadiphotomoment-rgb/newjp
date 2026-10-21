#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findHtmlFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      findHtmlFiles(fullPath, fileList);
    } else if (file.endsWith('.html')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const htmlFiles = findHtmlFiles(path.join(__dirname, '..', 'public'));
let totalErrors = 0;
let checkedScripts = 0;

for (const file of htmlFiles) {
  const relPath = path.relative(path.join(__dirname, '..'), file);
  const content = fs.readFileSync(file, 'utf8');
  const scriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(content)) !== null) {
    checkedScripts++;
    const fullTag = match[0];
    const scriptCode = match[1];
    const upToScript = content.slice(0, match.index + fullTag.indexOf('>') + 1);
    const lineNumber = upToScript.split('\n').length;
    try {
      new vm.Script(scriptCode, { filename: relPath, lineOffset: lineNumber - 1 });
    } catch (err) {
      console.error(`\x1b[31m[SYNTAX ERROR]\x1b[0m ${relPath}:${lineNumber}`);
      console.error(err.message);
      totalErrors++;
    }
  }
}

if (totalErrors > 0) {
  console.error(`\n\x1b[31mGagal: Ditemukan ${totalErrors} kesalahan sintaks pada script inline HTML.\x1b[0m`);
  process.exit(1);
} else {
  console.log(`\x1b[32mSemua script inline HTML valid (${htmlFiles.length} file, ${checkedScripts} blok script dicek).\x1b[0m`);
  process.exit(0);
}
