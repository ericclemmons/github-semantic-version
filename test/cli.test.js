import expect from "expect";
import Version from "../src/Version";

describe("cli", function() {
  context("when given --dry-run", function() {
    it("should run", function() {
      this.timeout(5000);

      const output = Version.exec("babel-node src/cli --dry-run");

      expect(output).toExist();
    });
  });
});
