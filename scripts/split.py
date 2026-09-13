#!/usr/bin/env python3
"""Split the single-file design doc into Starlight content pages.

Pass 1: split on H2, demote headings, write files, record a heading index.
Pass 2 (after scripts/anchors.mjs computes real GitHub anchors): rewrite
        every §N / §N.M cross-reference into a relative Starlight link.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = pathlib.Path('/mnt/user-data/outputs/helix-platform-design.md')
DOCS = ROOT / 'src' / 'content' / 'docs'
INDEX = ROOT / 'scripts' / 'headings.json'


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r'[^\w\s-]', '', text, flags=re.UNICODE)
    text = re.sub(r'[\s_]+', '-', text.strip())
    return re.sub(r'-+', '-', text).strip('-')


# ---------------------------------------------------------------- read + strip front matter
raw = SRC.read_text()
body = raw.split('\n## ', 1)
preamble = body[0]
rest = '## ' + body[1]

# ---------------------------------------------------------------- split on H2
chunks = re.split(r'\n(?=## )', rest)

GROUPS = [
    ('Orientation',            [0, 1]),
    ('The three planes',       [2, 3]),
    ('Build and deploy',       [4, 5]),
    ('Isolation and runtimes', [6, 7, 8]),
    ('The runtime contract',   [9, 10]),
    ('Traffic and scale',      [11, 12, 13, 19]),
    ('Data and interfaces',    [14, 15, 16, 17, 18]),
    ('Running it',             [20, 21, 22, 23, 24, 25]),
    ('Building it',            [26, 27, 28, 29, 30, 31]),
    ('Money and choices',      [32, 33, 34]),
    ('Diagrams and failure',   [35, 36, 37, 38]),
    ('Closing',                [39, 40, 41, 42, 43, 44]),
]

DESCRIPTIONS = {
    0: 'Conventions, maturity labels, an honest note on scope, and the glossary.',
    1: 'Why OCI is the universal artifact, the pipeline stated precisely, the three planes, and the trust boundaries.',
    2: 'Modular monolith over microservices, component responsibilities, and an explicit stateless/stateful inventory.',
    3: 'Worker node anatomy, why the agent is Rust, the guest init, and the agent to control-plane protocol.',
    4: 'Git push to live URL, step by step, with the failure handling for each stage.',
    5: 'Secure multi-tenant builds: isolation, cache, secrets, egress policy, and the malicious-build attack tree.',
    6: 'The threat model, the defense layers, and a flat statement of what Firecracker does and does not solve.',
    7: 'KVM, the VMM, jailer, rootfs conversion, networking, snapshots, and managing thousands of microVMs.',
    8: 'Wasmtime as a separate deployment type, its mechanics, and the WASM vs Firecracker vs containers tradeoff.',
    9: 'The runtime definition and helix.yaml schemas that let a new language ship without core changes.',
    10: 'Dockerfiles, prebuilt images, external registries, base-image policy, scanning and signing.',
    11: 'Envoy at the edge, the activator, TLS and domains, protocols, timeouts and load balancing.',
    12: 'Concurrency-based autoscaling, the placement algorithm, the cold-start decision tree and scale-to-zero.',
    13: 'Snapshots, warm pools, image caching, lazy loading, and per-language startup figures.',
    14: 'Ephemeral by default, the storage tiers, and why application state must not live in the microVM.',
    15: 'Full PostgreSQL DDL for 29 tables, an ER diagram, and the modeling decisions behind them.',
    16: 'REST conventions, authentication, authorization, the core endpoints with examples, and error shapes.',
    17: 'GitHub Apps, webhooks, deployment triggers, preview URLs, secrets on forks, and promotion.',
    18: 'The isolation boundaries, three layers of data isolation, quotas, and noisy-neighbor controls.',
    19: 'Three loops at three timescales: instances in seconds, workers in minutes, regions in weeks.',
    20: 'The multi-region topology, the failure matrix, the autonomy principle and split-brain prevention.',
    21: 'RPO and RTO targets, backup strategy, four restore scenarios, and the DR calendar.',
    22: 'The stack, four user-facing SLOs, the metric catalogue, logs, traces and alerting philosophy.',
    23: 'Authentication, authorization, secrets, encryption, key management, supply chain and the attack tree.',
    24: 'Detecting and stopping mining, proxy abuse, phishing, scanning and DDoS from customer workloads.',
    25: 'What to meter, how to collect it without touching the request path, and the edge cases that cause disputes.',
    26: 'CLI design goals, the command surface, its architecture, and what a good error message looks like.',
    27: 'The configuration format and the reasoning behind each design choice.',
    28: 'Six deployables, not fourteen, with the responsibility and failure behavior of each.',
    29: 'A production monorepo layout, with the additions that are easy to forget in planning.',
    30: 'Eight phases with goals, tasks, acceptance criteria, risks, and realistic timelines.',
    31: 'Developing this from Windows: WSL2, nested virtualization, and the remote worker setup.',
    32: 'Sizing for small, medium and large production, with the assumptions stated up front.',
    33: 'Infrastructure costs by tier and provider, and which optimizations are safe to take.',
    34: 'Runtime, queue, proxy and language comparisons with weighted scoring and final recommendations.',
    35: 'Eleven sequence diagrams covering deployment, build, VM creation, cold start, rollback and failure.',
    36: 'Ten architecture diagrams from the overall system down to the security boundaries.',
    37: 'Per-component crash, slowness and partition behavior, and whether requests can be lost.',
    38: 'Idempotency, consistency, fencing, retries, delivery semantics, and the deployment state machine.',
    39: 'An adversarial review written before allowing arbitrary third-party code to run.',
    40: 'The concise final stack, how it balances the five constraints, and the decisions most likely to be regretted.',
    41: 'Test levels from unit to chaos, with the two suites that matter most and are easiest to skip.',
    42: 'The gates to clear before this runs untrusted workloads in production.',
    43: 'Decisions to settle before phase 2.',
    44: 'The architecture decision records to write first.',
}

pages = []
appendix_n = 43

for chunk in chunks:
    first, _, remainder = chunk.partition('\n')
    heading = first[3:].strip()

    m = re.match(r'(\d+)\.\s+(.*)', heading)
    if m:
        num = int(m.group(1))
        title = m.group(2).strip()
    else:
        num = appendix_n
        appendix_n += 1
        title = heading

    slug = f"{num:02d}-{slugify(title)[:52].rstrip('-')}"

    # demote: ### -> ##, #### -> ###  (H1 comes from frontmatter)
    content = re.sub(r'^#### ', '### ', remainder, flags=re.M)
    content = re.sub(r'^### ',  '## ',  content,   flags=re.M)
    content = content.strip()
    content = re.sub(r'\n\*End of document\.\*\s*$', '', content)
    content = re.sub(r'\n---\s*$', '', content).strip()

    # collect the sub-headings so pass 2 can build anchors
    subs = []
    for hm in re.finditer(r'^## (.+)$', content, flags=re.M):
        htext = hm.group(1).strip()
        sm = re.match(r'(\d+)\.(\d+)\s', htext)
        subs.append({'text': htext, 'ref': f"{sm.group(1)}.{sm.group(2)}" if sm else None})

    pages.append({'num': num, 'title': title, 'slug': slug,
                  'content': content, 'subs': subs})

# ---------------------------------------------------------------- write the heading index for pass 2
INDEX.write_text(json.dumps(
    {'pages': [{'num': p['num'], 'slug': p['slug'], 'subs': p['subs']} for p in pages]},
    indent=1))

# ---------------------------------------------------------------- write pages (pass 2 rewrites xrefs in place)
DOCS.mkdir(parents=True, exist_ok=True)
for p in pages:
    desc = DESCRIPTIONS.get(p['num'], '')
    fm = (
        '---\n'
        f'title: "{p["num"]}. {p["title"]}"\n'
        f'description: "{desc}"\n'
        f'sidebar:\n'
        f'  order: {p["num"]}\n'
        '---\n\n'
    )
    (DOCS / f"{p['slug']}.md").write_text(fm + p['content'] + '\n')

# ---------------------------------------------------------------- sidebar config
by_num = {p['num']: p for p in pages}
groups = []
for label, nums in GROUPS:
    items = [f"'{by_num[n]['slug']}'" for n in nums if n in by_num]
    if items:
        groups.append(
            "    {\n"
            f"      label: '{label}',\n"
            "      items: [" + ', '.join(items) + "],\n"
            "    },"
        )
(ROOT / 'scripts' / 'sidebar.txt').write_text('\n'.join(groups))

print(f"wrote {len(pages)} pages")
print("preamble kept for the landing page:", len(preamble), "chars")
