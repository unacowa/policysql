import { HttpError, wasmError } from "./errors.ts";
import type { AuthContext } from "./types.ts";

export type RequiredAccess = "catalog" | "explain" | "execute";

type SessionRuntime = {
  authorize_session_json(sessionJson: string, requestedRole: string | undefined, requiredAccess: string): string;
};

const internal = () => new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");

/**
 * Reads the optional `PolicySQL-Role` header. Only the HTTP framing is checked here: a
 * repeated header (joined with a comma) is ambiguous. Whether the role is allowed is
 * decided by core.
 */
export const requestedRole = (headers: Headers): string | undefined => {
  const value = headers.get("policysql-role");
  if (value === null) return undefined;
  if (value.includes(",")) {
    throw new HttpError(400, "POLICYSQL_INVALID_REQUEST", "PolicySQL-Role must be a single value.");
  }
  return value;
};

/**
 * Passes the wrapper's trusted session to core, which validates its shape, selects the
 * role, and checks the endpoint's access in one place. A malformed session is a wrapper
 * fault (500, logged without session values); a role or access the client may not use is
 * 403. The result is core's canonical value, which compile and Catalog calls accept.
 */
export const authorizeSession = (
  runtime: SessionRuntime,
  session: unknown,
  role: string | undefined,
  access: RequiredAccess,
  requestId: string,
): AuthContext => {
  const reject = (fault: string) => {
    console.log(JSON.stringify({ event: "trusted_session_rejected", requestId, fault }));
    return internal();
  };
  let sessionJson: string | undefined;
  try {
    sessionJson = JSON.stringify(session);
  } catch {
    throw reject("shape");
  }
  if (typeof sessionJson !== "string") throw reject("shape");
  let result: any;
  try {
    result = JSON.parse(runtime.authorize_session_json(sessionJson, role, access));
  } catch {
    throw internal();
  }
  if (result?.error) {
    if (result.error.code === "POLICYSQL_INTERNAL") {
      throw reject(typeof result.fault === "string" ? result.fault : "unknown");
    }
    throw wasmError(result) ?? internal();
  }
  if (!result?.auth || typeof result.auth !== "object") throw internal();
  return result.auth as AuthContext;
};
