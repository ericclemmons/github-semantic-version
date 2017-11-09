import Github from "github";

export default class GithubAPI {
  constructor(userRepo, apiOptions = {}) {
    this.defaultOptions = {
      owner: userRepo.user,
      repo: userRepo.repo,
    };

    this.github = new Github({
      version: "3.0.0",
      ...apiOptions,
    });

    // this buys you 5000 requests an hour in all but the Search API, where you get 30 requests/min
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

    if (token) {
      this.github.authenticate({
        token: token,
        type: "oauth"
      });
    }
  }

  async getCommit(hash) {
    return new Promise((resolve, reject) => {
      this.github.repos.getCommit({ ...this.defaultOptions, sha: hash }, (err, commit) => {
        if (err) {
          return reject(err);
        }

        return resolve({
          date: commit.commit.author.date,
          sha: commit.sha,
          user: commit.author ? commit.author.login : undefined,
          userName: commit.commit.author.name,
          message: commit.commit.message,
          url: commit.html_url,
        });
      });
    });
  }

  async getPullRequest(prNumber) {
    return new Promise((resolve, reject) => {
      this.github.pullRequests.get({ ...this.defaultOptions, number: prNumber }, (err, pr) => {
        if (err) {
          return reject(err);
        }

        return resolve({
          date: pr.merged_at,
          user: pr.user.login,
          title: pr.title,
          number: pr.number,
          url: pr.html_url,
        });
      });
    });
  }

  async getIssueLabels(issueNumber) {
    return new Promise((resolve, reject) => {
      this.github.issues.getIssueLabels({ ...this.defaultOptions, number: issueNumber }, (err, labels) => {
        if (err) {
          return reject(err);
        }

        return resolve(labels);
      });
    });
  }

  // convert query object to a string in the format: searchProperty1:searchValue1 [searchPropertyN:searchValueN]
  formatSearchString(query) {
    let q = `repo:${this.defaultOptions.owner}/${this.defaultOptions.repo}`;
    for (let key in query) {
      if (query.hasOwnProperty(key)) {
        q += ` ${key}:\"${query[key]}\"`;
      }
    }

    return q.trim();
  }

  async searchIssues(query) {
    // the search string takes the format: searchProperty1:searchValue1 [searchPropertyN:searchValueN]
    const q = this.formatSearchString(query);

    return new Promise((resolve, reject) => {
      let allIssues = [];
      let _this = this;

      _this.github.search.issues({ per_page: 100, q }, function getIssues(err, issues) {
        if (err) {
          return reject(err);
        }

        allIssues = allIssues.concat(
          issues.items.map((issue) => ({
            date: issue.closed_at,
            user: issue.user.login,
            title: issue.title,
            labels: issue.labels,
            number: issue.number,
            url: issue.html_url,
          }))
        );

        if(_this.github.hasNextPage(issues)) {
          _this.github.getNextPage(issues, getIssues);
        } else {
          return resolve(allIssues);
        }
      });
    });
  }

  async getCommitsFromPullRequest(prNumber) {
    return new Promise((resolve, reject) => {
      this.github.pullRequests.getCommits({ ...this.defaultOptions, number: prNumber, per_page: 100 }, (err, commits) => {
        if (err) {
          return reject(err);
        }

        return resolve(commits.map((c) => c.sha));
      });
    });
  }

  async getCommitsFromRepo(query = {}) {
    return new Promise((resolve, reject) => {
      let allCommits = [];
      let _this = this;

      _this.github.repos.getCommits({ ...this.defaultOptions, ...query }, function getCommits(err, commits) {
        if (err) {
          return reject(err);
        }

        allCommits = allCommits.concat(
          commits.map((commit) => ({
            date: commit.commit.author.date, // some heirarchy
            sha: commit.sha,
            user: commit.author ? commit.author.login : undefined,
            userName: commit.commit.author.name,
            message: commit.commit.message,
            url: commit.html_url,
          }))
        );

        if (_this.github.hasNextPage(commits)) {
          _this.github.getNextPage(commits, getCommits);
        } else {
          return resolve(allCommits);
        }
      });
    });
  }
};
