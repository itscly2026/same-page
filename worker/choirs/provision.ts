import { hashJoinCode, generateJoinCode } from "../security/join-code";
import { encryptJoinCode } from "../security/join-code-storage";
import { defaultSharedLayers } from "../../src/shared/annotations";

export const DEFAULT_CHOIR_NAME = "小红花云盘";
export const CHOIR_STORAGE_LIMIT_BYTES = 1_073_741_824;

export async function provisionChoir(options: {
  binding: D1Database;
  ownerUserId: string;
  ownerDisplayName: string;
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
  const joinCodeCiphertext = joinCode
    ? await encryptJoinCode(joinCode, choirId, options.inviteSecret)
    : null;
  await options.binding.batch([
    options.binding
      .prepare(
        `INSERT INTO choirs
          (id, owner_membership_id, name, guest_admission_mode, guest_session_version,
           is_preview_entry, join_code_hash, join_code_ciphertext, storage_limit_bytes)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .bind(
        choirId,
        membershipId,
        options.choirName ?? DEFAULT_CHOIR_NAME,
        guestAdmissionMode,
        options.isPreviewEntry ? 1 : 0,
        joinCodeHash,
        joinCodeCiphertext,
        CHOIR_STORAGE_LIMIT_BYTES,
      ),
    options.binding
      .prepare(
        `INSERT INTO memberships
          (id, choir_id, user_id, display_name, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
      .bind(
        membershipId,
        choirId,
        options.ownerUserId,
        options.ownerDisplayName,
      ),
    ...defaultSharedLayers.map((layer) =>
      options.binding.prepare(
        `INSERT INTO choir_shared_layer_settings
          (choir_id, slot, name, sort_order, default_color, updated_by_membership_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(choirId, layer.slot, layer.name, layer.sortOrder, layer.defaultColor, membershipId),
    ),
  ]);

  return { choirId, joinCode };
}
