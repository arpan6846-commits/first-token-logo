// Copies the engine (core/) into base44/shared/core so Base44 functions can import it.
// core/ stays the single source of truth; never edit base44/shared/core by hand.
import { cpSync, rmSync, writeFileSync } from 'node:fs';
rmSync('base44/shared/core', { recursive: true, force: true });
cpSync('core', 'base44/shared/core', { recursive: true });
writeFileSync('base44/shared/core/README.md', '# GENERATED — copy of /core by scripts/sync-shared.mjs. Do not edit here.\n');
console.log('synced core → base44/shared/core');
