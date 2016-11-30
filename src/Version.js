import chalk from "chalk";
import { find, flattenDeep, join, orderBy, reverse } from "lodash";
import fs from "fs-extra";
import Listr from "listr";
import moment from "moment";
import ora from "ora";

import * as debug from "./debug";
import Utils from "./Utils";
import GithubAPI from "./Github";

const DRY_RUN_MSG = "The --dry-run option was passed";
const NO_PUSH_MSG = "Neither --push or --publish options were passed";

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

    this.taskList = new Listr();

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
    const spinner = ora("Getting last change and determining the new version").start();
    const lastChange = await this.getLastChangeWithIncrement();
    const branch = Utils.getBranch();
    const newVersion = Utils.incrementVersion(lastChange.increment, this.config.version);
    spinner.succeed();

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

      this.taskList.add({
        skip: () => {
          if (this.options.dryRun) {
            return DRY_RUN_MSG;
          }
        },
        title: "Overriding default git user/email options",
        task: () => {
          return new Listr([
            {
              title: `Overriding user.name to ${name}`,
              task: () => Utils.exec(`git config user.name "${name}"`),
            },
            {
              title: `Overriding user.email to ${email}`,
              task: () => Utils.exec(`git config user.email "${email}"`),
            },
          ]);
        }
      });
    }

    this.taskList.add({
      skip: () => {
        if (!this.shouldPush) {
          return NO_PUSH_MSG;
        }

        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: `Checking out the ${branch} branch`,
      task: () => Utils.exec(`git checkout ${branch}`),
    });

    this.taskList.add({
      skip: () => {
        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: "Bumping the package version",
      task: () => Utils.exec(`npm version ${lastChange.increment} --no-git-tag-version`, { stdio: "ignore" }),
    });

    this.taskList.add({
      skip: () => {
        if (!this.shouldPush) {
          return NO_PUSH_MSG;
        }

        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: "Add package.json to commit list",
      task: () => Utils.exec("git add package.json"),
    });

    if (this.options.changelog) {
      let appendSuccess = true;
      try {
        this.appendChangeLog(newVersion, lastChange);
      } catch (err) {
        debug.warn("Skipping appending to CHANGELOG -- no current CHANGELOG.md found.");
        appendSuccess = false;
      }

      this.taskList.add({
        skip: () => {
          if (!appendSuccess) {
            return "Writing to the CHANGELOG failed";
          }

          if (!this.shouldPush) {
            return NO_PUSH_MSG;
          }

          if (this.options.dryRun) {
            return DRY_RUN_MSG;
          }
        },
        title: "Addding CHANGELOG.md to the commit list",
        task: () => Utils.exec("git add CHANGELOG.md"),
      });
    }

    this.taskList.add({
      skip: () => {
        if (!this.shouldPush) {
          return NO_PUSH_MSG;
        }

        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: "Committing current changes and tagging new version",
      task: () => {
        return new Listr([
          {
            title: "Committing current changes",
            task: () => Utils.exec(`git commit -m "Automated release: v${newVersion}\n\n[ci skip]"`),
          },
          {
            title: `Tagging the new version v${newVersion}`,
            task: () => Utils.exec(`git tag v${newVersion}`),
          },
        ]);
      }
    })
  }

  async publish() {
    this.taskList.add({
      skip: () => {
        if (this.config.private) {
          return "This package is marked private";
        }

        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: "Publishing to NPM",
      task: () => Utils.exec("npm publish"),
    });
  }

  async push() {
    if (process.env.CI && process.env.GH_TOKEN) {
      const { user, repo } = Utils.getUserRepo();
      const token = '${GH_TOKEN}';
      const origin = `https://${user}:${token}@github.com/${user}/${repo}.git`;

      debug.info(`Explicitly setting git origin to: ${origin}`);

      this.taskList.add({
        title: `Explicitly setting git origin to: ${origin}`,
        task: () => Utils.exec(`git remote set-url origin ${origin}`),
      });
    }

    this.taskList.add({
      skip: () => {
        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: "Pushing changes to master",
      task: () => Utils.exec("git push origin master --tags", { stdio: "ignore" }),
    });
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
    const spinner = ora("Generating the CHANGELOG contents").start();
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
        throw err;
      }

      return data;
    });

    if (!contents) {
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

    const spinner = ora("Writing out the CHANGELOG contents");

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

    this.taskList.add({
      skip: () => {
        if (this.options.dryRun) {
          return DRY_RUN_MSG;
        }
      },
      title: "Bumping package version & committing changes",
      task: () => {
        return new Listr([
          {
            title: `Checking out ${branch}`,
            task: () => Utils.exec(`git checkout ${branch}`),
          },
          {
            title: "Bumping package version",
            task: () => Utils.exec(`npm version ${version} --no-git-tag-version`, { stdio: "ignore" }),
          },
          {
            title: "Adding package.json to the commit list",
            task: () => Utils.exec("git add package.json"),
          },
          {
            title: "Adding CHANGELOG.md to the commit list",
            task: () => Utils.exec("git add CHANGELOG.md"),
          },
          {
            title: "Committing changes",
            task: () => Utils.exec(`git commit -m "Automated release: v${version}\n\n[ci skip]"`),
          },
          {
            title: "Creating a tag for the new changes",
            task: () => Utils.exec(`git tag v${version}`),
          },
        ]);
      }
    });
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

    this.taskList.run().catch(err => {
      console.error(err);
    });
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
    if (Utils.versionsInSync(this.config.version, version)) {
      console.log(`\n${chalk.bold.cyan(`HEADS UP!`)}`);
      console.log(`The current version listed in package.json is the same as the calculated version: ${chalk.bold.cyan(`${version}`)}.`);
      console.log(`Use of --push and --publish will be ignored and you'll need to manually commit and push these changes to your repo.\n`);
      this.shouldPush = false;
      this.shouldPublish = false;
    } else {
      this.taskList.add({
        skip: () => {
          if (this.options.dryRun) {
            return DRY_RUN_MSG;
          }
        },
        title: "Setting the package version",
        task: () => Utils.exec(`npm version ${version} --no-git-tag-version`, { stdio: "ignore" }),
      });
    }

    this.writeChangeLog(changeLog);

    if (this.shouldPush) {
      this.commitRefreshedChanges(version);
      await this.push();

      if (this.shouldPublish) {
        await this.publish();
      }
    }

    this.taskList.run().catch(err => {
      console.error(err);
    });
  }
};
