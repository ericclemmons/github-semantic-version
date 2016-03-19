#!/usr/bin/env node

import meow from "meow";

import { error } from "./debug";
import Version from "./Version";

const cli = meow(`
  Usage:
    $ github-semantic-version

  Options:
    -b, --branch    (Default: master) Release branch, others are ignored.
    -d, --dry-run   Perform dry-run without pushing or publishing.
    -f, --force     Bypass CI environment check.
`, {
  alias: {
    b: "branch",
    d: "debug",
    f: "force",
  },

  default: Version.defaultOptions,
});

if (process.env.CI || cli.flags.dryRun || cli.flags.force) {
  new Version(cli.pkg, cli.flags).release();
} else {
  error("Not in CI environement.");
  cli.showHelp(1);
}
