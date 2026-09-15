// User avatar validation and storage. The single definition of a valid avatar, shared by the
// browser-driven setAvatar RPC and by profile hints applied when a gatekeeper is connected.

const MAX_AVATAR_BYTES = 100 * 1024;

/** The one binding avatars live in: KV, global, keyed by user id -- not the user's DO storage. */
export type AvatarEnv = Pick<Cloudflare.Env, "AVATARS">;

/**
 * Validates that `data` is an acceptable avatar image: at most 100 KB, and JPEG or PNG by
 * magic-byte header. Throws with a user-facing message otherwise.
 */
export function validateAvatarBytes(data: Uint8Array): void {
  if (data.byteLength > MAX_AVATAR_BYTES) {
    throw new Error("Avatar too large (max 100 KB)");
  }
  // Verify the data starts with a known image magic-byte header.
  let isJpeg = data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
  let isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47;
  if (!isJpeg && !isPng) {
    throw new Error("Avatar must be a JPEG or PNG image");
  }
}

/** Writes an avatar to KV, keyed by user id. Callers validate `data` first. */
export async function putUserAvatar(env: AvatarEnv, userId: string, data: Uint8Array): Promise<void> {
  await env.AVATARS.put(userId, data);
}

/** Whether an avatar is already stored for this user. */
export async function userAvatarExists(env: AvatarEnv, userId: string): Promise<boolean> {
  let result = await env.AVATARS.get(userId, "arrayBuffer");
  return result !== null;
}
