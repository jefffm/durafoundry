import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  ArtifactRef,
  ArtifactUri,
  MilestoneId,
  NodeId,
  PlanDAG,
  PlanSnapshotId,
  PlanSnapshotManifest,
  SnapshotArtifact,
} from '@durafoundry/domain';

export type ArtifactContent = unknown;

export interface LocalArtifactStoreOptions {
  rootDir: string;
  now?: () => string;
}

export interface WriteArtifactInput {
  kind: string;
  producer: string;
  content: ArtifactContent;
  relativePath?: string;
  createdAt?: string;
}

export interface PlanBundleInput {
  plan: PlanDAG;
  nodeBodies: Record<NodeId, string>;
  milestoneBodies: Record<MilestoneId, string>;
  producer: string;
  createdAt?: string;
}

export interface PlanBundleResult {
  plan: PlanDAG;
  planRef: ArtifactRef;
  nodeBodyRefs: Record<NodeId, ArtifactRef>;
  milestoneBodyRefs: Record<MilestoneId, ArtifactRef>;
}

export interface SnapshotManifestInput {
  snapshotId: PlanSnapshotId;
  planId: string;
  planRef: ArtifactRef;
  nodeBodyRefs: Record<NodeId, ArtifactRef>;
  milestoneBodyRefs: Record<MilestoneId, ArtifactRef>;
  producer: string;
  createdAt?: string;
}

export interface SnapshotManifestResult {
  manifest: PlanSnapshotManifest;
  manifestRef: ArtifactRef;
}

export class LocalArtifactStore {
  private readonly rootDir: string;
  private readonly now: () => string;

  constructor(options: LocalArtifactStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef> {
    const bytes = serializeArtifactContent(input.content);
    const sha256 = sha256Hex(bytes);
    const relativePath =
      input.relativePath ?? join('artifacts', safePathSegment(input.kind), sha256);
    const artifactPath = this.resolveInsideRoot(relativePath);

    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes);

    return {
      uri: pathToFileURL(artifactPath).href,
      kind: input.kind,
      sha256,
      createdAt: input.createdAt ?? this.now(),
      producer: input.producer,
    };
  }

  async readArtifact(uriOrRef: ArtifactUri | ArtifactRef): Promise<Buffer> {
    const uri = typeof uriOrRef === 'string' ? uriOrRef : uriOrRef.uri;
    return readFile(this.pathFromUri(uri));
  }

  async readTextArtifact(uriOrRef: ArtifactUri | ArtifactRef): Promise<string> {
    return (await this.readArtifact(uriOrRef)).toString('utf8');
  }

  async writePlanBundle(input: PlanBundleInput): Promise<PlanBundleResult> {
    const planDir = join('plans', safePathSegment(input.plan.planId));
    const createdAt = input.createdAt ?? this.now();
    const nodeBodyRefs: Record<NodeId, ArtifactRef> = {};
    const milestoneBodyRefs: Record<MilestoneId, ArtifactRef> = {};

    for (const node of input.plan.nodes) {
      const body = input.nodeBodies[node.id];
      if (body === undefined) {
        throw new Error(`Missing node body for ${node.id}`);
      }

      nodeBodyRefs[node.id] = await this.writeArtifact({
        kind: 'node-body',
        producer: input.producer,
        content: body,
        relativePath: join(planDir, 'nodes', `${safePathSegment(node.id)}.md`),
        createdAt,
      });
    }

    for (const milestone of input.plan.milestones) {
      const body = input.milestoneBodies[milestone.id];
      if (body === undefined) {
        throw new Error(`Missing milestone body for ${milestone.id}`);
      }

      milestoneBodyRefs[milestone.id] = await this.writeArtifact({
        kind: 'milestone-body',
        producer: input.producer,
        content: body,
        relativePath: join(planDir, 'milestones', `${safePathSegment(milestone.id)}.md`),
        createdAt,
      });
    }

    const planUri = this.uriForRelativePath(join(planDir, 'plan.json'));
    const storedPlan: PlanDAG = {
      ...input.plan,
      artifactUri: planUri,
      nodes: input.plan.nodes.map((node) => ({
        ...node,
        bodyUri: requireRef(nodeBodyRefs, node.id).uri,
      })),
      milestones: input.plan.milestones.map((milestone) => ({
        ...milestone,
        bodyUri: requireRef(milestoneBodyRefs, milestone.id).uri,
      })),
    };

    const planRef = await this.writeArtifact({
      kind: 'plan-json',
      producer: input.producer,
      content: storedPlan,
      relativePath: join(planDir, 'plan.json'),
      createdAt,
    });

    return {
      plan: storedPlan,
      planRef,
      nodeBodyRefs,
      milestoneBodyRefs,
    };
  }

