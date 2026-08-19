import type { Hono } from "hono";
import { HttpError } from "../errors.ts";
import { readJsonBody } from "../http.ts";
import type { AppEnv } from "../types.ts";

const VALIDATION_ID = /^cval_[a-f0-9]{32}$/u;

export const registerCommitCheckRoutes = (app: Hono<AppEnv>) => {
  app.post("/v1/commit-checks/:validationId/query", async (context) => {
    const validationId = context.req.param("validationId");
    if (!VALIDATION_ID.test(validationId)) {
      throw new HttpError(404, "POLICYSQL_NOT_FOUND", "Endpoint not found.");
    }
    const body = await readJsonBody(context.req.raw);
    const ownerName = `tx_${validationId.slice("cval_".length)}`;
    const owner = context.env.TRANSACTION_OWNER.get(context.env.TRANSACTION_OWNER.idFromName(ownerName));
    return owner.fetch("https://owner/validation-query", {
      method: "POST",
      headers: {
        authorization: context.req.header("authorization") ?? "",
        "content-type": "application/json",
        "x-policysql-request-id": context.get("requestId"),
      },
      body: body.text,
    });
  });
};
