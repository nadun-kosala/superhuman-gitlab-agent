import * as coda from "@codahq/packs-sdk";

export const pack = coda.newPack();

pack.addNetworkDomain("gitlab.com");

pack.setUserAuthentication({
  type: coda.AuthenticationType.OAuth2,
  // Hardcode these temporarily (remove the relative paths)
  authorizationUrl: "https://gitlab.com/oauth/authorize",
  tokenUrl: "https://gitlab.com/oauth/token",
  
  scopes: ["api", "read_user", "read_repository", "write_repository"],

  // SET THIS TO FALSE FOR NOW
  requiresEndpointUrl: false, 

  getConnectionName: async function (context) {
    let response = await context.fetcher.fetch({
      method: "GET",
      url: "https://gitlab.com/api/v4/user",
    });
    return response.body.username;
  },
});