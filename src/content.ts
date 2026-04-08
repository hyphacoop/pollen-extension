import "./content.css";
import "./modal.css";
import { getActiveSession, createClaimRecord } from "./auth";
import { showClaimModal } from "./modal";
import {
  fetchPfps,
  fetchRecordCid,
  fetchProfiles,
  searchClaims,
  didFromAtUri,
  type SearchMatch,
  type PfpBlob,
  type ProfileInfo,
} from "./api";

// Track posts we've already processed to avoid duplicate API calls
const processedPosts = new Set<string>();

// Cache post info so re-virtualized posts can get badges without re-fetching
const postInfoCache = new Map<string, PostInfo | null>();

// Cache claim matches per post key, grouped by image
const claimMatchCache = new Map<string, ImageMatches[]>();

// Regex to extract handle and rkey from Bluesky post URLs
const POST_URL_REGEX = /\/profile\/([^/]+)\/post\/([a-zA-Z0-9]+)/;

interface PostInfo {
  atUri: string;
  handle: string;
  rkey: string;
  pfpBlobs: PfpBlob[];
}

interface ImageMatches {
  thumbnailUrl: string | null; // feed image CDN URL (null if image not in DOM)
  matches: SearchMatch[];
}

/**
 * Parse a Bluesky CDN image URL to extract the DID and blob CID.
 */
function parseCdnUrl(url: string): { did: string; cid: string } | null {
  const match = url.match(/cdn\.bsky\.app\/img\/[^/]+\/plain\/(did:[^/]+)\/([^@]+)/);
  return match ? { did: match[1], cid: match[2] } : null;
}


/**
 * Walk up from a post link to find the post container element.
 */
function findPostContainer(link: HTMLAnchorElement): HTMLElement | null {
  // Try data-testid first (feed items and thread items)
  const testIdContainer = link.closest(
    '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]'
  ) as HTMLElement | null;
  if (testIdContainer) return testIdContainer;

  // Fallback: walk up max 20 levels looking for an ancestor that contains feed images
  let el: HTMLElement | null = link;
  for (let i = 0; i < 20 && el; i++) {
    el = el.parentElement;
    if (
      el &&
      el.querySelector('img[src*="cdn.bsky.app/img/feed_"]')
    ) {
      return el;
    }
  }

  return null;
}

/**
 * Find the image embed container within a post container.
 * Returns the smallest ancestor that contains ALL feed images.
 */
function findImageEmbedContainer(
  postContainer: HTMLElement
): HTMLElement | null {
  const feedImages = postContainer.querySelectorAll(
    'img[src*="cdn.bsky.app/img/feed_"]'
  );
  if (feedImages.length === 0) return null;

  if (feedImages.length === 1) {
    // Walk up from the single image to find a reasonable container
    let el: HTMLElement | null = feedImages[0] as HTMLElement;
    for (let i = 0; i < 5 && el && el !== postContainer; i++) {
      el = el.parentElement;
    }
    return el && el !== postContainer ? el : (feedImages[0].parentElement as HTMLElement);
  }

  // Multiple images: find the smallest common ancestor
  let ancestor: HTMLElement | null = feedImages[0].parentElement as HTMLElement;
  while (ancestor && ancestor !== postContainer) {
    let containsAll = true;
    for (const img of feedImages) {
      if (!ancestor.contains(img)) {
        containsAll = false;
        break;
      }
    }
    if (containsAll) return ancestor;
    ancestor = ancestor.parentElement;
  }

  return postContainer;
}

/**
 * Format a relative time string from an ISO date.
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Convert an AT URI (at://did/app.bsky.feed.post/rkey) to a bsky.app post URL.
 */
function atUriToPostUrl(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9]+)/);
  return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : null;
}

/**
 * Truncate a DID for display (e.g. "did:plc:abc123..." → "did:plc:abc1...")
 */
function truncateDid(did: string): string {
  if (did.length > 20) return did.substring(0, 20) + "...";
  return did;
}

/**
 * Create a claim card element for a single match.
 * Returns the card and a callback to update it once profile info is available.
 */
