#!/usr/bin/env node

import meow from "meow";

import { error } from "./debug";
import Version from "./Version";

const cli = meow(`
  Usage:
    $ github-semantic-version

  Options:
    -b, --branch    (Default: master) Release branch, others are ignored.
    -r, --dry-run   Perform dry-run without pushing or publishing.
    -h, --refresh   Re-generate the changelog and calculate the current repo version
    -c, --changelog Append latest change to the changelog on release
`, {
  alias: {
    b: "branch",
    c: "changelog",
    d: "debug",
    f: "force",
    r: "dry-run",
    h: "refresh"
  },

  default: Version.defaultOptions,
});

if (process.env.CI || cli.flags.dryRun || cli.flags.force) {
  const version = new Version(cli.pkg, cli.flags);

  if (cli.flags.refresh) {
    version.refresh();
  } else {
    version.release();
  }
} else {
  error("Not in CI environment.");
  cli.showHelp(1);
}
