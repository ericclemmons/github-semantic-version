#!/usr/bin/env node

import meow from "meow";
import path from "path";
import fs from "fs-extra";

import { error } from "./debug";
import Version from "./Version";

function getPackageOpts() {
  try {
    var pkgPath = path.resolve(process.cwd(), './package.json');
    return fs.readJsonSync(pkgPath);
  }
  catch (err) {}
}

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

// run release only in CI environment. don't run complete changelog generation in CI.
if (process.env.CI || cli.flags.dryRun || cli.flags.force || cli.flags.refresh) {
  const version = new Version(getPackageOpts(), cli.flags);

  if (cli.flags.refresh) {
    version.refresh();
  } else {
    version.release();
  }
} else {
  error("Not in CI environment or incorrect usage.");
  cli.showHelp(1);
}