function createClaimCard(
  match: SearchMatch,
  postAtUri: string | null
): { card: HTMLElement; updateProfile: (profile: ProfileInfo) => void } {
  const card = document.createElement("div");
  card.className = "pollen-drawer-card";

  // Author row
  const authorRow = document.createElement("div");
  authorRow.className = "pollen-drawer-author";

  const did = didFromAtUri(match.uri);
  const profileUrl = `https://bsky.app/profile/${did}`;

  const avatarLink = document.createElement("a");
  avatarLink.className = "pollen-drawer-avatar";
  avatarLink.href = profileUrl;
  avatarLink.target = "_blank";
  avatarLink.rel = "noopener";

  const handleLink = document.createElement("a");
  handleLink.className = "pollen-drawer-handle";
  handleLink.href = profileUrl;
  handleLink.target = "_blank";
  handleLink.rel = "noopener";
  handleLink.textContent = truncateDid(did);

  authorRow.appendChild(avatarLink);
  authorRow.appendChild(handleLink);
  card.appendChild(authorRow);

  // Claim text
  const text = match.record?.content?.text;
  if (text) {
    const textEl = document.createElement("div");
    textEl.className = "pollen-drawer-text";
    textEl.textContent = text;
    card.appendChild(textEl);
  }

  // Footer row
  const footer = document.createElement("div");
  footer.className = "pollen-drawer-footer";

  const createdAt = match.record?.createdAt;
  if (createdAt) {
    const timeEl = document.createElement("span");
    timeEl.className = "pollen-drawer-time";
    timeEl.textContent = relativeTime(createdAt);
    footer.appendChild(timeEl);
  }

  const subjectUri = match.record?.subject?.uri;
  if (subjectUri) {
    if (postAtUri && subjectUri === postAtUri) {
      const thisPost = document.createElement("span");
      thisPost.className = "pollen-drawer-this-post";
      thisPost.textContent = "Claim on this post";
      footer.appendChild(thisPost);
    } else {
      // Show match quality as a percentage for claims on different posts.
      // PDQ hash distance is in bits. 128 is the expected hamming distance
      // between two random PDQ hashes (per Facebook's hashing.pdf), so we
      // treat it as the baseline for 0% match. Distance 0 = 100% match.
      const matchPct = Math.max(0, Math.round((1 - match.distance / 128) * 100));
      const postUrl = atUriToPostUrl(subjectUri);
      if (postUrl) {
        const sourceLink = document.createElement("a");
        sourceLink.className = "pollen-drawer-source-link";
        sourceLink.href = postUrl;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener";
        sourceLink.textContent = "View claimed post";
        footer.appendChild(sourceLink);
      }

      const matchEl = document.createElement("span");
      matchEl.className = "pollen-drawer-match";
      matchEl.textContent = `${matchPct}% match`;
      footer.appendChild(matchEl);
    }
  }

  if (footer.childNodes.length > 0) {
    card.appendChild(footer);
  }

  // Inspect link: open claim record in pdsls.dev viewer
  const inspectLink = document.createElement("a");
  inspectLink.className = "pollen-drawer-inspect";
  inspectLink.href = `https://pdsls.dev/${match.uri}`;
  inspectLink.target = "_blank";
  inspectLink.rel = "noopener";
  inspectLink.title = "View claim record";
  inspectLink.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M6 3H3v10h10v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M9 2h5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 2L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  card.appendChild(inspectLink);

  // Profile update callback
  const updateProfile = (profile: ProfileInfo) => {
    // Update handle text
    if (profile.displayName) {
      handleLink.textContent = `${profile.displayName} (@${profile.handle})`;
    } else if (profile.handle !== profile.did) {
      handleLink.textContent = `@${profile.handle}`;
    }

    // Update avatar
    if (profile.avatar) {
      const img = document.createElement("img");
      img.className = "pollen-drawer-avatar-img";
      img.src = profile.avatar;
      img.alt = profile.handle;
      avatarLink.appendChild(img);
      avatarLink.classList.add("pollen-drawer-avatar-loaded");
    }

    // Update profile link href to use handle for nicer URL
    if (profile.handle !== profile.did) {
      const handleProfileUrl = `https://bsky.app/profile/${profile.handle}`;
      avatarLink.href = handleProfileUrl;
      handleLink.href = handleProfileUrl;
    }
  };

  return { card, updateProfile };
}

/**
 * Create the drawer element that shows claim cards for all matches.
 * When there are multiple image groups, claims are shown grouped under image thumbnails.
 */
