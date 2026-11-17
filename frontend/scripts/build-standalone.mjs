// Builds a single self-contained HTML page (CSS + JS inlined) of the local-simulation app,
// for static hosting where only one page and no external assets are available.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

execSync('npx vite build --outDir dist-standalone --emptyOutDir', { stdio: 'inherit', env: { ...process.env, VITE_ROUTER: 'hash', VITE_DATA_MODE: 'local-simulation' } });
const dir = 'dist-standalone/assets';
const files = readdirSync(dir);
const css = readFileSync(`${dir}/${files.find((f) => f.endsWith('.css'))}`, 'utf8');
const js = readFileSync(`${dir}/${files.find((f) => f.endsWith('.js'))}`, 'utf8').replace(/<\/script/gi, '<\\/script');
const page = `<title>Wealth Engine AI</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${css}
html,body{background:#07090d;color:#e2e8f0;color-scheme:dark}</style>
<div id="root"></div>
<script type="module">${js}</script>
`;
mkdirSync('standalone', { recursive: true });
writeFileSync('standalone/wealth-engine-ai.html', page);
console.log(`standalone/wealth-engine-ai.html ${(page.length / 1024).toFixed(0)} KB`);
