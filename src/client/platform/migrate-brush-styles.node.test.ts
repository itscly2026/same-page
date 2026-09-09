import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it } from "vitest";
import { migrateBrushStyles } from "./migrate-brush-styles";
it.each([12, 13])("upgrades v%s offline content and queued operations without changing their OCC base", async version => {
  const name = `brush-upgrade-${crypto.randomUUID()}`;
  const schema = { annotations: "&key", annotationOutbox: "&opId", annotationConflicts: "&opId", offlineSnapshots: "&key", offlineScores: "&key" };
  const old = new Dexie(name); old.version(version).stores(schema); await old.open();
  const payload = { ...(version === 13 ? { brush: "highlighter", pressureMode: "uniform" } : {}), kind: "ink", strokeWidth: .018, opacity: .3, points: [{x:.1,y:.2},{x:.3,y:.2}] };
  await old.table("annotations").put({key:"a",payload,lastOpId:"old"});
  await old.table("annotationOutbox").put({opId:"old",payload,baseVersion:7,attemptedAt:1});
  await old.table("annotationConflicts").put({opId:"conflict",localPayload:payload,canonical:{payload}});
  await old.table("offlineSnapshots").put({key:"s",annotationSnapshot:{annotations:[{payload}]}});
  await old.table("offlineScores").put({key:"file", untouched:"immutable PDF"}); old.close();
  const current = new Dexie(name); current.version(version).stores(schema); current.version(14).stores({}).upgrade(migrateBrushStyles);
  try {
    await current.open();
    const [op] = await current.table("annotationOutbox").toArray();
    expect(op.opId).not.toBe("old"); expect(op.baseVersion).toBe(7); expect(op.attemptedAt).toBeNull();
    expect(op.payload).toMatchObject({brush:"highlighter",nib:"round",pressureMode:"uniform"});
    expect((await current.table("annotations").get("a")).lastOpId).toBe(op.opId);
    expect((await current.table("annotationConflicts").get("conflict")).canonical.payload.brush).toBe("highlighter");
    expect((await current.table("offlineSnapshots").get("s")).annotationSnapshot.annotations[0].payload.brush).toBe("highlighter");
    expect(await current.table("offlineScores").get("file")).toEqual({key:"file",untouched:"immutable PDF"});
  } finally { current.close(); await Dexie.delete(name); }
});
