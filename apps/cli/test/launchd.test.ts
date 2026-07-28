import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLaunchAgentDefinition, renderLaunchAgentPlist } from "../src/service/launchd.js";

describe("launchd service definition", () => {
  it("renders one deterministic per-user LaunchAgent with escaped XDG paths and bounded restarts", () => {
    const definition = createLaunchAgentDefinition({
      executableArguments: ["/Users/test & tools/.local/bin/revoir"],
      configFile: "/Users/test & tools/.config/revoir/config.json",
      homeDir: "/Users/test & tools",
      paths: {
        configDir: "/Users/test & tools/.config/revoir",
        configFile: "/Users/test & tools/.config/revoir/config.json",
        cacheDir: "/Users/test & tools/.cache/revoir",
        stateDir: "/Users/test & tools/.local/state/revoir",
        dataDir: "/Users/test & tools/.local/share/revoir",
      },
    });

    const plist = renderLaunchAgentPlist(definition);

    assert.equal(plist, renderLaunchAgentPlist(definition));
    assert.deepEqual(definition.programArguments, [
      "/Users/test & tools/.local/bin/revoir",
      "run",
      "--config",
      "/Users/test & tools/.config/revoir/config.json",
    ]);
    assert.deepEqual(definition.environment, {
      HOME: "/Users/test & tools",
      XDG_CACHE_HOME: "/Users/test & tools/.cache",
      XDG_CONFIG_HOME: "/Users/test & tools/.config",
      XDG_DATA_HOME: "/Users/test & tools/.local/share",
      XDG_STATE_HOME: "/Users/test & tools/.local/state",
    });
    assert.match(plist, /<string>\/Users\/test &amp; tools\/\.local\/bin\/revoir<\/string>/u);
    assert.match(plist, /<key>Crashed<\/key>\s*<true\/>/u);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/u);
    assert.match(
      plist,
      /<key>StandardOutPath<\/key>\s*<string>\/Users\/test &amp; tools\/\.local\/state\/revoir\/logs\/launchd\.stdout\.log<\/string>/u,
    );
    assert.match(
      plist,
      /<key>StandardErrorPath<\/key>\s*<string>\/Users\/test &amp; tools\/\.local\/state\/revoir\/logs\/launchd\.stderr\.log<\/string>/u,
    );
  });
});
