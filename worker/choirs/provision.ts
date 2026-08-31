import { hashJoinCode, generateJoinCode } from "../security/join-code";

export const DEFAULT_CHOIR_NAME = "小红花云盘";
export const CHOIR_STORAGE_LIMIT_BYTES = 1_073_741_824;

export async function provisionChoir(options: {
  binding: D1Database;
  adminUserId: string;
  adminDisplayName: string;
  inviteSecret: string;
  choirName?: string;
  guestAdmissionMode?: "invite" | "open";
  isPreviewEntry?: boolean;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}) {
  const choirId = crypto.randomUUID();
  const guestAdmissionMode = options.guestAdmissionMode ?? "invite";
  if (options.isPreviewEntry && guestAdmissionMode !== "open") {
    throw new Error("Preview entry choir must use open guest admission");
  }
  const joinCode =
    guestAdmissionMode === "invite"
      ? generateJoinCode(options.getRandomValues)
      : null;
  const joinCodeHash = joinCode
    ? await hashJoinCode(joinCode, options.inviteSecret)
    : null;

  await options.binding.batch([
    options.binding
      .prepare(
        `INSERT INTO choirs
          (id, name, guest_admission_mode, guest_session_version,
           is_preview_entry, join_code_hash, storage_limit_bytes)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        choirId,
        options.choirName ?? DEFAULT_CHOIR_NAME,
        guestAdmissionMode,
        options.isPreviewEntry ? 1 : 0,
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