function createDrawerElement(imageMatchList: ImageMatches[], postAtUri: string | null): HTMLElement {
  const drawer = document.createElement("div");
  drawer.className = "pollen-drawer";

  // Prevent clicks from bubbling up to parent links (e.g. feed item <a> tags)
  drawer.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // Collect unique DIDs and create cards
  const uniqueDids = new Set<string>();
  const profileUpdaters: { did: string; update: (p: ProfileInfo) => void }[] = [];

  const allMatches = imageMatchList.flatMap(g => g.matches);

  if (imageMatchList.length > 1) {
    // Multi-image: render grouped by image
    for (const group of imageMatchList) {
      const groupEl = document.createElement("div");
      groupEl.className = "pollen-drawer-group";

      // Group header with thumbnail and count
      const header = document.createElement("div");
      header.className = "pollen-drawer-group-header";
      if (group.thumbnailUrl) {
        const thumb = document.createElement("img");
        thumb.className = "pollen-drawer-group-thumb";
        thumb.src = group.thumbnailUrl;
        thumb.alt = "";
        header.appendChild(thumb);
      }
      const label = document.createElement("span");
      label.className = "pollen-drawer-group-label";
      const cnt = group.matches.length;
      label.textContent = cnt === 1 ? "1 claim" : `${cnt} claims`;
      header.appendChild(label);
      groupEl.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "pollen-drawer-grid";
      for (const match of group.matches) {
        const { card, updateProfile } = createClaimCard(match, postAtUri);
        grid.appendChild(card);
        const did = didFromAtUri(match.uri);
        uniqueDids.add(did);
        profileUpdaters.push({ did, update: updateProfile });
      }
      groupEl.appendChild(grid);
      drawer.appendChild(groupEl);
    }
  } else {
    // Single image or empty: flat grid (no group headers)
    const grid = document.createElement("div");
    grid.className = "pollen-drawer-grid";
    for (const match of allMatches) {
      const { card, updateProfile } = createClaimCard(match, postAtUri);
      grid.appendChild(card);
      const did = didFromAtUri(match.uri);
      uniqueDids.add(did);
      profileUpdaters.push({ did, update: updateProfile });
    }
    drawer.appendChild(grid);
  }

  // Async fetch profiles and update cards
  fetchProfiles(Array.from(uniqueDids)).then((profiles) => {
    for (const { did, update } of profileUpdaters) {
      const profile = profiles.get(did);
      if (profile) {
        update(profile);
      }
    }
  });

  return drawer;
}

/**
 * Create the Pollen claim badge element with drawer on click.
 */
function createBadgeElement(postKey: string, imageMatchList: ImageMatches[], postAtUri: string | null): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "pollen-claim-strip";
  strip.setAttribute("data-pollen-post", postKey);

  const count = imageMatchList.reduce((sum, g) => sum + g.matches.length, 0);
  const label = count === 1 ? "1 claim" : `${count} claims`;
  strip.innerHTML = `
    <svg class="pollen-claim-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="7" fill="#f59e0b" stroke="#d97706" stroke-width="1"/>
      <path d="M5 8.5L7 10.5L11 6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="pollen-claim-label">${label}</span>
  `;

  let activeDrawer: HTMLElement | null = null;

  strip.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();

    // Toggle: close if drawer already open
    if (activeDrawer && activeDrawer.parentElement) {
      const closing = activeDrawer;
      activeDrawer = null;
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReducedMotion) {
        closing.remove();
      } else {
        closing.classList.add("pollen-drawer-closing");
        closing.addEventListener("animationend", () => closing.remove(), { once: true });
      }
      return;
    }

    // Walk up from badge to find the post container, insert drawer
    // as last child so it sits above the engagement buttons
    const postContainer = strip.closest(
      '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]'
    ) as HTMLElement | null;

    const drawer = createDrawerElement(imageMatchList, postAtUri);
    activeDrawer = drawer;

    if (postContainer) {
      postContainer.appendChild(drawer);

      // Stretch drawer to fill the full feed column width by measuring
      // against the post container's parent (the feed column), which
      // accounts for thread reply indentation.
      requestAnimationFrame(() => {
        const widthRef = postContainer.parentElement ?? postContainer;
        const refRect = widthRef.getBoundingClientRect();
        const drawerRect = drawer.getBoundingClientRect();
        const offsetLeft = drawerRect.left - refRect.left;
        const offsetRight = refRect.right - drawerRect.right;
        const basePadding = parseFloat(getComputedStyle(drawer).paddingLeft) || 0;
        drawer.style.marginLeft = `-${offsetLeft}px`;
        drawer.style.marginRight = `-${offsetRight}px`;
        drawer.style.paddingLeft = `${offsetLeft + basePadding}px`;
        drawer.style.paddingRight = `${offsetRight + basePadding}px`;
      });
    } else {
      // Fallback: insert after badge
      strip.insertAdjacentElement("afterend", drawer);
    }
  });

  return strip;
}

