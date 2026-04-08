/**
 * Auth module: reads bsky.app's session from BSKY_STORAGE in localStorage,
 * and writes claim records to the user's PDS using Bearer auth.
 */

export interface SessionInfo {
  did: string;
  service: string;
  accessJwt: string;
}

// Shape of account entries in BSKY_STORAGE
interface BskyAccount {
  did: string;
  handle: string;
  service: string;
  accessJwt: string;
  refreshJwt: string;
  pdsUrl?: string;
}

interface BskyStorage {
  session?: {
    currentAccount?: BskyAccount;
    accounts?: BskyAccount[];
  };
}

/**
 * Read the active session from bsky.app's BSKY_STORAGE localStorage.
 */
export function getActiveSession(): SessionInfo | null {
  try {
    const raw = localStorage.getItem("BSKY_STORAGE");
    if (!raw) {
      console.log("[Pollen] BSKY_STORAGE not found in localStorage");
      return null;
    }

    const storage: BskyStorage = JSON.parse(raw);

    // Try currentAccount first, then first account in array
    let account = storage.session?.currentAccount;
    if (!account?.accessJwt && storage.session?.accounts?.length) {
      account = storage.session.accounts.find((a) => !!a.accessJwt);
    }

    if (!account) {
      console.log("[Pollen] No account with accessJwt in BSKY_STORAGE");
      return null;
    }

    // Use pdsUrl if available, otherwise fall back to service (entryway)
    const service = (account.pdsUrl || account.service).replace(/\/+$/, "");

    console.log("[Pollen] Session loaded — did:", account.did, "service:", service, "handle:", account.handle);

    return {
      did: account.did,
      service,
      accessJwt: account.accessJwt,
    };
  } catch (err) {
    console.error("[Pollen] Failed to read BSKY_STORAGE:", err);
    return null;
  }
}

// --- createRecord API call ---

export async function createClaimRecord(
  session: SessionInfo,
  subjectUri: string,
  subjectCid: string,
  blobCid: string,
  text: string,
  pfp: string
): Promise<{ uri: string; cid: string }> {
  const record: Record<string, unknown> = {
    $type: "coop.hypha.pollen.claim",
    pfp: { __pfp: pfp },
    cid: { $link: blobCid },
    subject: { uri: subjectUri, cid: subjectCid },
    content: {
      $type: "coop.hypha.pollen.embed.text",
      text,
    },
    createdAt: new Date().toISOString(),
  };

  const url = `${session.service}/xrpc/com.atproto.repo.createRecord`;

  const body = JSON.stringify({
    repo: session.did,
    collection: "coop.hypha.pollen.claim",
    validate: false,
    record,
  });

  console.log("[Pollen] createRecord →", url, "repo:", session.did);

  const result = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body,
  });

  if (!result.ok) {
    const errorBody = await result.text();
    console.error("[Pollen] createRecord failed:", result.status, errorBody);
    let message: string;
    try {
      message = JSON.parse(errorBody).message || errorBody;
    } catch {
      message = errorBody;
    }
    throw new Error(message);
  }

  const data = await result.json();
  return { uri: data.uri, cid: data.cid };
}
