import { OAuth2 } from '@backstage/core-app-api';
import { SignInPage } from '@backstage/core-components';
import {
  ApiBlueprint,
  createApiFactory,
  createApiRef,
  createFrontendModule,
  configApiRef,
  discoveryApiRef,
  oauthRequestApiRef,
} from '@backstage/frontend-plugin-api';
import type {
  BackstageIdentityApi,
  OpenIdConnectApi,
  ProfileInfoApi,
  SessionApi,
} from '@backstage/core-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';

/** Local Dex OIDC provider; the only interactive sign-in method in this demo. */
export const dexOidcAuthApiRef = createApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
>({ id: 'auth.dex-oidc' });

const dexOidcAuthApi = ApiBlueprint.make({
  name: 'dex-oidc',
  params: defineParams =>
    defineParams(
      createApiFactory({
        api: dexOidcAuthApiRef,
        deps: {
          discoveryApi: discoveryApiRef,
          oauthRequestApi: oauthRequestApiRef,
          configApi: configApiRef,
        },
        factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
          OAuth2.create({
            configApi,
            discoveryApi,
            oauthRequestApi,
            provider: { id: 'oidc', title: 'Local Dex', icon: () => null },
            environment: configApi.getOptionalString('auth.environment'),
            defaultScopes: ['openid', 'profile', 'email', 'offline_access'],
          }),
      }),
    ),
});

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props => (
      <SignInPage
        {...props}
        title="Who Authorized That?"
        align="center"
        provider={{
          id: 'dex-oidc',
          title: 'Local Dex (synthetic users)',
          message:
            'Sign in as a synthetic demo user (alice, bob or carol) through the local OIDC provider.',
          apiRef: dexOidcAuthApiRef,
        }}
      />
    ),
  },
});

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [dexOidcAuthApi, signInPage],
});