/**
 * Inject a claim badge below the image embed container for a post.
 */
function injectClaimBadge(
  link: HTMLAnchorElement,
  postKey: string,
  imageMatchList: ImageMatches[],
  postAtUri: string | null
): void {
  const postContainer = findPostContainer(link);
  if (!postContainer) return;

  const imageContainer = findImageEmbedContainer(postContainer);
  if (!imageContainer) return;

  // Prevent duplicate badge on same DOM element
  if (imageContainer.getAttribute("data-pollen-injected")) return;

  const badge = createBadgeElement(postKey, imageMatchList, postAtUri);

  // Insert badge just before the engagement buttons row.
  // replyBtn sits at div > div > div > button, so 3 levels up
  // reaches the row container.
  const replyBtn = postContainer.querySelector('[data-testid="replyBtn"]');
  if (replyBtn) {
    const engagementRow = replyBtn.parentElement?.parentElement?.parentElement;
    if (engagementRow) {
      engagementRow.insertAdjacentElement("beforebegin", badge);
    }
  } else {
    postContainer.appendChild(badge);
  }

  imageContainer.setAttribute("data-pollen-injected", "true");
}


/**
 * Process a post link element.
 * Uses postInfoCache to handle feed virtualization (re-inject badge without re-fetching).
 */
async function processPostLink(link: HTMLAnchorElement): Promise<void> {
  const href = link.getAttribute("href");
  if (!href) return;

  let match = href.match(POST_URL_REGEX);
  if (!match) {
    // Fallback to the current page URL, but only for the main thread post.
    // Skip if this post container has its own post link (meaning it's a
    // parent/child in the thread, not the main post).
    const container = findPostContainer(link);
    if (container && container.querySelector('a[href*="/post/"]')) return;
    match = window.location.pathname.match(POST_URL_REGEX);
  }
  if (!match) return;

  const [, handle, rkey] = match;
  const postKey = `${handle}/${rkey}`;

  // Find post container and check for feed images in the DOM
  const postContainer = findPostContainer(link);
  if (!postContainer) return;

  const feedImages = postContainer.querySelectorAll<HTMLImageElement>(
    'img[src*="cdn.bsky.app/img/feed_"]'
  );
  if (feedImages.length === 0) return;

  // If we have cached data, inject badge + buttons (handles re-virtualized posts)
  if (postInfoCache.has(postKey)) {
    const cached = postInfoCache.get(postKey);
    if (cached) {
      const imageMatches = claimMatchCache.get(postKey) || [];
      const totalMatches = imageMatches.reduce((sum, g) => sum + g.matches.length, 0);
      if (totalMatches > 0) {
        injectClaimBadge(link, postKey, imageMatches, cached.atUri);
      }
      injectClaimButtons(link, cached);
    }
    return;
  }

  // Guard API calls with processedPosts
  if (processedPosts.has(postKey)) return;
  processedPosts.add(postKey);

  // Extract DID from first feed image's CDN URL
  const parsed = parseCdnUrl(feedImages[0].src);
  if (!parsed) {
    processedPosts.delete(postKey);
    return;
  }

  const atUri = `at://${parsed.did}/app.bsky.feed.post/${rkey}`;

  // Fetch PFPs for this post's blobs
  const pfpBlobs = await fetchPfps(atUri);

  const postInfo: PostInfo = { atUri, handle, rkey, pfpBlobs };
  postInfoCache.set(postKey, postInfo);

  // Collect unique PFPs and search for claims
  const uniquePfps = new Set<string>();
  for (const blob of pfpBlobs) {
    uniquePfps.add(blob.pfp);
  }

  const imageMatchList: ImageMatches[] = [];
  const searchPromises = Array.from(uniquePfps).map(async (pfp) => {
    const matches = await searchClaims(pfp);
    if (matches.length === 0) return;
    // Find the thumbnail URL for this PFP's image
    const blob = pfpBlobs.find(b => b.pfp === pfp);
    let thumbnailUrl: string | null = null;
    if (blob) {
      for (const img of feedImages) {
        const p = parseCdnUrl(img.src);
        if (p && p.cid === blob.cid) { thumbnailUrl = img.src; break; }
      }
    }
    imageMatchList.push({ thumbnailUrl, matches });
  });
  await Promise.all(searchPromises);

  // Sort groups by image DOM order
  const feedImageUrls = Array.from(feedImages).map(img => img.src);
  imageMatchList.sort((a, b) => {
    const ai = a.thumbnailUrl ? feedImageUrls.indexOf(a.thumbnailUrl) : feedImageUrls.length;
    const bi = b.thumbnailUrl ? feedImageUrls.indexOf(b.thumbnailUrl) : feedImageUrls.length;
    return ai - bi;
  });

  claimMatchCache.set(postKey, imageMatchList);

  const totalMatches = imageMatchList.reduce((sum, g) => sum + g.matches.length, 0);
  if (totalMatches > 0) {
    injectClaimBadge(link, postKey, imageMatchList, postInfo.atUri);
  }
  injectClaimButtons(link, postInfo);
  console.log("[Pollen] Post with images:", postInfo, "claims:", totalMatches);
}

