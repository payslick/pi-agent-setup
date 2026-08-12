import path from "node:path";
import { SUBAGENT_PROFILE_NAMES, type SubagentSpec } from "./schemas";
import type { SpawnedSubagentRecord } from "./state";

const MAX_CONCURRENT_IMPLEMENTERS = 2;
const IMPLEMENTATION_PROFILES = new Set([
  "frontend-implementer",
  "backend-implementer",
  "unit-test-implementer",
  "e2e-test-implementer",
]);
const KNOWN_PROFILES = new Set<string>(SUBAGENT_PROFILE_NAMES);

interface Ownership {
  owner: string;
  writableFiles: string[];
  contractFiles: string[];
  implementation: boolean;
}

const resolveInsideRoot = (root: string, requested: string): string => {
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside) throw new Error(`Subagent file must stay inside ${root}: ${requested}`);
  return path.normalize(relative);
};

const profileOwnership = (spec: SubagentSpec, projectRoot: string): Ownership | undefined => {
  if (!spec.profile) return undefined;
  if (!KNOWN_PROFILES.has(spec.profile))
    throw new Error(`Unknown subagent profile: ${spec.profile}.`);
  if (!spec.workPacket) throw new Error(`${spec.profile} requires a structured workPacket.`);
  if (
    typeof spec.workPacket.objective !== "string" ||
    !Array.isArray(spec.workPacket.writableFiles) ||
    (spec.workPacket.contractFiles !== undefined &&
      !Array.isArray(spec.workPacket.contractFiles)) ||
    !Array.isArray(spec.workPacket.acceptanceCriteria) ||
    spec.workPacket.acceptanceCriteria.length === 0
  ) {
    throw new Error(`${spec.profile} has an invalid workPacket.`);
  }

  const implementation = IMPLEMENTATION_PROFILES.has(spec.profile);
  if (implementation && spec.workPacket.writableFiles.length === 0) {
    throw new Error(`${spec.profile} requires at least one writable file.`);
  }
  if (!implementation && spec.workPacket.writableFiles.length > 0) {
    throw new Error(`${spec.profile} is read-only and cannot own writable files.`);
  }

  return {
    owner: spec.name ?? spec.profile,
    writableFiles: spec.workPacket.writableFiles.map((file) =>
      resolveInsideRoot(projectRoot, file),
    ),
    contractFiles:
      spec.workPacket.contractFiles?.map((file) => resolveInsideRoot(projectRoot, file)) ?? [],
    implementation,
  };
};

const packetFilesForSpec = (
  spec: SubagentSpec,
  projectRoot: string,
  key: "writableFiles" | "contractFiles",
) => spec.workPacket?.[key]?.map((file) => resolveInsideRoot(projectRoot, file));

export const writableFilesForSpec = (spec: SubagentSpec, projectRoot: string) =>
  packetFilesForSpec(spec, projectRoot, "writableFiles");

export const contractFilesForSpec = (spec: SubagentSpec, projectRoot: string) =>
  packetFilesForSpec(spec, projectRoot, "contractFiles");

export function validateImplementationAssignments(
  specs: SubagentSpec[],
  activeRecords: SpawnedSubagentRecord[],
  projectRoot: string,
): void {
  const requested = specs
    .map((spec) => profileOwnership(spec, projectRoot))
    .filter((assignment): assignment is Ownership => Boolean(assignment));
  const activeImplementers = activeRecords.filter(
    (record) => record.profile && IMPLEMENTATION_PROFILES.has(record.profile),
  );
  const requestedImplementers = requested.filter((assignment) => assignment.implementation);
  if (activeImplementers.length + requestedImplementers.length > MAX_CONCURRENT_IMPLEMENTERS) {
    throw new Error(
      `At most ${MAX_CONCURRENT_IMPLEMENTERS} implementation workers may run at once.`,
    );
  }

  const contractOwnerByFile = new Map<string, string>();
  for (const record of activeRecords) {
    for (const file of record.contractFiles ?? []) contractOwnerByFile.set(file, record.name);
  }
  for (const assignment of requested) {
    for (const file of assignment.contractFiles) contractOwnerByFile.set(file, assignment.owner);
  }

  const writeOwnerByFile = new Map<string, string>();
  for (const record of activeRecords) {
    for (const file of record.writableFiles ?? []) {
      const contractOwner = contractOwnerByFile.get(file);
      if (contractOwner) throw new Error(`${file} is a contract owned by ${contractOwner}.`);
      writeOwnerByFile.set(file, record.name);
    }
  }
  for (const assignment of requested) {
    for (const file of assignment.writableFiles) {
      const contractOwner = contractOwnerByFile.get(file);
      if (contractOwner) throw new Error(`${file} is a contract owned by ${contractOwner}.`);
      const writeOwner = writeOwnerByFile.get(file);
      if (writeOwner) throw new Error(`${file} is already owned by ${writeOwner}.`);
      writeOwnerByFile.set(file, assignment.owner);
    }
  }
}
