const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const indexJs = path.join(distDir, 'index.js');
const indexCjs = path.join(distDir, 'index.cjs');
const sourcemapJs = path.join(distDir, 'sourcemap-register.js');
const sourcemapCjs = path.join(distDir, 'sourcemap-register.cjs');

function replaceInFile(filePath, from, to) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const updated = content.replace(from, to);
  if (updated !== content) {
    fs.writeFileSync(filePath, updated);
  }
}

function renameFile(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest);
  }
  fs.renameSync(src, dest);
}

renameFile(indexJs, indexCjs);
renameFile(sourcemapJs, sourcemapCjs);
replaceInFile(
  indexCjs,
  "require('./sourcemap-register.js')",
  "require('./sourcemap-register.cjs')"
);
