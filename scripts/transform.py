#!/usr/bin/env python3
"""Pass 3: inline transforms on the split pages.

1. ```mermaid fences  ->  raw <pre class="mermaid"> blocks, so Expressive Code
   never sees them and the client-side renderer can pick them up. Blank lines
   inside the source are dropped so the block stays one CommonMark HTML block.
2. [MVP] / [V1] / [SCALE] -> styled chips. They encode the build sequence, so
   they are worth rendering as chips rather than as bracketed text.
"""
import html
import pathlib
import re

DOCS = pathlib.Path(__file__).resolve().parents[1] / 'src' / 'content' / 'docs'

CHIPS = {'MVP': 'mvp', 'V1': 'v1', 'SCALE': 'scale'}

total_diagrams = 0
total_chips = 0

for path in sorted(DOCS.glob('*.md')):
    text = path.read_text()

    # -- 1. mermaid ------------------------------------------------------
    def mermaid(m):
        global total_diagrams
        total_diagrams += 1
        src = '\n'.join(line for line in m.group(1).split('\n') if line.strip())
        return f'<figure class="mermaid-figure"><pre class="mermaid">{html.escape(src)}</pre></figure>'

    text = re.sub(r'```mermaid\n([\s\S]*?)```', mermaid, text)

    # -- 2. maturity chips (outside code) --------------------------------
    fences, spans = [], []

    def stash(pattern, store, tag, s):
        def keep(m):
            store.append(m.group(0))
            return f'\x00{tag}{len(store) - 1}\x00'
        return re.sub(pattern, keep, s)

    text = stash(r'```[\s\S]*?```', fences, 'F', text)
    text = stash(r'<pre class="mermaid">[\s\S]*?</pre>', spans, 'M', text)
    text = stash(r'`[^`\n]*`', spans, 'M', text)

    def chip(m):
        global total_chips
        total_chips += 1
        key = m.group(1)
        return f'<span class="mat mat-{CHIPS[key]}">{key}</span>'

    text = re.sub(r'\*\*\[(MVP|V1|SCALE)\]\*\*', chip, text)
    text = re.sub(r'\[(MVP|V1|SCALE)\]', chip, text)

    text = re.sub(r'\x00M(\d+)\x00', lambda m: spans[int(m.group(1))], text)
    text = re.sub(r'\x00F(\d+)\x00', lambda m: fences[int(m.group(1))], text)

    path.write_text(text)

print(f'{total_diagrams} diagrams converted, {total_chips} chips')
