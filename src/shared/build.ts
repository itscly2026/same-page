declare const __SAME_PAGE_BUILD_ID__: string;

export const buildId = typeof __SAME_PAGE_BUILD_ID__ === "string"
  ? __SAME_PAGE_BUILD_ID__
  : "development";

declare const __SAME_PAGE_BUILD_RUN_ID__: string;
export const buildRunId = typeof __SAME_PAGE_BUILD_RUN_ID__ === "string" ? __SAME_PAGE_BUILD_RUN_ID__ : "";
