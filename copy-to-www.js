// ওয়েব অ্যাসেট www/ ফোল্ডারে কপি করা — Capacitor-এর webDir।
// (কোনো build step নেই; এই স্ক্রিপ্টটাই "build"।)
// চালানো: npm run copy:www  (বা সরাসরি: node copy-to-www.js)
const fs = require('fs');
const path = require('path');

const FILES = [
  'index.html', 'styles.css', 'app.js', 'utils.js', 'i18n.js', 'seed.js',
  'firebase-config.js', 'manifest.webmanifest', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'privacy.html', 'terms.html'
];

const out = path.join(__dirname, 'www');
fs.mkdirSync(out, { recursive: true });
for (const f of FILES) {
  fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
  console.log('copied', f, '-> www/' + f);
}
console.log('www/ ready — now run: npx cap sync android');
