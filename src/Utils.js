import { EOL } from "os";
import { execSync } from "child_process";
import fs from "fs-extra";
import { join } from "lodash";
import path from "path";
import semver from "semver";

import * as debug from "./debug";

export default class Utils {
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
      Utils.getLatestTag() || Utils.getInitialCommit(),
      "HEAD"
    ].join("..");
  }

  static getInitialCommit() {
    return Utils.exec("git log --format=%h --max-parents=0 HEAD")
      .filter(Boolean)
      .pop()
    ;
  }

  static getLastCommit() {
    return Utils.exec("git log -1 --format=%h HEAD")
      .filter(Boolean)
      .pop()
    ;
  }

  static getLastPullRequest() {
    const range = Utils.getCommitRange();

    // Merge commits
    let commits = Utils.exec(`git log --merges -n1 --format='%an|%ae|%s' ${range}`);

    if (!commits.length) {
      debug.warn("No merge commits found between: %s", range);
      debug.info("Checking for squash commits.");
    }

    // Squash commits
    commits = Utils.exec(`git log --format='%an|%ae|%s' ${range}`);

    if (!commits.length) {
      debug.warn("No squash commits found between: %s", range);
      return null;
    }

    // Parse and detect
    let pr;

    try {
      commits.some((commit) => {
        const [ name, email, message ] = commit.split("|");

        if (!message) {
          throw new Error(`Could not parse name, email, & message from: ${commit}`);
        }

        const match = message.match(/^Merge pull request #(\d+)|\(#(\d+)\)$/) || [];

        // 2 = squash, 1 = merge
        pr = match[2] || match[1];

        return !!pr;
      });
    } catch (error) {
      return debug.error(error.message);
    }

    return pr;
  }

  static getLatestTag() {
    const tag = Utils.exec("git fetch --tags && git tag -l v*")
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
    const [ user, repo ] = Utils.exec("git config --get remote.origin.url")
      .shift()
      .replace(".git", "")
      .split(/\/|:/)
      .slice(-2)
    ;

    debug.info("User: %s", user);
    debug.info("Repo: %s", repo);

    return { user, repo };
  }

  static getChangeLogHeader() {
    const headerLines = [];

    headerLines.push("# Change Log\n");
    headerLines.push("All notable changes to this project will be documented in this file.\n\n");
    headerLines.push("This project adheres to [Semantic Versioning](http://semver.org/).\n\n");

    return join(headerLines,"");
  }

  static getChangeLogLine(version, issue) {
    const issueNumber = issue.number ? `[${issue.number}]` : `[${issue.sha.slice(0,7)}]`;
    const issueUrl = `(${issue.url})`;
    const title = `${issue.title ? issue.title : issue.message.replace(/\n/g, " ")}`;
    const user = issue.user ? `(@${issue.user})` : `(${issue.userName})`;

    return `- ${version} - (${issueNumber}${issueUrl}) - ${title} ${user}`;
  }

  static incrementVersion(increment, version) {
    const inc = increment || "patch";

    return semver.inc(version, inc);
  }

  static validVersionBump(oldVersion, newVersion) {
    return semver.gte(newVersion, oldVersion);
  }

  static versionsInSync(oldVersion, newVersion) {
    return semver.eq(newVersion, oldVersion);
  }

  static getOptionsFromFile(configFilePath) {
    if (configFilePath) {
      try {
        const filePath = path.resolve(process.cwd(), configFilePath);
        return fs.readJsonSync(filePath);
      } catch (err) {}
    }
  }
}
