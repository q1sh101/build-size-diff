const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const distPath = path.resolve(__dirname, 'dist');

console.log('Testing bundle size scan...');
console.log('Scanning:', distPath);
console.log('');

function scanDir(dir) {
  const files = [];

  function walk(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(js|css|cjs|mjs)$/i.test(entry.name)) {
        const content = fs.readFileSync(fullPath);
        const gzipped = zlib.gzipSync(content);
        const brotli = zlib.brotliCompressSync(content);

        files.push({
          path: path.relative(distPath, fullPath),
          size: content.length,
          gzip: gzipped.length,
          brotli: brotli.length,
        });
      }
    }
  }

  walk(dir);
  return files;
}

try {
  const files = scanDir(distPath);

  console.log(`Found ${files.length} bundle files:\n`);

  let totalSize = 0;
  let totalGzip = 0;
  let totalBrotli = 0;

  files.forEach((f) => {
    totalSize += f.size;
    totalGzip += f.gzip;
    totalBrotli += f.brotli;

    console.log(`${f.path}`);
    console.log(`   Size:   ${(f.size / 1024).toFixed(2)} KB`);
    console.log(`   Gzip:   ${(f.gzip / 1024).toFixed(2)} KB`);
    console.log(`   Brotli: ${(f.brotli / 1024).toFixed(2)} KB`);
    console.log('');
  });

  console.log('TOTALS:');
  console.log(`   Size:   ${(totalSize / 1024).toFixed(2)} KB`);
  console.log(`   Gzip:   ${(totalGzip / 1024).toFixed(2)} KB`);
  console.log(`   Brotli: ${(totalBrotli / 1024).toFixed(2)} KB`);

  console.log('\nTest passed! Action logic works correctly.');
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
