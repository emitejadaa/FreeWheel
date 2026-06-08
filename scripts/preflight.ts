import { spawnSync } from "node:child_process";

// The unit-test suite was removed and will be reimplemented from scratch, so
// preflight covers schema validation, the build, and a live endpoint smoke check.
const checks = [
  {
    label: "Prisma validate/generate",
    command: "npm",
    args: ["run", "check:prisma"],
  },
  { label: "Build", command: "npm", args: ["run", "build"] },
];

function main() {
  for (const check of checks) {
    console.log("");
    console.log(`Running ${check.label}...`);
    run(check.command, check.args);
  }

  console.log("");
  console.log("Checking local endpoint availability...");
  const endpointResult = spawnSync("npm", ["run", "test:endpoints:local"], {
    stdio: "inherit",
    shell: true,
  });

  if (endpointResult.status !== 0) {
    console.log("");
    console.log(
      "Local endpoint checker did not pass. If the server is not running, start npm run start:dev and rerun it.",
    );
  }
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();
