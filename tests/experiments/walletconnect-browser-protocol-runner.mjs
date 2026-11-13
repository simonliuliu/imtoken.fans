// Supervises only its own isolated worker. Forced termination is always failure.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultWorker = fileURLToPath(new URL("./walletconnect-browser-protocol.mjs", import.meta.url));
const worker = process.env.IMTOKEN_BROWSER_PROTOCOL_QA_WORKER || defaultWorker;
if (!path.isAbsolute(worker)) throw new Error("QA worker path must be absolute");
const child = spawn(process.execPath, [worker], { env: { ...process.env, IMTOKEN_BROWSER_PROTOCOL_WORKER: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let passed = 0;
let failed = 0;
let invalid = 0;
let last;
let stopReason;
let failureTimer;
let forceTimer;
let overallTimer;
function stop(reason) {
  if (stopReason || child.exitCode !== null || child.signalCode !== null) return;
  stopReason = reason;
  child.kill("SIGTERM");
  forceTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
  forceTimer.unref();
}
function forward(stream, target) {
  let pending = "";
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    target.write(text);
    pending += text;
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      try {
        const report = JSON.parse(line);
        if (report.status === "passed") { passed += 1; last = "passed"; }
        else if (report.status === "failed") { failed += 1; last = "failed"; }
        else if (Object.prototype.hasOwnProperty.call(report, "status")) { invalid += 1; last = "invalid"; }
        if ((failed || invalid) && !failureTimer) { failureTimer = setTimeout(() => stop("failure cleanup timeout"), 3000); failureTimer.unref(); }
      } catch {}
    }
    if (pending.length > 65536) pending = pending.slice(-65536);
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);
overallTimer = setTimeout(() => stop("overall timeout"), 75000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop("interrupted"));
child.on("error", (error) => {
  clearTimeout(overallTimer);
  process.stderr.write(JSON.stringify({ status: "failed", phase: "supervisor startup", errorName: error.name }) + "\n");
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  clearTimeout(overallTimer); clearTimeout(failureTimer); clearTimeout(forceTimer);
  if (stopReason) process.stderr.write(JSON.stringify({ status: "failed", phase: "supervisor", reason: stopReason, signal }) + "\n");
  const success = passed === 1 && failed === 0 && invalid === 0 && last === "passed" && !stopReason && code === 0;
  if (!success && !stopReason && !failed) process.stderr.write(JSON.stringify({ status: "failed", phase: "supervisor", reason: "invalid worker result", code, signal }) + "\n");
  process.exitCode = success ? 0 : 1;
});
