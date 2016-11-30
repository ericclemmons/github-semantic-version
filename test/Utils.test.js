import expect from "expect";

import Utils from "../src/Utils";

describe("validVersionBump(oldVersion, newVersion)", function() {
  it("should return true for same versions", function() {
    expect(Utils.validVersionBump("1.0.0", "1.0.0")).toBe(true);
  });

  it("should return false when new major version < old major version", function() {
    expect(Utils.validVersionBump("2.0.0", "1.0.0")).toBe(false);
  });

  it("should return false when major versions match, but new minor version < the old minor version", function() {
    expect(Utils.validVersionBump("2.1.0", "2.0.2")).toBe(false);
  });

  it("should return false when major & minor versions match, but new patch version < the old patch version", function() {
    expect(Utils.validVersionBump("2.1.1", "2.1.0")).toBe(false);
  });

  it("should return true when new major version > old major version", function() {
    expect(Utils.validVersionBump("4.0.14", "5.0.0")).toBe(true);
  });

  it("should return true when major versons match, but new minor version > the old minor version", function() {
    expect(Utils.validVersionBump("4.0.14", "4.1.0")).toBe(true);
  });

  it("should return true when major & minor versons match, but new patch version > the old patch version", function() {
    expect(Utils.validVersionBump("4.1.14", "4.1.15")).toBe(true);
  })
});
