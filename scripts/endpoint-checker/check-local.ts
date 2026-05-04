import { hasCriticalFailures, printDiscoveredEndpoints, printReport, runEndpointChecks } from './shared';

async function main() {
  const baseUrl = process.env.LOCAL_API_URL ?? 'http://localhost:3000';
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
