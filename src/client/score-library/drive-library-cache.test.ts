import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDriveLibraryCache,
  driveCacheOwnerKey,
  invalidateDriveLibrary,
  readDriveSummary,
  readDriveLibrary,
  rememberDriveLibrary,
  rememberDriveSummary,
  rememberDriveView,
} from "./drive-library-cache";

const result = {
  scores: [],
  storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
  permissions: { canManage: false },
};

describe("drive library cache", () => {
  beforeEach(clearDriveLibraryCache);

  it("restores one owner's library and view without crossing identities", () => {
    const firstOwner = driveCacheOwnerKey("user-1", "drive-1");
    rememberDriveLibrary(firstOwner, "drive-1", {
      choir: { id: "drive-1", name: "排练云盘", guestAdmissionMode: "invite" },
      result,
    });
    rememberDriveView(firstOwner, "drive-1", { search: "春天", scrollTop: 420 });

    expect(readDriveLibrary(firstOwner, "drive-1")).toMatchObject({
      search: "春天",
      scrollTop: 420,
      choir: { name: "排练云盘" },
    });

    const secondOwner = driveCacheOwnerKey("user-2", "drive-1");
    expect(readDriveLibrary(secondOwner, "drive-1")).toBeNull();
    expect(readDriveLibrary(firstOwner, "drive-1")).toBeNull();
  });

  it("invalidates only the denied drive for the active owner", () => {
    const owner = driveCacheOwnerKey("user-1", "drive-1");
    for (const driveId of ["drive-1", "drive-2"]) {
      rememberDriveLibrary(owner, driveId, { choir: null, result });
    }

    invalidateDriveLibrary(owner, "drive-1");

    expect(readDriveLibrary(owner, "drive-1")).toBeNull();
    expect(readDriveLibrary(owner, "drive-2")).not.toBeNull();
  });

  it("primes a drive summary before its library has loaded", () => {
    const owner = driveCacheOwnerKey("user-1", "drive-1");
    rememberDriveSummary(owner, {
      id: "drive-1",
      name: "首页已有云盘",
      guestAdmissionMode: "invite",
    });

    expect(readDriveSummary(owner, "drive-1")).toMatchObject({
      name: "首页已有云盘",
    });
    expect(readDriveLibrary(owner, "drive-1")).toBeNull();
  });
});
