import {
  hasCriticalFailures,
  printDiscoveredEndpoints,
  printReport,
  runEndpointChecks,
} from "./shared";

async function main() {
  const baseUrl = process.env.API_BASE_URL ?? process.env.TARGET_URL;

  if (!baseUrl) {
    console.error("API_BASE_URL or TARGET_URL is not defined.");
    console.error(
      "Set it to the deployed backend URL, for example https://api.example.com.",
    );
    process.exitCode = 1;
    return;
  }

  const results = await runEndpointChecks(baseUrl);

  printDiscoveredEndpoints();
  printReport(baseUrl, results);

  if (hasCriticalFailures(results)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
