import path from "node:path";

const CONSOLIDATION_PATTERNS = [
  {
    matches: isValidationLeakageText,
    key: "pattern:validation-error-details",
    priority: 100,
    title: "Validation error details expose identifiers",
    summary:
      "Common root: validators expose raw identifier values in errors. Decide the shared error-message policy once, then apply it to all affected validators.",
  },
  {
    matches: isDataOptionalityText,
    key: "pattern:data-optionality",
    priority: 90,
    title: "Data schema optionality is too loose",
    summary:
      "Common root: DB/API/UI types allow absent or nullable values where the feature appears to require a concrete value. Tighten the schema boundary first, then derive API and form types from it.",
  },
  {
    matches: isSchemaDriftText,
    key: "pattern:schema-drift",
    priority: 85,
    title: "Schema-derived types drift across layers",
    summary:
      "Common root: API or UI/form types appear duplicated or broader than the source schema. Derive downstream types from the API/schema boundary and keep feature constraints in the schema.",
  },
  {
    matches: isAuthScopeText,
    key: "pattern:auth-scope",
    priority: 80,
    title: "Authorization or tenant scope is inconsistent",
    summary:
      "Common root: multiple findings point to missing or inconsistent auth, permission, or tenant/company scoping. Fix the shared boundary check before addressing individual call sites.",
  },
  {
    matches: isMissingTestText,
    key: "pattern:missing-tests",
    priority: 70,
    title: "Changed behavior lacks focused coverage",
    summary:
      "Common root: several changed paths rely on the same untested behavior. Add a focused test at the shared behavior boundary, then cover representative edge cases.",
  },
];

export function buildIssueConsolidations(findings) {
  const buckets = new Map();
  for (const finding of findings) {
    for (const candidate of consolidationCandidates(finding)) {
      const bucket = buckets.get(candidate.key) ?? { ...candidate, findings: [] };
      if (!bucket.findings.some((existing) => existing.id === finding.id))
        bucket.findings.push(finding);
      bucket.priority = Math.max(bucket.priority, candidate.priority);
      buckets.set(candidate.key, bucket);
    }
  }
  return finalizeConsolidationBuckets(buckets);
}

function consolidationCandidates(finding) {
  const candidates = [];
  const filePath = finding.location?.filePath;
  if (finding.type === "documentation" && filePath)
    candidates.push({
      key: `docs:${filePath}`,
      title: `${path.basename(filePath)} documentation quality`,
      priority: 60,
      summary: `Multiple documentation findings affect ${filePath}. Resolve the shared guidance once, then update each affected example or instruction.`,
    });
  const searchText = findingSearchText(finding);
  candidates.push(...CONSOLIDATION_PATTERNS.filter((pattern) => pattern.matches(searchText)));
  const locationKey = sharedLocationKey(finding);
  if (locationKey)
    candidates.push({
      key: `location:${locationKey}`,
      title: `Multiple lanes flagged ${sharedLocationLabel(finding)}`,
      summary:
        "Several reviewers point at the same changed code area. Treat these as symptoms of one underlying implementation issue before fixing each reported detail.",
      priority: 55,
    });
  const normalizedTitle = normalizeIssuePhrase(finding.title);
  if (normalizedTitle)
    candidates.push({
      key: `title:${normalizedTitle}`,
      title: `Repeated issue: ${sentenceCase(normalizedTitle)}`,
      summary:
        "Multiple findings describe the same issue pattern. Fix the shared cause once, then verify each affected site.",
      priority: 50,
    });
  return candidates;
}

function finalizeConsolidationBuckets(buckets) {
  const usedFindingIds = new Set();
  return [...buckets.values()]
    .filter((bucket) => bucket.findings.length >= 2)
    .sort(
      (first, second) =>
        second.priority - first.priority ||
        second.findings.length - first.findings.length ||
        first.title.localeCompare(second.title),
    )
    .flatMap((bucket, bucketIndex) => {
      const findings = bucket.findings.filter((finding) => !usedFindingIds.has(finding.id));
      if (findings.length < 2) return [];
      for (const finding of findings) usedFindingIds.add(finding.id);
      const findingIds = findings.map((finding) => finding.id);
      return [
        {
          id: `group-${bucketIndex + 1}-${stableId(`${bucket.key}:${findingIds.join(",")}`)}`,
          title: bucket.title,
          summary: bucket.summary,
          findingIds,
        },
      ];
    });
}

function findingSearchText(finding) {
  return [
    finding.title,
    finding.body,
    finding.suggestion,
    finding.type,
    finding.laneId,
    finding.location?.filePath,
    finding.functionName,
    finding.location?.functionName,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidationLeakageText(text) {
  return /(echo|echoed|expos|leak).*(validation error|error detail|identifier|\bid\b|pii|tax id|national id)/i.test(
    text,
  );
}

function isDataOptionalityText(text) {
  return (
    /(data|database|db|drizzle|schema|zod|type|form)/i.test(text) &&
    /(nullable|nullability|null|optional|undefined|required|not null|notnull|default|constraint|tight|loose|broad|empty array|empty string)/i.test(
      text,
    )
  );
}

function isSchemaDriftText(text) {
  return /(duplicate|drift|derive|derived|infer|inferred|source of truth|broader|looser).*(schema|type|api|ui|form|zod|db)|((schema|type|api|ui|form|zod|db).*(duplicate|drift|derive|derived|infer|inferred|source of truth|broader|looser))/i.test(
    text,
  );
}

function isAuthScopeText(text) {
  return /(auth|authorization|permission|access control|tenant|company\s*id|companyid|scope|scoping)/i.test(
    text,
  );
}

function isMissingTestText(text) {
  return /(missing|lacks?|without|no).{0,30}(test|coverage)|untested|edge case/i.test(text);
}

function sharedLocationKey(finding) {
  const filePath = finding.location?.filePath;
  if (!filePath) return undefined;
  const functionName = finding.functionName?.trim() || finding.location?.functionName?.trim();
  if (functionName) return `${filePath}#${functionName}`;
  const line = finding.location?.line ?? finding.location?.startLine;
  return line === undefined ? undefined : `${filePath}:${line}`;
}

function sharedLocationLabel(finding) {
  const filePath = finding.location?.filePath ?? "the same code area";
  const functionName = finding.functionName?.trim() || finding.location?.functionName?.trim();
  return functionName ? `${functionName} in ${filePath}` : filePath;
}

function normalizeIssuePhrase(value) {
  const normalized = value
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(can|could|may|might|should|would|the|a|an|to|of|for|in|on|with|and|or|is|are|be|been|this|that|these|those)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return normalized.split(" ").length >= 3 ? normalized : undefined;
}

function sentenceCase(value) {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function stableId(text) {
  let hash = 0;
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    hash = (hash * 31 + text.charCodeAt(characterIndex)) >>> 0;
  }
  return hash.toString(36);
}
