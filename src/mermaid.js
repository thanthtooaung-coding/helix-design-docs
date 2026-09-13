/**
 * Client-side Mermaid renderer.
 *
 * Injected on every page by the tiny `helixMermaid()` integration in
 * astro.config.mjs. Diagrams arrive as <pre class="mermaid"> (emitted by
 * scripts/transform.py), so Expressive Code never touches them.
 *
 * Mermaid itself is imported lazily and only on pages that actually contain a
 * diagram, so text-only pages pay nothing for it.
 */

const FONT = '"IBM Plex Sans", system-ui, sans-serif';

/** Mermaid theme variables derived from the Helix palette. */
function themeVariables(dark) {
  const shared = { fontFamily: FONT, fontSize: '15px' };
  return dark
    ? {
        ...shared,
        background: '#151A21',
        primaryColor: '#1F2731',
        primaryTextColor: '#E7EBF0',
        primaryBorderColor: '#3A4654',
        secondaryColor: '#2A1A14',
        tertiaryColor: '#17222D',
        lineColor: '#7A8593',
        textColor: '#E7EBF0',
        mainBkg: '#1F2731',
        nodeBorder: '#3A4654',
        clusterBkg: '#11161C',
        clusterBorder: '#2B333E',
        edgeLabelBackground: '#151A21',
        actorBkg: '#1F2731',
        actorBorder: '#E0764F',
        actorTextColor: '#E7EBF0',
        actorLineColor: '#5A6673',
        signalColor: '#BFC7D2',
        signalTextColor: '#E7EBF0',
        labelBoxBkgColor: '#2A1A14',
        labelBoxBorderColor: '#E0764F',
        labelTextColor: '#F0987A',
        loopTextColor: '#BFC7D2',
        noteBkgColor: '#2A1A14',
        noteBorderColor: '#E0764F',
        noteTextColor: '#F0987A',
        sequenceNumberColor: '#151A21',
        altBackground: '#11161C',
        transitionColor: '#7A8593',
        transitionLabelColor: '#E7EBF0',
        stateBkg: '#1F2731',
        labelBackgroundColor: '#151A21',
        attributeBackgroundColorOdd: '#1A2029',
        attributeBackgroundColorEven: '#151A21',
      }
    : {
        ...shared,
        background: '#FFFFFF',
        primaryColor: '#EDF0F4',
        primaryTextColor: '#14171D',
        primaryBorderColor: '#AEB8C4',
        secondaryColor: '#F6E9E4',
        tertiaryColor: '#E7EDF3',
        lineColor: '#7C8694',
        textColor: '#14171D',
        mainBkg: '#EDF0F4',
        nodeBorder: '#AEB8C4',
        clusterBkg: '#FAFBFC',
        clusterBorder: '#D6DBE2',
        edgeLabelBackground: '#FFFFFF',
        actorBkg: '#EDF0F4',
        actorBorder: '#AC4225',
        actorTextColor: '#14171D',
        actorLineColor: '#9AA3AF',
        signalColor: '#39414E',
        signalTextColor: '#14171D',
        labelBoxBkgColor: '#F6E9E4',
        labelBoxBorderColor: '#AC4225',
        labelTextColor: '#8E3620',
        loopTextColor: '#39414E',
        noteBkgColor: '#F6E9E4',
        noteBorderColor: '#AC4225',
        noteTextColor: '#8E3620',
        sequenceNumberColor: '#FFFFFF',
        altBackground: '#FAFBFC',
        transitionColor: '#7C8694',
        transitionLabelColor: '#14171D',
        stateBkg: '#EDF0F4',
        labelBackgroundColor: '#FFFFFF',
        attributeBackgroundColorOdd: '#FAFBFC',
        attributeBackgroundColorEven: '#FFFFFF',
      };
}

function prefersDark() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

let mermaid = null;
let counter = 0;
let rendering = false;

async function render() {
  if (rendering) return;
  const nodes = Array.from(document.querySelectorAll('pre.mermaid'));
  if (nodes.length === 0) return;

  rendering = true;
  try {
    if (!mermaid) mermaid = (await import('mermaid')).default;

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(prefersDark()),
      // useMaxWidth:false keeps diagrams at natural size and lets the figure
      // scroll horizontally. Shrinking a 29-table ER diagram to fit makes it
      // unreadable; a scrollbar does not.
      flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false },
      sequence: { useMaxWidth: false, wrap: true, width: 170 },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    });

    for (const node of nodes) {
      // Stash the source once: Mermaid replaces the element's contents.
      if (!node.dataset.src) node.dataset.src = node.textContent || '';
      const source = node.dataset.src;
      if (!source.trim()) continue;
      try {
        const { svg } = await mermaid.render(`helix-mmd-${counter++}`, source);
        node.innerHTML = svg;
        node.setAttribute('data-rendered', 'true');
      } catch (error) {
        node.setAttribute('data-error', 'true');
        node.textContent = source;
        // eslint-disable-next-line no-console
        console.error('[helix] mermaid render failed', error);
      }
    }
  } finally {
    rendering = false;
  }
}

function reset() {
  document.querySelectorAll('pre.mermaid[data-rendered]').forEach((node) => {
    node.removeAttribute('data-rendered');
    node.textContent = node.dataset.src || '';
  });
}

function watchTheme() {
  // Starlight's theme select writes data-theme on <html>.
  new MutationObserver((records) => {
    if (records.some((r) => r.attributeName === 'data-theme')) {
      reset();
      render();
    }
  }).observe(document.documentElement, { attributes: true });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.dataset.theme) return; // an explicit choice wins
    reset();
    render();
  });
}

function boot() {
  render();
  watchTheme();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// If the site ever enables Starlight's ClientRouter, re-render after navigation.
document.addEventListener('astro:page-load', () => {
  render();
});
