import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  GitHubManifestFlow,
  REQUIRED_GITHUB_APP_EVENTS,
  REQUIRED_GITHUB_APP_PERMISSIONS,
} from "../src/setup/github-manifest.js";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

describe("GitHub App Manifest flow", () => {
  it("binds to loopback, submits an Any-account manifest, validates state, and converts once", async () => {
    let manifest: Record<string, unknown> | undefined;
    let persistedCode: string | undefined;
    const opened: string[] = [];
    const flow = new GitHubManifestFlow(
      {
        async open(url) {
          opened.push(url);
          const start = await fetch(url);
          const body = await start.text();
          const encodedManifest = /name="manifest" value="([^"]+)"/u.exec(body)?.[1];
          assert.ok(encodedManifest);
          manifest = JSON.parse(decodeHtml(encodedManifest)) as Record<string, unknown>;
          const callback = new URL(String(manifest.redirect_url));
          callback.searchParams.set("state", "expected-state");
          callback.searchParams.set("code", "one-time-code");
          const response = await fetch(callback);
          assert.equal(response.status, 200);
        },
      },
      async (url, init) => {
        assert.equal(persistedCode, "one-time-code");
        assert.equal(String(url), "https://api.github.com/app-manifests/one-time-code/conversions");
        assert.equal(init?.method, "POST");
        return new Response(
          JSON.stringify({
            id: 7,
            slug: "revoir-test",
            pem: PRIVATE_KEY,
            webhook_secret: "github-generated-secret",
          }),
        );
      },
    );

    const result = await flow.create({
      appName: "Revoir Test",
      relayUrl: "https://relay.example.workers.dev/github/webhook",
      state: "expected-state",
      async persistConversionCode(code) {
        persistedCode = code;
      },
    });

    assert.deepEqual(result, {
      appId: 7,
      appSlug: "revoir-test",
      privateKey: PRIVATE_KEY,
      webhookSecret: "github-generated-secret",
    });
    assert.match(opened[0] ?? "", /^http:\/\/127\.0\.0\.1:\d+\/start$/u);
    assert.equal(manifest?.public, true);
    assert.deepEqual(manifest?.default_permissions, REQUIRED_GITHUB_APP_PERMISSIONS);
    assert.deepEqual(manifest?.default_events, REQUIRED_GITHUB_APP_EVENTS);
    assert.deepEqual(manifest?.hook_attributes, {
      active: true,
      url: "https://relay.example.workers.dev/github/webhook",
    });
    assert.match(String(manifest?.redirect_url), /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  });

  it("resumes a checkpointed manifest conversion without opening another registration", async () => {
    let browserOpens = 0;
    const flow = new GitHubManifestFlow(
      {
        async open() {
          browserOpens += 1;
        },
      },
      async (url) => {
        assert.equal(
          String(url),
          "https://api.github.com/app-manifests/checkpointed-code/conversions",
        );
        return Response.json({
          id: 7,
          slug: "revoir-test",
          pem: PRIVATE_KEY,
          webhook_secret: "github-generated-secret",
        });
      },
    );

    const result = await flow.create({
      appName: "Revoir Test",
      conversionCode: "checkpointed-code",
      relayUrl: "https://relay.example.workers.dev/github/webhook",
      state: "expected-state",
    });

    assert.equal(browserOpens, 0);
    assert.equal(result.appId, 7);
  });

  it("rejects a callback with the wrong state before conversion", async () => {
    let conversions = 0;
    const flow = new GitHubManifestFlow(
      {
        async open(url) {
          const callback = new URL(url);
          callback.pathname = "/callback";
          callback.searchParams.set("state", "attacker-state");
          callback.searchParams.set("code", "stolen-code");
          assert.equal((await fetch(callback)).status, 400);
        },
      },
      async () => {
        conversions += 1;
        return new Response("{}");
      },
    );

    await assert.rejects(
      flow.create({
        appName: "Revoir Test",
        relayUrl: "https://relay.example.workers.dev/github/webhook",
        state: "expected-state",
      }),
      /state did not match/u,
    );
    assert.equal(conversions, 0);
  });

  it("expires an unapproved browser flow without attempting conversion", async () => {
    let conversions = 0;
    const flow = new GitHubManifestFlow(
      { async open() {} },
      async () => {
        conversions += 1;
        return new Response("{}");
      },
      5,
    );

    await assert.rejects(
      flow.create({
        appName: "Revoir Test",
        relayUrl: "https://relay.example.workers.dev/github/webhook",
        state: "expected-state",
      }),
      /browser approval expired/u,
    );
    assert.equal(conversions, 0);
  });
});
