import { and, eq, isNull } from "drizzle-orm";

import type { GuestAdmissionRequest } from "../../src/shared/choirs";
import type { Database } from "../db/database";
import { choirs } from "../db/schema";
import { hashJoinCode } from "../security/join-code";

export async function findAdmissibleChoir(options: {
  database: Database;
  inviteSecret: string;
  request: GuestAdmissionRequest;
}) {
  if (options.request.admission === "open") {
    return options.database.query.choirs.findFirst({
      where: and(
        eq(choirs.id, options.request.choirId),
        eq(choirs.guestAdmissionMode, "open"),
      isNull(choirs.purgedAt),
      ),
    });
  }

  const joinCodeHash = await hashJoinCode(
    options.request.joinCode,
    options.inviteSecret,
  );
  return options.database.query.choirs.findFirst({
    where: and(
      eq(choirs.joinCodeHash, joinCodeHash),
      eq(choirs.guestAdmissionMode, "invite"),
      isNull(choirs.purgedAt),
    ),
  });
}
