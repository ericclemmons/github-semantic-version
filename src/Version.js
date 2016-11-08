import { EOL } from "os";
import { execSync } from "child_process";
import { find, flattenDeep, join, orderBy, reverse } from "lodash";
import fs from "fs-extra";
import moment from "moment";
import path from "path";
import * as debug from "./debug";

import GithubAPI from "./Github";

export default class Version {
  static defaultOptions = {
    branch: "master",
  }

  static INCREMENT_MAJOR = "major";
  static INCREMENT_MINOR = "minor";
  static INCREMENT_PATCH = "patch";

  constructor(config, options) {
    this.config = config;
    this.options = {
      ...Version.defaultOptions,
      ...options,
    };

    this.incrementMap = {
      [this.config["major-label"]]: Version.INCREMENT_MAJOR,
      [this.config["minor-label"]]: Version.INCREMENT_MINOR,
      [this.config["patch-label"]]: Version.INCREMENT_PATCH,
    };

    const branch = Version.getBranch();

    // force dry-run when not on the release-branch
    if (branch !== this.options.branch) {
      this.options.dryRun = true;
    }

    debug.info("Current branch: %s", branch);
    debug.info("Release branch: %s", this.options.branch);

    this.shouldPush = (this.options.push || this.options.publish);
    this.shouldPublish = this.options.publish;

    if (this.options.dryRun) {
      debug.info("Dry-run enabled");
    }

    if (this.shouldPush) {
      debug.info("Version updates will be pushed to the repo");
    }

    if (this.shouldPublish) {
      debug.info("Version updates will be published to NPM")
    }
  }

