import debug from "debug";

export const error = debug("github-semantic-version:error");
error.log = console.error.bind(console);

export const info = debug("github-semantic-version:info");
info.log = console.info.bind(console);

export const log = debug("github-semantic-version:log");
log.log = console.log.bind(console);

export const warn = debug("github-semantic-version:warn");
warn.log = console.warn.bind(console);
