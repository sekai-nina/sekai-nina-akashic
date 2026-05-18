/**
 * Render a Dossier into the YAML shape consumed by sekai-nina-site articles.
 * Mirrors the per-asset `copy-source-ref.tsx` snippet but rolls up multiple
 * items and an optional placeCandidates block.
 */

interface DossierItemForExport {
  kind: string;
  caption: string;
  excerpt: string;
  externalUrl: string | null;
  externalImageKey: string | null;
  asset: {
    id: string;
    title: string;
    canonicalDate: Date | string | null;
  } | null;
}

interface PlaceCandidateForExport {
  name: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  confidence: number;
  note: string;
  place: { entity: { canonicalName: string } } | null;
}

interface DossierForExport {
  title: string;
  summary: string;
  items: DossierItemForExport[];
  placeCandidates: PlaceCandidateForExport[];
}

function quote(value: string): string {
  if (!value) return '""';
  if (/[:#\[\]{},&*!|>'"%@`\n]|^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function dateLine(d: Date | string | null): string | null {
  if (!d) return null;
  const iso = typeof d === "string" ? d : d.toISOString();
  return iso.slice(0, 10);
}

function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
}

export function exportDossierToYaml(dossier: DossierForExport): string {
  const lines: string[] = [];
  lines.push(`# ${dossier.title}`);
  if (dossier.summary) {
    lines.push("#");
    for (const summaryLine of dossier.summary.split("\n")) {
      lines.push(`# ${summaryLine}`);
    }
  }

  lines.push("sources:");
  for (const item of dossier.items) {
    if (item.kind === "asset_ref" && item.asset) {
      const date = dateLine(item.asset.canonicalDate);
      const label = item.caption || item.asset.title;
      lines.push("  - id: _");
      lines.push(`    ref: ${item.asset.id}`);
      lines.push(`    label: ${quote(label)}`);
      if (date) lines.push(`    date: ${date}`);
      if (item.excerpt) {
        lines.push("    excerpt: |");
        lines.push(indent(item.excerpt, 6));
      }
    } else if (item.kind === "external_link") {
      // sekai-nina-site doesn't have a canonical schema for external links yet —
      // emit a commented-out entry so the editor can decide later.
      lines.push(`  # external_link: ${item.externalUrl ?? ""}`);
      if (item.caption) lines.push(`  #   label: ${quote(item.caption)}`);
    } else if (item.kind === "external_image") {
      lines.push(`  # external_image: ${item.externalImageKey ?? ""}`);
      if (item.caption) lines.push(`  #   label: ${quote(item.caption)}`);
    }
  }

  if (dossier.placeCandidates.length > 0) {
    lines.push("placeCandidates:");
    for (const c of dossier.placeCandidates) {
      lines.push(`  - name: ${quote(c.place?.entity.canonicalName ?? c.name)}`);
      if (c.address) lines.push(`    address: ${quote(c.address)}`);
      if (c.latitude !== null && c.longitude !== null) {
        lines.push(`    lat: ${c.latitude}`);
        lines.push(`    lng: ${c.longitude}`);
      }
      if (c.confidence) lines.push(`    confidence: ${c.confidence}`);
      if (c.note) lines.push(`    note: ${quote(c.note)}`);
    }
  }

  return lines.join("\n") + "\n";
}
