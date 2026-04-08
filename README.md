# Pollen Browser Extension

A browser extension that surfaces image provenance claims on Bluesky, using the Nectar API.

Learn more at [nectar.hypha.coop](https://nectar.hypha.coop).

## Setup

```bash
cd extension
npm install
npm run package
```

## Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist` folder

## Load in Firefox

Follow [these instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Development

```bash
npm run watch    # Rebuild on file changes
```

After making changes, click the refresh icon on the extension card in `chrome://extensions/`.

## Usage

1. Navigate to https://bsky.app
2. Browse/scroll the feed
3. Posts with matching claims show a badge below their images
4. Click the badge to view claim details
5. Hover over a post image and click **Claim** to add your own provenance claim

## How It Works

The extension uses a content script that:

1. Observes the DOM for post links via `MutationObserver`
2. Extracts handle and post ID from URLs (`/profile/{handle}/post/{rkey}`)
3. Resolves handles to DIDs via Bluesky's public API
4. Fetches post metadata including image URLs and perceptual fingerprints (PFPs)
5. Searches for existing claims matching each image's PFP
6. Injects claim badges and per-image claim buttons into the feed
7. Writes new claim records to the user's PDS via their active session

## Dependencies

- [@atcute/client](https://github.com/mary-ext/atcute) - AT Protocol client
- [@atcute/bluesky](https://github.com/mary-ext/atcute) - Bluesky lexicon types
- [esbuild](https://esbuild.github.io/) - Bundler
