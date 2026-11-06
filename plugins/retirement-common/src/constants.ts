/** Backstage plugin ID that owns the retirement actions and resource type. */
export const RETIREMENT_PLUGIN_ID = 'retirement-demo';

/** Resource type used for affected-resource authorization. */
export const RETIREMENT_TARGET_RESOURCE_TYPE = 'retirement-demo-target';

/**
 * Annotation namespace for trusted, operator-owned fixture classification.
 * Approval is deliberately NOT an annotation: it lives in a backend-owned table.
 */
export const ANNOTATION_ENVIRONMENT = 'retirement-demo.example.com/environment';
export const ANNOTATION_DEMO_MANAGED = 'retirement-demo.example.com/managed';
/** Marks a catalog User entity as a demo service account for an agent (trusted, operator-owned). */
export const ANNOTATION_ACCOUNT_TYPE = 'retirement-demo.example.com/account-type';

/** Action identifier recorded on task grants. */
export const RETIRE_ACTION_ID = 'retirement-demo:retire-service';

/** Startup profiles. Unknown values refuse startup; a missing value selects gated. */
export const DEMO_MODES = ['gated', 'ungated-lab'] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

/** Logical action names (registered under the retirement-demo plugin). */
export const ACTION_NAMES = {
  readIssue: 'read-issue',
  listServices: 'list-services',
  previewRetirement: 'preview-retirement',
  retireService: 'retire-service',
} as const;

/** Subject of the only service principal (static external-access token) allowed on operator routes. */
export const OPERATOR_SUBJECT = 'demo-operator';
