import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("the public API", () => {
  it("is what 0.1.1 exported, and nothing internal", () => {
    // Adding to this list is a decision: whatever is exported is covered by semver.
    expect(Object.keys(api).sort()).toEqual(
      [
        "ALL_RULES",
        "DEFAULT_SESSION",
        "DEFAULT_UPSTREAMS",
        "RULE_IDS",
        "VERSION",
        "apiKindOf",
        "appendExchange",
        "contextOf",
        "estimateTokens",
        "extract",
        "lintExchanges",
        "parseSse",
        "readSession",
        "renderFindings",
        "renderReport",
        "renderSummary",
        "sectionTotals",
        "startProxy",
        "stripCredentials",
        "summarize",
        "toJson",
        "turnsOf",
      ].sort(),
    );
  });
});