  async writeSnapshotManifest(input: SnapshotManifestInput): Promise<SnapshotManifestResult> {
    const createdAt = input.createdAt ?? this.now();
    const manifest: PlanSnapshotManifest = {
      snapshotId: input.snapshotId,
      planJson: toSnapshotArtifact(input.planRef, 'plan-json'),
      nodeBodies: mapSnapshotArtifacts(input.nodeBodyRefs, 'node-body'),
      milestoneBodies: mapSnapshotArtifacts(input.milestoneBodyRefs, 'milestone-body'),
      createdAt,
    };

    const manifestRef = await this.writeArtifact({
      kind: 'plan-snapshot-manifest',
      producer: input.producer,
      content: manifest,
      relativePath: join(
        'plans',
        safePathSegment(input.planId),
        'snapshots',
        `${safePathSegment(input.snapshotId)}.json`,
      ),
      createdAt,
    });

    return { manifest, manifestRef };
  }

  uriForRelativePath(relativePath: string): ArtifactUri {
    return pathToFileURL(this.resolveInsideRoot(relativePath)).href;
  }

  private pathFromUri(uri: ArtifactUri): string {
    if (!uri.startsWith('file://')) {
      throw new Error(`Unsupported artifact URI: ${uri}`);
    }

    const artifactPath = fileURLToPath(uri);
    return this.assertInsideRoot(artifactPath);
  }

  private resolveInsideRoot(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error(`Artifact path must be relative: ${relativePath}`);
    }

    return this.assertInsideRoot(resolve(this.rootDir, relativePath));
  }

  private assertInsideRoot(path: string): string {
    const resolvedPath = resolve(path);
    const rel = relative(this.rootDir, resolvedPath);
    if (rel === '' || (!rel.startsWith('..') && rel !== '..' && !isAbsolute(rel))) {
      return resolvedPath;
    }

    throw new Error(`Artifact path escapes root: ${path}`);
  }
}

export function createLocalArtifactStore(options: LocalArtifactStoreOptions): LocalArtifactStore {
  return new LocalArtifactStore(options);
}

export function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function serializeArtifactContent(content: ArtifactContent): Uint8Array {
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }

  if (content instanceof Uint8Array) {
    return content;
  }

  return Buffer.from(`${stableJsonStringify(content)}\n`, 'utf8');
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
    );
  }

  return value;
}

function toSnapshotArtifact(ref: ArtifactRef, kind: SnapshotArtifact['kind']): SnapshotArtifact {
  if (!ref.sha256) {
    throw new Error(`Artifact ${ref.uri} is missing sha256`);
  }

  return {
    uri: ref.uri,
    sha256: ref.sha256,
    kind,
  };
}

function mapSnapshotArtifacts<TKey extends string>(
  refs: Record<TKey, ArtifactRef>,
  kind: SnapshotArtifact['kind'],
): Record<TKey, SnapshotArtifact> {
  return Object.fromEntries(
    Object.entries(refs).map(([id, ref]) => [id, toSnapshotArtifact(ref as ArtifactRef, kind)]),
  ) as Record<TKey, SnapshotArtifact>;
}

function requireRef<TKey extends string>(
  refs: Record<TKey, ArtifactRef>,
  id: TKey,
): ArtifactRef {
  const ref = refs[id];
  if (!ref) {
    throw new Error(`Missing artifact ref for ${id}`);
  }

  return ref;
}

function safePathSegment(segment: string): string {
  if (!segment || segment.includes('/') || segment.includes('\\') || segment === '.' || segment === '..') {
    throw new Error(`Unsafe artifact path segment: ${segment}`);
  }

  return segment;
}
