# github-semantic-release

> Automated semantic version releases powered by Github Issues.

[![travis build](https://img.shields.io/travis/ericclemmons/github-semantic-release.svg)](https://travis-ci.org/ericclemmons/github-semantic-release)
[![version](https://img.shields.io/npm/v/github-semantic-release.svg)](http://npm.im/ggithub-semantic-release)
[![downloads](https://img.shields.io/npm/dm/github-semantic-release.svg)](http://npm-stat.com/charts.html?package=github-semantic-release)
[![MIT License](https://img.shields.io/npm/l/github-semantic-release.svg)](http://opensource.org/licenses/MIT)

## Getting Started

### 1. Install

```shell
$ npm install --save-dev github-semantic-release
```

### 2. Add labels

```shell
$ npm install --save-dev git-labelmaker
```

[Generate a token](https://github.com/settings/tokens).

```shell
$ git-labelmaker
? What is your GitHub Access Token? <paste token here>
? What is your master password, to keep your access token secure? ************
? Welcome to git-labelmaker!
What would you like to do?
> Add Labels From Package
? What is the path & name of the package you want to use? (eg: `packages/my-label-pkg.json`) ./node_modules/github-semantic-release/labels.json
Successfully created 3 labels
```

### 3. Assign `Breaking`, `Feature`, or `Fix` to issues.



### License

> MIT License 2016 © Eric Clemmons
