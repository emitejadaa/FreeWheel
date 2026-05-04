import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const requiredVariables = ['DATABASE_URL', 'JWT_SECRET'];
const documentedOptionalVariables = [
  'DIRECT_URL',
  'JWT_EXPIRES_IN',
  'PORT',
  'LOCAL_API_URL',
  'RENDER_API_URL',
  'TARGET_URL',
  'FRONTEND_URL',
  'API_BASE_URL',
  'TEST_EMAIL',
  'TEST_PASSWORD',
  'FUNCTIONAL_TEST_TIMEOUT_MS',
  'SENDGRID_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
];

const examplePath = join(process.cwd(), '.env.example');

function main() {
  ensureEnvExample();

  const missingRequired = requiredVariables.filter((name) => !process.env[name]);
  const documented = parseEnvExample();
  const missingFromExample = [...requiredVariables, ...documentedOptionalVariables].filter(
    (name) => !documented.has(name),
  );

  console.log('Required variables:', requiredVariables.join(', '));
  console.log('Documented optional variables:', documentedOptionalVariables.join(', '));

  if (missingRequired.length > 0) {
    console.error(`Missing required variables in current environment: ${missingRequired.join(', ')}`);
  }

  if (missingFromExample.length > 0) {
    console.error(`Missing variables in .env.example: ${missingFromExample.join(', ')}`);
  }

  if (missingRequired.length > 0 || missingFromExample.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log('Environment documentation and required variable presence look OK.');
}

function ensureEnvExample(): void {
  if (existsSync(examplePath)) {
    return;
  }

  writeFileSync(
    examplePath,
    [
      'DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"',
      'DIRECT_URL=""',
      'JWT_SECRET="replace-with-a-secure-secret"',
      'JWT_EXPIRES_IN="24h"',
      'PORT=3000',
      'LOCAL_API_URL="http://localhost:3000"',
      'RENDER_API_URL=""',
      'TARGET_URL=""',
      'FRONTEND_URL=""',
      'API_BASE_URL=""',
      'TEST_EMAIL=""',
      'TEST_PASSWORD=""',
      'FUNCTIONAL_TEST_TIMEOUT_MS=10000',
      'SENDGRID_API_KEY=""',
      'TWILIO_ACCOUNT_SID=""',
      'TWILIO_AUTH_TOKEN=""',
      '',
    ].join('\n'),
  );
  console.log('Created .env.example with placeholders only.');
}

function parseEnvExample(): Set<string> {
  const content = readFileSync(examplePath, 'utf8');
  const variables = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (match) {
      variables.add(match[1]);
    }
  }

  return variables;
}

main();
