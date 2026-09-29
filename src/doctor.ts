import { runDiagnostics } from "./diagnostics.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--code-only")) {
  console.error("Usage: npm run doctor [-- --code-only]. This command is always offline.");
  process.exitCode = 1;
} else {
  console.log("Countdown Bot local checks (offline): no Discord requests or production database writes.");
  const results = await runDiagnostics({ codeOnly: args[0] === "--code-only" });
  for (const result of results) console.log(`${result.status.toUpperCase()} ${result.name}: ${result.message}`);
  const failed = results.some(({ status }) => status === "fail");
  console.log(failed ? "Fix the failed local checks before starting the bot." : "Local checks passed. Live Discord delivery is a separate acceptance test.");
  process.exitCode = failed ? 1 : 0;
}
