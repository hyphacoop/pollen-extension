import { test, expect, type Page } from "@playwright/test";
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

/**
 * That same account's profile feed. Exercises the "feedItem-by-" DOM
 * branch, which is structurally different from the single-post
 * "postThreadItem-by-" view above (Bluesky renders the feed as a
 * virtualized list) and is otherwise untested.
 */
const TEST_PROFILE_URL =
  process.env.BLUESKY_TEST_PROFILE_URL ?? "https://bsky.app/profile/urra.ca";

const CONTENT_SCRIPT_PATH = path.resolve(__dirname, "../dist/content.js");

test.beforeAll(() => {
  if (!fs.existsSync(CONTENT_SCRIPT_PATH)) {
    throw new Error(
      `${CONTENT_SCRIPT_PATH} not found — run "npm run build" before this test.`
    );
  }
});

/** Collects uncaught page exceptions and Pollen's own logged errors. */
function trackErrors(page: Page) {
  const pageErrors: string[] = [];
  const pollenConsoleErrors: string[] = [];

  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("[Pollen]")) {
      pollenConsoleErrors.push(msg.text());
    }
  });

  return { pageErrors, pollenConsoleErrors };
}

function assertNoErrors(pageErrors: string[], pollenConsoleErrors: string[]) {
  expect(pageErrors, `Uncaught errors in content.ts:\n${pageErrors.join("\n")}`).toEqual(
    []
  );
  expect(
    pollenConsoleErrors,
    `Pollen logged errors it shouldn't have (network calls were mocked to succeed):\n${pollenConsoleErrors.join(
      "\n"
    )}`
  ).toEqual([]);
}

/**
 * injectClaimButtons only attaches a button to images whose CDN-URL blob
 * CID matches one of the mocked PFP blobs' cid; the mock has to use a real
 * image's CID from the page under test, not a placeholder.
 */
async function getFirstFeedImageCid(page: Page): Promise<string> {
  const imgSrc = await page
    .locator('img[src*="cdn.bsky.app/img/feed_"]')
    .first()
    .getAttribute("src");
  const cidMatch = imgSrc?.match(/\/plain\/did:[^/]+\/([^@]+)/);
  const realCid = cidMatch?.[1];
  if (!realCid) {
    throw new Error(`Could not parse a blob CID out of the image URL: ${imgSrc}`);
  }
  return realCid;
}

/**
 * Stub Pollen's own backend and the Bluesky profile-hydration endpoint it
 * calls, so these tests isolate "did Bluesky's DOM change" from "is our
 * backend up"
 */
async function mockPollenBackend(page: Page, imageCid: string): Promise<void> {
  await page.route("https://nectar-api.hypha.coop/pfps**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ blobs: [{ cid: imageCid, pfp: "test-pfp" }] }),
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
}

/**
 * Injects the real built bundle as a page-world <script> tag. This is what
 * manifest.json's world: "MAIN" content script becomes at runtime, and
 * running it after "load" mirrors run_at: "document_idle".
 */
async function injectContentScript(page: Page): Promise<void> {
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

test("Pollen still works on a single post (thread) view", async ({ page }) => {
  const { pageErrors, pollenConsoleErrors } = trackErrors(page);

  await page.goto(TEST_POST_URL, { waitUntil: "load" });
  const realCid = await getFirstFeedImageCid(page);
  await mockPollenBackend(page, realCid);
  await injectContentScript(page);

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

  assertNoErrors(pageErrors, pollenConsoleErrors);
});

test("Pollen still works on a profile feed (virtualized list) view", async ({
  page,
}) => {
  const { pageErrors, pollenConsoleErrors } = trackErrors(page);

  await page.goto(TEST_PROFILE_URL, { waitUntil: "load" });
  const realCid = await getFirstFeedImageCid(page);
  await mockPollenBackend(page, realCid);
  await injectContentScript(page);

  // The feed renders items via "feedItem-by-", a structurally different
  // branch of findPostContainer's selector than the thread view above.
  await expect(
    page.locator('[data-testid^="feedItem-by-"]').first()
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('img[src*="cdn.bsky.app/img/feed_"]').first()
  ).toBeVisible();
  await expect(page.locator('[data-testid="replyBtn"]').first()).toBeVisible();

  await expect(
    page.locator('[data-pollen-injected="true"]').first()
  ).toBeAttached({ timeout: 20_000 });
  await expect(page.locator(".pollen-claim-strip").first()).toBeVisible();
  await expect(page.locator(".pollen-claim-wrap").first()).toBeAttached();
  await expect(page.locator(".pollen-claim-btn").first()).toBeAttached();

  assertNoErrors(pageErrors, pollenConsoleErrors);
});
