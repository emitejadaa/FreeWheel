/**
 * Two Jest projects:
 *  - "unit": fast, pure unit specs under src (file suffix .spec.ts), no database.
 *  - "e2e":  test/*.e2e-spec.ts against a dedicated test database (see
 *    `.env.test`). Specs share one database, so everything runs serially
 *    (`maxWorkers: 1`) and each e2e spec cleans up in `beforeEach`.
 */
const tsTransform = {
  "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "test/tsconfig.json" }],
};

/** @type {import('jest').Config} */
module.exports = {
  maxWorkers: 1,
  projects: [
    {
      displayName: "unit",
      moduleFileExtensions: ["js", "json", "ts"],
      rootDir: ".",
      roots: ["<rootDir>/src"],
      testRegex: ".*\\.spec\\.ts$",
      transform: tsTransform,
      testEnvironment: "node",
      testTimeout: 30000,
    },
    {
      displayName: "e2e",
      moduleFileExtensions: ["js", "json", "ts"],
      rootDir: ".",
      roots: ["<rootDir>/test"],
      testRegex: ".*\\.e2e-spec\\.ts$",
      transform: tsTransform,
      testEnvironment: "node",
      setupFiles: ["<rootDir>/test/setup-env.ts"],
      globalSetup: "<rootDir>/test/jest-global-setup.ts",
      testTimeout: 30000,
    },
  ],
};
