import { copyFile, mkdir } from 'node:fs/promises'
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
await Promise.all(['manifest.json', 'sidepanel.html'].map((name) => copyFile(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url))))
