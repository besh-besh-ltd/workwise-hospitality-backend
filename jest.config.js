export default {
  testEnvironment: "node",
  transform: {},
  testTimeout: 60000,
  forceExit: true,
  globalSetup: "<rootDir>/tests/setup/globalSetup.js",
  globalTeardown: "<rootDir>/tests/setup/globalTeardown.js",
  setupFiles: ["<rootDir>/tests/setup/jestEnv.js"],
  testPathIgnorePatterns: ["/node_modules/"],
  // Run all suites in a single Jest worker so they share the prepared test DB.
  // (globalSetup runs once per Jest process; multiple workers would each try to
  // create the DB and clobber each other.) Tests within a worker isolate via
  // per-test transactional rollback (see tests/setup/db.js withTx helper).
  maxWorkers: 1,
};
