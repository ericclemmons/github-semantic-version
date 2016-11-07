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
    -i, --init        Generates a new changelog and updates the current version in package.json.
    -u, --update      Bump the version in package.json based on the last change.
    -c, --changelog   Bump the version in package.json AND append last change to the CHANGELOG.md.
    -r, --repo        Commits and pushes the changes (version and CHANGELOG) to the repo.
    -p, --publish     Commits and pushes the changes to the repo, AND publishes the latest to NPM.
    -b, --branch      (Default: master) Release branch, others are ignored.
    --force           By default, -v and -c only work in CI environment. Override this only if you know what you're doing!
    --debug           Output debug info about what's happening in the running process.
    --dry-run         Perform a dry-run without writing, commiting, pushing, or publishing.
`, {
  alias: {
    i: "init",
    u: "update",
    c: "changelog",
    r: "repo",
    p: "publish",
    b: "branch"
  },

  default: Version.defaultOptions,
});

const validEnvironment = process.env.CI || cli.flags.force || cli.flags.dryRun;
const hasRequiredFlags = cli.flags.init || cli.flags.update || cli.flags.changelog;

// run release only in CI environment. don't run complete changelog generation in CI.
if (validEnvironment && hasRequiredFlags) {
  const version = new Version(getPackageOpts(), cli.flags);

  if (cli.flags.init) {
    version.refresh();
  } else {
    version.release();
  }
} else if (validEnvironment && !hasRequiredFlags) {
  error("Must specify one of the following options: -i, -u, or -c")
  cli.showHelp(1);
} else {
  error("Not in CI environment or incorrect usage.");
  cli.showHelp(1);
}
