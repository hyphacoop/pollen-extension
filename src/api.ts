/**
 * Pollen API client for fetching PFPs and searching claims.
 */

const POLLEN_API_URL = "https://nectar-api.hypha.coop";
// Public API access token, limited to Pollen records
const POLLEN_API_TOKEN = "pollen";

export interface PfpBlob {
  cid: string;
  pfp: string;
}

interface ClaimRecord {
  content?: { text?: string };
  createdAt?: string;
  subject?: { uri: string; cid: string };
}

export interface SearchMatch {
  uri: string;
  pfp: string;
  distance: number;
  record?: ClaimRecord;
}

const SLINGSHOT_URL = "https://slingshot.microcosm.blue";

/**
 * Fetch the CID of an AT Protocol record via Slingshot.
 * Returns null if the record is not found or the request fails.
 */
export async function fetchRecordCid(atUri: string): Promise<string | null> {
  const url = `${SLINGSHOT_URL}/xrpc/blue.microcosm.repo.getRecordByUri?at_uri=${encodeURIComponent(atUri)}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("[Pollen] fetchRecordCid failed:", resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    return data.cid || null;
  } catch (err) {
    console.error("[Pollen] fetchRecordCid error:", err);
    return null;
  }
}

/**
 * Fetch PFPs for a post's image blobs (resolve-on-miss).
 */
export async function fetchPfps(atUri: string): Promise<PfpBlob[]> {
  try {
    const url = `${POLLEN_API_URL}/pfps?uri=${encodeURIComponent(atUri)}`;
    const resp = await fetch(url, { headers: { "Authorization": `Bearer ${POLLEN_API_TOKEN}` } });
    if (!resp.ok) {
      console.error("[Pollen] fetchPfps failed:", resp.status, await resp.text());
      return [];
    }
    const data = await resp.json();
    return data.blobs || [];
  } catch (err) {
    console.error("[Pollen] fetchPfps error:", err);
    return [];
  }
}

/**
 * Search for claim records containing a matching PFP.
 */
export async function searchClaims(pfp: string): Promise<SearchMatch[]> {
  try {
    const url = `${POLLEN_API_URL}/search/pfps?pfp=${encodeURIComponent(pfp)}&wantedCollections=coop.hypha.pollen.claim&hydrate=true`;
    const resp = await fetch(url, { headers: { "Authorization": `Bearer ${POLLEN_API_TOKEN}` } });
    if (!resp.ok) {
      console.error("[Pollen] searchClaims failed:", resp.status, await resp.text());
      return [];
    }
    const data = await resp.json();
    return data.matches || [];
  } catch (err) {
    console.error("[Pollen] searchClaims error:", err);
    return [];
  }
}

export interface ProfileInfo {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

const profileCache = new Map<string, ProfileInfo>();

const BSKY_PUBLIC_API = "https://public.api.bsky.app";

/**
 * Batch-fetch profiles from the Bluesky public API.
 * Uses a module-level cache; only fetches uncached DIDs.
 * Returns a map of DID → ProfileInfo for all requested DIDs.
 */
export async function fetchProfiles(
  dids: string[]
): Promise<Map<string, ProfileInfo>> {
  const result = new Map<string, ProfileInfo>();
  const uncached: string[] = [];

  for (const did of dids) {
    const cached = profileCache.get(did);
    if (cached) {
      result.set(did, cached);
    } else {
      uncached.push(did);
    }
  }

  // Fetch uncached DIDs in batches of 25
  for (let i = 0; i < uncached.length; i += 25) {
    const batch = uncached.slice(i, i + 25);
    const params = batch.map((d) => `actors=${encodeURIComponent(d)}`).join("&");
    const url = `${BSKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfiles?${params}`;

    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        for (const profile of data.profiles || []) {
          let avatar: string | undefined = profile.avatar;
          if (avatar) {
            avatar = avatar.replace("/img/avatar/", "/img/avatar_thumbnail/");
          }
          const info: ProfileInfo = {
            did: profile.did,
            handle: profile.handle,
            displayName: profile.displayName || undefined,
            avatar,
          };
          profileCache.set(profile.did, info);
          result.set(profile.did, info);
        }
      } else {
        console.error("[Pollen] fetchProfiles failed:", resp.status);
      }
    } catch (err) {
      console.error("[Pollen] fetchProfiles error:", err);
    }

    // Create fallback entries for any DIDs that weren't in the response
    for (const did of batch) {
      if (!result.has(did)) {
        const fallback: ProfileInfo = { did, handle: did };
        profileCache.set(did, fallback);
        result.set(did, fallback);
      }
    }
  }

  return result;
}

/**
 * Extract the full DID from an AT URI.
 */
export function didFromAtUri(uri: string): string {
  const match = uri.match(/^at:\/\/(did:[^/]+)/);
  return match ? match[1] : "unknown";
}
