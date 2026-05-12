import { hasCriticalFailures, printReport, runEndpointChecks } from "./shared";

const attempts = Number.parseInt(process.env.DEPLOY_VERIFY_ATTEMPTS ?? "5", 10);
const delayMs = Number.parseInt(
  process.env.DEPLOY_VERIFY_DELAY_MS ?? "15000",
  10,
);

async function main() {
  const baseUrl = process.env.API_BASE_URL ?? process.env.TARGET_URL;

  if (!baseUrl) {
    console.error("API_BASE_URL or TARGET_URL is not defined.");
    console.error(
      "The deploy verifier only checks the remote URL you provide.",
    );
    process.exitCode = 1;
    return;
  }

  let lastFailed = true;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`Deploy verification attempt ${attempt}/${attempts}`);
    const results = await runEndpointChecks(baseUrl);
    printReport(baseUrl, results);

    lastFailed = hasCriticalFailures(results);

    if (!lastFailed) {
      return;
    }

    if (attempt < attempts) {
      console.log("");
      console.log(`Waiting ${delayMs}ms before retrying...`);
      await wait(delayMs);
    }
  }

  console.error("");
  console.error("Deploy verification failed after limited retries.");
  console.error(
    "Possible causes: deploy still starting, missing env vars, pending migrations, Prisma errors,",
  );
  console.error(
    "an endpoint path changed, or the server is not listening on the expected port.",
  );
  process.exitCode = 1;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
