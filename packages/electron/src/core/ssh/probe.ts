/**
 * Probe script generation and output parsing for service discovery. Ported
 * from crates/omnyssh-core/src/ssh/probe.rs.
 *
 * The Quick Scan probe is a single bash script that collects maximum
 * information in one SSH invocation. Output is delimited by section markers
 * (`===OMNYSSH:SECTION===`) for easy parsing.
 */

/** Generates the Quick Scan probe bash script. Runs multiple commands and
 *  delimits their output with section markers; every command redirects
 *  stderr to /dev/null for graceful failure. */
export function generateQuickScanScript(): string {
  return `cat << 'OMNYSSH_PROBE_EOF' | bash
echo "===OMNYSSH:OS==="
cat /etc/os-release 2>/dev/null | head -5
echo "===OMNYSSH:SERVICES==="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -50
echo "===OMNYSSH:DOCKER==="
docker ps --format '{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null | head -30
echo "===OMNYSSH:LISTEN==="
ss -tlnp 2>/dev/null | tail -n +2 | head -30
echo "===OMNYSSH:PROCESS==="
ps aux --sort=-%mem 2>/dev/null | head -15
OMNYSSH_PROBE_EOF
`;
}

/** Parsed output from the probe script, organized by section. */
export class ProbeOutput {
  private readonly sections: Map<string, string>;

  private constructor(sections: Map<string, string>) {
    this.sections = sections;
  }

  /** Parses the probe script output into sections, delimited by
   *  `===OMNYSSH:NAME===` markers. Never throws — unknown or malformed
   *  output is silently ignored (graceful degradation). */
  static parse(output: string): ProbeOutput {
    const sections = new Map<string, string>();
    let currentSection: string | undefined;
    let currentContent = '';

    for (const line of output.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('===OMNYSSH:') && trimmed.endsWith('===')) {
        if (currentSection !== undefined) {
          sections.set(currentSection, currentContent.trim());
          currentContent = '';
        }
        currentSection = trimmed.slice('===OMNYSSH:'.length, -'==='.length);
      } else if (currentSection !== undefined) {
        currentContent += line + '\n';
      }
    }

    if (currentSection !== undefined) sections.set(currentSection, currentContent.trim());
    return new ProbeOutput(sections);
  }

  /** True only if the section exists and has non-empty content. */
  hasSection(name: string): boolean {
    const content = this.sections.get(name);
    return content !== undefined && content !== '';
  }

  getSection(name: string): string | undefined {
    return this.sections.get(name);
  }

  /** Parses OS information from the OS section's `/etc/os-release` format:
   *  prefers `PRETTY_NAME`, else combines `NAME` + `VERSION`, else just `NAME`. */
  parseOsInfo(): string | undefined {
    const osSection = this.getSection('OS');
    if (osSection === undefined) return undefined;

    let name: string | undefined;
    let version: string | undefined;
    let prettyName: string | undefined;

    for (const rawLine of osSection.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('PRETTY_NAME=')) prettyName = extractValue(line, 'PRETTY_NAME=');
      else if (line.startsWith('NAME=')) name = extractValue(line, 'NAME=');
      else if (line.startsWith('VERSION=')) version = extractValue(line, 'VERSION=');
    }

    if (prettyName !== undefined) return prettyName;
    if (name !== undefined && version !== undefined) return `${name} ${version}`;
    return name;
  }
}

/** Extracts a value from an os-release line, handling both quoted
 *  (`"value"`/`'value'`) and unquoted formats. */
function extractValue(line: string, prefix: string): string | undefined {
  const value = line.slice(prefix.length).trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1);
    }
  }
  return value;
}
