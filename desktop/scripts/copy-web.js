#!/usr/bin/env node
'use strict';
// Copia la app web (index.html, css/, js/, vendor/) desde la raíz del repo
// hacia desktop/app-web/, borrando previamente el destino. Node puro.
const fs = require('fs');
const path = require('path');

const desktopDir = path.join(__dirname, '..');   // desktop/
const appWeb = path.join(desktopDir, 'app-web');
const repoRoot = path.join(desktopDir, '..');

const COPIES = ['index.html', 'css', 'js', 'vendor'];

function copyAll(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyAll(path.join(src, entry), path.join(dest, entry));
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dest);
  } else if (stat.isSymbolicLink()) {
    const real = fs.realpathSync(src);
    if (fs.existsSync(real)) fs.copyFileSync(real, dest);
  }
}

fs.rmSync(appWeb, { recursive: true, force: true });
fs.mkdirSync(appWeb, { recursive: true });

let copied = 0;
for (const name of COPIES) {
  const src = path.join(repoRoot, name);
  if (!fs.existsSync(src)) {
    console.log(`[copy-web] (skip, no existe) ${name}`);
    continue;
  }
  copyAll(src, path.join(appWeb, name));
  copied++;
}

// Verificación: solo se copian los elementos autorizados
const top = fs.readdirSync(appWeb).sort();
const unknown = top.filter(f => !COPIES.includes(f));
if (unknown.length) {
  console.error(`[copy-web] ERROR: rutas no autorizadas en app-web: ${unknown.join(', ')}`);
  process.exit(1);
}
console.log(`[copy-web] OK (${copied}/4 elementos): ${top.join(', ')}`);
