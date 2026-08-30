import { hashJoinCode, generateJoinCode } from "../security/join-code";

export const DEFAULT_CHOIR_NAME = "小红花合唱团";
export const CHOIR_STORAGE_LIMIT_BYTES = 1_073_741_824;

export async function provisionChoir(options: {
  binding: D1Database;
  adminUserId: string;
  adminDisplayName: string;
  inviteSecret: string;
  choirName?: string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}) {
  const choirId = crypto.randomUUID();
  const joinCode = generateJoinCode(options.getRandomValues);
  const joinCodeHash = await hashJoinCode(joinCode, options.inviteSecret);

  await options.binding.batch([
    options.binding
      .prepare(
        `INSERT INTO choirs
          (id, name, join_code_hash, join_code_version, storage_limit_bytes)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .bind(
        choirId,
        options.choirName ?? DEFAULT_CHOIR_NAME,
        joinCodeHash,
        CHOIR_STORAGE_LIMIT_BYTES,
      ),
    options.binding
      .prepare(
        `INSERT INTO memberships
          (id, choir_id, user_id, display_name, role, status)
         VALUES (?, ?, ?, ?, 'admin', 'active')`,
      )
      .bind(
        crypto.randomUUID(),
        choirId,
        options.adminUserId,
        options.adminDisplayName,
      ),
  ]);

  return { choirId, joinCode };
}
