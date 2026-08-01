// Integration tests that need a real MariaDB but not a browser.
// Run with `npm run test-db` (see .testenv.sh for connection settings).
export default {
  spec_dir: "",
  spec_files: ["src/**/*_dbtest.ts"],
  jsLoader: "require",
  env: {
    stopSpecOnExpectationFailure: false,
    random: true,
    forbidDuplicateNames: true,
  },
};
