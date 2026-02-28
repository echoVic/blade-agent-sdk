import { spawn } from "node:child_process";

const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

const externals = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {})
];

console.log("Building @blade-ai/agent-sdk...");

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  minify: true,
  external: externals
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

console.log("✓ JavaScript build completed!");

console.log("Generating type declarations...");

const tsc = spawn("bun", ["x", "tsc", "-p", "tsconfig.build.json"], {
  stdio: "inherit",
  shell: true
});

const exitCode = await new Promise<number>((resolve) => {
  tsc.on("close", (code) => resolve(code ?? 0));
});

if (exitCode !== 0) {
  console.error("✗ Type declaration generation failed!");
  process.exit(exitCode);
}

console.log("✓ Type declarations generated!");
console.log("✓ Build completed!");
