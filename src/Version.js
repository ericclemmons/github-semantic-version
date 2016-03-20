import { EOL } from "os";
import { execSync } from "child_process";
import * as debug from "./debug";
import fs from "fs";
import Github from "github";
import path from "path";

export default class Version {
  static defaultOptions = {
    branch: "master",
  };

  static INCREMENT_MAJOR = "major";
  static INCREMENT_MINOR = "minor";
  static INCREMENT_PATCH = "patch";

  static exec(cmd, options = {}) {
    debug.info(`Executing: ${cmd}`);

    // Execute command, split lines, & trim empty ones
    const output = execSync(cmd, {
      env: process.env,
      ...options,
    }).toString();

    debug.info("Output:\n", output);

    return output
      .split(EOL)
      .filter(Boolean)
    ;
  }

  static getBranch() {
    const branch = (
      process.env.BRANCH
      ||
      process.env.CIRCLE_BRANCH
      ||
      process.env.TRAVIS_BRANCH
    );

    if (branch) {
      return branch;
    }

    const headFile = path.join(process.cwd(), ".git", "HEAD");
    const headContents = fs.readFileSync(headFile, "utf8");
    const [ _, name ] = headContents.match(/ref: refs\/heads\/([^\n]+)/) || [];

    return name;
  }

  static getCommitRange() {
    return [
      Version.getLatestTag() || Version.getInitialCommit(),
      "HEAD"
    ].join("..");
  }

  static async getIncrement() {
    const pr = Version.getLastPullRequest();

    if (!pr) {
      debug.warn(`Only commits found. Defaulting to ${Version.INCREMENT_PATCH}.`);
      return Version.INCREMENT_PATCH;
    }

    return await Version.getIncrementFromPullRequest(pr);
  }

  static async getIncrementFromPullRequest(number) {
    const github = new Github({
      version: "3.0.0",
    });

    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

    if (token) {
      github.authenticate({
        token: token,
        type: "oauth"
      });
    }

    const { user, repo } = Version.getUserRepo();

    return new Promise((resolve, reject) => {
      github.issues.getIssueLabels({ user, repo, number }, (err, labels) => {
        if (err) {
          return reject(err);
        }

        if (!labels) {
          debug.warn(`No labels found on PR #${number}. Defaulting to ${Version.INCREMENT_PATCH}.`);

          return resolve(Version.INCREMENT_PATCH);
        }

        const increment = labels
          .map((label) => label.name)
          .filter((name) => name.match(/^Version:/))
          .map((name) => name.split("Version: ").pop().toUpperCase())
          .map((increment) => Version[`INCREMENT_${increment}`])
          .shift()
        ;

        if (increment) {
          debug.info(`Found ${increment} label on PR #${number}.`);
          return resolve(increment);
        }

        debug.warn(`No "Version:" labels found on PR #${number}. Defaulting to ${Version.INCREMENT_PATCH}.`);

        return resolve(Version.INCREMENT_PATCH);
      });
    });
  }

  static getInitialCommit() {
    return Version.exec("git log --format=%h --max-parents=0 HEAD")
      .filter(Boolean)
      .pop()
    ;
  }

  static getLastPullRequest() {
    const range = Version.getCommitRange();
    const commit = Version.exec(`git log --merges -n1 --format='%an|%ae|%s' ${range}`).shift();

    if (!commit) {
      debug.warn("No merge commits found between: %s", range);
      return null;
    }

    const [ name, email, message ] = commit.split("|");

    if (!message) {
      return debug.error(`Could not parse name, email, & message from: ${commit}`);
    }

    const [ , pr ] = message.match(/Merge pull request #(\d+)/) || [];

    return pr;
  }

  static getLatestTag() {
    const tag = Version.exec("git fetch --tags && git tag -l v*")
      .filter(function(tag) {
        return tag.match(/^v(\d+)\.(\d+)\.(\d)/);
      })
      .pop()
    ;

    if (tag) {
      debug.info("Latest tag: %s", tag);
    } else {
      debug.warn("No tags found!");
    }

    return tag || null;
  }

  static getUserRepo() {
    const [ user, repo ] = Version.exec("git config --get remote.origin.url")
      .shift()
      .replace(".git", "")
      .split(/\/|:/)
      .slice(-2)
    ;

    debug.info("User: %s", user);
    debug.info("Repo: %s", repo);

    return { user, repo };
  }

  constructor(pkg, options) {
    this.pkg = pkg;
    this.options = {
      ...Version.defaultOptions,
      ...options,
    };

    // Force dry-run when not on the release branch
    if (Version.getBranch() !== this.options.branch) {
      this.options.dryRun = true;
    }

    debug.info("Current branch: %s", Version.getBranch());
    debug.info("Release branch: %s", this.options.branch);

    if (this.options.dryRun) {
      debug.info("Dry-run enabled");
    }
  }

  async increment() {
    const increment = await Version.getIncrement();
    const cmd = `npm version ${increment} -m 'Automated Release: v%s'`;
    const branch = Version.getBranch();

    debug.info(`Bumping v${this.pkg.version} with ${increment} release...`);

    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] ${cmd}`);
    }

    if (process.env.CI) {
      const range = Version.getCommitRange();
      const commit = Version.exec(`git log -n1 --format='%an|%ae|%s' ${range}`).shift();
      const [ name, email, message ] = commit.split("|");

      debug.info(`Overriding user.name to ${name}`);
      Version.exec(`git config user.name "${name}"`);

      debug.info(`Overriding user.email to ${email}`);
      Version.exec(`git config user.email "${email}"`);
    }

    Version.exec(`git checkout ${branch}`);
    Version.exec(cmd);
  }

  async publish() {
    const cmd = "npm publish";

    if (this.pkg.private) {
      return debug.warn(`Private package! Skipping ${cmd}...`);
    }

    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] ${cmd}`);
    }

    if (process.env.CI && process.env.NPM_TOKEN) {
      debug.info("Writing NPM_TOKEN to ~/.npmrc...");
      Version.exec('echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc');
    }

    Version.exec(cmd);
  }

  async push() {
    if (process.env.CI && process.env.GH_TOKEN) {
      const { user, repo } = Version.getUserRepo();
      const token = '${GH_TOKEN}';
      const origin = `https://${user}:${token}@github.com/${user}/${repo}.git`;

      debug.info(`Explicitly setting git origin to: ${origin}`);

      Version.exec(`git remote set-url origin ${origin}`);
    }

    const cmd = "git push origin master --tags";

    if (this.options.dryRun) {
      debug.warn(`[DRY RUN] ${cmd}`);
    } else {
      Version.exec(cmd, { silent: true });
    }
  }

  async release() {
    await this.increment();
    await this.publish();
    await this.push();

    console.log(Version.exec("git status"));
    console.log(Version.exec("git diff"));
  }
}
