import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const command = process.argv[2];
const passthroughArgs = process.argv.slice(3);

const commands = new Set(['deploy', 'deploys', 'logs', 'services', 'validate']);

if (!command || !commands.has(command)) {
  console.error('Usage: ts-node scripts/render-control.ts <deploy|deploys|logs|services|validate> [args]');
  process.exit(1);
}

const renderBin = resolveRenderBinary();

if (command === 'validate') {
  const workspaceArgs = process.env.RENDER_WORKSPACE_ID
    ? ['--workspace', process.env.RENDER_WORKSPACE_ID]
    : [];
  runRender([
    'blueprints',
    'validate',
    'render.yaml',
    '--output',
    'text',
    '--confirm',
    ...workspaceArgs,
    ...passthroughArgs,
  ]);
} else if (command === 'services') {
  runRender(['services', '--output', 'text', '--confirm', ...passthroughArgs]);
} else {
  const serviceId = process.env.RENDER_SERVICE_ID;

  if (!serviceId) {
    console.error('RENDER_SERVICE_ID is not defined.');
    console.error('Set it in your local .env or shell. Do not commit real Render IDs if you consider them sensitive.');
    process.exit(1);
  }

  if (!process.env.RENDER_API_KEY) {
    console.warn('RENDER_API_KEY is not defined. The Render CLI must be logged in locally or the command will fail.');
  }

  if (command === 'deploy') {
    runRender(['deploys', 'create', serviceId, '--output', 'text', '--confirm', ...passthroughArgs]);
  }

  if (command === 'deploys') {
    runRender(['deploys', 'list', serviceId, '--output', 'text', '--confirm', ...passthroughArgs]);
  }

  if (command === 'logs') {
    runRender([
      'logs',
      '--resources',
      serviceId,
      '--limit',
      process.env.RENDER_LOG_LIMIT ?? '100',
      '--output',
      'text',
      '--confirm',
      ...passthroughArgs,
    ]);
  }
}

function resolveRenderBinary(): string {
  if (process.env.RENDER_CLI_PATH) {
    return process.env.RENDER_CLI_PATH;
  }

  if (process.platform === 'win32' && process.env.USERPROFILE) {
    const localBinary = join(process.env.USERPROFILE, 'bin', 'render-cli', 'cli_v2.16.0.exe');
    if (existsSync(localBinary)) {
      return localBinary;
    }
  }

  return 'render';
}

function runRender(args: string[]): never {
  const result = spawnSync(renderBin, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      RENDER_OUTPUT: process.env.RENDER_OUTPUT ?? 'text',
    },
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
