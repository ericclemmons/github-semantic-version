#!/usr/bin/env node

import meow from "meow";
import path from "path";
import fs from "fs-extra";

import { error } from "./debug";
import Version from "./Version";

const cli = meow(`
  Usage:
    $ github-semantic-version

  Options:
    --init        Generates a new changelog and updates the current version in package.json.
    --bump        Bump the version in package.json based on the last change.
    --changelog   Bump the version in package.json AND append last change to the CHANGELOG.md.
    --push        Commits and pushes the changes (version and CHANGELOG) to the repo.
    --publish     Commits and pushes the changes to the repo, AND publishes the latest to NPM.
    --branch      (Default: master) Release branch, others are ignored.
    --force       By default, --bump and --changelog only work in CI environment. Override this only if you know what you're doing!
    --debug       Output debug info about what's happening in the running process.
    --dry-run     Perform a dry-run without writing, commiting, pushing, or publishing.
`, {

  default: Version.defaultOptions,
});

// we really need a GI_TOKEN or GITHUB_TOKEN b/c api request limiting
if (!(process.env.GI_TOKEN || process.env.GITHUB_TOKEN)) {
  error(`Either a GITHUB_TOKEN or GI_TOKEN environment variable is required to interact with the Github API.`);
  process.exit(1);
}

// if the user is publishing to NPM, they need an NPM_TOKEN
if (cli.flags.publish && !process.env.NPM_TOKEN) {
  error(`If specifying --publish, the NPM_TOKEN environment variable needs to be set.`);
  process.exit(1);
}

const validEnvironment = process.env.CI || cli.flags.force || cli.flags.dryRun;
const hasRequiredFlags = cli.flags.init || cli.flags.bump || cli.flags.changelog;

const packageOptions = getOptionsFromFile("./package.json");
const configOptions = packageOptions.gsv || getOptionsFromFile("./gsv.json");

if (!configOptions || !(configOptions["major-label"] && configOptions["minor-label"] && configOptions["patch-label"])) {
  error(`Must specify version label config options in either a gsv.json file or a package.json entry.
    Ex:
    {
      "major-label": "Version: Major",
      "minor-label": "Version: Minor",
      "patch-label": "Version: Patch"
    }
  `);
  process.exit(1);
}

const versionOptions = {
  version: packageOptions.version,
  private: packageOptions.private || false,
  ...configOptions
};

// run release only in CI environment. don't run complete changelog generation in CI.
if (validEnvironment && hasRequiredFlags) {
  const version = new Version(versionOptions, cli.flags);

  if (cli.flags.init) {
    version.refresh();
  } else {
    version.release();
  }
} else if (validEnvironment && !hasRequiredFlags) {
  error("Must specify one of the following options: --init, --bump, or --changelog")
  cli.showHelp(1);
} else {
  error("Not in CI environment or incorrect usage.");
  cli.showHelp(1);
}

function getOptionsFromFile(configFilePath) {
  if (configFilePath) {
    try {
      const filePath = path.resolve(process.cwd(), configFilePath);
      return fs.readJsonSync(filePath);
    } catch (err) {}
  }
}
