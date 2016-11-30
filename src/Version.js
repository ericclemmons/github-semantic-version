import chalk from "chalk";
import { find, flattenDeep, join, orderBy, reverse } from "lodash";
import fs from "fs-extra";
import moment from "moment";
import ora from "ora";

import * as debug from "./debug";
import Utils from "./Utils";
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

    const branch = Utils.getBranch();

    // force dry-run when not on the release-branch and !this.options.init
    if (!this.options.init && branch !== this.options.branch) {
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

  // returns the PR or commit with the increment level attached
  async getLastChangeWithIncrement() {
    const pr = Utils.getLastPullRequest();

    if (!pr) {
      debug.warn(`Only commits found. Defaulting to ${Version.INCREMENT_PATCH}.`);
      const commitSHA = Utils.getLastCommit();

      // get the last commit from github
      const githubapi = new GithubAPI(Utils.getUserRepo());
      const commit = await githubapi.getCommit(commitSHA);
      commit.increment = Version.INCREMENT_PATCH;

      return commit;
    }

    return await this.getIncrementFromPullRequest(pr);
  }

  // returns a pull request with increment level noted
  async getIncrementFromPullRequest(number) {
    const githubapi = new GithubAPI(Utils.getUserRepo());
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
    const spinners = [];

    spinners.push(ora("Getting last change and determining the current version").start());
    const lastChange = await this.getLastChangeWithIncrement();
    const branch = Utils.getBranch();
    const newVersion = Utils.incrementVersion(lastChange.increment, this.config.version);
    spinners[0].succeed();

    debug.info(`Bumping v${this.config.version} with ${lastChange.increment} release...`);

    // override the git user/email based on last commit
    if (process.env.CI && !this.options.dryRun) {
      const range = Utils.getCommitRange();
      const commit = Utils.exec(`git log -n1 --format='%an|%ae|%s' ${range}`).shift();

      if (!commit) {
        debug.warn("No merge commits found between: %s", range);
        throw new Error(`No commits found in ${range}`);
      }

      const [ name, email, message ] = commit.split("|");

      debug.info(`Overriding default git user/email options`);

      Utils.exec(`git config user.name "${name}"`);
      Utils.exec(`git config user.email "${email}"`);
    }

    if (this.shouldPush && !this.options.dryRun) {
      debug.info(`Checking out the ${branch} branch`);
      Utils.exec(`git checkout ${branch}`);
    }

    if (!this.options.dryRun) {
      spinners.push(ora(`Incrementing the version in package.json with ${lastChange.increment}`).start());
      Utils.exec(`npm version ${lastChange.increment} --no-git-tag-version`, { stdio: "ignore" });
      spinners[1].succeed();
    } else {
      debug.warn(`[DRY RUN] bumping package version with ${lastChange.increment}`);
    }

    if (this.shouldPush && !this.options.dryRun) {
      debug.info(`Adding package.json to commit list`);
      Utils.exec("git add package.json");
    }

    if (this.options.changelog) {
      let appendSuccess = true;
      try {
        this.appendChangeLog(newVersion, lastChange);
      } catch (err) {
        debug.warn("Skipping appending to CHANGELOG -- no current CHANGELOG.md found.");
        appendSuccess = false;
      }

      if (appendSuccess && this.shouldPush && !this.options.dryRun) {
        debug.info(`Adding CHANGELOG.md to the commit list`);
        Utils.exec("git add CHANGELOG.md");
      }
    }

    if (this.shouldPush && !this.options.dryRun) {
      spinners.push(ora("Committing the changes and tagging a new version").start());
      debug.info(`Committing the current changes and tagging new version`);
      Utils.exec(`git commit -m "Automated release: v${newVersion}\n\n[ci skip]"`);
      Utils.exec(`git tag v${newVersion}`);
      spinners[2].succeed();
    }
  }

  async publish() {
    if (this.config.private) {
      return debug.warn(`This package is marked private -- skipping NPM publish`);
    }

    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] publishing to NPM`);
    }

    const spinner = ora("Publishing to NPM");
    Utils.exec("npm publish");
    spinner.succeed();
  }

  async push() {
    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] Pushing changes to master branch`);
    }

    const spinner = ora("Pushing changes to Github");

    if (process.env.CI && process.env.GH_TOKEN) {
      const { user, repo } = Utils.getUserRepo();
      const token = '${GH_TOKEN}';
      const origin = `https://${user}:${token}@github.com/${user}/${repo}.git`;

      debug.info(`Explicitly setting git origin to: ${origin}`);
      Utils.exec(`git remote set-url origin ${origin}`)
    }

    Utils.exec("git push origin master --tags", { stdio: "ignore" });

    spinner.succeed();
  }

  async getPullRequestCommits(prs) {
    const githubapi = new GithubAPI(Utils.getUserRepo());

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

    const githubapi = new GithubAPI(Utils.getUserRepo());
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
      version = Utils.incrementVersion(increment, version);
    });

    return version;
  }

  async getChangeLogContents() {
    const spinner = ora("Generating the changelog contents");
    const githubapi = new GithubAPI(Utils.getUserRepo());
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
      version = Utils.incrementVersion(increment, version);
      lines.push(`${Utils.getChangeLogLine(version, issue)}\n`);
      lastEventDate = currentEventDate;
    });

    lines.push(`## ${lastEventDate} - [${version} - current version]\n\n`);
    lines.push(Utils.getChangeLogHeader());

    spinner.succeed();

    return reverse(lines);
  }

  appendChangeLog(newVersion, lastChange) {
    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] appending "${Utils.getChangeLogLine(newVersion, lastChange)}" to CHANGELOG`);
    }

    const spinner = ora("Appending latest change to CHANGELOG contents").start();
    const contents = fs.readFileSync("CHANGELOG.md", "utf8", (err, data) => {
      if (err) {
        spinner.fail();
        throw err;
      }

      return data;
    });

    if (!contents) {
      spinner.fail();
      return debug.warn(`Skipping appending CHANGELOG.md -- can't find a current CHANGELOG"`);
    }

    const lines = contents.split("\n");

    let newLines = lines.slice(0,5);
    newLines.push(`## ${moment().format("YYYY-MM-DD")} - [${newVersion} - current version]`);
    newLines.push("");
    newLines.push(Utils.getChangeLogLine(newVersion, lastChange));

    // if latest change is the same date
    if(moment(lines[5].slice(3,13)).isSame(moment(),"day")) {
        newLines = newLines.concat(lines.slice(7));
    } else {
        newLines.push("");
        newLines.push(lines[5].slice(0,13));
        newLines = newLines.concat(lines.slice(6));
    }

    spinner.succeed();
    this.writeChangeLog(newLines.map((line) => `${line}\n`));
  }

  async calculateCurrentVersion() {
    const spinner = ora("Calculating the repo's current version").start();
    const allEvents = await this.getRepoTimeline();
    const version = this.getVersionFromTimeline(allEvents);
    spinner.succeed();

    return version;
  }

  writeChangeLog(lines) {
    if (this.options.dryRun) {
      debug.warn(`[DRY RUN] writing changelog`);
      return debug.warn(join(lines, ""));
    }

    const spinner = ora("Writing the contents of the changelog").start();

    fs.writeFileSync("CHANGELOG.md", join(lines, ""), { encoding: "utf8" }, (err) => {
      if (err) {
        spinner.fail();
        throw new Error("Problem writing CHANGELOG.md to file!");
      }
    });

    spinner.succeed();
  }

  commitRefreshedChanges(version) {
    const branch = Utils.getBranch();

    if (this.options.dryRun) {
      return debug.warn(`[DRY RUN] Bumping package version & committing changes`);
    }

    const spinner = ora("Committing the refreshed changes").start();

    debug.info(`git checkout ${branch}`);
    Utils.exec(`git checkout ${branch}`);
    debug.info(`npm version ${version} --no-git-tag-version`);
    Utils.exec(`npm version ${version} --no-git-tag-version`, { stdio: "ignore" });
    debug.info("git add package.json");
    Utils.exec("git add package.json");
    debug.info("git add CHANGELOG.md");
    Utils.exec("git add CHANGELOG.md");
    debug.info(`git commit -m "Automated release: v${version}\n\n[ci skip]"`);
    Utils.exec(`git commit -m "Automated release: v${version}\n\n[ci skip]"`);
    debug.info(`git tag v${version}`);
    Utils.exec(`git tag v${version}`);

    spinner.succeed();
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

    if (!Utils.validVersionBump(this.config.version, version)) {
      console.log(`\n${chalk.bold.red(`WARNING!`)}`);
      console.log(`The current version listed in package.json (${chalk.bold.cyan(`${this.config.version}`)}) is > the calculated version (${chalk.bold.cyan(`${version}`)}).`);
      console.log(`To ensure a consistent changelog, either make use of ${chalk.bold.red(`startVersion`)} in your package.json, or label existing PRs as you would expect them to affect the repo version.\n`);

      return;
    }

    // if versions are the same:
    // disallow the use of --push or --publish. this needs to be manual.
    const versionsInSync = Utils.versionsInSync(this.config.version, version);

    if (versionsInSync) {
      console.log(`\n${chalk.bold.cyan(`HEADS UP!`)}`);
      console.log(`The current version listed in package.json is the same as the calculated version: ${chalk.bold.cyan(`${version}`)}.`);
      console.log(`Use of --push and --publish will be ignored and you'll need to manually commit and push these changes to your repo.\n`);
      this.shouldPush = false;
      this.shouldPublish = false;
    }

    if (!versionsInSync) {
      if (this.options.dryRun) {
        debug.warn(`[DRY RUN] Setting the version in package.json to ${version}`);
      } else {
        debug.info(`Setting the version in package.json to ${version}`);
        const spinner = ora(`Setting the version in package.json to ${version}`).start();
        Utils.exec(`npm version ${version} --no-git-tag-version`, { stdio: "ignore" })
        spinner.succeed();
      }
    }

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
