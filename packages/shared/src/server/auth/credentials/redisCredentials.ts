import type { Redis } from "ioredis";
import { env } from "../../../env";
import { logger } from "../../logger";
import {
  AZURE_REDIS_SCOPE,
  AzureManagedIdentityCredentialProvider,
} from "./azureManagedIdentity";
import { RefreshingTokenManager } from "./RefreshingTokenManager";
import type { ManagedAccessToken, ManagedCredentialProvider } from "./types";

// Returns null for the default static auth, leaving the existing path unchanged.
export function getRedisManagedCredentialProviderFromEnv(): ManagedCredentialProvider | null {
  switch (env.REDIS_AUTH_METHOD) {
    case "azure_managed_identity":
      return new AzureManagedIdentityCredentialProvider({
        scope: env.REDIS_AZURE_SCOPE ?? AZURE_REDIS_SCOPE,
        username: env.REDIS_USERNAME ?? undefined,
        clientId: env.REDIS_AZURE_CLIENT_ID ?? undefined,
      });
    case "static":
    default:
      return null;
  }
}

// ioredis v5 has no credentials hook, so on each refresh we update
// options.password (for reconnects) and issue a live AUTH on the open
// connection. The caller uses lazyConnect so the first token is set before connect.
export async function bindManagedCredentialToRedis(
  client: Redis,
  provider: ManagedCredentialProvider,
  deps: { manager?: RefreshingTokenManager } = {},
): Promise<RefreshingTokenManager> {
  const manager = deps.manager ?? new RefreshingTokenManager(provider);

  const applyToken = (token: ManagedAccessToken) => {
    client.options.password = token.token;
    if (provider.username) client.options.username = provider.username;
  };

  const initial = await manager.start();
  applyToken(initial);

  manager.onRefresh((token) => {
    applyToken(token);
    const authArgs = provider.username
      ? [provider.username, token.token]
      : [token.token];
    Promise.resolve(client.call("AUTH", ...authArgs)).catch((error) =>
      logger.warn(
        `Failed to re-authenticate Redis after ${provider.name} token refresh`,
        error,
      ),
    );
  });

  if (client.status === "wait") {
    await client
      .connect()
      .catch((error) =>
        logger.warn(
          `Redis connect after ${provider.name} credential bootstrap failed`,
          error,
        ),
      );
  }

  return manager;
}
