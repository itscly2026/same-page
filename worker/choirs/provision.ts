import { hashJoinCode, generateJoinCode } from "../security/join-code";
import { defaultSharedLayers } from "../../src/shared/annotations";

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

  const membershipId = crypto.randomUUID();
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
        membershipId,
        choirId,
        options.adminUserId,
        options.adminDisplayName,
      ),
    ...defaultSharedLayers.map((layer) =>
      options.binding.prepare(
        `INSERT INTO choir_shared_layer_settings
          (choir_id, slot, default_color, updated_by_membership_id)
         VALUES (?, ?, ?, ?)`,
      ).bind(choirId, layer.slot, layer.defaultColor, membershipId),
    ),
  ]);

  return { choirId, joinCode };
}
