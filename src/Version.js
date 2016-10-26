import { EOL } from "os";
import { execSync } from "child_process";
import { find, first, flattenDeep, join, orderBy, reverse } from "lodash";
import fs from "fs-extra";
import moment from "moment";
import objectPath from "object-path";
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

  static getStartVersion() {
    try {
      var pkgPath = path.resolve(process.cwd(), './package.json');
      const startVersion = fs.readJsonSync(pkgPath).startVersion;

      if (startVersion) {
        return startVersion;
      }
    }
    catch (err) {}

    return "0.0.0";
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
    const githubapi = new GithubAPI(Version.getUserRepo());
    const labels = await githubapi.getIssueLabels(number);
    if (!labels) {
      debug.warn(`No labels found on PR #${number}. Defaulting to ${Version.INCREMENT_PATCH}.`);
      return Version.INCREMENT_PATCH;
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
      return increment;
    }

    debug.warn(`No "Version:" labels found on PR #${number}. Defaulting to ${Version.INCREMENT_PATCH}.`);

    return Version.INCREMENT_PATCH;
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

  constructor(pkg, options) {
    this.pkg = pkg;
    this.options = {
      ...Version.defaultOptions,
      ...options,
    };

    const branch = Version.getBranch();

    // force dry-run when not on the release-branch
    if (branch !== this.options.branch) {
      this.options.dryRun = true;
    }

    debug.info("Current branch: %s", branch);
    debug.info("Release branch: %s", this.options.branch);

    if (this.options.dryRun) {
      debug.info("Dry-run enabled");
    }
  }

  async increment() {
    const increment = await Version.getIncrement();
    const cmd = `npm version ${increment} -m "Automated release: v%s\n\n[ci skip]"`;
    const branch = Version.getBranch();
    console.log(increment);

    debug.info(`Bumping v${this.pkg.version} with ${increment} release...`);

    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] ${cmd}`);
    }

    if (process.env.CI) {
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
      Version.exec(cmd, { stdio: "ignore" });
    }
  }

  // TODO: rename this
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

    // TODO: would be better if we could send concurrent requests here
    const prCommits = prs.map(async (pr) => {
      const commits = await githubapi.getCommitsFromPullRequest(pr.number);

      return [ ...commits ];
    });

    return Promise.all(prCommits);
  }

  async getRepoTimeline() {
    const githubapi = new GithubAPI(Version.getUserRepo());
    debug.info(`Fetching all merged pull requests for the repo...`);
    const allIssues = await githubapi.searchIssues({ state: "closed", type: "pr", is: "merged" });
    debug.info(`Pull requests fetched: ${allIssues.length}`);
    debug.info(`Fetching all commits for the repo...`);
    const allCommits = await githubapi.getCommitsFromRepo();
    debug.info(`Commits fetched: ${allCommits.length}`);

    // populate the commits for each pull request
    debug.info(`Fetching the commits associated with the pull requests.`)
    const allPRCommits = flattenDeep(await this.getPullRequestCommits(allIssues));
    debug.info(`Commits fetched: ${allPRCommits.length}`);

    // get a list of commits not part of any pull requests
    // and not in the form of "Merge pull request #"
    const independentCommits = allCommits
      .filter((commit) => !commit.message.match(/^Merge pull request #/)) // fragile?
      .filter((commit) => !commit.message.match(/^Automated Release: v/))
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

    // console.log(theTimeline);

    return theTimeline;
  }

  getChangeLogLine(version, issue) {
    const versionNumber = `[${version[0]}.${version[1]}.${version[2]}]`;
    const issueNumber = issue.number ? `[${issue.number}]` : `[${issue.sha.slice(0,7)}]`;
    const issueUrl = `(${issue.url})`;
    const title = `${issue.title ? issue.title : issue.message.replace(/\n/g, " ")}`;
    const user = issue.user ? `(@${issue.user})` : `(${issue.userName})`;

    return `- ${versionNumber} - (${issueNumber}${issueUrl}) - ${title} ${user}\n`;
  }

  async getChangeLogContents() {
    const githubapi = new GithubAPI(Version.getUserRepo());
    const allEvents = await this.getRepoTimeline();

    const lines = [];
    let version = Version.getStartVersion().split(".").map((v) => Number(v));
    let lastEventDate = moment(allEvents[0].date).format("YYYY-MM-DD");

    allEvents.forEach((issue) => {
      const currentEventDate = moment(issue.date).format("YYYY-MM-DD");

      if (currentEventDate !== lastEventDate) {
        lines.push(`\n## ${lastEventDate}\n\n`);
      }

      // commits won't have labels property
      const increment = issue.labels ? issue.labels
        .map((label) => label.name)
        .filter((name) => name.match(/^Version:/))
        .map((name) => name.split("Version: ").pop().toLowerCase())
        .shift()
        : undefined;
      ;

      if (increment) {
        if (increment === "major") {
          version[0] += 1;
          version[1] = 0;
          version[2] = 0;
        } else if (increment === "minor") {
          version[1] += 1;
          version[2] = 0;
        } else if (increment === "patch") {
          version[2] += 1;
        }
      } else {
        // no label match, assume patch
        version[2] += 1;
      }

      lines.push(this.getChangeLogLine(version, issue));

      lastEventDate = currentEventDate;
    });

    lines.push(`## ${lastEventDate} - [${version[0]}.${version[1]}.${version[2]} - current version]\n\n`);

    lines.push(Version.getChangeLogHeader());

    return reverse(lines);
  }

  static writeChangeLog(lines) {
    fs.writeFileSync("CHANGELOG.md", join(lines, ""), { encoding: "utf8" }, (err) => {
      if (err) {
        throw new Error("Problem writing CHANGELOG.md to file!");
      }
    });
  }

  // TODO: refactor ?
  // TODO: get rid of the date from the sorting... that's taken care of in the search now... or is it?
  async calculateCurrentVersion() {
    debug.info(`NPM VERSION: ${Version.getStartVersion()}`)
    const githubapi = new GithubAPI(Version.getUserRepo());

    let lastFoundPR;
    const queryBase = { state: "closed", type: "pr", is: "merged" };
    const queryMajor = { ...queryBase, label: "Version: Major" };

    const majorIssues = await githubapi.searchIssues(queryMajor);
    const major = Version.sortItems(majorIssues);
    lastFoundPR = first(major);
    const lastMajorDate = objectPath.get(lastFoundPR, "date");

    const queryMinor = { ...queryBase, label: "Version: Minor" };
    if (lastMajorDate) {
      queryMinor.closed = `>${lastMajorDate}`;
    }

    const minorIssues = await githubapi.searchIssues(queryMinor);
    const minor = Version.sortItems(minorIssues, lastMajorDate);
    lastFoundPR = first(minor) || lastFoundPR;
    const lastMinorDate = objectPath.get(first(minor), "date") || lastMajorDate;

    const queryPatch = { ...queryBase };
    if (lastMinorDate) {
      queryPatch.closed = `>${lastMinorDate}`;
    }

    const patchIssues = await githubapi.searchIssues(queryPatch);
    const patch = Version.sortItems(patchIssues, lastMinorDate);
    lastFoundPR = first(patch) || lastFoundPR;

    // TODO: should get the commits after the last MINOR PR, not PATCH PR.
    const queryCommits = {};
    if (lastFoundPR) {
      queryCommits.since = lastFoundPR.date;
    }

    const commits = await githubapi.getCommitsFromRepo(queryCommits);

    // shouldn't have to do this. since should only return commits AFTER that date...
    const filteredCommits = commits
      .filter((commit) => moment(commit.date).isAfter(moment(queryCommits.since)))
      .filter((commit) => !commit.message.match(/^Automated Release:/))
    ;

    console.log(`${major.length}.${minor.length}.${patch.length + filteredCommits.length}`);

    return `${major.length}.${minor.length}.${patch.length + filteredCommits.length}`;
  }

  async release() {
    await this.increment();
    // await this.push();
  }
};

// TODO: custom labels
