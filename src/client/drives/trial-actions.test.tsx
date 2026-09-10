import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CreateDrive } from "./create-drive";
import { PurgeDialog } from "./purge-dialog";
import { TrashContents } from "../score-library/trash-contents";
afterEach(() => vi.unstubAllGlobals());
it("creates a drive with the verified identity fence and enters the returned drive", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ choirId: "new-drive" }, { status: 201 }));
  vi.stubGlobal("fetch",fetch);
  render(<MemoryRouter><Routes><Route path="/" element={<CreateDrive userId="user" />} /><Route path="/choirs/new-drive" element={<h1>新云盘</h1>} /></Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole("button",{name:"创建云盘"}));
  fireEvent.change(screen.getByLabelText("云盘名称"),{target:{value:"排练"}});
  fireEvent.change(screen.getByLabelText("你在云盘内的显示名"),{target:{value:"指挥"}});
  fireEvent.click(screen.getByRole("button",{name:"免费创建"}));
  expect(await screen.findByRole("heading",{name:"新云盘"})).toBeVisible();
  expect(fetch).toHaveBeenCalledWith("/api/choirs",expect.objectContaining({body:JSON.stringify({name:"排练",displayName:"指挥"}),headers:expect.objectContaining({"x-same-page-owner-user-id":"user"})}));
});
it("explains a full global trial allocation without blocking joining elsewhere", async () => {
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({error:"free_drive_limit_reached"},{status:409})));
  render(<MemoryRouter><CreateDrive userId="user" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button",{name:"创建云盘"}));
  fireEvent.change(screen.getByLabelText("云盘名称"),{target:{value:"排练"}});
  fireEvent.change(screen.getByLabelText("你在云盘内的显示名"),{target:{value:"指挥"}});
  fireEvent.click(screen.getByRole("button",{name:"免费创建"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("你仍可以加入其他云盘");
});
it("requires the current drive name and explicit confirmation before destructive submission", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null,{status:204}));const done=vi.fn();
  vi.stubGlobal("fetch",fetch);
  render(<MemoryRouter><PurgeDialog userId="user" path="/api/choirs/drive/purge" title="彻底删除云盘" description="全部成员的笔记都会被删除。" driveName="排练" onClose={()=>{}} onComplete={done} /></MemoryRouter>);
  const confirm=screen.getByRole("button",{name:"确认彻底删除"});
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText("输入云盘名称“排练”确认"),{target:{value:"其他"}});
  expect(confirm).toBeDisabled();expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("输入云盘名称“排练”确认"),{target:{value:"排练"}});
  fireEvent.click(confirm);await waitFor(()=>expect(done).toHaveBeenCalledTimes(1));
});
it("distinguishes a full library from a filename conflict when restoring trash", async () => {
  const score={id:"score",choirId:"drive",fileName:"曲谱.pdf",updatedAt:1,trashedAt:1,trashExpiresAt:Date.now()+86400000,currentVersion:{id:"version",versionNumber:1,sizeBytes:10,sha256:"hash",etag:"tag",pageCount:1,createdAt:1}};
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json({scores:[score],storage:{usedBytes:10,limitBytes:100}})).mockResolvedValueOnce(Response.json({error:"score_limit_reached"},{status:409})));
  render(<MemoryRouter><TrashContents userId="user" choirId="drive" onRestored={()=>{}} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button",{name:"恢复"}));
  expect(await screen.findByText(/文件库乐谱数量已达上限/)).toBeVisible();
  expect(screen.queryByLabelText("恢复时使用的新文件名")).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"彻底删除"})).not.toBeInTheDocument();
});
