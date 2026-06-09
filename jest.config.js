/**
 * E2E test configuration. Specs live in `test/*.e2e-spec.ts` and run against a
 * dedicated test database (see `.env.test`). Tests share one database, so they
 * run serially (`maxWorkers: 1`) and each spec cleans up in `beforeEach`.
 */
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>/test"],
  testRegex: ".*\\.e2e-spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "test/tsconfig.json" }],
  },
  testEnvironment: "node",
  setupFiles: ["<rootDir>/test/setup-env.ts"],
  globalSetup: "<rootDir>/test/jest-global-setup.ts",
  maxWorkers: 1,
  testTimeout: 30000,
};