/**
 * Show a toast notification.
 */
function showToast(message: string, type: "success" | "error"): void {
  const toast = document.createElement("div");
  toast.className = `pollen-toast pollen-toast--${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

/**
 * Handle click on a claim button for a specific image.
 */
async function handleClaimClick(
  atUri: string,
  blobCid: string,
  pfp: string,
  thumbUrl: string,
  alt: string,
  link: HTMLAnchorElement,
  postKey: string
): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    showToast("Sign in to Bluesky to add a claim", "error");
    return;
  }

  const text = await showClaimModal(thumbUrl, alt);
  if (!text) return; // cancelled

  try {
    const recordCid = await fetchRecordCid(atUri);
    if (!recordCid) {
      showToast("Could not resolve post record", "error");
      return;
    }

    const result = await createClaimRecord(
      session,
      atUri,
      recordCid,
      blobCid,
      text,
      pfp
    );
    console.log("[Pollen] Claim created:", result);
    showToast("Claim saved!", "success");

    // Optimistic update: add the new claim to the cache and re-render badge
    const newMatch: SearchMatch = {
      uri: result.uri,
      pfp: pfp,
      distance: 0,
      record: {
        content: { text },
        createdAt: new Date().toISOString(),
        subject: { uri: atUri, cid: recordCid },
      },
    };
    const cachedImageMatches = claimMatchCache.get(postKey) || [];
    // Insert into the correct group by matching PFP, or create a new group
    const existingGroup = cachedImageMatches.find(g => g.matches.some(m => m.pfp === pfp));
    if (existingGroup) {
      existingGroup.matches.push(newMatch);
    } else {
      cachedImageMatches.push({ thumbnailUrl: thumbUrl, matches: [newMatch] });
    }
    claimMatchCache.set(postKey, cachedImageMatches);

    // Remove existing badge and drawer so injectClaimBadge can re-insert with updated data
    const postContainer = findPostContainer(link);
    if (postContainer) {
      const existingDrawer = postContainer.querySelector(".pollen-drawer");
      if (existingDrawer) existingDrawer.remove();
    }
    const existingBadge = postContainer?.querySelector(`[data-pollen-post="${postKey}"]`)
      ?? document.querySelector(`[data-pollen-post="${postKey}"]`);
    if (existingBadge) existingBadge.remove();
    // Clear injected marker on the image container so badge can be re-inserted
    if (postContainer) {
      const imageContainer = findImageEmbedContainer(postContainer);
      if (imageContainer) {
        imageContainer.removeAttribute("data-pollen-injected");
      }
    }
    injectClaimBadge(link, postKey, cachedImageMatches, atUri);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to save claim";
    console.error("[Pollen] createClaimRecord failed:", err);
    if (message.includes("expired") || message.includes("token")) {
      showToast("Session expired — refresh bsky.app", "error");
    } else if (message.includes("CORS") || message.includes("NetworkError") || message.includes("fetch")) {
      showToast("Cannot reach your server", "error");
    } else {
      showToast(`Failed: ${message}`, "error");
    }
  }
}

/**
 * Inject per-image claim buttons on feed images within a post.
 */
function injectClaimButtons(
  link: HTMLAnchorElement,
  postInfo: PostInfo
): void {
  const postContainer = findPostContainer(link);
  if (!postContainer) return;

  const feedImages = postContainer.querySelectorAll<HTMLImageElement>(
    'img[src*="cdn.bsky.app/img/feed_"]'
  );

  for (const img of feedImages) {
    if (img.getAttribute("data-pollen-claim")) continue;

    // Parse CID from this image's CDN URL and look up its PFP
    const parsed = parseCdnUrl(img.src);
    if (!parsed) continue;

    const pfpBlob = postInfo.pfpBlobs.find((b) => b.cid === parsed.cid);
    if (!pfpBlob) continue;

    // Walk up from the image to find a positioned ancestor with actual
    // dimensions that won't clip the button. Bluesky (React Native Web)
    // sets position:relative on View elements, so we must NOT add
    // position:relative to the img's direct parent — doing so breaks
    // the absolute-positioning chain the image relies on for sizing.
    let wrapper: HTMLElement | null = img.parentElement;
    while (wrapper && wrapper !== postContainer) {
      const style = window.getComputedStyle(wrapper);
      if (
        style.position !== "static" &&
        wrapper.offsetWidth > 0 &&
        wrapper.offsetHeight > 0 &&
        style.overflow !== "hidden"
      ) {
        break;
      }
      wrapper = wrapper.parentElement;
    }
    if (!wrapper || wrapper === postContainer) continue;

    // For link card embeds the wrapper ends up being the <a> tag, which is
    // too far from the image — the card's border/border-radius overlaps the
    // button.  Fall back to the data-expoimage container instead: it's
    // positioned and has dimensions, and the inset button won't be clipped
    // by its overflow:hidden.
    if (wrapper.tagName === "A") {
      const expoImage = img.closest("[data-expoimage]") as HTMLElement | null;
      if (expoImage && wrapper.contains(expoImage)) {
        if (window.getComputedStyle(expoImage).position === "static") {
          expoImage.style.position = "relative";
        }
        wrapper = expoImage;
      }
    }

    wrapper.classList.add("pollen-claim-wrap");

    const btn = document.createElement("button");
    btn.className = "pollen-claim-btn";
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Claim
    `;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const postKey = `${postInfo.handle}/${postInfo.rkey}`;
      handleClaimClick(postInfo.atUri, parsed.cid, pfpBlob.pfp, img.src, img.alt || "", link, postKey);
    });

    wrapper.appendChild(btn);
    img.setAttribute("data-pollen-claim", "true");
  }
}

