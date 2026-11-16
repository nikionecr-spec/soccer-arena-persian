/* Copies the single-file client into the Capacitor webDir (before `cap sync`). */
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'client', 'index.html');
const dir = path.join(__dirname, 'web');
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, 'index.html'));
console.log('copied client/index.html -> android/web/index.html (' + fs.statSync(src).size + ' bytes)');
console.log('REMINDER: set window.SAP_SERVER inside client/index.html to your VPS URL before building the APK.');
