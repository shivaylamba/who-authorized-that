import path from 'node:path';
import { ManifestGuard, canonicalEntityRef, loadManifest } from './manifest';

const fixturesDir = path.resolve(__dirname, '../../../fixtures');

describe('canonicalEntityRef', () => {
  it('canonicalizes refs and fills defaults', () => {
    expect(canonicalEntityRef('component:default/checkout-preview')).toBe(
      'component:default/checkout-preview',
    );
    expect(canonicalEntityRef('Component:Default/Checkout-Preview')).toBe(
      'component:default/checkout-preview',
    );
    expect(canonicalEntityRef('checkout-preview')).toBe(
      'component:default/checkout-preview',
    );
  });

  it.each([
    'https://example.com/catalog-info.yaml',
    'file:/etc/passwd',
    'component:default/../payments-api',
    'component:default/a/b',
    'component:default/x?y',
    'component:default/x y',
    'a'.repeat(201),
    '',
  ])('rejects URLs, paths and malformed refs: %s', ref => {
    expect(() => canonicalEntityRef(ref)).toThrow();
  });
});

describe('loadManifest / ManifestGuard', () => {
  const manifest = loadManifest(fixturesDir);
  const guard = new ManifestGuard(manifest);

  it('resolves every target to its own fixture file inside the fixtures dir', () => {
    const files = manifest.targets.map(t => t.locationTarget);
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) {
      expect(f.startsWith(manifest.fixturesDir + path.sep)).toBe(true);
    }
  });

  it('contains demo refs and nothing else', () => {
    expect(guard.isManagedEntityRef('component:default/payments-api')).toBe(true);
    expect(guard.isManagedEntityRef('user:default/alice')).toBe(false);
    expect(guard.isManagedEntityRef('component:default/unknown')).toBe(false);
    expect(guard.targetForLocation('/etc/passwd')).toBeUndefined();
  });

  it('keeps approvals backend-owned and limited to the manifest', () => {
    const approved = manifest.approvals.map(a => a.entityRef);
    expect(approved).toContain('component:default/checkout-preview');
    expect(approved).not.toContain('component:default/payments-api');
    expect(approved).not.toContain('component:default/checkout-v2');
  });
});
