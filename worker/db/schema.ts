export * from "./app-schema";
export * from "./auth-schema.generated";

import * as appSchema from "./app-schema";
import * as authSchema from "./auth-schema.generated";

export const schema = {
  ...authSchema,
  ...appSchema,
};
