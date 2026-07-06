#!/usr/bin/env node
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(
    `cursor-observatory requires Node.js 22+ (found ${process.versions.node}).`
  );
  process.exit(1);
}

const { runCli } = await import("../src/cli.mjs");

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
