import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', 'verify-draw': 'scripts/verify-draw.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
