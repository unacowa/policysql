import { internalError, wasmError } from "./errors.ts";
import type { AuthContext } from "./types.ts";

export type RequiredAccess = "catalog" | "explain" | "execute";

type SessionRuntime = {
  authorize_session_json(sessionJson: string, requestedRole: string | undefined, requiredAccess: string): string;
};

const internal = internalError;

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