// Track which links have been registered with the IntersectionObserver
const observedLinks = new WeakSet<HTMLAnchorElement>();

/**
 * IntersectionObserver that processes posts only when they approach the
 * viewport. Uses a generous rootMargin so processing starts before the
 * post is visible, reducing perceived latency.
 */
const postObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const link = entry.target as HTMLAnchorElement;
      postObserver.unobserve(link);
      processPostLink(link);
    }
  },
  { rootMargin: "500px 0px" }
);

/**
 * Scan the page for post links and register them with the
 * IntersectionObserver for deferred processing.
 */
function scanForPosts(): void {
  // Don't process posts on the notifications page
  if (window.location.pathname.startsWith("/notifications")) return;

  // Find all links that look like post links, including profile links
  // inside thread items (which may lack /post/ links when engagement is zero)
  const links = document.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/profile/"][href*="/post/"], [data-testid^="postThreadItem-by-"] a[href*="/profile/"]'
  );

  for (const link of links) {
    if (observedLinks.has(link)) continue;
    observedLinks.add(link);
    postObserver.observe(link);
  }
}

/**
 * Set up MutationObserver to watch for new posts
 */
function setupObserver(): void {
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasNewNodes = true;
        break;
      }
    }

    if (hasNewNodes) {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanForPosts, 100);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log("[Pollen] Observer started, watching for posts...");
}

// Initialize
console.log("[Pollen] Extension loaded on", window.location.href);
scanForPosts();
setupObserver();
