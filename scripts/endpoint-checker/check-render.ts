import { hasCriticalFailures, printDiscoveredEndpoints, printReport, runEndpointChecks } from './shared';

async function main() {
  const baseUrl = process.env.RENDER_API_URL;

  if (!baseUrl) {
    console.error('RENDER_API_URL is not defined.');
    console.error('Set it to the deployed backend URL, for example in your shell or Render/GitHub secret config.');
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
