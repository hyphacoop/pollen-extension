import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * A stable, permanent public post (owned by the Pollen team) containing a
 * single image, used as a fixture so this test doesn't depend on whatever
 * happens to be in someone's feed today.
 */
const TEST_POST_URL =
  process.env.BLUESKY_TEST_POST_URL ??
  "https://bsky.app/profile/urra.ca/post/3mw6tkb3bqk2u";

const CONTENT_SCRIPT_PATH = path.resolve(__dirname, "../dist/content.js");

test.beforeAll(() => {
  if (!fs.existsSync(CONTENT_SCRIPT_PATH)) {
    throw new Error(
      `${CONTENT_SCRIPT_PATH} not found — run "npm run build" before this test.`
    );
  }
});

test("Pollen's selectors and injection logic still match bsky.app's live DOM", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const pollenConsoleErrors: string[] = [];

  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("[Pollen]")) {
      pollenConsoleErrors.push(msg.text());
    }
  });

  await page.goto(TEST_POST_URL, { waitUntil: "load" });

  // injectClaimButtons only attaches a button to images whose CDN-URL blob
  // CID matches one of the mocked PFP blobs' cid; the mock has to use
  // the fixture post's real image CID, not a placeholder.
  const imgSrc = await page
    .locator('img[src*="cdn.bsky.app/img/feed_"]')
    .first()
    .getAttribute("src");
  const cidMatch = imgSrc?.match(/\/plain\/did:[^/]+\/([^@]+)/);
  const realCid = cidMatch?.[1];
  if (!realCid) {
    throw new Error(
      `Could not parse a blob CID out of the fixture post's image URL: ${imgSrc}`
    );
  }

  // Stub Pollen's own backend and the Bluesky profile-hydration endpoint it
  // calls, so this test isolates "did Bluesky's DOM change" from "is our
  // backend up"
  await page.route("https://nectar-api.hypha.coop/pfps**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ blobs: [{ cid: realCid, pfp: "test-pfp" }] }),
    })
  );
  await page.route("https://nectar-api.hypha.coop/search/pfps**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        matches: [
          {
            uri: "at://did:plc:test/coop.hypha.pollen.claim/test",
            pfp: "test-pfp",
            distance: 0,
            record: {
              content: { text: "Test claim" },
              createdAt: new Date().toISOString(),
              subject: {
                uri: "at://did:plc:test/app.bsky.feed.post/test",
                cid: "test-cid",
              },
            },
          },
        ],
      }),
    })
  );
  await page.route(
    "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles**",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          profiles: [
            { did: "did:plc:test", handle: "test.bsky.social", displayName: "Test" },
          ],
        }),
      })
  );

  // Inject the real built bundle as a page-world <script> tag. This is what
  // manifest.json's world: "MAIN" content script becomes at runtime, and
  // running it after "load" mirrors run_at: "document_idle".
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

  // Selectors Pollen reads directly from Bluesky's DOM.
  await expect(
    page.locator('[data-testid^="postThreadItem-by-"]').first()
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('img[src*="cdn.bsky.app/img/feed_"]').first()
  ).toBeVisible();
  await expect(page.locator('[data-testid="replyBtn"]').first()).toBeVisible();

  // Pollen's own markers. These only appear if findPostContainer,
  // findImageEmbedContainer, injectClaimBadge and injectClaimButtons all
  // ran successfully end to end against the real markup above.
  await expect(
    page.locator('[data-pollen-injected="true"]').first()
  ).toBeAttached({ timeout: 20_000 });
  await expect(page.locator(".pollen-claim-strip").first()).toBeVisible();
  await expect(page.locator(".pollen-claim-wrap").first()).toBeAttached();
  await expect(page.locator(".pollen-claim-btn").first()).toBeAttached();

  expect(pageErrors, `Uncaught errors in content.ts:\n${pageErrors.join("\n")}`).toEqual(
    []
  );
  expect(
    pollenConsoleErrors,
    `Pollen logged errors it shouldn't have (network calls were mocked to succeed):\n${pollenConsoleErrors.join(
      "\n"
    )}`
  ).toEqual([]);
});