  static exec(cmd, options = {}) {
    debug.info(`Executing: ${cmd}`);

    // Execute command, split lines, & trim empty ones
    const output = execSync(cmd, {
      env: process.env,
      ...options,
    });

    return (output || "")
      .toString()
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

  static getInitialCommit() {
    return Version.exec("git log --format=%h --max-parents=0 HEAD")
      .filter(Boolean)
      .pop()
    ;
  }

  static getLastCommit() {
    return Version.exec("git log -1 --format=%h HEAD")
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
      debug.warn("No tags found");
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

  // returns the PR or commit with the increment level attached
  async getLastChangeWithIncrement() {
    const pr = Version.getLastPullRequest();

    if (!pr) {
      debug.warn(`Only commits found. Defaulting to ${Version.INCREMENT_PATCH}.`);
      const commitSHA = Version.getLastCommit();

      // get the last commit from github
      const githubapi = new GithubAPI(Version.getUserRepo());
      const commit = await githubapi.getCommit(commitSHA);
      commit.increment = Version.INCREMENT_PATCH;

      return commit;
    }

    return await this.getIncrementFromPullRequest(pr);
  }

  // returns a pull request with increment level noted
  async getIncrementFromPullRequest(number) {
    const githubapi = new GithubAPI(Version.getUserRepo());
    const prDetails = await githubapi.getPullRequest(number);
    prDetails.labels = await githubapi.getIssueLabels(number);

    if (!prDetails.labels) {
      debug.warn(`No labels found on PR #${number}. Defaulting to ${Version.INCREMENT_PATCH}.`);
      prDetails.increment = Version.INCREMENT_PATCH;

      return prDetails;
    }

    const increment = this.getIncrementFromIssueLabels(prDetails);

    if (increment) {
      debug.info(`Found ${increment} label on PR #${number}.`);
      prDetails.increment = increment;

      return prDetails;
    }

    debug.warn(`No labels found on PR #${number}. Defaulting to ${Version.INCREMENT_PATCH}.`);
    prDetails.increment = Version.INCREMENT_PATCH;

    return prDetails;
  }

  async increment() {
    const lastChange = await this.getLastChangeWithIncrement();
    const cmd = `npm version ${lastChange.increment} --no-git-tag-version`;
    const branch = Version.getBranch();
    const newVersion = Version.incrementVersion(lastChange.increment, this.config.version);

    debug.info(`Bumping v${this.config.version} with ${lastChange.increment} release...`);

    // override the git user/email based on last commit
    if (process.env.CI && !this.options.dryRun) {
      const range = Version.getCommitRange();
      const commit = Version.exec(`git log -n1 --format='%an|%ae|%s' ${range}`);

      if (!commit) {
        throw new Error(`No commits found in ${range}`);
      }

      const [ name, email, message ] = commit.split("|");

      debug.info(`Overriding user.name to ${name}`);
      Version.exec(`git config user.name "${name}"`);

      debug.info(`Overriding user.email to ${email}`);
      Version.exec(`git config user.email "${email}"`);
    }

    if (this.shouldPush && !this.options.dryRun) {
      Version.exec(`git checkout ${branch}`);
    }

    if (!this.options.dryRun) {
      Version.exec(cmd, { stdio: "ignore" });
    } else {
      debug.warn(`[DRY RUN] Executing ${cmd}`);
    }

    if (this.shouldPush && !this.options.dryRun) {
      Version.exec("git add package.json");
    }

    if (this.options.changelog) {
      this.appendChangeLog(newVersion, lastChange);

      if (this.shouldPush && !this.options.dryRun) {
        Version.exec("git add CHANGELOG.md");
      }
    }

    if (this.shouldPush && !this.options.dryRun) {
      Version.exec(`git commit -m "Automated release: v${newVersion}\n\n[ci skip]"`);
      Version.exec(`git tag v${newVersion}`);
    }
  }

  async publish() {
    const cmd = "npm publish";

    if (this.config.private) {
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
      debug.warn(`[DRY RUN] Executing ${cmd}`);
    } else {
      Version.exec(cmd, { stdio: "ignore" });
    }
  }

  static sortItems(issues, afterDate, sortBy = "date", direction = "desc") {
    if (!issues) {
      return [];
    }

    const sorted = orderBy(
      issues
        .filter((pr) => afterDate ? (moment(pr.closed_at).isAfter(moment(afterDate))) : true)
      ,
      [sortBy], // sortBy
      [direction], // direction
    )

    return sorted;
  }

  static getChangeLogHeader() {
    const headerLines = [];

    headerLines.push("# Change Log\n");
    headerLines.push("All notable changes to this project will be documented in this file.\n\n");
    headerLines.push("This project adheres to [Semantic Versioning](http://semver.org/).\n\n");

    return join(headerLines,"");
  }

  async getPullRequestCommits(prs) {
    const githubapi = new GithubAPI(Version.getUserRepo());

    const prCommits = prs.map(async (pr) => {
      const commits = await githubapi.getCommitsFromPullRequest(pr.number);

      return [ ...commits ];
    });

    return Promise.all(prCommits);
  }

  async getRepoTimeline() {
    if (this.timeline) {
      return this.timeline;
    }

    const githubapi = new GithubAPI(Version.getUserRepo());
    debug.info(`Fetching all merged pull requests for the repo...`);
    const allIssues = await githubapi.searchIssues({ state: "closed", type: "pr", is: "merged" });
    debug.info(`Merged pull requests fetched: ${allIssues.length}`);
    debug.info(`Fetching all commits for the repo (yep, ALL commits)...`);
    const allCommits = await githubapi.getCommitsFromRepo();
    debug.info(`Commits fetched: ${allCommits.length}`);

    // populate the commits for each pull request
    debug.info(`Fetching the commits associated with the pull requests.`)
    const allPRCommits = flattenDeep(await this.getPullRequestCommits(allIssues));
    debug.info(`Commits (attached to PRs) fetched: ${allPRCommits.length}`);

    // get a list of commits not part of any pull requests
    // and not in the form of "Merge pull request #"
    // and not part of any automatic release
    const independentCommits = allCommits
      .filter((commit) => !commit.message.match(/^Merge pull request #/))
      .filter((commit) => !commit.message.match(/^Automated Release: v/i))
      .filter((commit) => !commit.message.match(/\[ci skip\]/))
      .filter((commit) => !commit.message.match(/\[skip ci\]/))
      .filter((commit) => !find(allPRCommits, (prc) => prc === commit.sha)
    );

    const theTimeline = orderBy(
      [
        ...allIssues,
        ...independentCommits
      ],
      ['date'],
      ['asc'],
    );

    this.timeline = theTimeline;

    return theTimeline;
  }

  static incrementVersion(increment, version) {
    if (typeof version === "string") {
        version = version.split(".").map((v) => Number(v));
    }

    switch(increment) {
      case "major":
        return [ version[0] + 1, 0, 0 ].join(".");
      case "minor":
        return [ version[0], version[1] + 1, 0 ].join(".");
      default:
        return [ version[0], version[1], version[2] + 1 ].join(".");
    }
  }

  getIncrementFromIssueLabels(issue) {
    const regex = new RegExp(`^${this.config["major-label"]}|^${this.config["minor-label"]}|^${this.config["patch-label"]}`);
    // commits won't have labels property
    return issue.labels ? issue.labels
      .map((label) => label.name)
      .filter((name) => name.match(regex))
      .map((increment) => this.incrementMap[increment])
      .shift()
      : undefined;
    ;
  }

  // not static because we need the config option passed into the constructor
  getVersionFromTimeline(timeline) {
    let version = this.config.startVersion || "0.0.0";

    timeline.forEach((event) => {
      const increment = this.getIncrementFromIssueLabels(event);
      version = Version.incrementVersion(increment, version);
    });

    return version;
  }

  static getChangeLogLine(version, issue) {
    const issueNumber = issue.number ? `[${issue.number}]` : `[${issue.sha.slice(0,7)}]`;
    const issueUrl = `(${issue.url})`;
    const title = `${issue.title ? issue.title : issue.message.replace(/\n/g, " ")}`;
    const user = issue.user ? `(@${issue.user})` : `(${issue.userName})`;

    return `- ${version} - (${issueNumber}${issueUrl}) - ${title} ${user}`;
  }

  async getChangeLogContents() {
    const githubapi = new GithubAPI(Version.getUserRepo());
    const allEvents = await this.getRepoTimeline();

    const lines = [];
    let version = this.config.startVersion || "0.0.0";
    let lastEventDate = moment(allEvents[0].date).format("YYYY-MM-DD");

    allEvents.forEach((issue) => {
      const currentEventDate = moment(issue.date).format("YYYY-MM-DD");

      if (currentEventDate !== lastEventDate) {
        lines.push(`\n## ${lastEventDate}\n\n`);
      }

      const increment = this.getIncrementFromIssueLabels(issue);

      version = Version.incrementVersion(increment, version);

      lines.push(`${Version.getChangeLogLine(version, issue)}\n`);

      lastEventDate = currentEventDate;
    });

    lines.push(`## ${lastEventDate} - [${version} - current version]\n\n`);

    lines.push(Version.getChangeLogHeader());

    return reverse(lines);
  }

  appendChangeLog(newVersion, lastChange) {
    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] appending "${Version.getChangeLogLine(newVersion, lastChange)}" to CHANGELOG`);
    }

    const contents = fs.readFileSync("CHANGELOG.md", "utf8", (err, data) => {
      if (err) {
        debug.warn("Skipping appending CHANGELOG.md -- can't find a current CHANGELOG");
      }

      return data;
    });

    const lines = contents.split("\n");

    let newLines = lines.slice(0,5);
    newLines.push(`## ${moment().format("YYYY-MM-DD")} - [${newVersion} - current version]`);
    newLines.push("");
    newLines.push(Version.getChangeLogLine(newVersion, lastChange));

    // if latest change is the same date
    if(moment(lines[5].slice(3,13)).isSame(moment(),"day")) {
        newLines = newLines.concat(lines.slice(7));
    } else {
        newLines.push("");
        newLines.push(lines[5].slice(0,13));
        newLines = newLines.concat(lines.slice(6));
    }

    this.writeChangeLog(newLines.map((line) => `${line}\n`));
  }

  async calculateCurrentVersion() {
    const allEvents = await this.getRepoTimeline();

    return this.getVersionFromTimeline(allEvents);
  }

  writeChangeLog(lines) {
    if (this.options.dryRun) {
      debug.warn(`[DRY RUN] writing changelog`);
      return debug.warn(join(lines, ""));
    }

    fs.writeFileSync("CHANGELOG.md", join(lines, ""), { encoding: "utf8" }, (err) => {
      if (err) {
        throw new Error("Problem writing CHANGELOG.md to file!");
      }
    });
  }

  commitRefreshedChanges(version) {
    const cmd = `npm version ${version} --no-git-tag-version`;

    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] Executing ${cmd}`);
    }

    const branch = Version.getBranch();

    Version.exec(`git checkout ${branch}`);
    Version.exec(cmd, { stdio: "ignore" });
    Version.exec("git add package.json");
    Version.exec("git add CHANGELOG.md");

    Version.exec(`git commit -m "Automated release: v${version}\n\n[ci skip]"`);
    Version.exec(`git tag v${version}`);
  }

  // meant to be used after a successful CI build.
  async release() {
    await this.increment();

    if (this.shouldPush) {
      await this.push();

      if (this.shouldPublish) {
        await this.publish();
      }
    }
  }

  // meant to be used as a one off refresh of the changelog generation and version calculation
  async refresh() {
    const version = await this.calculateCurrentVersion();
    const changeLog = await this.getChangeLogContents();

    this.writeChangeLog(changeLog);

    if (this.shouldPush) {
      this.commitRefreshedChanges(version);
      await this.push();

      if (this.shouldPublish) {
        await this.publish();
      }
    }
  }
};
