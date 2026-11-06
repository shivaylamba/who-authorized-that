import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { InputError } from '@backstage/errors';

const manifestSchema = z
  .object({
    version: z.literal(1),
    targets: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            file: z.string().min(1),
            testOnly: z.boolean().optional(),
            entityRefs: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1),
    approvals: z.array(
      z
        .object({
          entityRef: z.string(),
          approvalId: z.string().min(1),
          approvedBy: z.string().min(1),
        })
        .strict(),
    ),
    issues: z.array(
      z.object({ issueId: z.string().min(1), file: z.string().min(1) }).strict(),
    ),
  })
  .strict();

export type ManifestTarget = {
  id: string;
  /** Absolute path to the fixture YAML; also the catalog location target. */
  locationTarget: string;
  testOnly: boolean;
  entityRefs: string[];
};

export type ManifestApproval = {
  entityRef: string;
  approvalId: string;
  approvedBy: string;
};

export type DemoManifest = {
  fixturesDir: string;
  targets: ManifestTarget[];
  approvals: ManifestApproval[];
  issues: Array<{ issueId: string; path: string }>;
};

/** Canonicalizes an entity ref; throws InputError for anything malformed. */
export function canonicalEntityRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length > 200) {
    throw new InputError('Entity ref must be a short string');
  }
  if (/[\s?#\\]|:\/\/|\.\./.test(ref) || (ref.match(/\//g) ?? []).length > 1) {
    throw new InputError('Entity ref must not contain URLs or path syntax');
  }
  let parsed;
  try {
    parsed = parseEntityRef(ref, { defaultKind: 'component', defaultNamespace: 'default' });
  } catch {
    throw new InputError(`Malformed entity ref`);
  }
  return stringifyEntityRef(parsed).toLocaleLowerCase('en-US');
}

/** Resolves a manifest-relative file and refuses anything outside the fixtures dir. */
function resolveInside(fixturesDir: string, file: string): string {
  const resolved = path.resolve(fixturesDir, file);
  const rel = path.relative(fixturesDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Manifest file ${file} escapes the fixtures directory`);
  }
  return resolved;
}

export function loadManifest(fixturesDir: string): DemoManifest {
  const absDir = path.resolve(fixturesDir);
  const raw = YAML.parse(fs.readFileSync(path.join(absDir, 'manifest.yaml'), 'utf8'));
  const parsed = manifestSchema.parse(raw);

  const targets = parsed.targets.map(t => {
    const locationTarget = resolveInside(absDir, t.file);
    if (!fs.existsSync(locationTarget)) {
      throw new Error(`Manifest target file is missing: ${t.file}`);
    }
    return {
      id: t.id,
      locationTarget,
      testOnly: t.testOnly ?? false,
      entityRefs: t.entityRefs.map(canonicalEntityRef),
    };
  });

  const allRefs = targets.flatMap(t => t.entityRefs);
  if (new Set(allRefs).size !== allRefs.length) {
    throw new Error('An entity ref appears in more than one manifest target');
  }

  return {
    fixturesDir: absDir,
    targets,
    approvals: parsed.approvals.map(a => ({
      ...a,
      entityRef: canonicalEntityRef(a.entityRef),
    })),
    issues: parsed.issues.map(i => ({
      issueId: i.issueId,
      path: resolveInside(absDir, i.file),
    })),
  };
}

/** Containment checks shared by the executor, reset and resolution code. */
export class ManifestGuard {
  constructor(readonly manifest: DemoManifest) {}

  isManagedEntityRef(ref: string): boolean {
    return this.manifest.targets.some(t => t.entityRefs.includes(ref));
  }

  targetForEntityRef(ref: string): ManifestTarget | undefined {
    return this.manifest.targets.find(t => t.entityRefs.includes(ref));
  }

  targetForLocation(locationTarget: string): ManifestTarget | undefined {
    return this.manifest.targets.find(t => t.locationTarget === locationTarget);
  }

  allManagedEntityRefs(): string[] {
    return this.manifest.targets.flatMap(t => t.entityRefs);
  }
}
