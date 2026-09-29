import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const requiredVariables = ["DATABASE_URL", "JWT_SECRET"];
const documentedOptionalVariables = [
  "DIRECT_URL",
  "JWT_EXPIRES_IN",
  "PORT",
  "LOCAL_API_URL",
  "API_BASE_URL",
  "FRONTEND_URL",
  "CORS_ORIGINS",
  "TARGET_URL",
  "TEST_EMAIL",
  "TEST_PASSWORD",
  "FUNCTIONAL_TEST_TIMEOUT_MS",
  "DEPLOY_VERIFY_ATTEMPTS",
  "DEPLOY_VERIFY_DELAY_MS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "SMS_PROVIDER",
  "REQUIRE_PHONE_VERIFICATION",
  "VERIFICATION_CODE_IN_RESPONSE",
  "IDENTITY_REVIEW_MODE",
  "IDENTITY_REVIEW_TIMEOUT_MS",
  "ONBOARDING_JWT_EXPIRES_IN",
  "GROQ_API_KEY",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "PAYMENTS_PROVIDER",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_API_VERSION",
  "STRIPE_CONNECT_ENABLED",
  "PLATFORM_FEE_PCT",
  "INSURANCE_PCT",
  "SENA_PCT",
  "DEPOSIT_DEFAULT_USD",
  "DEFAULT_CURRENCY",
  "PRICE_CHANGE_COOLDOWN_HOURS",
];

const examplePath = join(process.cwd(), ".env.example");

function main() {
  ensureEnvExample();

  const missingRequired = requiredVariables.filter(
    (name) => !process.env[name],
  );
  const documented = parseEnvExample();
  const missingFromExample = [
    ...requiredVariables,
    ...documentedOptionalVariables,
  ].filter((name) => !documented.has(name));

  console.log("Required variables:", requiredVariables.join(", "));
  console.log(
    "Documented optional variables:",
    documentedOptionalVariables.join(", "),
  );

  if (missingRequired.length > 0) {
    console.error(
      `Missing required variables in current environment: ${missingRequired.join(", ")}`,
    );
  }

  if (missingFromExample.length > 0) {
    console.error(
      `Missing variables in .env.example: ${missingFromExample.join(", ")}`,
    );
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  const isLiveKey = /^(sk|rk)_live_/.test(stripeKey);
  if (isLiveKey) {
    console.error(
      "Refusing live Stripe key: STRIPE_SECRET_KEY must be a TEST key " +
        "(sk_test_/rk_test_). This build is test-mode only.",
    );
  }

  if (
    missingRequired.length > 0 ||
    missingFromExample.length > 0 ||
    isLiveKey
  ) {
    process.exitCode = 1;
    return;
  }

  console.log(
    "Environment documentation and required variable presence look OK.",
  );
}

function ensureEnvExample(): void {
  if (existsSync(examplePath)) {
    return;
  }

  writeFileSync(
    examplePath,
    [
      'DATABASE_URL="postgresql://user:password@host:5432/freewheel?sslmode=require"',
      'JWT_SECRET="replace-with-a-secure-secret"',
      'JWT_EXPIRES_IN="24h"',
      "PORT=3000",
      'LOCAL_API_URL="http://localhost:3000"',
      'API_BASE_URL=""',
      'FRONTEND_URL=""',
      'CORS_ORIGINS=""',
      'TARGET_URL=""',
      'TEST_EMAIL=""',
      'TEST_PASSWORD=""',
      "FUNCTIONAL_TEST_TIMEOUT_MS=10000",
      "DEPLOY_VERIFY_ATTEMPTS=5",
      "DEPLOY_VERIFY_DELAY_MS=15000",
      'GOOGLE_CLIENT_ID=""',
      'GOOGLE_CLIENT_SECRET=""',
      'GMAIL_USER=""',
      'GMAIL_APP_PASSWORD=""',
      "",
    ].join("\n"),
  );
  console.log("Created .env.example with placeholders only.");
}

function parseEnvExample(): Set<string> {
  const content = readFileSync(examplePath, "utf8");
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
