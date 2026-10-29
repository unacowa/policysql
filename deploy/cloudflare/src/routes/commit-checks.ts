import type { Hono } from "hono";
import { HttpError } from "../errors.ts";
import { readJsonBody } from "../http.ts";
import { transactionOwner } from "../middleware/request-context.ts";
import type { AppEnv } from "../types.ts";

const VALIDATION_ID = /^cval_[a-f0-9]{32}$/u;

export const registerCommitCheckRoutes = (app: Hono<AppEnv>) => {
  app.post("/v1/commit-checks/:validationId/query", async (context) => {
    // Only fetchCallback serves callbacks. Through fetch (for example a percent-encoded
    // path that the router decodes to this route) it is not found, before any body read.
    if (context.env.callback !== true) {
      throw new HttpError(404, "POLICYSQL_NOT_FOUND", "Endpoint not found.");
    }
    const validationId = context.req.param("validationId");
    if (!VALIDATION_ID.test(validationId)) {
      throw new HttpError(404, "POLICYSQL_NOT_FOUND", "Endpoint not found.");
    }
    const body = await readJsonBody(context.req.raw);
    const ownerName = `tx_${validationId.slice("cval_".length)}`;
    const owner = transactionOwner(context, ownerName);
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
