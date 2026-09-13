// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

/**
 * Injects the client-side Mermaid renderer on every page.
 * Kept as a three-line integration rather than a Starlight component override
 * so it survives Starlight upgrades.
 * @returns {import('astro').AstroIntegration}
 */
function helixMermaid() {
  return {
    name: 'helix-mermaid',
    hooks: {
      'astro:config:setup': ({ injectScript }) => {
        injectScript('page', `import '/src/mermaid.js';`);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// EDIT THESE TWO LINES for your repository, then everything else follows.
//   site: https://<your-github-username>.github.io
//   base: /<your-repo-name>
// If you later move to a custom domain at the root, set base to '/' and drop
// the trailing-slash handling below.
// ---------------------------------------------------------------------------
const GITHUB_USER = 'thanthtooaung-coding';
const REPO_NAME = 'helix-design-docs';

export default defineConfig({
  site: `https://${GITHUB_USER}.github.io`,
  base: `/${REPO_NAME}`,
  trailingSlash: 'always',

  integrations: [
    helixMermaid(),
    starlight({
      title: 'Helix Platform Design',
      description:
        'Master technical design for a multi-tenant application deployment platform built on OCI images, Firecracker microVMs and WebAssembly.',
      tagline: 'A deployment platform built on microVMs',

      social: {
        github: `https://github.com/${GITHUB_USER}/${REPO_NAME}`,
      },

      editLink: {
        baseUrl: `https://github.com/${GITHUB_USER}/${REPO_NAME}/edit/main/`,
      },

      lastUpdated: true,
      pagination: true,

      // IBM Plex Sans / Mono + Source Serif 4 — the pairing the design uses.
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap',
          },
        },
      ],

      customCss: ['./src/styles/helix.css'],

      expressiveCode: {
        themes: ['github-dark-dimmed', 'github-light'],
        styleOverrides: {
          borderRadius: '5px',
          codeFontFamily: '"IBM Plex Mono", ui-monospace, monospace',
          codeFontSize: '0.8rem',
          uiFontFamily: '"IBM Plex Sans", system-ui, sans-serif',
        },
      },

      sidebar: [
        {
          label: 'Orientation',
          items: ['00-how-to-read-this-document', '01-core-abstraction-and-system-overview'],
        },
        {
          label: 'The three planes',
          items: ['02-control-plane', '03-compute-plane'],
        },
        {
          label: 'Build and deploy',
          items: ['04-deployment-pipeline', '05-build-system'],
        },
        {
          label: 'Isolation and runtimes',
          items: [
            '06-runtime-isolation-and-threat-model',
            '07-firecracker-architecture',
            '08-wasm-architecture',
          ],
        },
        {
          label: 'The runtime contract',
          items: ['09-universal-runtime-specification', '10-custom-runtimes'],
        },
        {
          label: 'Traffic and scale',
          items: [
            '11-http-routing',
            '12-serverless-scheduling',
            '13-cold-start-optimization',
            '19-autoscaling',
          ],
        },
        {
          label: 'Data and interfaces',
          items: [
            '14-storage-architecture',
            '15-database-schema',
            '16-api-design',
            '17-git-integration-and-preview-deployments',
            '18-multi-tenancy',
          ],
        },
        {
          label: 'Running it',
          items: [
            '20-high-availability',
            '21-disaster-recovery',
            '22-observability',
            '23-security-architecture',
            '24-abuse-prevention',
            '25-billing-and-metering',
          ],
        },
        {
          label: 'Building it',
          items: [
            '26-developer-experience-and-cli',
            '27-deployment-configuration-format',
            '28-internal-services',
            '29-repository-structure',
            '30-implementation-roadmap',
            '31-local-development-environment',
          ],
        },
        {
          label: 'Money and choices',
          items: [
            '32-production-infrastructure-sizing',
            '33-cost-model',
            '34-technology-decision-matrices',
          ],
        },
        {
          label: 'Diagrams and failure',
          items: [
            '35-sequence-diagrams',
            '36-architecture-diagrams',
            '37-failure-scenarios',
            '38-distributed-systems-concerns',
          ],
        },
        {
          label: 'Closing',
          items: [
            '39-production-security-review',
            '40-final-recommended-architecture',
            '41-testing-strategy',
            '42-production-readiness-checklist',
            '43-appendix-a-open-questions-to-settle-before-phase-2',
            '44-appendix-b-architecture-decision-records-to-write-fi',
          ],
        },
      ],
    }),
  ],
});
