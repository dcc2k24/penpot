import { cpSync, existsSync } from "fs";

// copy static assets and data to dist
cpSync("src/static", "dist/static", { recursive: true });
cpSync("data", "dist/data", { recursive: true });

// the sandbox starts its guest in a worker that must sit next to the bundle; fail the build without it
const worker = "dist/SandboxWorkerThread.js";
if (!existsSync(worker)) {
    console.error(`missing ${worker}: the sandbox needs this worker next to dist/index.js`);
    process.exit(1);
}
