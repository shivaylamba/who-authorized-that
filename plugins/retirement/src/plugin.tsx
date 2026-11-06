import {
  PageBlueprint,
  createFrontendPlugin,
  createRouteRef,
} from '@backstage/frontend-plugin-api';
import SecurityIcon from '@material-ui/icons/Security';

export const rootRouteRef = createRouteRef();
export const detailsRouteRef = createRouteRef();

/** The simple three-scenario dashboard (what the audience sees). */
const dashboardPage = PageBlueprint.make({
  params: {
    path: '/identity-boundary-demo',
    title: 'Who Authorized That?',
    icon: <SecurityIcon />,
    routeRef: rootRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/ScenarioDashboard').then(m => <m.ScenarioDashboard />),
  },
});

/** The full presenter page: timeline, decision inspector, grants, comparisons. */
const detailsPage = PageBlueprint.make({
  name: 'details',
  params: {
    path: '/identity-boundary-demo-details',
    title: 'Who Authorized That? — details',
    routeRef: detailsRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/DemoPage').then(m => <m.DemoPage />),
  },
});

export const retirementPlugin = createFrontendPlugin({
  pluginId: 'retirement-demo',
  info: { packageJson: () => import('../package.json') },
  routes: { root: rootRouteRef, details: detailsRouteRef },
  extensions: [dashboardPage, detailsPage],
});
