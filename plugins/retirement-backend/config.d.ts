export interface Config {
  retirementDemo?: {
    /** startup profile: gated (default) or ungated-lab (also needs DEMO_LAB_ENABLED=true) */
    mode?: string;
    /** directory containing manifest.yaml */
    fixturesDir?: string;
    /**
     * Static external-access token used by the privileged executor for catalog
     * mutations. Must match an externalAccess entry with accessRestrictions.
     * @visibility secret
     */
    executorToken?: string;
  };
}
