import { statSync } from "node:fs";
import path from "node:path";

export const PR_METADATA_SKILL_RELATIVE_PATH = path.join(
  ".pi",
  "skills",
  "pr-metadata",
  "SKILL.md",
);
export const PR_METADATA_AGENT_TOOLS = ["read", "read-many-files-lines"];
export const PR_METADATA_READ_EXTENSION_RELATIVE_PATH = path.join(
  ".pi",
  "extensions",
  "read-many-files-lines.ts",
);

export function resolvePrMetadataSkillPath(ctx) {
  const skillPath = path.resolve(ctx.cwd, PR_METADATA_SKILL_RELATIVE_PATH);
  try {
    if (statSync(skillPath).isFile()) return skillPath;
  } catch {}
  throw new Error(
    `The pr-metadata skill is not installed at ${PR_METADATA_SKILL_RELATIVE_PATH}. Run: npx skills add ~/payslick/skills --skill pr-metadata --agent pi --yes`,
  );
}

export function prMetadataAgentOptions(ctx) {
  return {
    skillPath: resolvePrMetadataSkillPath(ctx),
    tools: PR_METADATA_AGENT_TOOLS,
    extensions: [path.resolve(ctx.cwd, PR_METADATA_READ_EXTENSION_RELATIVE_PATH)],
  };
}
